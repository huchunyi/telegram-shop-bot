'use strict';

const crypto = require('crypto');
const net = require('net');
const { PAYMENT_MODES, ORDER_STATUS, USDT_TRC20_CONTRACT } = require('./constants');
const { round, truncate } = require('./utils');

function md5(value, uppercase = false) {
  const result = crypto.createHash('md5').update(String(value), 'utf8').digest('hex');
  return uppercase ? result.toUpperCase() : result;
}

function nonEmptyEntries(data, excluded = []) {
  const ignored = new Set(excluded);
  return Object.entries(data)
    .filter(([key, value]) => !ignored.has(key) && value !== '' && value !== null && value !== undefined && value !== false)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

function signEpay(data, key) {
  const source = nonEmptyEntries(data, ['sign', 'sign_type'])
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  return md5(`${source}${key}`);
}

function signOkpay(data, appId, secret) {
  const values = { ...data, id: appId };
  const source = nonEmptyEntries(values, ['sign', 'token'])
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  return md5(`${source}&token=${secret}`, true);
}

function flattenPhpStyle(value, prefix = '', result = {}) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    for (const [key, item] of Object.entries(value)) {
      const next = prefix ? `${prefix}[${key}]` : key;
      flattenPhpStyle(item, next, result);
    }
    return result;
  }
  result[prefix] = value;
  return result;
}

function normalizeOkpayPayload(payload) {
  const normalized = payload && typeof payload === 'object' ? { ...payload } : {};
  if (typeof normalized.data === 'string') {
    try {
      const parsed = JSON.parse(normalized.data);
      if (parsed && typeof parsed === 'object') normalized.data = parsed;
    } catch {}
  }
  return normalized;
}

function signOkpayCallback(payload, appId, secret) {
  const source = { ...normalizeOkpayPayload(payload), id: appId };
  const pairs = [];
  const append = (value, prefix) => {
    if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
      for (const [key, item] of Object.entries(value)) append(item, `${prefix}[${key}]`);
      return;
    }
    if (value === '' || value === null || value === undefined || value === false) return;
    pairs.push(`${prefix}=${value}`);
  };
  for (const key of Object.keys(source).filter((key) => !['sign', 'token'].includes(key)).sort()) append(source[key], key);
  return md5(`${pairs.join('&')}&token=${secret}`, true);
}

function parseConfig(channel) {
  try {
    return JSON.parse(channel.config_json || '{}');
  } catch {
    return {};
  }
}

function normalizeApiBase(value, fallback) {
  const base = String(value || fallback).trim();
  return `${base.replace(/\/+$/, '')}/`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`接口返回的不是 JSON：${truncate(text, 300)}`);
  }
  if (!response.ok) throw new Error(`接口 HTTP ${response.status}：${truncate(text, 300)}`);
  return data;
}

function callbackBase(settings) {
  const publicUrl = String(settings.public_base_url || '').trim().replace(/\/+$/, '');
  if (publicUrl) return publicUrl;
  const port = Number(settings.web_port || 50000);
  return `http://127.0.0.1:${port}`;
}

function callbackUrl(settings, route) {
  return `${callbackBase(settings)}/${String(route || '').replace(/^\/+/, '')}`;
}

function epayClientIp(settings) {
  try {
    const hostname = new URL(callbackBase(settings)).hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(hostname)) return hostname;
  } catch {}
  // Telegram Bot API 不提供客户 IP。域名部署时使用回环地址满足通用易支付接口的必填格式。
  return '127.0.0.1';
}

function resolveHttpUrl(value, base) {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  try {
    const url = new URL(candidate, base);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function centsEqual(a, b) {
  return Math.abs(Number(a) - Number(b)) < 0.005;
}

function parseUsdtTransfer(tx, targetAddress) {
  if (!tx || String(tx.type || '').trim().toLowerCase() !== 'transfer') return null;
  if (String(tx.token_info?.address || '') !== USDT_TRC20_CONTRACT) return null;
  if (String(tx.to || '') !== String(targetAddress || '')) return null;
  const decimals = Number(tx.token_info?.decimals);
  if (decimals !== 6) return null;
  const amount = Number(tx.value) / 10 ** decimals;
  const transactionId = String(tx.transaction_id || '');
  const blockTimestamp = Number(tx.block_timestamp);
  if (!transactionId || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(blockTimestamp) || blockTimestamp <= 0) return null;
  return { amount, transactionId, blockTimestamp };
}

class PaymentService {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.orderService = null;
    this.tronTimer = null;
    this.providerTimer = null;
    this.expireTimer = null;
    this.tronRunning = false;
    this.providerRunning = false;
  }

  setOrderService(orderService) {
    this.orderService = orderService;
  }

  async createPayment(order, channel, botUsername = '') {
    const config = parseConfig(channel);
    const settings = this.store.getSettings();

    if (channel.mode === PAYMENT_MODES.TRC20) {
      if (!config.address) throw new Error('TRC20 通道未配置收款地址');
      return { mode: channel.mode, address: config.address, amount: order.payable_amount, currency: 'USDT' };
    }

    if (channel.mode === PAYMENT_MODES.OKPAY) {
      if (!config.app_id || !config.secret) throw new Error('OKPay 通道缺少 App ID 或密钥');
      const base = normalizeApiBase(config.api_url, 'https://api.okaypay.me/shop/');
      const data = {
        unique_id: order.order_no,
        name: order.product_name,
        amount: Number(order.payable_amount).toFixed(6),
        return_url: botUsername ? `https://t.me/${botUsername}` : callbackBase(settings),
        callback_url: callbackUrl(settings, `callbacks/okpay/${channel.id}`),
        coin: 'USDT'
      };
      const requestPayLink = async (requestData) => {
        const signed = { ...requestData };
        signed.sign = signOkpay(signed, config.app_id, config.secret);
        signed.id = config.app_id;
        const response = await fetchWithTimeout(`${base}payLink`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: new URLSearchParams(signed)
        });
        return readJsonResponse(response);
      };
      let payload;
      let callbackRejected = false;
      try {
        payload = await requestPayLink(data);
      } catch (error) {
        if (!/callback_url/i.test(String(error?.message || ''))) throw error;
        callbackRejected = true;
      }
      if (!payload || (!((payload.data || payload).pay_url || (payload.data || payload).payLink || (payload.data || payload).url)
        && /callback_url/i.test(JSON.stringify(payload)))) {
        callbackRejected = true;
        const pollingOnlyData = { ...data };
        delete pollingOnlyData.callback_url;
        payload = await requestPayLink(pollingOnlyData);
      }
      if (callbackRejected) {
        this.store.addOrderEvent?.(order.id, 'okpay_callback_rejected', 'OKPay 拒绝单订单回调地址，已自动切换为快速主动查询');
        console.warn(`[支付] OKPay 订单 ${order.order_no} 的 callback_url 被拒绝，已改用主动查询`);
      }
      const result = payload.data || payload;
      const externalOrderId = result.order_id || null;
      const payUrl = result.pay_url || result.payLink || result.url;
      if (!payUrl) throw new Error(`OKPay 未返回支付链接：${truncate(JSON.stringify(payload), 500)}`);
      this.db.prepare('UPDATE orders SET external_order_id = ?, pay_url = ?, updated_at = ? WHERE id = ?')
        .run(externalOrderId, payUrl, this.store.nowIso(), order.id);
      return { mode: channel.mode, payUrl, externalOrderId, amount: order.payable_amount, currency: 'USDT' };
    }

    if (channel.mode === PAYMENT_MODES.EPAY) {
      if (!config.api_url || !config.pid || !config.key || !config.pay_type) {
        throw new Error('易支付通道缺少支付 URL、商户 ID、密钥或通道类型');
      }
      const base = normalizeApiBase(config.api_url, config.api_url);
      const data = {
        pid: config.pid,
        type: config.pay_type,
        out_trade_no: order.order_no,
        notify_url: callbackUrl(settings, `callbacks/epay/${channel.id}`),
        return_url: botUsername ? `https://t.me/${botUsername}` : callbackBase(settings),
        name: order.product_name.slice(0, 60),
        money: Number(order.payable_amount).toFixed(2),
        clientip: epayClientIp(settings),
        device: 'mobile',
        param: order.order_no
      };
      data.sign = signEpay(data, config.key);
      data.sign_type = 'MD5';
      const response = await fetchWithTimeout(`${base}mapi.php`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          accept: 'application/json'
        },
        body: new URLSearchParams(data)
      });
      const payload = await readJsonResponse(response);
      const result = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
      const code = Number(payload.code ?? result.code);
      if (code !== 1) {
        throw new Error(`易支付创建订单失败：${truncate(payload.msg || result.msg || JSON.stringify(payload), 500)}`);
      }

      // mapi.php 正常返回 payurl；部分兼容实现会将 HTTP 二维码链接放在 qrcode 中。
      // 只把支付服务商返回的 HTTP(S) 地址发给客户，绝不回传创建订单时的签名参数。
      const payUrl = resolveHttpUrl(result.payurl || result.pay_url || result.qrcode, base);
      if (!payUrl) {
        throw new Error(`易支付未返回可用的支付链接：${truncate(JSON.stringify(payload), 500)}`);
      }
      const externalOrderId = String(result.trade_no || payload.trade_no || '') || null;
      this.db.prepare('UPDATE orders SET external_order_id = ?, pay_url = ?, updated_at = ? WHERE id = ?')
        .run(externalOrderId, payUrl, this.store.nowIso(), order.id);
      return { mode: channel.mode, payUrl, externalOrderId, amount: order.payable_amount, currency: 'CNY' };
    }

    throw new Error('未知支付通道模式');
  }

  verifyEpayCallback(query, channel) {
    const config = parseConfig(channel);
    if (String(query.pid || '') !== String(config.pid || '')) return null;
    if (!query.sign || signEpay(query, config.key) !== String(query.sign).toLowerCase()) return null;
    if (query.trade_status !== 'TRADE_SUCCESS') return null;
    return {
      orderNo: String(query.out_trade_no || ''),
      amount: Number(query.money),
      transactionId: String(query.trade_no || ''),
      raw: query
    };
  }

  verifyOkpayCallback(payload, channel) {
    const config = parseConfig(channel);
    const normalized = normalizeOkpayPayload(payload);
    const flattened = flattenPhpStyle(normalized);
    if (String(flattened.id || '') !== String(config.app_id || '')) return null;
    const given = String(flattened.sign || '').toUpperCase();
    if (!given || signOkpayCallback(normalized, config.app_id, config.secret) !== given) return null;
    if (flattened.status && String(flattened.status).toLowerCase() !== 'success') return null;
    if (flattened.code && !['200', '10000'].includes(String(flattened.code))) return null;
    const status = flattened['data[status]'];
    const type = flattened['data[type]'];
    const coin = flattened['data[coin]'];
    if (String(status) !== '1' || (type && type !== 'deposit') || (coin && String(coin).toUpperCase() !== 'USDT')) return null;
    return {
      orderNo: String(flattened['data[unique_id]'] || ''),
      amount: Number(flattened['data[amount]']),
      transactionId: String(flattened['data[order_id]'] || ''),
      raw: flattened
    };
  }

  validateCallbackOrder(payment, channel, currency) {
    if (!payment || !payment.orderNo) return null;
    const order = this.db.prepare('SELECT * FROM orders WHERE order_no = ? AND payment_channel_id = ?').get(payment.orderNo, channel.id);
    if (!order || order.status !== ORDER_STATUS.PENDING_PAYMENT || order.payment_status !== 'unpaid') return null;
    if (new Date(order.expires_at).getTime() <= Date.now()) return null;
    const amountMatches = currency === 'CNY'
      ? centsEqual(payment.amount, order.payable_amount)
      : Math.abs(Number(payment.amount) - Number(order.payable_amount)) < 0.000001;
    if (order.payable_currency !== currency || !amountMatches) return null;
    return order;
  }

  start() {
    this.stop();
    this.expireTimer = setInterval(() => this.expireOrders(), 15_000);
    this.tronTimer = setInterval(() => this.pollTron().catch((error) => console.error('[支付] TRC20 轮询失败:', error.message)), 20_000);
    this.providerTimer = setInterval(() => this.pollProviders().catch((error) => console.error('[支付] 通道轮询失败:', error.message)), 5_000);
    this.expireOrders();
    setTimeout(() => this.pollTron().catch(() => {}), 2_000);
    setTimeout(() => this.pollProviders().catch(() => {}), 1_500);
  }

  stop() {
    for (const timer of [this.tronTimer, this.providerTimer, this.expireTimer]) {
      if (timer) clearInterval(timer);
    }
    this.tronTimer = null;
    this.providerTimer = null;
    this.expireTimer = null;
  }

  expireOrders() {
    const stamp = this.store.nowIso();
    const rows = this.db.prepare(`
      SELECT id FROM orders WHERE status = ? AND payment_status = 'unpaid' AND expires_at <= ?
    `).all(ORDER_STATUS.PENDING_PAYMENT, stamp);
    const update = this.db.prepare(`UPDATE orders SET status = ?, failure_reason = '订单支付超时', updated_at = ? WHERE id = ? AND status = ?`);
    this.db.transaction(() => {
      for (const row of rows) {
        const result = update.run(ORDER_STATUS.EXPIRED, stamp, row.id, ORDER_STATUS.PENDING_PAYMENT);
        if (result.changes) this.store.addOrderEvent(row.id, 'expired', '订单超过支付有效期');
      }
    })();
  }

  async pollTron() {
    if (this.tronRunning || !this.orderService) return;
    this.tronRunning = true;
    try {
      const channels = this.db.prepare(`SELECT * FROM payment_channels WHERE enabled = 1 AND mode = ?`).all(PAYMENT_MODES.TRC20);
      const pendingOrders = this.db.prepare(`
        SELECT * FROM orders
        WHERE payment_mode = ? AND status = ? AND payment_status = 'unpaid' AND expires_at > ?
        ORDER BY created_at ASC
      `).all(PAYMENT_MODES.TRC20, ORDER_STATUS.PENDING_PAYMENT, this.store.nowIso()).map((order) => {
        let config = {};
        try { config = JSON.parse(order.payment_config_json || '{}'); } catch {}
        return { ...order, trcAddress: String(config.address || ''), trongridKey: String(config.trongrid_key || '') };
      });

      const targets = new Map();
      const addTarget = (address, channelId, apiKey) => {
        const normalized = String(address || '').trim();
        if (!normalized) return;
        const current = targets.get(normalized) || { address: normalized, channelId: channelId || null, apiKey: '' };
        if (!current.channelId && channelId) current.channelId = channelId;
        if (!current.apiKey && apiKey) current.apiKey = String(apiKey);
        targets.set(normalized, current);
      };
      for (const channel of channels) {
        const config = parseConfig(channel);
        addTarget(config.address, channel.id, config.trongrid_key);
      }
      for (const order of pendingOrders) addTarget(order.trcAddress, order.payment_channel_id, order.trongridKey);

      for (const target of targets.values()) {
        const addressOrders = pendingOrders.filter((order) => order.trcAddress === target.address && order.payment_status === 'unpaid');
        if (!addressOrders.length) continue;
        const oldest = addressOrders[0].created_at;
        const start = Math.max(0, new Date(oldest).getTime() - 5 * 60 * 1000);
        const url = new URL(`https://api.trongrid.io/v1/accounts/${encodeURIComponent(target.address)}/transactions/trc20`);
        url.searchParams.set('only_confirmed', 'true');
        url.searchParams.set('limit', '200');
        url.searchParams.set('contract_address', USDT_TRC20_CONTRACT);
        url.searchParams.set('min_timestamp', String(start));
        url.searchParams.set('order_by', 'block_timestamp,desc');
        const headers = {};
        if (target.apiKey) headers['TRON-PRO-API-KEY'] = target.apiKey;
        const response = await fetchWithTimeout(url, { headers }, 15_000);
        const payload = await readJsonResponse(response);
        for (const tx of payload.data || []) {
          const transfer = parseUsdtTransfer(tx, target.address);
          if (!transfer) continue;
          const { amount, transactionId: txId, blockTimestamp } = transfer;
          const recorded = this.db.prepare('SELECT order_id FROM trc20_transfers WHERE transaction_id = ?').get(txId);
          if (recorded?.order_id) continue;

          const order = addressOrders.find((item) => item.payment_status === 'unpaid'
            && Math.abs(Number(item.payable_amount) - amount) < 0.0000001
            && blockTimestamp >= new Date(item.created_at).getTime()
            && blockTimestamp <= new Date(item.expires_at).getTime());
          const channelId = order?.payment_channel_id || target.channelId || null;
          if (recorded) {
            this.db.prepare(`UPDATE trc20_transfers SET channel_id = ?, order_id = ? WHERE transaction_id = ?`)
              .run(channelId, order?.id || null, txId);
          } else {
            this.db.prepare(`
              INSERT INTO trc20_transfers
                (transaction_id, channel_id, from_address, to_address, amount_usdt, block_timestamp, order_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(txId, channelId, tx.from || '', tx.to, amount, Number(tx.block_timestamp || 0), order?.id || null, this.store.nowIso());
          }

          if (order) {
            await this.orderService.markPaid(order.id, txId, { source: 'trongrid', transaction: tx });
            order.payment_status = 'paid';
          }
        }
      }
    } finally {
      this.tronRunning = false;
    }
  }

  async pollProviders() {
    if (this.providerRunning || !this.orderService) return;
    this.providerRunning = true;
    try {
      const orders = this.db.prepare(`
        SELECT o.*, c.config_json FROM orders o
        JOIN payment_channels c ON c.id = o.payment_channel_id
        WHERE o.status = ? AND o.payment_status = 'unpaid' AND o.expires_at > ?
          AND o.payment_mode IN (?, ?)
        ORDER BY o.created_at ASC LIMIT 100
      `).all(ORDER_STATUS.PENDING_PAYMENT, this.store.nowIso(), PAYMENT_MODES.OKPAY, PAYMENT_MODES.EPAY);

      for (const order of orders) {
        try {
          const config = JSON.parse(order.config_json || '{}');
          if (order.payment_mode === PAYMENT_MODES.OKPAY) {
            const base = normalizeApiBase(config.api_url, 'https://api.okaypay.me/shop/');
            const data = { unique_id: order.order_no };
            data.sign = signOkpay(data, config.app_id, config.secret);
            data.id = config.app_id;
            const response = await fetchWithTimeout(`${base}checkDeposit`, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
              body: new URLSearchParams(data)
            });
            const payload = await readJsonResponse(response);
            const result = payload.data || payload;
            if (String(result.status) === '1' && Math.abs(Number(result.amount) - Number(order.payable_amount)) < 0.000001) {
              await this.orderService.markPaid(order.id, String(result.order_id || ''), { source: 'okpay_poll', response: payload });
            }
          } else if (order.payment_mode === PAYMENT_MODES.EPAY) {
            const base = normalizeApiBase(config.api_url, config.api_url);
            const url = new URL(`${base}api.php`);
            url.searchParams.set('act', 'order');
            url.searchParams.set('pid', config.pid);
            url.searchParams.set('key', config.key);
            url.searchParams.set('out_trade_no', order.order_no);
            const response = await fetchWithTimeout(url, {}, 15_000);
            const payload = await readJsonResponse(response);
            if (Number(payload.status) === 1 && centsEqual(payload.money, order.payable_amount)) {
              await this.orderService.markPaid(order.id, String(payload.trade_no || ''), { source: 'epay_poll', response: payload });
            }
          }
        } catch (error) {
          console.error(`[支付] 查询订单 ${order.order_no} 失败:`, error.message);
        }
      }
    } finally {
      this.providerRunning = false;
    }
  }
}

module.exports = {
  PaymentService,
  callbackBase,
  callbackUrl,
  centsEqual,
  epayClientIp,
  fetchWithTimeout,
  flattenPhpStyle,
  normalizeOkpayPayload,
  parseConfig,
  parseUsdtTransfer,
  resolveHttpUrl,
  signEpay,
  signOkpay,
  signOkpayCallback
};
