'use strict';

const crypto = require('crypto');

function httpError(status, message, code = 'REQUEST_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function asString(value, name, options = {}) {
  const text = String(value ?? '').trim();
  if (options.required && !text) throw httpError(400, `${name}不能为空`);
  if (options.max && text.length > options.max) throw httpError(400, `${name}不能超过 ${options.max} 个字符`);
  return text;
}

function asNumber(value, name, options = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw httpError(400, `${name}必须是有效数字`);
  if (options.min !== undefined && number < options.min) throw httpError(400, `${name}不能小于 ${options.min}`);
  if (options.max !== undefined && number > options.max) throw httpError(400, `${name}不能大于 ${options.max}`);
  return number;
}

function asInteger(value, name, options = {}) {
  const number = asNumber(value, name, options);
  if (!Number.isInteger(number)) throw httpError(400, `${name}必须是整数`);
  return number;
}

function asBoolean(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(value, max = 1000) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatDate(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = {
  asBoolean,
  asInteger,
  asNumber,
  asString,
  asyncHandler,
  escapeHtml,
  formatDate,
  httpError,
  round,
  safeEqual,
  sleep,
  truncate
};
