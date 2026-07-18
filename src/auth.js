'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { httpError, safeEqual } = require('./utils');

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function parseCookies(header = '') {
  const result = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

class AuthService {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.loginAttempts = new Map();
  }

  cleanup() {
    const stamp = new Date().toISOString();
    this.db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(stamp);
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [key, value] of this.loginAttempts) {
      if (value.last < cutoff) this.loginAttempts.delete(key);
    }
  }

  checkRateLimit(ip) {
    const key = String(ip || 'unknown');
    const current = this.loginAttempts.get(key);
    if (!current || Date.now() - current.first > 15 * 60 * 1000) return;
    if (current.count >= 8) {
      const waitSeconds = Math.max(1, Math.ceil((15 * 60 * 1000 - (Date.now() - current.first)) / 1000));
      const error = httpError(429, `登录尝试过多，请在 ${waitSeconds} 秒后重试`, 'RATE_LIMITED');
      error.retryAfter = waitSeconds;
      throw error;
    }
  }

  recordFailure(ip) {
    const key = String(ip || 'unknown');
    const current = this.loginAttempts.get(key);
    if (!current || Date.now() - current.first > 15 * 60 * 1000) {
      this.loginAttempts.set(key, { count: 1, first: Date.now(), last: Date.now() });
      return;
    }
    current.count += 1;
    current.last = Date.now();
  }

  clearFailures(ip) {
    this.loginAttempts.delete(String(ip || 'unknown'));
  }

  login(username, password, req, res) {
    this.checkRateLimit(req.ip);
    const admin = this.db.prepare('SELECT * FROM admins WHERE username = ?').get(String(username || ''));
    if (!admin || !bcrypt.compareSync(String(password || ''), admin.password_hash)) {
      this.recordFailure(req.ip);
      throw httpError(401, '用户名或密码错误', 'INVALID_CREDENTIALS');
    }

    this.clearFailures(req.ip);
    const token = crypto.randomBytes(32).toString('base64url');
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + SESSION_MAX_AGE_MS);
    this.db.prepare(`
      INSERT INTO admin_sessions (token_hash, created_at, expires_at, ip, user_agent)
      VALUES (?, ?, ?, ?, ?)
    `).run(hash(token), createdAt.toISOString(), expiresAt.toISOString(), req.ip || '', String(req.get('user-agent') || '').slice(0, 500));

    const secure = req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https';
    const cookie = [
      `shop_session=${encodeURIComponent(token)}`,
      'Path=/',
      `Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`,
      'HttpOnly',
      'SameSite=Strict',
      secure ? 'Secure' : ''
    ].filter(Boolean).join('; ');
    res.setHeader('Set-Cookie', cookie);
    return { username: admin.username, csrfToken: this.csrfFor(token) };
  }

  csrfFor(token) {
    return hash(`csrf:${token}`);
  }

  sessionFromRequest(req) {
    const token = parseCookies(req.headers.cookie).shop_session;
    if (!token) return null;
    const row = this.db.prepare(`
      SELECT s.*, a.username FROM admin_sessions s CROSS JOIN admins a
      WHERE s.token_hash = ? AND s.expires_at > ? AND a.id = 1
    `).get(hash(token), new Date().toISOString());
    if (!row) return null;
    return { token, row, username: row.username, csrfToken: this.csrfFor(token) };
  }

  requireAuth = (req, res, next) => {
    const session = this.sessionFromRequest(req);
    if (!session) return res.status(401).json({ error: '登录已过期，请重新登录', code: 'UNAUTHORIZED' });
    req.adminSession = session;
    return next();
  };

  requireCsrf = (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const supplied = req.get('x-csrf-token');
    if (!req.adminSession || !safeEqual(supplied, req.adminSession.csrfToken)) {
      return res.status(403).json({ error: '安全校验失败，请刷新页面后重试', code: 'CSRF_FAILED' });
    }
    return next();
  };

  logout(req, res) {
    const session = req.adminSession || this.sessionFromRequest(req);
    if (session) this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hash(session.token));
    res.setHeader('Set-Cookie', 'shop_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
  }

  changePassword(oldPassword, newPassword, req) {
    const admin = this.db.prepare('SELECT * FROM admins WHERE id = 1').get();
    if (!admin || !bcrypt.compareSync(String(oldPassword || ''), admin.password_hash)) {
      throw httpError(400, '原密码不正确', 'INVALID_OLD_PASSWORD');
    }
    const password = String(newPassword || '');
    if (password.length < 10 || password.length > 128) {
      throw httpError(400, '新密码长度应为 10–128 位');
    }
    this.db.prepare('UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = 1')
      .run(bcrypt.hashSync(password, 12), new Date().toISOString());
    this.db.prepare('DELETE FROM admin_sessions WHERE token_hash != ?').run(hash(req.adminSession.token));
  }
}

module.exports = { AuthService, parseCookies };
