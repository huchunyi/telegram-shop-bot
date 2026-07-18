'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const multer = require('multer');
const { PAYMENT_MODES, ORDER_STATUS } = require('./constants');
const { parseConfig } = require('./payments');
const {
  asBoolean, asInteger, asNumber, asString, asyncHandler, httpError, sleep, truncate
} = require('./utils');

function cleanFilename(value) {
  return path.basename(String(value || 'upload.bin')).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 160) || 'upload.bin';
}

function shanghaiDayRange(daysAgo = 0) {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const start = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - daysAgo) - 8 * 60 * 60 * 1000;
  return { start: new Date(start).toISOString(), end: new Date(start + 24 * 60 * 60 * 1000).toISOString() };
}

function createServer({ store, auth, bot, orderService, paymentService }) {
  const app = express();
  if (process.env.SHOP_TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        // 默认部署直接使用 HTTP 监听端口；不能让浏览器把静态资源强制升级到 HTTPS。
        // 生产环境由 Nginx/Caddy 终止 HTTPS 时，同源资源本身已经是 HTTPS。
        upgradeInsecureRequests: null
      }
    },
    crossOriginResourcePolicy: { policy: 'same-origin' }
  }));
  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 1 }
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, bot: bot.status(), time: new Date().toISOString() }));

  app.get('/callbacks/epay/:channelId', asyncHandler(async (req, res) => {
    const channel = store.db.prepare('SELECT * FROM payment_channels WHERE id = ? AND mode = ?').get(req.params.channelId, PAYMENT_MODES.EPAY);
    if (!channel) return res.status(404).send('fail');
    const payment = paymentService.verifyEpayCallback(req.query, channel);
    const order = paymentService.validateCallbackOrder(payment, channel, 'CNY');
    if (!order) return res.status(400).send('fail');
    orderService.markPaid(order.id, payment.transactionId, { source: 'epay_callback', response: payment.raw }).catch((error) => console.error('[回调] 易支付发货失败:', error.message));
    return res.type('text/plain').send('success');
  }));

  app.all('/callbacks/okpay/:channelId', asyncHandler(async (req, res) => {
    const channel = store.db.prepare('SELECT * FROM payment_channels WHERE id = ? AND mode = ?').get(req.params.channelId, PAYMENT_MODES.OKPAY);
    if (!channel) return res.status(404).json({ status: 'fail' });
    const payload = { ...(req.query || {}), ...(req.body || {}) };
    const payment = paymentService.verifyOkpayCallback(payload, channel);
    if (!payment) {
      console.warn(`[回调] OKPay 通道 ${channel.id} 收到未通过签名或状态校验的回调`);
      return res.status(400).json({ status: 'fail' });
    }
    const order = paymentService.validateCallbackOrder(payment, channel, 'USDT');
    if (!order) {
      const existing = store.db.prepare('SELECT payment_status FROM orders WHERE order_no = ? AND payment_channel_id = ?')
        .get(payment.orderNo, channel.id);
      if (existing?.payment_status === 'paid') return res.json({ status: 'success' });
      return res.status(400).json({ status: 'fail' });
    }
    orderService.markPaid(order.id, payment.transactionId, { source: 'okpay_callback', response: payment.raw }).catch((error) => console.error('[回调] OKPay 发货失败:', error.message));
    return res.json({ status: 'success' });
  }));

  app.post('/api/auth/login', (req, res, next) => {
    try {
      const result = auth.login(req.body.username, req.body.password, req, res);
      res.json({ ok: true, ...result });
    } catch (error) { next(error); }
  });
  app.get('/api/auth/me', auth.requireAuth, (req, res) => {
    res.json({ username: req.adminSession.username, csrfToken: req.adminSession.csrfToken, bot: bot.status() });
  });
  app.post('/api/auth/logout', auth.requireAuth, auth.requireCsrf, (req, res) => {
    auth.logout(req, res);
    res.json({ ok: true });
  });
  app.post('/api/auth/password', auth.requireAuth, auth.requireCsrf, (req, res, next) => {
    try {
      auth.changePassword(req.body.oldPassword, req.body.newPassword, req);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  const api = express.Router();
  api.use(auth.requireAuth, auth.requireCsrf);

  api.get('/dashboard', (req, res) => {
    const today = shanghaiDayRange(0);
    const metrics = {
      todayOrders: store.db.prepare('SELECT COUNT(*) AS n FROM orders WHERE created_at >= ? AND created_at < ?').get(today.start, today.end).n,
      totalOrders: store.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,
      todayRevenue: store.db.prepare(`SELECT COALESCE(SUM(amount_usdt), 0) AS n FROM orders WHERE payment_status = 'paid' AND paid_at >= ? AND paid_at < ?`).get(today.start, today.end).n,
      totalRevenue: store.db.prepare(`SELECT COALESCE(SUM(amount_usdt), 0) AS n FROM orders WHERE payment_status = 'paid'`).get().n,
      pendingOrders: store.db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status IN (?, ?)`).get(ORDER_STATUS.PROCESSING, ORDER_STATUS.PENDING_MANUAL).n,
      unreadSupport: store.db.prepare('SELECT COALESCE(SUM(unread_count), 0) AS n FROM support_threads').get().n
    };
    const chart = [];
    for (let daysAgo = 6; daysAgo >= 0; daysAgo -= 1) {
      const range = shanghaiDayRange(daysAgo);
      const data = store.db.prepare(`
        SELECT COUNT(*) AS orders, COALESCE(SUM(amount_usdt), 0) AS revenue
        FROM orders WHERE payment_status = 'paid' AND paid_at >= ? AND paid_at < ?
      `).get(range.start, range.end);
      chart.push({ date: range.start.slice(5, 10), ...data });
    }
    const recentOrders = store.db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 8').all();
    res.json({ metrics, chart, recentOrders, bot: bot.status() });
  });

  api.get('/categories', (req, res) => {
    const rows = store.db.prepare(`
      SELECT c.*, COUNT(p.id) AS product_count FROM categories c
      LEFT JOIN products p ON p.category_id = c.id
      GROUP BY c.id ORDER BY c.sort_order, c.id
    `).all();
    res.json(rows);
  });
  api.post('/categories', (req, res) => {
    const name = asString(req.body.name, '分类名称', { required: true, max: 80 });
    const description = asString(req.body.description, '分类说明', { max: 500 });
    const next = store.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM categories').get().n;
    const stamp = store.nowIso();
    const result = store.db.prepare(`INSERT INTO categories (name, description, enabled, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(name, description, asBoolean(req.body.enabled) ? 1 : 0, next, stamp, stamp);
    res.status(201).json(store.db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid));
  });
  api.put('/categories/:id', (req, res) => {
    const id = asInteger(req.params.id, '分类 ID', { min: 1 });
    if (!store.db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id)) throw httpError(404, '分类不存在');
    store.db.prepare('UPDATE categories SET name = ?, description = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(asString(req.body.name, '分类名称', { required: true, max: 80 }), asString(req.body.description, '分类说明', { max: 500 }), asBoolean(req.body.enabled) ? 1 : 0, store.nowIso(), id);
    res.json(store.db.prepare('SELECT * FROM categories WHERE id = ?').get(id));
  });
  api.delete('/categories/:id', (req, res) => {
    const id = asInteger(req.params.id, '分类 ID', { min: 1 });
    const count = store.db.prepare('SELECT COUNT(*) AS n FROM products WHERE category_id = ?').get(id).n;
    if (count) throw httpError(409, '请先删除或移动该分类下的商品');
    store.db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    res.json({ ok: true });
  });
  api.put('/category-order', (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
    const valid = store.db.prepare('SELECT id FROM categories ORDER BY sort_order, id').all().map((row) => row.id);
    if (ids.length !== valid.length || new Set(ids).size !== ids.length || ids.some((id) => !valid.includes(id))) throw httpError(400, '分类排序数据无效');
    const stmt = store.db.prepare('UPDATE categories SET sort_order = ?, updated_at = ? WHERE id = ?');
    store.db.transaction(() => ids.forEach((id, index) => stmt.run(index, store.nowIso(), id)))();
    res.json({ ok: true });
  });

  function productPayload(body) {
    const categoryId = asInteger(body.category_id, '上游分类', { min: 1 });
    if (!store.db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) throw httpError(400, '上游分类不存在');
    const type = asString(body.product_type, '商品类型', { required: true });
    if (!['card', 'api'].includes(type)) throw httpError(400, '商品类型无效');
    const options = Array.isArray(body.options) ? body.options : [];
    const seen = new Set();
    const checkedOptions = options.map((item, index) => {
      const name = asString(item.name, `扩展选项 ${index + 1} 名称`, { required: true, max: 50 });
      const field = asString(item.field_key, `扩展选项 ${index + 1} 字段`, { required: true, max: 40 });
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field)) throw httpError(400, `扩展字段“${field}”只能以英文字母开头，并包含字母、数字、下划线`);
      if (field === 'num' || seen.has(field)) throw httpError(400, `扩展字段“${field}”重复或为系统保留字段`);
      seen.add(field);
      const optionType = item.option_type === 'choice' ? 'choice' : 'text';
      const choices = optionType === 'choice'
        ? (Array.isArray(item.choices) ? item.choices : String(item.choices || '').split(',')).map((value) => String(value).trim()).filter(Boolean)
        : [];
      if (optionType === 'choice' && choices.length < 1) throw httpError(400, `选项类“${name}”至少需要一个选项`);
      return { name, field, optionType, choices: [...new Set(choices)].slice(0, 50), sortOrder: index };
    });
    const apiUrl = asString(body.api_url, 'API 地址', { max: 4000 });
    if (type === 'api' && !apiUrl) throw httpError(400, '自动 API 发货商品必须设置 API 地址');
    return {
      categoryId,
      name: asString(body.name, '商品名称', { required: true, max: 120 }),
      description: asString(body.description, '商品介绍', { max: 8000 }),
      price: asNumber(body.price_usdt, '价格', { min: 0.000001, max: 100000000 }),
      maxQuantity: asInteger(body.max_quantity, '单次最大购买数量', { min: 1, max: 10000 }),
      type,
      postMessage: asString(body.post_purchase_message, '购买后提示', { max: 4000 }),
      apiUrl: type === 'api' ? apiUrl : '',
      marker: type === 'api' ? asString(body.api_success_marker, '成功标志', { max: 1000 }) : '',
      enabled: asBoolean(body.enabled) ? 1 : 0,
      options: checkedOptions
    };
  }

  function replaceProductOptions(productId, options) {
    store.db.prepare('DELETE FROM product_options WHERE product_id = ?').run(productId);
    const stmt = store.db.prepare(`INSERT INTO product_options (product_id, name, field_key, option_type, choices_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const item of options) stmt.run(productId, item.name, item.field, item.optionType, JSON.stringify(item.choices), item.sortOrder);
  }

  api.get('/products', (req, res) => {
    const rows = store.db.prepare(`
      SELECT p.*, c.name AS category_name,
        SUM(CASE WHEN cards.is_used = 0 THEN 1 ELSE 0 END) AS available_stock,
        COUNT(cards.id) AS total_stock
      FROM products p JOIN categories c ON c.id = p.category_id
      LEFT JOIN cards ON cards.product_id = p.id
      GROUP BY p.id ORDER BY c.sort_order, p.category_id, p.sort_order, p.id
    `).all();
    const optionStmt = store.db.prepare('SELECT * FROM product_options WHERE product_id = ? ORDER BY sort_order, id');
    for (const row of rows) row.options = optionStmt.all(row.id).map((item) => ({ ...item, choices: JSON.parse(item.choices_json || '[]') }));
    res.json(rows);
  });
  api.post('/products', (req, res) => {
    const data = productPayload(req.body);
    const stamp = store.nowIso();
    const result = store.db.transaction(() => {
      const next = store.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM products WHERE category_id = ?').get(data.categoryId).n;
      const inserted = store.db.prepare(`
        INSERT INTO products (category_id, name, description, price_usdt, max_quantity, product_type, post_purchase_message, api_url, api_success_marker, enabled, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(data.categoryId, data.name, data.description, data.price, data.maxQuantity, data.type, data.postMessage, data.apiUrl, data.marker, data.enabled, next, stamp, stamp);
      replaceProductOptions(inserted.lastInsertRowid, data.options);
      return inserted.lastInsertRowid;
    })();
    res.status(201).json({ id: result });
  });
  api.put('/products/:id', (req, res) => {
    const id = asInteger(req.params.id, '商品 ID', { min: 1 });
    const existing = store.db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) throw httpError(404, '商品不存在');
    const data = productPayload(req.body);
    store.db.transaction(() => {
      let sortOrder = existing.sort_order;
      if (existing.category_id !== data.categoryId) sortOrder = store.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM products WHERE category_id = ?').get(data.categoryId).n;
      store.db.prepare(`
        UPDATE products SET category_id = ?, name = ?, description = ?, price_usdt = ?, max_quantity = ?, product_type = ?, post_purchase_message = ?, api_url = ?, api_success_marker = ?, enabled = ?, sort_order = ?, updated_at = ? WHERE id = ?
      `).run(data.categoryId, data.name, data.description, data.price, data.maxQuantity, data.type, data.postMessage, data.apiUrl, data.marker, data.enabled, sortOrder, store.nowIso(), id);
      replaceProductOptions(id, data.options);
    })();
    res.json({ ok: true });
  });
  api.delete('/products/:id', (req, res) => {
    const id = asInteger(req.params.id, '商品 ID', { min: 1 });
    store.db.prepare('DELETE FROM products WHERE id = ?').run(id);
    res.json({ ok: true });
  });
  api.put('/product-order', (req, res) => {
    const categoryId = asInteger(req.body.category_id, '分类 ID', { min: 1 });
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
    const valid = store.db.prepare('SELECT id FROM products WHERE category_id = ? ORDER BY sort_order, id').all(categoryId).map((row) => row.id);
    if (ids.length !== valid.length || new Set(ids).size !== ids.length || ids.some((id) => !valid.includes(id))) throw httpError(400, '商品排序数据无效');
    const stmt = store.db.prepare('UPDATE products SET sort_order = ?, updated_at = ? WHERE id = ?');
    store.db.transaction(() => ids.forEach((id, index) => stmt.run(index, store.nowIso(), id)))();
    res.json({ ok: true });
  });

  api.get('/products/:id/cards', (req, res) => {
    const id = asInteger(req.params.id, '商品 ID', { min: 1 });
    const filter = req.query.status;
    let where = 'WHERE c.product_id = ?';
    if (filter === 'used') where += ' AND c.is_used = 1';
    if (filter === 'unused') where += ' AND c.is_used = 0';
    const rows = store.db.prepare(`
      SELECT c.*, o.order_no FROM cards c LEFT JOIN orders o ON o.id = c.order_id ${where} ORDER BY c.id DESC LIMIT 2000
    `).all(id);
    res.json(rows);
  });
  api.post('/products/:id/cards/bulk', (req, res) => {
    const id = asInteger(req.params.id, '商品 ID', { min: 1 });
    const product = store.db.prepare('SELECT * FROM products WHERE id = ? AND product_type = \'card\'').get(id);
    if (!product) throw httpError(404, '自动发卡商品不存在');
    const lines = String(req.body.content || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) throw httpError(400, '请至少输入一条卡密');
    if (lines.length > 10000) throw httpError(400, '单次最多添加 10000 条卡密');
    const stmt = store.db.prepare('INSERT INTO cards (product_id, content, created_at, updated_at) VALUES (?, ?, ?, ?)');
    store.db.transaction(() => lines.forEach((line) => stmt.run(id, line.slice(0, 4000), store.nowIso(), store.nowIso())))();
    res.status(201).json({ count: lines.length });
  });
  api.put('/cards/:id', (req, res) => {
    const id = asInteger(req.params.id, '卡密 ID', { min: 1 });
    const content = asString(req.body.content, '卡密内容', { required: true, max: 4000 });
    store.db.prepare('UPDATE cards SET content = ?, updated_at = ? WHERE id = ?').run(content, store.nowIso(), id);
    res.json({ ok: true });
  });
  api.delete('/cards/:id', (req, res) => {
    const id = asInteger(req.params.id, '卡密 ID', { min: 1 });
    store.db.prepare('DELETE FROM cards WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  api.get('/orders', (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 30));
    const clauses = [];
    const params = [];
    if (req.query.status) { clauses.push('status = ?'); params.push(String(req.query.status)); }
    if (req.query.payment_status) { clauses.push('payment_status = ?'); params.push(String(req.query.payment_status)); }
    if (req.query.search) {
      clauses.push('(order_no LIKE ? OR product_name LIKE ? OR tg_user_id LIKE ? OR tg_username LIKE ?)');
      const q = `%${String(req.query.search).slice(0, 100)}%`;
      params.push(q, q, q, q);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = store.db.prepare(`SELECT COUNT(*) AS n FROM orders ${where}`).get(...params).n;
    const rows = store.db.prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit);
    res.json({ rows, total, page, limit });
  });
  api.get('/orders/:id', (req, res) => {
    const order = store.db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) throw httpError(404, '订单不存在');
    order.options = JSON.parse(order.options_json || '{}');
    order.events = store.db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at, id').all(order.id);
    order.cards = store.db.prepare('SELECT id, content, used_at FROM cards WHERE order_id = ? ORDER BY id').all(order.id);
    res.json(order);
  });
  api.post('/orders/:id/retry', asyncHandler(async (req, res) => {
    const order = await orderService.fulfillOrder(asInteger(req.params.id, '订单 ID', { min: 1 }), { source: 'admin_retry' });
    res.json(order);
  }));
  api.post('/orders/:id/manual-fulfill', asyncHandler(async (req, res) => {
    const order = await orderService.manualFulfill(asInteger(req.params.id, '订单 ID', { min: 1 }), {
      mode: String(req.body.mode || 'default'),
      content: req.body.content,
      forcePaid: asBoolean(req.body.forcePaid)
    });
    res.json(order);
  }));

  api.get('/support/threads', (req, res) => {
    const rows = store.db.prepare(`
      SELECT t.*, u.username, u.display_name,
        (SELECT text FROM support_messages m WHERE m.tg_id = t.tg_id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_text
      FROM support_threads t JOIN bot_users u ON u.tg_id = t.tg_id
      ORDER BY COALESCE(t.last_message_at, t.updated_at) DESC
    `).all();
    res.json(rows);
  });
  api.get('/support/:tgId/messages', (req, res) => {
    const tgId = String(req.params.tgId);
    const rows = store.db.prepare('SELECT * FROM support_messages WHERE tg_id = ? ORDER BY created_at, id LIMIT 5000').all(tgId);
    store.db.prepare('UPDATE support_threads SET unread_count = 0 WHERE tg_id = ?').run(tgId);
    res.json(rows.map((row) => ({ ...row, file_url: row.local_path ? `/api/support/messages/${row.id}/file` : null })));
  });
  api.get('/support/messages/:id/file', (req, res) => {
    const row = store.db.prepare('SELECT * FROM support_messages WHERE id = ?').get(req.params.id);
    if (!row?.local_path) throw httpError(404, '文件不存在');
    const full = path.resolve(store.dataDir, row.local_path);
    const root = `${path.resolve(store.dataDir)}${path.sep}`;
    if (!full.startsWith(root) || !fs.existsSync(full)) throw httpError(404, '文件不存在');
    if (row.message_type === 'photo' && req.query.download !== '1') {
      res.type(row.mime_type || 'image/jpeg');
      return res.sendFile(full);
    }
    return res.download(full, cleanFilename(row.original_name || path.basename(full)));
  });
  api.post('/support/:tgId/reply', upload.single('file'), asyncHandler(async (req, res) => {
    const tgId = String(req.params.tgId);
    if (!store.db.prepare('SELECT 1 FROM bot_users WHERE tg_id = ?').get(tgId)) throw httpError(404, '用户不存在');
    const text = String(req.body.text || '').trim().slice(0, 4000);
    if (!text && !req.file) throw httpError(400, '请输入回复内容或选择文件');
    const outboundText = text ? `【来自管理员的回复】\n${text}` : '【来自管理员的回复】';
    let type = 'text';
    let relativePath = null;
    let originalName = null;
    let mimeType = null;
    let sent;
    if (req.file) {
      originalName = cleanFilename(req.file.originalname);
      mimeType = req.file.mimetype || 'application/octet-stream';
      type = mimeType.startsWith('image/') ? 'photo' : 'file';
      const folder = path.join(store.dataDir, 'uploads', 'support', tgId);
      fs.mkdirSync(folder, { recursive: true });
      const full = path.join(folder, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${path.extname(originalName).slice(0, 12)}`);
      fs.writeFileSync(full, req.file.buffer);
      relativePath = path.relative(store.dataDir, full);
      sent = await bot.sendLocalFile(tgId, full, { kind: type, filename: originalName, mimeType, caption: outboundText });
    } else {
      sent = await bot.api.sendMessage(tgId, outboundText);
    }
    const stamp = store.nowIso();
    const result = store.db.prepare(`
      INSERT INTO support_messages (tg_id, direction, message_type, text, original_name, mime_type, local_path, telegram_message_id, created_at)
      VALUES (?, 'admin', ?, ?, ?, ?, ?, ?, ?)
    `).run(tgId, type, text, originalName, mimeType, relativePath, String(sent?.message_id || ''), stamp);
    store.db.prepare(`
      INSERT INTO support_threads (tg_id, active, unread_count, last_message_at, updated_at) VALUES (?, 1, 0, ?, ?)
      ON CONFLICT(tg_id) DO UPDATE SET last_message_at = excluded.last_message_at, updated_at = excluded.updated_at
    `).run(tgId, stamp, stamp);
    res.status(201).json({ id: result.lastInsertRowid });
  }));

  function channelPayload(body) {
    const mode = asString(body.mode, '通道模式', { required: true });
    if (!Object.values(PAYMENT_MODES).includes(mode)) throw httpError(400, '通道模式无效');
    const config = body.config && typeof body.config === 'object' ? body.config : {};
    let checked;
    if (mode === PAYMENT_MODES.TRC20) {
      const address = asString(config.address, 'TRC20 收款地址', { required: true, max: 80 });
      if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) throw httpError(400, 'TRC20 收款地址格式无效');
      checked = { address, trongrid_key: asString(config.trongrid_key, 'TronGrid Key', { max: 200 }) };
    } else if (mode === PAYMENT_MODES.OKPAY) {
      checked = {
        app_id: asString(config.app_id, 'OKPay App ID', { required: true, max: 120 }),
        secret: asString(config.secret, 'OKPay 密钥', { required: true, max: 300 }),
        api_url: asString(config.api_url || 'https://api.okaypay.me/shop/', 'OKPay API URL', { required: true, max: 500 })
      };
    } else {
      const payType = asString(config.pay_type, '易支付通道类型', { required: true });
      if (!['alipay', 'wxpay'].includes(payType)) throw httpError(400, '易支付通道类型仅支持 alipay 或 wxpay');
      checked = {
        api_url: asString(config.api_url, '易支付 URL', { required: true, max: 500 }),
        pid: asString(config.pid, '易支付商户 ID', { required: true, max: 120 }),
        key: asString(config.key, '易支付密钥', { required: true, max: 300 }),
        pay_type: payType
      };
    }
    for (const key of Object.keys(checked).filter((key) => key.endsWith('url'))) {
      try { const url = new URL(checked[key]); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { throw httpError(400, `${key} 必须是有效的 HTTP(S) URL`); }
    }
    return {
      name: asString(body.name, '通道名称', { required: true, max: 80 }),
      mode,
      maxAmount: asNumber(body.max_amount_usdt ?? 0, '最大金额', { min: 0, max: 100000000 }),
      enabled: asBoolean(body.enabled) ? 1 : 0,
      config: checked
    };
  }

  api.get('/payment-channels', (req, res) => {
    res.json(store.db.prepare('SELECT * FROM payment_channels ORDER BY id').all().map((row) => ({ ...row, config: parseConfig(row) })));
  });
  api.post('/payment-channels', (req, res) => {
    const data = channelPayload(req.body);
    const stamp = store.nowIso();
    try {
      const result = store.db.prepare(`INSERT INTO payment_channels (name, mode, max_amount_usdt, config_json, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(data.name, data.mode, data.maxAmount, JSON.stringify(data.config), data.enabled, stamp, stamp);
      res.status(201).json({ id: result.lastInsertRowid });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed: payment_channels\.name/i.test(error.message)) throw httpError(409, '支付通道名称必须全局唯一');
      throw error;
    }
  });
  api.put('/payment-channels/:id', (req, res) => {
    const id = asInteger(req.params.id, '通道 ID', { min: 1 });
    const data = channelPayload(req.body);
    try {
      store.db.prepare('UPDATE payment_channels SET name = ?, mode = ?, max_amount_usdt = ?, config_json = ?, enabled = ?, updated_at = ? WHERE id = ?')
        .run(data.name, data.mode, data.maxAmount, JSON.stringify(data.config), data.enabled, store.nowIso(), id);
      res.json({ ok: true });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed: payment_channels\.name/i.test(error.message)) throw httpError(409, '支付通道名称必须全局唯一');
      throw error;
    }
  });
  api.delete('/payment-channels/:id', (req, res) => {
    store.db.prepare('DELETE FROM payment_channels WHERE id = ?').run(asInteger(req.params.id, '通道 ID', { min: 1 }));
    res.json({ ok: true });
  });

  api.get('/broadcasts', (req, res) => res.json(store.db.prepare('SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 50').all()));
  api.get('/broadcasts/:id', (req, res) => {
    const row = store.db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(req.params.id);
    if (!row) throw httpError(404, '广播不存在');
    res.json(row);
  });
  api.post('/broadcasts', upload.single('file'), (req, res) => {
    const text = String(req.body.text || '').trim().slice(0, 4000);
    if (!text && !req.file) throw httpError(400, '广播内容不能为空');
    let type = 'text';
    let relativePath = null;
    let originalName = null;
    let mimeType = null;
    if (req.file) {
      originalName = cleanFilename(req.file.originalname);
      mimeType = req.file.mimetype || 'application/octet-stream';
      type = mimeType.startsWith('image/') ? 'photo' : 'file';
      const folder = path.join(store.dataDir, 'uploads', 'broadcasts');
      fs.mkdirSync(folder, { recursive: true });
      const full = path.join(folder, `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${path.extname(originalName).slice(0, 12)}`);
      fs.writeFileSync(full, req.file.buffer);
      relativePath = path.relative(store.dataDir, full);
    }
    const users = store.db.prepare('SELECT tg_id FROM bot_users WHERE tg_id != ?').all(String(store.getSettings().telegram_admin_id || ''));
    const stamp = store.nowIso();
    const id = store.db.transaction(() => {
      const result = store.db.prepare(`
        INSERT INTO broadcasts (message_type, text, file_path, original_name, mime_type, status, total_count, created_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
      `).run(type, text, relativePath, originalName, mimeType, users.length, stamp);
      const recipient = store.db.prepare('INSERT INTO broadcast_recipients (broadcast_id, tg_id) VALUES (?, ?)');
      for (const user of users) recipient.run(result.lastInsertRowid, user.tg_id);
      return result.lastInsertRowid;
    })();
    setImmediate(() => processBroadcast(id).catch((error) => console.error('[广播] 发送任务失败:', error.message)));
    res.status(202).json({ id });
  });

  async function processBroadcast(id) {
    const broadcast = store.db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id);
    if (!broadcast) return;
    store.db.prepare("UPDATE broadcasts SET status = 'running', started_at = ? WHERE id = ?").run(store.nowIso(), id);
    const recipients = store.db.prepare("SELECT * FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'queued' ORDER BY id").all(id);
    for (const recipient of recipients) {
      let ok = false;
      let errorText = '';
      try {
        if (!bot.isReady()) throw new Error('Bot 尚未连接 Telegram');
        if (broadcast.message_type === 'text') {
          await bot.api.sendMessage(recipient.tg_id, broadcast.text);
        } else {
          const full = path.resolve(store.dataDir, broadcast.file_path);
          await bot.sendLocalFile(recipient.tg_id, full, {
            kind: broadcast.message_type,
            filename: broadcast.original_name,
            mimeType: broadcast.mime_type,
            caption: broadcast.text || undefined
          });
        }
        ok = true;
      } catch (error) {
        errorText = truncate(error.message, 500);
        if (error.parameters?.retry_after) await sleep(Number(error.parameters.retry_after) * 1000);
      }
      const stamp = store.nowIso();
      store.db.transaction(() => {
        store.db.prepare('UPDATE broadcast_recipients SET status = ?, error = ?, sent_at = ? WHERE id = ?')
          .run(ok ? 'success' : 'failed', errorText || null, ok ? stamp : null, recipient.id);
        store.db.prepare(`
          UPDATE broadcasts SET success_count = success_count + ?, failure_count = failure_count + ? WHERE id = ?
        `).run(ok ? 1 : 0, ok ? 0 : 1, id);
      })();
      await sleep(45);
    }
    store.db.prepare("UPDATE broadcasts SET status = 'completed', completed_at = ? WHERE id = ?").run(store.nowIso(), id);
  }

  const SETTING_KEYS = ['bot_name', 'telegram_bot_token', 'telegram_admin_id', 'order_timeout_min', 'usdt_cny_rate', 'web_port', 'public_base_url', 'open_source_url'];
  api.get('/settings', (req, res) => res.json({ settings: store.getSettings(), bot: bot.status() }));
  api.post('/bot/reconnect', (req, res) => {
    const token = String(store.getSettings().telegram_bot_token || '').trim();
    if (!token) throw httpError(400, '当前数据库尚未保存 Telegram Bot Token');
    const restarted = bot.forceReload();
    res.json({ ok: true, restarted });
  });
  api.put('/settings', (req, res) => {
    const oldPort = Number(process.env.SHOP_PORT || store.getSettings().web_port);
    const previousToken = String(store.getSettings().telegram_bot_token || '');
    const values = {};
    for (const key of SETTING_KEYS) if (Object.prototype.hasOwnProperty.call(req.body, key)) values[key] = String(req.body[key] ?? '').trim();
    values.bot_name = asString(values.bot_name, 'BOT 名称', { required: true, max: 120 });
    values.telegram_admin_id = asString(values.telegram_admin_id, 'Telegram 管理员 ID', { required: true, max: 30 });
    if (!/^\d+$/.test(values.telegram_admin_id)) throw httpError(400, 'Telegram 管理员 ID 必须为数字');
    values.order_timeout_min = String(asInteger(values.order_timeout_min, '订单超时时间', { min: 1, max: 1440 }));
    values.usdt_cny_rate = String(asNumber(values.usdt_cny_rate, 'USDT/CNY 汇率', { min: 0.0001, max: 100000 }));
    values.web_port = String(asInteger(values.web_port, 'Web 端口', { min: 1, max: 65535 }));
    if (values.telegram_bot_token && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(values.telegram_bot_token)) throw httpError(400, 'Telegram Bot Token 格式无效');
    for (const key of ['public_base_url', 'open_source_url']) {
      if (!values[key]) continue;
      try { const url = new URL(values[key]); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { throw httpError(400, `${key} 必须是有效的 HTTP(S) URL`); }
    }
    values.public_base_url = String(values.public_base_url || '').replace(/\/+$/, '');
    store.setSettings(values);
    if (values.telegram_bot_token !== previousToken || (values.telegram_bot_token && !bot.isReady())) {
      bot.forceReload();
    }
    res.json({ ok: true, restartRequired: oldPort !== Number(values.web_port) });
  });

  app.use('/api', api);

  const publicDir = path.join(__dirname, '..', 'public');
  app.use('/assets', express.static(publicDir, { maxAge: '1h', etag: true }));
  app.get(['/', '/admin', '/admin/*'], (req, res) => res.sendFile(path.join(publicDir, 'admin.html')));

  app.use((req, res) => res.status(404).json({ error: '接口不存在', code: 'NOT_FOUND' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof multer.MulterError) {
      return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? '文件不能超过 20MB' : error.message, code: error.code });
    }
    if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || /FOREIGN KEY constraint failed/i.test(error.message)) error = httpError(409, '该记录仍被其他数据引用，无法删除');
    const status = Number(error.status) || 500;
    if (status >= 500) console.error('[Web] 请求处理失败:', error);
    if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    return res.status(status).json({ error: status >= 500 ? '服务器内部错误' : error.message, code: error.code || 'INTERNAL_ERROR' });
  });

  return app;
}

module.exports = { createServer, shanghaiDayRange };
