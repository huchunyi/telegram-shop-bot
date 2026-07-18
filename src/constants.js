'use strict';

const path = require('path');

const APP_NAME = '盛世王朝的SHOP BOT';
const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const DEFAULT_SETTINGS = Object.freeze({
  bot_name: APP_NAME,
  telegram_bot_token: '',
  telegram_admin_id: '6078247461',
  order_timeout_min: '30',
  usdt_cny_rate: '7',
  web_port: '50000',
  public_base_url: '',
  open_source_url: 'https://github.com/sswc01/'
});

const ORDER_STATUS = Object.freeze({
  PENDING_PAYMENT: 'pending_payment',
  EXPIRED: 'expired',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  PENDING_MANUAL: 'pending_manual',
  CANCELLED: 'cancelled'
});

const PAYMENT_MODES = Object.freeze({
  TRC20: 'trc20_usdt',
  OKPAY: 'okpay',
  EPAY: 'epay'
});

const STATUS_LABELS = Object.freeze({
  pending_payment: '待付款',
  expired: '已超时',
  processing: '处理中',
  completed: '已完成',
  pending_manual: '待处理',
  cancelled: '已取消'
});

function resolveDataDir() {
  const configured = process.env.SHOP_DATA_DIR || path.join(process.cwd(), 'data');
  return path.resolve(configured);
}

module.exports = {
  APP_NAME,
  DEFAULT_SETTINGS,
  ORDER_STATUS,
  PAYMENT_MODES,
  STATUS_LABELS,
  USDT_TRC20_CONTRACT,
  resolveDataDir
};
