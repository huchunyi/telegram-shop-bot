'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { DEFAULT_SETTINGS, resolveDataDir } = require('./constants');
const { createSqliteDatabase } = require('./sqlite');

function nowIso() {
  return new Date().toISOString();
}

function randomPassword(length = 16) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  while (value.length < length) {
    const bytes = crypto.randomBytes(length);
    for (const byte of bytes) {
      if (byte >= 248) continue;
      value += alphabet[byte % alphabet.length];
      if (value.length === length) break;
    }
  }
  return value;
}

function safeJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function openDatabase(options = {}) {
  const dataDir = path.resolve(options.dataDir || resolveDataDir());
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'uploads', 'support'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'uploads', 'broadcasts'), { recursive: true });

  const dbPath = path.join(dataDir, 'shop.sqlite');
  const firstRun = !fs.existsSync(dbPath);
  const db = await createSqliteDatabase(dbPath);
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_usdt REAL NOT NULL CHECK (price_usdt >= 0),
      max_quantity INTEGER NOT NULL DEFAULT 1 CHECK (max_quantity > 0),
      product_type TEXT NOT NULL CHECK (product_type IN ('card', 'api')),
      post_purchase_message TEXT NOT NULL DEFAULT '',
      api_url TEXT NOT NULL DEFAULT '',
      api_success_marker TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      field_key TEXT NOT NULL,
      option_type TEXT NOT NULL CHECK (option_type IN ('choice', 'text')),
      choices_json TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE(product_id, field_key)
    );

    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      is_used INTEGER NOT NULL DEFAULT 0,
      order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
      used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payment_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL CHECK (mode IN ('trc20_usdt', 'okpay', 'epay')),
      max_amount_usdt REAL NOT NULL DEFAULT 0 CHECK (max_amount_usdt >= 0),
      config_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bot_users (
      tg_id TEXT PRIMARY KEY,
      username TEXT,
      display_name TEXT NOT NULL DEFAULT '',
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      is_blocked INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bot_sessions (
      tg_id TEXT PRIMARY KEY REFERENCES bot_users(tg_id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT NOT NULL UNIQUE,
      tg_user_id TEXT NOT NULL,
      tg_username TEXT,
      tg_display_name TEXT NOT NULL DEFAULT '',
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      product_name TEXT NOT NULL,
      product_description TEXT NOT NULL DEFAULT '',
      product_type TEXT NOT NULL,
      unit_price_usdt REAL NOT NULL,
      quantity INTEGER NOT NULL,
      amount_usdt REAL NOT NULL,
      payable_amount REAL NOT NULL,
      payable_currency TEXT NOT NULL,
      options_json TEXT NOT NULL DEFAULT '{}',
      payment_channel_id INTEGER REFERENCES payment_channels(id) ON DELETE SET NULL,
      payment_channel_name TEXT NOT NULL,
      payment_mode TEXT NOT NULL,
      payment_config_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'unpaid',
      external_order_id TEXT,
      pay_url TEXT,
      transaction_id TEXT,
      delivery_result TEXT,
      api_response TEXT,
      failure_reason TEXT,
      paid_at TEXT,
      completed_at TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS support_threads (
      tg_id TEXT PRIMARY KEY REFERENCES bot_users(tg_id) ON DELETE CASCADE,
      active INTEGER NOT NULL DEFAULT 0,
      unread_count INTEGER NOT NULL DEFAULT 0,
      last_message_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_id TEXT NOT NULL REFERENCES bot_users(tg_id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK (direction IN ('user', 'admin')),
      message_type TEXT NOT NULL CHECK (message_type IN ('text', 'photo', 'file')),
      text TEXT NOT NULL DEFAULT '',
      telegram_file_id TEXT,
      original_name TEXT,
      mime_type TEXT,
      local_path TEXT,
      telegram_message_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS broadcasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_type TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      file_path TEXT,
      original_name TEXT,
      mime_type TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      total_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS broadcast_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
      tg_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      error TEXT,
      sent_at TEXT,
      UNIQUE(broadcast_id, tg_id)
    );

    CREATE TABLE IF NOT EXISTS trc20_transfers (
      transaction_id TEXT PRIMARY KEY,
      channel_id INTEGER REFERENCES payment_channels(id) ON DELETE SET NULL,
      from_address TEXT,
      to_address TEXT NOT NULL,
      amount_usdt REAL NOT NULL,
      block_timestamp INTEGER,
      order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_products_category_sort ON products(category_id, sort_order, id);
    CREATE INDEX IF NOT EXISTS idx_options_product_sort ON product_options(product_id, sort_order, id);
    CREATE INDEX IF NOT EXISTS idx_cards_product_used ON cards(product_id, is_used, id);
    CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(tg_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_status_expires ON orders(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_support_messages_user ON support_messages(tg_id, created_at, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_support_message_dedupe
      ON support_messages(tg_id, direction, telegram_message_id)
      WHERE telegram_message_id IS NOT NULL AND telegram_message_id != '';
    CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id, created_at);
  `);

  const settingInsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO NOTHING
  `);
  const seedSettings = db.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      settingInsert.run(key, value, nowIso());
    }
  });
  seedSettings();

  let initialPassword = null;
  if (firstRun) {
    initialPassword = randomPassword(16);
    const stamp = nowIso();
    db.prepare(`
      INSERT INTO admins (id, username, password_hash, created_at, updated_at)
      VALUES (1, 'admin', ?, ?, ?)
    `).run(bcrypt.hashSync(initialPassword, 12), stamp, stamp);

    const loginPath = path.resolve(options.loginPath || path.join(process.cwd(), 'login.txt'));
    const loginText = [
      '盛世王朝 SHOP BOT 后台初始化登录信息',
      '====================================',
      '用户名：admin',
      `密码：${initialPassword}`,
      `后台端口：${DEFAULT_SETTINGS.web_port}`,
      '',
      '请在首次登录后立即修改密码，并妥善删除本文件。',
      ''
    ].join('\n');
    fs.writeFileSync(loginPath, loginText, { encoding: 'utf8', mode: 0o600 });
  }

  function getSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  function setSettings(values) {
    const stmt = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    db.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        stmt.run(key, String(value ?? ''), nowIso());
      }
    })();
  }

  function addOrderEvent(orderId, eventType, detail = '') {
    db.prepare(`INSERT INTO order_events (order_id, event_type, detail, created_at) VALUES (?, ?, ?, ?)`)
      .run(orderId, eventType, String(detail || '').slice(0, 20000), nowIso());
  }

  function upsertBotUser(user) {
    const tgId = String(user.id);
    const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
    const stamp = nowIso();
    db.prepare(`
      INSERT INTO bot_users (tg_id, username, display_name, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tg_id) DO UPDATE SET
        username = excluded.username,
        display_name = excluded.display_name,
        last_seen_at = excluded.last_seen_at
    `).run(tgId, user.username || null, displayName, stamp, stamp);
    return tgId;
  }

  function getSession(tgId) {
    const row = db.prepare('SELECT state, data_json FROM bot_sessions WHERE tg_id = ?').get(String(tgId));
    if (!row) return null;
    return { state: row.state, data: safeJson(row.data_json, {}) || {} };
  }

  function setSession(tgId, state, data = {}) {
    db.prepare(`
      INSERT INTO bot_sessions (tg_id, state, data_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(tg_id) DO UPDATE SET state = excluded.state, data_json = excluded.data_json, updated_at = excluded.updated_at
    `).run(String(tgId), state, JSON.stringify(data), nowIso());
  }

  function clearSession(tgId) {
    db.prepare('DELETE FROM bot_sessions WHERE tg_id = ?').run(String(tgId));
  }

  return {
    db,
    dbPath,
    dataDir,
    firstRun,
    initialPassword,
    getSettings,
    setSettings,
    addOrderEvent,
    upsertBotUser,
    getSession,
    setSession,
    clearSession,
    nowIso,
    safeJson
  };
}

module.exports = { openDatabase, nowIso, randomPassword, safeJson };
