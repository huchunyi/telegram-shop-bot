'use strict';

const { openDatabase } = require('./db');
const { AuthService } = require('./auth');
const { PaymentService } = require('./payments');
const { OrderService } = require('./orders');
const { BotManager } = require('./bot');
const { createServer } = require('./server');

if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error('本程序需要 Node.js 18 或更高版本。');
  process.exit(1);
}

async function main() {
const store = await openDatabase();
const auth = new AuthService(store);
const paymentService = new PaymentService(store);
const orderService = new OrderService(store, paymentService);
const bot = new BotManager(store, orderService);

paymentService.setOrderService(orderService);
orderService.setBot(bot);

const app = createServer({ store, auth, bot, orderService, paymentService });
const settings = store.getSettings();
const port = Number(process.env.SHOP_PORT || settings.web_port || 50000);
const host = process.env.SHOP_HOST || '0.0.0.0';

const server = app.listen(port, host, () => {
  console.log('');
  console.log('盛世王朝 SHOP BOT 已启动');
  console.log(`管理后台：http://127.0.0.1:${port}/admin`);
  console.log(`数据库：${store.dbPath}`);
  if (store.firstRun) {
    console.log(`首次运行登录信息已写入：${require('path').join(process.cwd(), 'login.txt')}`);
  }
  if (!settings.telegram_bot_token) {
    console.log('Telegram Bot Token 尚未配置，请登录后台后在“系统设置”中填写。');
  }
  console.log('');
});

auth.cleanup();
setInterval(() => auth.cleanup(), 60 * 60 * 1000).unref();
bot.start();
paymentService.start();

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在安全停止服务…`);
  bot.stop();
  paymentService.stop();
  server.close(() => {
    try { store.db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.on('error', (error) => {
  console.error('Web 服务启动失败：', error.message);
  process.exit(1);
});
}

main().catch((error) => {
  console.error('程序启动失败：', error);
  process.exit(1);
});
