'use strict';

const fs = require('fs');
const path = require('path');
const { fetchWithTimeout } = require('./payments');
const { truncate } = require('./utils');

class TelegramApi {
  constructor(token) {
    this.token = token;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async call(method, payload = {}, timeoutMs = 20_000) {
    const response = await fetchWithTimeout(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json;charset=UTF-8' },
      body: JSON.stringify(payload)
    }, timeoutMs);
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      const error = new Error(data?.description || `Telegram API HTTP ${response.status}`);
      error.status = response.status;
      error.errorCode = data?.error_code;
      error.parameters = data?.parameters;
      throw error;
    }
    return data.result;
  }

  async callMultipart(method, fields, fileField, buffer, filename, mimeType) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields || {})) {
      if (value === undefined || value === null) continue;
      form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    form.append(fileField, new Blob([buffer], { type: mimeType || 'application/octet-stream' }), filename || 'upload.bin');
    const response = await fetchWithTimeout(`${this.baseUrl}/${method}`, { method: 'POST', body: form }, 60_000);
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      const error = new Error(data?.description || `Telegram API HTTP ${response.status}`);
      error.status = response.status;
      error.errorCode = data?.error_code;
      error.parameters = data?.parameters;
      throw error;
    }
    return data.result;
  }

  getUpdates(offset, timeout = 25) {
    return this.call('getUpdates', {
      offset,
      timeout,
      limit: 100,
      allowed_updates: ['message', 'callback_query']
    }, (timeout + 10) * 1000);
  }

  getMe() {
    return this.call('getMe');
  }

  sendMessage(chatId, text, options = {}) {
    return this.call('sendMessage', { chat_id: chatId, text, ...options });
  }

  editMessageText(chatId, messageId, text, options = {}) {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...options });
  }

  answerCallbackQuery(id, text = '') {
    return this.call('answerCallbackQuery', { callback_query_id: id, text, show_alert: false });
  }

  async sendPhotoBuffer(chatId, buffer, options = {}) {
    return this.callMultipart('sendPhoto', {
      chat_id: chatId,
      caption: options.caption,
      parse_mode: options.parse_mode,
      reply_markup: options.reply_markup
    }, 'photo', buffer, options.filename || 'image.png', options.mimeType || 'image/png');
  }

  async sendDocumentBuffer(chatId, buffer, options = {}) {
    return this.callMultipart('sendDocument', {
      chat_id: chatId,
      caption: options.caption,
      parse_mode: options.parse_mode,
      reply_markup: options.reply_markup
    }, 'document', buffer, options.filename || 'document.bin', options.mimeType || 'application/octet-stream');
  }

  async sendLocalFile(chatId, localPath, options = {}) {
    const buffer = fs.readFileSync(localPath);
    if (options.kind === 'photo') return this.sendPhotoBuffer(chatId, buffer, { ...options, filename: options.filename || path.basename(localPath) });
    return this.sendDocumentBuffer(chatId, buffer, { ...options, filename: options.filename || path.basename(localPath) });
  }

  async downloadFile(fileId) {
    const info = await this.call('getFile', { file_id: fileId });
    if (!info?.file_path) throw new Error('Telegram 未返回文件路径');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${info.file_path}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`下载 Telegram 文件失败：HTTP ${response.status}`);
      return { buffer: Buffer.from(await response.arrayBuffer()), filePath: info.file_path };
    } finally {
      clearTimeout(timer);
    }
  }
}

function describeTelegramError(error) {
  return truncate(error?.message || String(error), 500);
}

module.exports = { TelegramApi, describeTelegramError };
