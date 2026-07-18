'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { TelegramApi, describeTelegramError } = require('./telegram');
const { ORDER_STATUS, STATUS_LABELS } = require('./constants');
const { escapeHtml, formatDate, sleep, truncate } = require('./utils');

function keyboard(rows) {
  return { inline_keyboard: rows };
}

function callbackButton(text, data) {
  const characters = Array.from(String(text));
  return { text: characters.length > 60 ? `${characters.slice(0, 59).join('')}…` : String(text), callback_data: data };
}

class BotManager {
  constructor(store, orderService) {
    this.store = store;
    this.db = store.db;
    this.orderService = orderService;
    this.api = null;
    this.botInfo = null;
    this.activeToken = '';
    this.generation = 0;
    this.monitorTimer = null;
    this.lastError = '';
    this.startedAt = null;
    this.pollingActive = false;
    this.lastPollAt = null;
    this.lastUpdateAt = null;
  }

  start() {
    this.checkToken();
    this.monitorTimer = setInterval(() => this.checkToken(), 10_000);
  }

  forceReload() {
    const token = String(this.store.getSettings().telegram_bot_token || '').trim();
    if (token && token === this.activeToken && this.api) return false;
    this.activeToken = '__force_reload__';
    this.checkToken();
    return true;
  }

  stop() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    this.generation += 1;
    this.api = null;
    this.botInfo = null;
    this.activeToken = '';
    this.pollingActive = false;
  }

  isReady() {
    return Boolean(this.api && this.botInfo && this.pollingActive);
  }

  status() {
    return {
      ready: this.isReady(),
      username: this.botInfo?.username || '',
      name: this.botInfo?.first_name || '',
      lastError: this.lastError,
      startedAt: this.startedAt,
      pollingActive: this.pollingActive,
      lastPollAt: this.lastPollAt,
      lastUpdateAt: this.lastUpdateAt
    };
  }

  checkToken() {
    const token = String(this.store.getSettings().telegram_bot_token || '').trim();
    if (token === this.activeToken) return;
    this.generation += 1;
    this.activeToken = token;
    this.api = null;
    this.botInfo = null;
    this.pollingActive = false;
    this.lastPollAt = null;
    this.lastError = '';
    if (!token) return;
    const generation = this.generation;
    const api = new TelegramApi(token);
    this.api = api;
    this.initialize(api, generation).catch((error) => {
      if (generation !== this.generation) return;
      this.lastError = describeTelegramError(error);
      this.api = null;
      this.botInfo = null;
      this.pollingActive = false;
      this.activeToken = '';
      console.error('[Bot] 启动失败:', this.lastError);
    });
  }

  async initialize(api, generation) {
    const info = await api.getMe();
    if (generation !== this.generation) return;
    this.botInfo = info;
    this.startedAt = new Date().toISOString();
    console.log(`[Bot] @${info.username} 已启动`);
    // 本系统固定使用 getUpdates 长轮询。清理 webhook 失败时不能伪装为已连接，
    // 否则 Telegram 会拒绝后续 getUpdates，而后台仍会错误显示在线。
    await api.call('deleteWebhook', { drop_pending_updates: false });
    this.poll(api, generation).catch((error) => {
      if (generation === this.generation) {
        this.pollingActive = false;
        this.lastError = describeTelegramError(error);
        console.error('[Bot] 轮询停止:', this.lastError);
      }
    });
  }

  async poll(api, generation) {
    let offset = 0;
    let firstRequest = true;
    while (generation === this.generation && this.api === api) {
      try {
        // 第一次使用零等待请求确认 getUpdates 确实可用，成功后才标记 Bot 在线。
        const updates = await api.getUpdates(offset, firstRequest ? 0 : 25);
        firstRequest = false;
        this.pollingActive = true;
        this.lastPollAt = new Date().toISOString();
        this.lastError = '';
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          this.lastUpdateAt = new Date().toISOString();
          try {
            await this.handleUpdate(update);
          } catch (error) {
            console.error('[Bot] 处理消息失败:', describeTelegramError(error));
          }
        }
      } catch (error) {
        if (generation !== this.generation) break;
        this.pollingActive = false;
        this.lastError = describeTelegramError(error);
        await sleep(2500);
      }
    }
    if (generation === this.generation) this.pollingActive = false;
  }

  async safeSendMessage(chatId, text, options = {}) {
    if (!this.api) return null;
    try {
      return await this.api.sendMessage(chatId, text, options);
    } catch (error) {
      if (options.parse_mode) {
        try {
          const plain = String(text).replace(/<[^>]+>/g, '');
          return await this.api.sendMessage(chatId, plain, { ...options, parse_mode: undefined });
        } catch {}
      }
      console.error(`[Bot] 向 ${chatId} 发送失败:`, describeTelegramError(error));
      return null;
    }
  }

  async sendLocalFile(chatId, localPath, options = {}) {
    if (!this.api) throw new Error('Bot 尚未连接');
    const caption = String(options.caption || '');
    if (caption.length <= 1024) return this.api.sendLocalFile(chatId, localPath, options);
    const sent = await this.api.sendLocalFile(chatId, localPath, { ...options, caption: undefined });
    await this.api.sendMessage(chatId, caption);
    return sent;
  }

  homeMarkup() {
    const sourceUrl = this.store.getSettings().open_source_url || 'https://github.com/sswc01/';
    return keyboard([
      [callbackButton('🛍 开始选购', 'buy'), callbackButton('🧾 历史订单', 'h:0')],
      [callbackButton('💬 联系客服', 'support'), { text: '✨ 同款开源BOT', url: sourceUrl }]
    ]);
  }

  async sendHome(chatId, editMessageId = null) {
    const settings = this.store.getSettings();
    const text = `欢迎来到<b>${escapeHtml(settings.bot_name)}</b>，欢迎选购！`;
    if (editMessageId) {
      try {
        return await this.api.editMessageText(chatId, editMessageId, text, { parse_mode: 'HTML', reply_markup: this.homeMarkup() });
      } catch {}
    }
    return this.safeSendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: this.homeMarkup() });
  }

  async handleUpdate(update) {
    if (update.message) return this.handleMessage(update.message);
    if (update.callback_query) return this.handleCallback(update.callback_query);
  }

  async handleMessage(message) {
    if (!message.from || message.chat?.type !== 'private') return;
    const tgId = this.store.upsertBotUser(message.from);
    const text = message.text || message.caption || '';
    const settings = this.store.getSettings();
    const isAdmin = tgId === String(settings.telegram_admin_id);

    if (message.text === '/start' || message.text?.startsWith('/start ')) {
      this.store.clearSession(tgId);
      if (isAdmin) {
        return this.safeSendMessage(tgId, '欢迎使用盛世王朝的开源shop bot\n请通过后台管理bot');
      }
      return this.sendHome(tgId);
    }
    if (isAdmin) return;

    const session = this.store.getSession(tgId);
    if (session?.state === 'support') {
      if (message.text === '/cancel') return this.closeSupport(message.from);
      return this.recordSupportMessage(message);
    }

    if (message.text === '/cancel') {
      this.store.clearSession(tgId);
      await this.safeSendMessage(tgId, '已取消本次操作。');
      return this.sendHome(tgId);
    }

    if (session?.state === 'await_quantity') return this.receiveQuantity(message, session);
    if (session?.state === 'await_text_option') return this.receiveTextOption(message, session);
    return this.sendHome(tgId);
  }

  async handleCallback(query) {
    const message = query.message;
    if (!message || !query.from) return;
    const tgId = this.store.upsertBotUser(query.from);
    const settings = this.store.getSettings();
    if (tgId === String(settings.telegram_admin_id)) {
      await this.api.answerCallbackQuery(query.id).catch(() => {});
      return;
    }
    const data = query.data || '';
    await this.api.answerCallbackQuery(query.id).catch(() => {});
    if (data === 'home') {
      this.store.clearSession(tgId);
      return this.sendHome(tgId, message.message_id);
    }
    if (data === 'buy') return this.showCategories(tgId, message.message_id);
    if (data.startsWith('c:')) return this.showProducts(tgId, message.message_id, Number(data.slice(2)));
    if (data.startsWith('p:')) return this.showProduct(tgId, message.message_id, Number(data.slice(2)));
    if (data.startsWith('b:')) return this.showProducts(tgId, message.message_id, Number(data.slice(2)));
    if (data.startsWith('q:')) return this.beginQuantity(tgId, Number(data.slice(2)));
    if (data.startsWith('x:')) return this.chooseOption(tgId, Number(data.slice(2)));
    if (data.startsWith('pay:')) return this.choosePayment(query.from, Number(data.slice(4)));
    if (data.startsWith('h:')) return this.showHistory(tgId, message.message_id, Math.max(0, Number(data.slice(2)) || 0));
    if (data.startsWith('o:')) return this.showOrder(tgId, message.message_id, Number(data.slice(2)));
    if (data.startsWith('r:')) return this.retryOrder(tgId, message.message_id, Number(data.slice(2)));
    if (data === 'support') return this.openSupport(query.from);
  }

  async editOrSend(chatId, messageId, text, options = {}) {
    try {
      return await this.api.editMessageText(chatId, messageId, text, options);
    } catch {
      return this.safeSendMessage(chatId, text, options);
    }
  }

  async showCategories(tgId, messageId) {
    this.store.clearSession(tgId);
    const categories = this.db.prepare('SELECT * FROM categories WHERE enabled = 1 ORDER BY sort_order, id').all();
    const rows = categories.map((item) => [callbackButton(item.name, `c:${item.id}`)]);
    rows.push([callbackButton('⬅️ 返回主页', 'home')]);
    const text = categories.length ? '<b>请选择商品分类</b>' : '暂无可购买的商品分类。';
    return this.editOrSend(tgId, messageId, text, { parse_mode: 'HTML', reply_markup: keyboard(rows) });
  }

  async showProducts(tgId, messageId, categoryId) {
    const category = this.db.prepare('SELECT * FROM categories WHERE id = ? AND enabled = 1').get(categoryId);
    if (!category) return this.showCategories(tgId, messageId);
    const products = this.db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM cards s WHERE s.product_id = p.id AND s.is_used = 0) AS stock
      FROM products p WHERE p.category_id = ? AND p.enabled = 1 ORDER BY p.sort_order, p.id LIMIT 80
    `).all(categoryId);
    const rows = products.map((item) => [callbackButton(`${item.name} - ${Number(item.price_usdt).toFixed(2)} USDT`, `p:${item.id}`)]);
    rows.push([callbackButton('⬅️ 返回分类', 'buy')]);
    return this.editOrSend(tgId, messageId, `<b>${escapeHtml(category.name)}</b>\n请选择商品：`, {
      parse_mode: 'HTML', reply_markup: keyboard(rows)
    });
  }

  async showProduct(tgId, messageId, productId) {
    const product = this.db.prepare(`
      SELECT p.*, c.name AS category_name,
        (SELECT COUNT(*) FROM cards s WHERE s.product_id = p.id AND s.is_used = 0) AS stock
      FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.id = ? AND p.enabled = 1 AND c.enabled = 1
    `).get(productId);
    if (!product) return this.showCategories(tgId, messageId);
    const stock = product.product_type === 'card' ? `\n库存：${product.stock}` : '';
    const description = truncate(product.description || '暂无介绍', 3200);
    const text = `*${product.name}*\n\n${description}\n\n价格：${Number(product.price_usdt).toFixed(2)} USDT\n单次限购：${product.max_quantity}${stock}`;
    const markup = keyboard([[callbackButton('✅ 确认购买', `q:${product.id}`), callbackButton('⬅️ 返回上一页', `b:${product.category_id}`)]]);
    try {
      return await this.api.editMessageText(tgId, messageId, text, { parse_mode: 'Markdown', reply_markup: markup });
    } catch {
      return this.editOrSend(tgId, messageId, `${product.name}\n\n${description}\n\n价格：${Number(product.price_usdt).toFixed(2)} USDT\n单次限购：${product.max_quantity}${stock}`, { reply_markup: markup });
    }
  }

  async beginQuantity(tgId, productId) {
    const product = this.db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM cards c WHERE c.product_id = p.id AND c.is_used = 0) AS stock
      FROM products p WHERE p.id = ? AND p.enabled = 1
    `).get(productId);
    if (!product) return this.safeSendMessage(tgId, '商品已下架，请重新选择。');
    if (product.product_type === 'card' && product.stock < 1) return this.safeSendMessage(tgId, '该商品暂时无库存，无法下单。');
    this.store.setSession(tgId, 'await_quantity', { productId: product.id });
    const max = product.product_type === 'card' ? Math.min(product.max_quantity, product.stock) : product.max_quantity;
    return this.safeSendMessage(tgId, `请输入购买数量（1–${max}）。\n发送 /cancel 取消本次订购。`);
  }

  async receiveQuantity(message, session) {
    const tgId = String(message.from.id);
    if (!message.text || !/^\d+$/.test(message.text.trim())) return this.safeSendMessage(tgId, '请输入有效的整数购买数量。');
    const product = this.db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM cards c WHERE c.product_id = p.id AND c.is_used = 0) AS stock
      FROM products p WHERE p.id = ? AND p.enabled = 1
    `).get(session.data.productId);
    if (!product) {
      this.store.clearSession(tgId);
      return this.safeSendMessage(tgId, '商品已下架，本次订购已取消。');
    }
    const quantity = Number(message.text.trim());
    const max = product.product_type === 'card' ? Math.min(product.max_quantity, product.stock) : product.max_quantity;
    if (quantity < 1 || quantity > max) return this.safeSendMessage(tgId, `购买数量应为 1–${max}。`);
    const data = { productId: product.id, quantity, options: {}, optionIndex: 0 };
    this.store.setSession(tgId, 'collect_options', data);
    return this.advanceOptions(tgId, data);
  }

  optionDefinitions(productId) {
    return this.db.prepare('SELECT * FROM product_options WHERE product_id = ? ORDER BY sort_order, id').all(productId);
  }

  async advanceOptions(tgId, data) {
    const definitions = this.optionDefinitions(data.productId);
    if (data.optionIndex >= definitions.length) {
      this.store.setSession(tgId, 'checkout', data);
      return this.showPaymentChannels(tgId, data);
    }
    const option = definitions[data.optionIndex];
    if (option.option_type === 'choice') {
      let choices = [];
      try { choices = JSON.parse(option.choices_json || '[]'); } catch {}
      const rows = choices.map((value, index) => [callbackButton(value, `x:${index}`)]);
      rows.push([callbackButton('取消订购', 'home')]);
      this.store.setSession(tgId, 'await_choice_option', data);
      return this.safeSendMessage(tgId, `请选择“${option.name}”：`, { reply_markup: keyboard(rows) });
    }
    this.store.setSession(tgId, 'await_text_option', data);
    return this.safeSendMessage(tgId, `请输入“${option.name}”：\n发送 /cancel 取消本次订购。`);
  }

  async chooseOption(tgId, choiceIndex) {
    const session = this.store.getSession(tgId);
    if (!session || session.state !== 'await_choice_option') return this.safeSendMessage(tgId, '订购状态已失效，请重新开始。');
    const definitions = this.optionDefinitions(session.data.productId);
    const option = definitions[session.data.optionIndex];
    if (!option || option.option_type !== 'choice') return this.safeSendMessage(tgId, '选项已变更，请重新下单。');
    let choices = [];
    try { choices = JSON.parse(option.choices_json || '[]'); } catch {}
    if (!choices[choiceIndex]) return this.safeSendMessage(tgId, '选项无效，请重新选择。');
    session.data.options[option.field_key] = choices[choiceIndex];
    session.data.optionIndex += 1;
    return this.advanceOptions(tgId, session.data);
  }

  async receiveTextOption(message, session) {
    const tgId = String(message.from.id);
    if (!message.text?.trim()) return this.safeSendMessage(tgId, '请输入文本内容。');
    if (message.text.trim().length > 500) return this.safeSendMessage(tgId, '输入内容不能超过 500 个字符。');
    const definitions = this.optionDefinitions(session.data.productId);
    const option = definitions[session.data.optionIndex];
    if (!option || option.option_type !== 'text') return this.safeSendMessage(tgId, '选项已变更，请重新下单。');
    session.data.options[option.field_key] = message.text.trim();
    session.data.optionIndex += 1;
    return this.advanceOptions(tgId, session.data);
  }

  async showPaymentChannels(tgId, data) {
    const product = this.db.prepare('SELECT * FROM products WHERE id = ? AND enabled = 1').get(data.productId);
    if (!product) return this.safeSendMessage(tgId, '商品已下架，请重新选择。');
    const total = Number(product.price_usdt) * data.quantity;
    const channels = this.db.prepare(`
      SELECT * FROM payment_channels WHERE enabled = 1 AND (max_amount_usdt = 0 OR max_amount_usdt >= ?)
      ORDER BY id
    `).all(total);
    const rows = channels.map((item) => [callbackButton(item.name, `pay:${item.id}`)]);
    rows.push([callbackButton('取消订购', 'home')]);
    const text = [
      '<b>请选择支付通道</b>',
      `商品：${escapeHtml(product.name)}`,
      `数量：${data.quantity}`,
      `订单价格：${total.toFixed(2)} USDT`,
      channels.length ? '' : '\n暂无可用支付通道，请联系客服。'
    ].filter(Boolean).join('\n');
    return this.safeSendMessage(tgId, text, { parse_mode: 'HTML', reply_markup: keyboard(rows) });
  }

  async choosePayment(user, channelId) {
    const tgId = String(user.id);
    const session = this.store.getSession(tgId);
    if (!session || session.state !== 'checkout') return this.safeSendMessage(tgId, '订单信息已失效，请重新开始选购。');
    this.store.setSession(tgId, 'placing_order', session.data);
    try {
      const result = await this.orderService.createOrder({
        user,
        productId: session.data.productId,
        quantity: session.data.quantity,
        options: session.data.options,
        channelId,
        botUsername: this.botInfo?.username || ''
      });
      this.store.clearSession(tgId);
      return this.sendPaymentInstructions(tgId, result.order, result.payment);
    } catch (error) {
      this.store.setSession(tgId, 'checkout', session.data);
      const publicReason = Number(error.status) >= 400 && Number(error.status) < 500
        ? truncate(error.message, 300)
        : '支付订单创建失败，请稍后重试或联系客服。';
      await this.safeSendMessage(tgId, publicReason);
      return this.showPaymentChannels(tgId, session.data);
    }
  }

  async sendPaymentInstructions(tgId, order, payment) {
    const expires = formatDate(order.expires_at);
    if (payment.mode === 'trc20_usdt') {
      const qr = await QRCode.toBuffer(payment.address, { width: 560, margin: 2, errorCorrectionLevel: 'M' });
      const trcAmount = Number(payment.amount).toFixed(6).replace(/\.?0+$/, '');
      const caption = [
        '💵 <b>请使用 TRC20-USDT 完成付款</b>',
        `订单号：<code>${escapeHtml(order.order_no)}</code>`,
        `收款地址：<code>${escapeHtml(payment.address)}</code>`,
        `应付金额：<code>${trcAmount} USDT</code>`,
        `有效期至：${expires}`,
        '',
        '请务必按完整金额转账；系统每 20 秒确认一次到账，仅识别 TRON 主网官方 USDT 合约。'
      ].join('\n');
      try {
        return await this.api.sendPhotoBuffer(tgId, qr, {
          caption,
          parse_mode: 'HTML',
          filename: `${order.order_no}.png`,
          reply_markup: keyboard([[callbackButton('查看订单', `o:${order.id}`)], [callbackButton('返回主页', 'home')]])
        });
      } catch {
        return this.safeSendMessage(tgId, caption, { parse_mode: 'HTML', reply_markup: keyboard([[callbackButton('查看订单', `o:${order.id}`)]]) });
      }
    }
    const currency = payment.currency === 'CNY' ? 'CNY' : 'USDT';
    const shownAmount = currency === 'CNY'
      ? Number(payment.amount).toFixed(2)
      : Number(payment.amount).toFixed(6).replace(/\.?0+$/, '');
    return this.safeSendMessage(tgId, [
      '💳 <b>订单已创建，请完成付款</b>',
      `订单号：<code>${escapeHtml(order.order_no)}</code>`,
      `商品：${escapeHtml(order.product_name)} × ${order.quantity}`,
      `应付金额：${shownAmount} ${currency}`,
      `有效期至：${expires}`
    ].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: keyboard([[{ text: '立即支付', url: payment.payUrl }], [callbackButton('查看订单', `o:${order.id}`), callbackButton('返回主页', 'home')]])
    });
  }

  async showHistory(tgId, messageId, page) {
    const total = this.db.prepare('SELECT COUNT(*) AS count FROM orders WHERE tg_user_id = ?').get(tgId).count;
    const orders = this.db.prepare(`
      SELECT * FROM orders WHERE tg_user_id = ? ORDER BY created_at DESC LIMIT 10 OFFSET ?
    `).all(tgId, page * 10);
    const rows = orders.map((order) => [callbackButton(`${order.product_name}-${STATUS_LABELS[order.status] || order.status}-${formatDate(order.created_at)}`, `o:${order.id}`)]);
    const nav = [];
    if (page > 0) nav.push(callbackButton('⬅️ 上一页', `h:${page - 1}`));
    if ((page + 1) * 10 < total) nav.push(callbackButton('下一页 ➡️', `h:${page + 1}`));
    if (nav.length) rows.push(nav);
    rows.push([callbackButton('返回主页', 'home')]);
    return this.editOrSend(tgId, messageId, '<b>您的购买记录</b>', { parse_mode: 'HTML', reply_markup: keyboard(rows) });
  }

  async showOrder(tgId, messageId, orderId) {
    const order = this.db.prepare('SELECT * FROM orders WHERE id = ? AND tg_user_id = ?').get(orderId, tgId);
    if (!order) return this.safeSendMessage(tgId, '订单不存在。');
    const rows = [];
    if (order.status === ORDER_STATUS.PENDING_MANUAL && order.payment_status === 'paid') rows.push([callbackButton('🔄 申请自动重试', `r:${order.id}`)]);
    rows.push([callbackButton('返回历史订单', 'h:0'), callbackButton('返回主页', 'home')]);
    return this.editOrSend(tgId, messageId, this.orderService.orderText(order), { parse_mode: 'HTML', reply_markup: keyboard(rows) });
  }

  async retryOrder(tgId, messageId, orderId) {
    const order = this.db.prepare('SELECT * FROM orders WHERE id = ? AND tg_user_id = ?').get(orderId, tgId);
    if (!order || order.status !== ORDER_STATUS.PENDING_MANUAL || order.payment_status !== 'paid') {
      return this.safeSendMessage(tgId, '当前订单无法自动重试。');
    }
    await this.safeSendMessage(tgId, '正在重新处理订单，请稍候…');
    try {
      await this.orderService.fulfillOrder(order.id, { source: 'customer_retry' });
    } catch (error) {
      await this.safeSendMessage(tgId, '自动发货重试失败，请联系客服。');
    }
    return this.showOrder(tgId, messageId, order.id);
  }

  async openSupport(user) {
    const tgId = String(user.id);
    this.store.setSession(tgId, 'support', {});
    const stamp = this.store.nowIso();
    this.db.prepare(`
      INSERT INTO support_threads (tg_id, active, unread_count, updated_at) VALUES (?, 1, 0, ?)
      ON CONFLICT(tg_id) DO UPDATE SET active = 1, updated_at = excluded.updated_at
    `).run(tgId, stamp);
    await this.safeSendMessage(tgId, '已进入客服对话。接下来发送的文本、图片或文件都会转交客服。\n发送 /cancel 可退出客服对话。');
    return this.notifySupportState(user, true);
  }

  async closeSupport(user) {
    const tgId = String(user.id);
    this.store.clearSession(tgId);
    this.db.prepare('UPDATE support_threads SET active = 0, updated_at = ? WHERE tg_id = ?').run(this.store.nowIso(), tgId);
    await this.safeSendMessage(tgId, '已退出客服对话。');
    await this.notifySupportState(user, false);
    return this.sendHome(tgId);
  }

  async notifySupportState(user, opened) {
    const adminId = this.store.getSettings().telegram_admin_id;
    if (!adminId) return;
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || '-';
    return this.safeSendMessage(adminId, `${opened ? '💬 用户开启' : '✅ 用户关闭'}客服对话\n用户：${escapeHtml(name)}${user.username ? ` (@${escapeHtml(user.username)})` : ''}\nTG ID：<code>${user.id}</code>`, { parse_mode: 'HTML' });
  }

  async recordSupportMessage(message) {
    const tgId = String(message.from.id);
    let type = 'text';
    let text = message.text || message.caption || '';
    let fileId = null;
    let originalName = null;
    let mimeType = null;
    let relativePath = null;

    if (message.photo?.length) {
      type = 'photo';
      fileId = message.photo[message.photo.length - 1].file_id;
      originalName = `photo_${message.message_id}.jpg`;
      mimeType = 'image/jpeg';
    } else if (message.document) {
      type = 'file';
      fileId = message.document.file_id;
      originalName = path.basename(message.document.file_name || `file_${message.message_id}`);
      mimeType = message.document.mime_type || 'application/octet-stream';
    } else if (!message.text) {
      return this.safeSendMessage(tgId, '客服目前支持文本、图片和文件消息。');
    }

    if (fileId) {
      try {
        const downloaded = await this.api.downloadFile(fileId);
        const extension = path.extname(originalName || downloaded.filePath).slice(0, 12);
        const filename = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${extension}`;
        const folder = path.join(this.store.dataDir, 'uploads', 'support', tgId);
        fs.mkdirSync(folder, { recursive: true });
        const fullPath = path.join(folder, filename);
        fs.writeFileSync(fullPath, downloaded.buffer);
        relativePath = path.relative(this.store.dataDir, fullPath);
      } catch (error) {
        text = `${text}\n[文件下载失败：${truncate(error.message, 200)}]`.trim();
      }
    }

    const stamp = this.store.nowIso();
    this.db.transaction(() => {
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO support_messages
          (tg_id, direction, message_type, text, telegram_file_id, original_name, mime_type, local_path, telegram_message_id, created_at)
        VALUES (?, 'user', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(tgId, type, text, fileId, originalName, mimeType, relativePath, String(message.message_id), stamp);
      if (!inserted.changes) return;
      this.db.prepare(`
        INSERT INTO support_threads (tg_id, active, unread_count, last_message_at, updated_at)
        VALUES (?, 1, 1, ?, ?)
        ON CONFLICT(tg_id) DO UPDATE SET unread_count = unread_count + 1, last_message_at = excluded.last_message_at, updated_at = excluded.updated_at
      `).run(tgId, stamp, stamp);
    })();
  }
}

module.exports = { BotManager, callbackButton, keyboard };
