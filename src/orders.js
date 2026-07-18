'use strict';

const crypto = require('crypto');
const { ORDER_STATUS, PAYMENT_MODES, STATUS_LABELS } = require('./constants');
const { fetchWithTimeout, parseConfig } = require('./payments');
const { httpError, round, truncate, escapeHtml, formatDate } = require('./utils');

function generateOrderNo() {
  const time = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `SS${time}${crypto.randomInt(100000, 1000000)}`;
}

function parseOptions(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function replaceApiVariables(template, order) {
  const values = { num: order.quantity, ...parseOptions(order.options_json) };
  return String(template || '').replace(/\[([A-Za-z0-9_]+)]/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return match;
    return encodeURIComponent(String(values[key]));
  });
}

class OrderService {
  constructor(store, paymentService) {
    this.store = store;
    this.db = store.db;
    this.paymentService = paymentService;
    this.bot = null;
    this.fulfillmentLocks = new Set();
  }

  setBot(bot) {
    this.bot = bot;
  }

  validateProductOptions(productId, provided) {
    const definitions = this.db.prepare(`
      SELECT * FROM product_options WHERE product_id = ? ORDER BY sort_order, id
    `).all(productId);
    const input = parseOptions(provided);
    const result = {};
    for (const definition of definitions) {
      const value = String(input[definition.field_key] ?? '').trim();
      if (!value) throw httpError(400, `请填写或选择“${definition.name}”`);
      if (value.length > 500) throw httpError(400, `“${definition.name}”内容过长`);
      if (definition.option_type === 'choice') {
        let choices = [];
        try { choices = JSON.parse(definition.choices_json || '[]'); } catch {}
        if (!choices.includes(value)) throw httpError(400, `“${definition.name}”选项无效`);
      }
      result[definition.field_key] = value;
    }
    return result;
  }

  uniqueTrcAmount(baseAmount) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const candidate = round(baseAmount + crypto.randomInt(1, 100) / 1000, 6);
      const exists = this.db.prepare(`
        SELECT 1 FROM orders WHERE payment_mode = ? AND status = ?
          AND payment_status = 'unpaid' AND expires_at > ? AND ABS(payable_amount - ?) < 0.0000001
      `).get(PAYMENT_MODES.TRC20, ORDER_STATUS.PENDING_PAYMENT, this.store.nowIso(), candidate);
      if (!exists) return candidate;
    }
    throw httpError(503, '当前支付订单较多，请稍后重试');
  }

  async createOrder({ user, productId, quantity, options, channelId, botUsername = '' }) {
    const settings = this.store.getSettings();
    const stamp = this.store.nowIso();
    const expiresAt = new Date(Date.now() + Number(settings.order_timeout_min || 30) * 60 * 1000).toISOString();
    const tx = this.db.transaction(() => {
      const product = this.db.prepare(`
        SELECT p.*, c.enabled AS category_enabled FROM products p
        JOIN categories c ON c.id = p.category_id WHERE p.id = ?
      `).get(productId);
      if (!product || !product.enabled || !product.category_enabled) throw httpError(404, '商品已下架或不存在');
      const qty = Number(quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > product.max_quantity) {
        throw httpError(400, `购买数量应为 1–${product.max_quantity}`);
      }
      if (product.product_type === 'card') {
        const stock = this.db.prepare('SELECT COUNT(*) AS count FROM cards WHERE product_id = ? AND is_used = 0').get(product.id).count;
        if (stock < qty) throw httpError(409, `库存不足，当前可购买 ${stock} 件`);
      }

      const channel = this.db.prepare('SELECT * FROM payment_channels WHERE id = ? AND enabled = 1').get(channelId);
      if (!channel) throw httpError(404, '支付通道不可用');
      const amountUsdt = round(Number(product.price_usdt) * qty, 6);
      if (channel.max_amount_usdt > 0 && amountUsdt > channel.max_amount_usdt) {
        throw httpError(400, `该通道单笔上限为 ${channel.max_amount_usdt} USDT`);
      }
      const checkedOptions = this.validateProductOptions(product.id, options);
      let payableAmount = amountUsdt;
      let currency = 'USDT';
      if (channel.mode === PAYMENT_MODES.TRC20) payableAmount = this.uniqueTrcAmount(amountUsdt);
      if (channel.mode === PAYMENT_MODES.OKPAY) payableAmount = round(amountUsdt, 6);
      if (channel.mode === PAYMENT_MODES.EPAY) {
        payableAmount = round(amountUsdt * Number(settings.usdt_cny_rate || 7), 2);
        currency = 'CNY';
      }

      let orderNo;
      do { orderNo = generateOrderNo(); } while (this.db.prepare('SELECT 1 FROM orders WHERE order_no = ?').get(orderNo));
      const configSnapshot = JSON.stringify(parseConfig(channel));
      const result = this.db.prepare(`
        INSERT INTO orders (
          order_no, tg_user_id, tg_username, tg_display_name, product_id, product_name,
          product_description, product_type, unit_price_usdt, quantity, amount_usdt,
          payable_amount, payable_currency, options_json, payment_channel_id,
          payment_channel_name, payment_mode, payment_config_json, status,
          payment_status, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?, ?, ?)
      `).run(
        orderNo, String(user.id), user.username || null,
        [user.first_name, user.last_name].filter(Boolean).join(' '), product.id, product.name,
        product.description, product.product_type, product.price_usdt, qty, amountUsdt,
        payableAmount, currency, JSON.stringify(checkedOptions), channel.id, channel.name,
        channel.mode, configSnapshot, ORDER_STATUS.PENDING_PAYMENT, expiresAt, stamp, stamp
      );
      this.store.addOrderEvent(result.lastInsertRowid, 'created', `选择支付通道：${channel.name}`);
      return { order: this.db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid), channel, product };
    });

    const created = tx();
    try {
      const payment = await this.paymentService.createPayment(created.order, created.channel, botUsername);
      const order = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(created.order.id);
      await this.notifyAdminNewOrder(order);
      return { order, payment, product: created.product };
    } catch (error) {
      this.db.prepare(`UPDATE orders SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?`)
        .run(ORDER_STATUS.CANCELLED, `创建支付失败：${truncate(error.message, 500)}`, this.store.nowIso(), created.order.id);
      this.store.addOrderEvent(created.order.id, 'payment_create_failed', error.message);
      throw error;
    }
  }

  async markPaid(orderId, transactionId, metadata = {}) {
    const claim = this.db.transaction(() => {
      const order = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      if (!order || order.status !== ORDER_STATUS.PENDING_PAYMENT || order.payment_status !== 'unpaid') return null;
      if (new Date(order.expires_at).getTime() <= Date.now()) return null;
      const stamp = this.store.nowIso();
      const updated = this.db.prepare(`
        UPDATE orders SET status = ?, payment_status = 'paid', transaction_id = ?, paid_at = ?, updated_at = ?
        WHERE id = ? AND status = ? AND payment_status = 'unpaid'
      `).run(ORDER_STATUS.PROCESSING, transactionId || null, stamp, stamp, order.id, ORDER_STATUS.PENDING_PAYMENT);
      if (!updated.changes) return null;
      this.store.addOrderEvent(order.id, 'paid', truncate(JSON.stringify(metadata), 2000));
      return this.db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    })();
    if (!claim) return false;
    await this.fulfillOrder(claim.id, { source: 'payment' });
    return true;
  }

  async fulfillOrder(orderId, context = {}) {
    if (this.fulfillmentLocks.has(Number(orderId))) return this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    this.fulfillmentLocks.add(Number(orderId));
    try {
      let order = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      if (!order || order.payment_status !== 'paid') throw httpError(400, '订单尚未付款');
      if (![ORDER_STATUS.PROCESSING, ORDER_STATUS.PENDING_MANUAL].includes(order.status)) return order;
      if (order.status === ORDER_STATUS.PENDING_MANUAL) {
        this.db.prepare('UPDATE orders SET status = ?, failure_reason = NULL, updated_at = ? WHERE id = ?')
          .run(ORDER_STATUS.PROCESSING, this.store.nowIso(), order.id);
        this.store.addOrderEvent(order.id, 'retry', context.source || 'manual_retry');
        order = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
      }

      if (order.product_type === 'card') await this.fulfillCards(order);
      else await this.fulfillApi(order);

      order = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
      await this.notifyCustomerFulfillment(order);
      await this.notifyAdminPaid(order);
      return order;
    } finally {
      this.fulfillmentLocks.delete(Number(orderId));
    }
  }

  async fulfillCards(order) {
    const result = this.db.transaction(() => {
      const cards = this.db.prepare(`
        SELECT * FROM cards WHERE product_id = ? AND is_used = 0 ORDER BY id LIMIT ?
      `).all(order.product_id, order.quantity);
      if (cards.length < order.quantity) {
        const reason = `付款成功但库存不足：需要 ${order.quantity}，可用 ${cards.length}`;
        this.db.prepare('UPDATE orders SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?')
          .run(ORDER_STATUS.PENDING_MANUAL, reason, this.store.nowIso(), order.id);
        this.store.addOrderEvent(order.id, 'fulfillment_pending', reason);
        return { success: false, reason };
      }
      const stamp = this.store.nowIso();
      const use = this.db.prepare('UPDATE cards SET is_used = 1, order_id = ?, used_at = ?, updated_at = ? WHERE id = ? AND is_used = 0');
      for (const card of cards) {
        const changed = use.run(order.id, stamp, stamp, card.id);
        if (!changed.changes) throw new Error('库存被并发占用');
      }
      const delivery = cards.map((card) => card.content).join('\n');
      this.db.prepare(`
        UPDATE orders SET status = ?, delivery_result = ?, completed_at = ?, failure_reason = NULL, updated_at = ? WHERE id = ?
      `).run(ORDER_STATUS.COMPLETED, delivery, stamp, stamp, order.id);
      this.store.addOrderEvent(order.id, 'fulfilled', `自动发卡 ${cards.length} 条`);
      return { success: true, delivery };
    });
    return result();
  }

  async fulfillApi(order) {
    const product = this.db.prepare('SELECT api_url, api_success_marker FROM products WHERE id = ?').get(order.product_id);
    if (!product?.api_url) {
      const reason = '商品 API 未配置';
      this.db.prepare('UPDATE orders SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?')
        .run(ORDER_STATUS.PENDING_MANUAL, reason, this.store.nowIso(), order.id);
      this.store.addOrderEvent(order.id, 'fulfillment_pending', reason);
      return;
    }
    const url = replaceApiVariables(product.api_url, order);
    let parsed;
    try {
      parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('协议无效');
    } catch {
      const reason = '商品 API URL 无效';
      this.db.prepare('UPDATE orders SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?')
        .run(ORDER_STATUS.PENDING_MANUAL, reason, this.store.nowIso(), order.id);
      this.store.addOrderEvent(order.id, 'fulfillment_pending', reason);
      return;
    }

    try {
      const response = await fetchWithTimeout(parsed, { method: 'GET', redirect: 'follow' }, 20_000);
      const body = truncate(await response.text(), 20000);
      const success = product.api_success_marker ? body.includes(product.api_success_marker) : true;
      const stamp = this.store.nowIso();
      if (success) {
        this.db.prepare(`
          UPDATE orders SET status = ?, api_response = ?, delivery_result = ?, completed_at = ?, failure_reason = NULL, updated_at = ? WHERE id = ?
        `).run(ORDER_STATUS.COMPLETED, body, body, stamp, stamp, order.id);
        this.store.addOrderEvent(order.id, 'fulfilled', `API 响应 HTTP ${response.status}`);
      } else {
        const reason = `API 响应未包含成功标志（HTTP ${response.status}）`;
        this.db.prepare('UPDATE orders SET status = ?, api_response = ?, failure_reason = ?, updated_at = ? WHERE id = ?')
          .run(ORDER_STATUS.PENDING_MANUAL, body, reason, stamp, order.id);
        this.store.addOrderEvent(order.id, 'fulfillment_pending', reason);
      }
    } catch (error) {
      const reason = `API 请求失败：${truncate(error.message, 500)}`;
      this.db.prepare('UPDATE orders SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?')
        .run(ORDER_STATUS.PENDING_MANUAL, reason, this.store.nowIso(), order.id);
      this.store.addOrderEvent(order.id, 'fulfillment_pending', reason);
    }
  }

  async manualFulfill(orderId, options = {}, legacyForcePaid = false) {
    if (!options || typeof options !== 'object') options = { mode: 'custom', content: options, forcePaid: legacyForcePaid };
    const mode = String(options.mode || 'default');
    const text = String(options.content || '').trim();
    const forcePaid = Boolean(options.forcePaid);
    if (!['custom', 'default'].includes(mode)) throw httpError(400, '补单方式无效');
    if (mode === 'custom' && !text) throw httpError(400, '请填写自定义发货内容');
    const order = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) throw httpError(404, '订单不存在');
    if (order.status === ORDER_STATUS.COMPLETED) throw httpError(409, '订单已经完成');
    if (order.payment_status !== 'paid' && !forcePaid) throw httpError(400, '订单尚未付款；如需强制补单，请勾选“同时标记已付款”');
    const stamp = this.store.nowIso();
    if (mode === 'default') {
      this.db.prepare(`
        UPDATE orders SET status = ?, payment_status = CASE WHEN ? THEN 'paid' ELSE payment_status END,
          paid_at = CASE WHEN ? AND paid_at IS NULL THEN ? ELSE paid_at END,
          failure_reason = NULL, updated_at = ? WHERE id = ?
      `).run(ORDER_STATUS.PROCESSING, forcePaid ? 1 : 0, forcePaid ? 1 : 0, stamp, stamp, order.id);
      this.store.addOrderEvent(order.id, 'manual_default_fulfill', forcePaid ? '管理员强制标记付款并执行默认发货流程' : '管理员执行默认发货流程');
      return this.fulfillOrder(order.id, { source: 'admin_default_fulfill' });
    }
    this.db.prepare(`
      UPDATE orders SET status = ?, payment_status = CASE WHEN ? THEN 'paid' ELSE payment_status END,
        paid_at = CASE WHEN ? AND paid_at IS NULL THEN ? ELSE paid_at END,
        delivery_result = ?, completed_at = ?, failure_reason = NULL, updated_at = ? WHERE id = ?
    `).run(ORDER_STATUS.COMPLETED, forcePaid ? 1 : 0, forcePaid ? 1 : 0, stamp, text, stamp, stamp, order.id);
    this.store.addOrderEvent(order.id, 'manual_fulfill', forcePaid ? '管理员强制标记付款并补单' : '管理员手动补单');
    const updated = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    await this.notifyCustomerFulfillment(updated);
    await this.notifyAdminPaid(updated);
    return updated;
  }

  async notifyAdminNewOrder(order) {
    if (!this.bot?.isReady()) return;
    const adminId = this.store.getSettings().telegram_admin_id;
    if (!adminId) return;
    const text = [
      '🛒 <b>收到新订单</b>',
      `订单号：<code>${escapeHtml(order.order_no)}</code>`,
      `商品：${escapeHtml(order.product_name)} × ${order.quantity}`,
      `金额：${Number(order.amount_usdt).toFixed(2)} USDT`,
      `支付：${escapeHtml(order.payment_channel_name)}`,
      `用户：${escapeHtml(order.tg_display_name || '-')}${order.tg_username ? ` (@${escapeHtml(order.tg_username)})` : ''} / <code>${escapeHtml(order.tg_user_id)}</code>`,
      `状态：${STATUS_LABELS[order.status] || order.status}`
    ].join('\n');
    await this.bot.safeSendMessage(adminId, text, { parse_mode: 'HTML' });
  }

  async notifyAdminPaid(order) {
    if (!this.bot?.isReady()) return;
    const adminId = this.store.getSettings().telegram_admin_id;
    if (!adminId) return;
    const detailLabel = order.product_type === 'card' ? '卡密信息' : (order.api_response ? 'API 返回' : '发货内容');
    const detail = order.product_type === 'card' ? order.delivery_result : (order.api_response || order.delivery_result);
    const text = [
      '💳 <b>订单已付款并完成发货处理</b>',
      `订单号：<code>${escapeHtml(order.order_no)}</code>`,
      `商品：${escapeHtml(order.product_name)} × ${order.quantity}`,
      `金额：${Number(order.amount_usdt).toFixed(2)} USDT`,
      `支付方式：${escapeHtml(order.payment_channel_name)}`,
      `购买用户：${escapeHtml(order.tg_display_name || '-')} / <code>${escapeHtml(order.tg_user_id)}</code>`,
      `${detailLabel}：<pre>${escapeHtml(truncate(detail || order.failure_reason || '-', 2500))}</pre>`,
      `最终状态：${STATUS_LABELS[order.status] || order.status}`
    ].join('\n');
    await this.bot.safeSendMessage(adminId, text, { parse_mode: 'HTML' });
  }

  async notifyCustomerFulfillment(order) {
    if (!this.bot?.isReady()) return;
    let text;
    if (order.status === ORDER_STATUS.COMPLETED) {
      const product = order.product_id ? this.db.prepare('SELECT post_purchase_message FROM products WHERE id = ?').get(order.product_id) : null;
      const exposeDelivery = order.product_type === 'card'
        || (order.delivery_result && order.delivery_result !== order.api_response);
      text = [
        '✅ <b>付款成功，订单已完成</b>',
        `订单号：<code>${escapeHtml(order.order_no)}</code>`,
        `商品：${escapeHtml(order.product_name)} × ${order.quantity}`,
        exposeDelivery ? '\n<b>发货内容：</b>' : '\n自动发货成功。',
        exposeDelivery ? `<pre>${escapeHtml(truncate(order.delivery_result || '处理成功', 3000))}</pre>` : '',
        product?.post_purchase_message ? `\n<b>购买提示：</b>\n${escapeHtml(truncate(product.post_purchase_message, 600))}` : ''
      ].filter((line) => line !== '').join('\n');
    } else {
      text = [
        '⚠️ <b>付款成功，但自动发货未完成</b>',
        `订单号：<code>${escapeHtml(order.order_no)}</code>`,
        '原因：自动发货失败，请联系客服，或在历史订单中点击“申请自动重试”。'
      ].join('\n');
    }
    await this.bot.safeSendMessage(order.tg_user_id, text, { parse_mode: 'HTML' });
  }

  orderText(order) {
    const options = parseOptions(order.options_json);
    const optionLines = Object.entries(options).map(([key, value]) => `${key}：${value}`);
    const exposeDelivery = order.product_type === 'card'
      || (order.delivery_result && order.delivery_result !== order.api_response);
    const publicFailure = order.status === ORDER_STATUS.PENDING_MANUAL && order.payment_status === 'paid'
      ? '自动发货失败，请联系客服，或点击“申请自动重试”。'
      : '';
    return [
      '<b>订单详情</b>',
      `订单号：<code>${escapeHtml(order.order_no)}</code>`,
      `商品：${escapeHtml(order.product_name)}`,
      `数量：${order.quantity}`,
      `订单金额：${Number(order.amount_usdt).toFixed(2)} USDT`,
      `支付通道：${escapeHtml(order.payment_channel_name)}`,
      `付款状态：${order.payment_status === 'paid' ? '已付款' : '未付款'}`,
      `订单状态：${STATUS_LABELS[order.status] || order.status}`,
      `下单时间：${formatDate(order.created_at)}`,
      ...optionLines.map(escapeHtml),
      publicFailure ? `处理说明：${publicFailure}` : '',
      order.status === ORDER_STATUS.COMPLETED && exposeDelivery ? `\n<b>发货内容：</b>\n<pre>${escapeHtml(truncate(order.delivery_result, 2500))}</pre>` : '',
      order.status === ORDER_STATUS.COMPLETED && !exposeDelivery ? '\n自动发货成功。' : ''
    ].filter(Boolean).join('\n');
  }
}

module.exports = { OrderService, generateOrderNo, parseOptions, replaceApiVariables };
