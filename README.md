# 盛世王朝 Telegram SHOP BOT

一套基于 Telegram Bot API 的自动售货系统。客户在 Telegram 内完成选购、下单、支付和查询订单，管理员通过 Web 后台管理商品、库存、订单、支付通道、客服和广播。
**本项目除了传动的自动发卡功能外，还添加了自动API发货功能，并且拥有丰富的自定义参数扩展，使用场景例如：A提供L4服务且提供付费测试，可以通过添加API商品并设置自定义参数实现用户付款后自动完成攻击测试**

**TG频道 @sswcnet**

## 运行要求

- Node.js 18 或更高版本。
- npm。
- Linux、Windows 或其他可运行 Node.js 的系统。
- 一个通过 BotFather 创建的 Telegram Bot。
- 至少一个可用的支付通道。
- 生产环境建议准备域名和 HTTPS 反向代理。

不需要单独安装 SQLite 服务。项目使用本地数据库文件，首次运行时自动初始化。

## 快速安装

下载项目后进入项目目录：

```bash
npm ci --omit=dev
npm start
```

程序默认监听：

```text
http://0.0.0.0:50000
```

管理后台地址：

```text
http://服务器IP:50000/admin
```

首次运行会自动生成：

```text
data/shop.sqlite
data/uploads/support/
data/uploads/broadcasts/
login.txt
```

`login.txt` 中包含初始后台账号和随机生成的 16 位密码。默认用户名为 `admin`。首次登录后应立即修改密码，并删除 `login.txt`。

数据库已经存在时，程序只会加载和升级现有数据库结构，不会重新生成管理员账号或覆盖业务数据。

## 首次配置

系统默认设置如下（请尽快修改）：

| 设置项 | 默认值 |
| --- | --- |
| Bot 名称 | 盛世王朝的SHOP BOT |
| Telegram Bot Token | 空 |
| Telegram 管理员 ID | 6078247461 |
| 订单超时时间 | 30 分钟 |
| USDT/CNY 汇率 | 7 |
| Web 监听端口 | 50000 |
| 公网访问地址 | 空 |

**发布前请把默认 Telegram 管理员 ID 修改为自己的账号 ID。我不想收到你们的订单通知！**

## API 商品配置示例

假设商品包含以下扩展字段：

| 显示名称 | 字段 | 类型 |
| --- | --- | --- |
| 服务器 | server | 选择项 |
| 游戏账号 | account | 文本项 |

API 地址可以填写：

```text
https://api.example.com/deliver?quantity=[num]&server=[server]&account=[account]
```

用户购买 2 件、选择 `Asia` 并输入账号 `test@example.com` 后，系统会将变量编码并替换到请求 URL。

如果上游返回：

```json
{"code":0,"message":"SUCCESS"}
```

商品成功标志可填写：

```text
SUCCESS
```

重试 API 订单会再次请求上游接口。上游接口最好支持业务幂等，避免网络超时后重复提交。


## 功能概览

### Telegram 客户端

- `/start` 启动商店，展示选购、历史订单、联系客服和开源项目入口（正式运营建议删除）。
- 按分类浏览商品，商品介绍支持 Telegram Markdown。
- 下单时依次填写数量和商品扩展参数（后台充分自定义）。
- 扩展参数支持选择项和文本输入项，可作为 API 发货变量使用。
- 支持 TRC20-USDT、OKPay 和通用易支付三种付款方式，可添加多通道。
- 历史订单，可查看付款状态、处理状态和发货结果。
- 已付款但自动处理失败的订单，客户可以申请自动重试。
- 客服模式，支持直接通过shop bot联系客服，支持文本、图片和文件，发送 `/cancel` 退出客服会话。

Telegram 管理员账号只接收系统通知，不在 Bot 内处理商品和订单。

### 商品和库存

- 分类支持新增、编辑、删除、启用和停用。
- 分类可通过拖拽调整 Telegram 内的展示顺序。
- 商品必须归属于一个分类，同分类商品支持拖拽排序。
- 商品包含名称、介绍、USDT 价格、单次最大购买数量和购买后提示。
- 商品类型分为自动发卡和自动 API 发货。
- 商品扩展字段支持多个选择项或文本项。
- 自动发卡商品支持批量导入卡密，一行一条。
- 卡密可按已使用和未使用状态查看，并支持编辑和删除。
- 下单前检查库存，付款发货时再次通过事务检查和扣减，避免并发超卖。
- 付款后库存不足时，订单转为待处理，不会错误标记为已完成。

### 自动 API 发货

- 以 HTTP GET 请求调用商品配置的 API 地址。
- 内置 `[num]` 变量，代表购买数量。
- 商品扩展字段可作为自定义变量，例如 `[account]`、`[server]`。
- 变量在替换前会进行 URL 编码。
- 配置成功标志后，响应正文包含该标志才算发货成功。
- 成功标志留空时，请求完成即视为提交成功；网络错误仍会进入待处理状态。
- API 原始响应保存在订单记录中，并发送给 Telegram 管理员。
- 客户只会看到“自动发货成功”或统一的失败提示，不会看到接口正文。

### 订单管理

- 永久保留已付款、未付款、已超时和已取消订单。
- 订单保存商品快照、数量、价格、扩展参数、购买者 Telegram ID、通道信息和时间。
- 记录订单创建、付款、发货、重试、回调和异常等事件。
- 后台支持按订单号、商品、Telegram ID、用户名和状态筛选。
- 待处理订单可以重新执行默认发货流程。
- 后台补单支持两种方式：
  - 执行默认流程，重新取卡或重新请求商品 API。
  - 填写自定义发货内容并直接发送给客户。
- 默认补单方式为执行商品原有的自动发货流程。

### 客服系统

- 客户发送的文本、图片和文件会保存到本地数据库及附件目录。
- 后台采用双栏会话界面，左侧切换客户，右侧显示当前聊天。
- 当前会话和会话列表自动更新。
- 消息区使用独立滚动条，发送栏固定在聊天窗口底部。
- 管理员可以回复文本、图片和文件。
- 后台可查看图片，并下载客户或管理员发送的文件。

### 广播通知

- 向所有使用过 Bot 的客户发送广播。
- 支持纯文本、图片、文件以及图片加文字。
- 广播任务实时显示总人数、成功数、失败数和当前进度。
- Telegram 管理员 ID 不会被加入客户广播列表。

### Web 管理后台

- 首页展示今日订单、历史订单、今日交易额、累计交易额、待处理事项和近 7 日流水。
- 分类、商品、卡密、订单、客服、支付通道、广播和系统设置集中管理。
- 支持明暗主题切换。
- 后台使用动态请求加载数据，不需要整页刷新。

## 支付方式

### TRC20-USDT

每个 TRC20 通道需要填写一个 TRON 主网收款地址，可选填 TronGrid API Key。系统支持同时配置多个 TRC20 通道，并监听所有启用通道以及未过期订单中保存的地址快照。
每笔订单通过商品金额上增加 `0.001` 至 `0.099 USDT` 的随机尾数以识别订单。

### OKPay

OKPay 通道需要填写 App ID、密钥和 API 地址（api保持默认即可）。

系统使用 `payLink` 创建支付链接，通过以下两种方式确认付款：

- 接收 OKPay 的订单回调。
- 每 5 秒调用 `checkDeposit` 主动查询未过期订单。

如果 OKPay 拒绝 `callback_url`，系统会自动移除该参数重新创建订单，并切换为主动查询。此情况会写入订单事件和服务日志。HTTP 地址、裸 IP 或带高位端口的地址可能被支付服务商判定为风险地址；生产环境建议使用 HTTPS 域名。

### 通用易支付

易支付通道需要填写：

- 支付程序 URL。
- 商户 ID，也就是 PID。
- 商户密钥，也就是 KEY。
- 支付类型，支持 `alipay` 和 `wxpay`。

商品 USDT 价格会按照后台设置的 USDT/CNY 汇率换算为人民币，并保留两位小数。
系统同时接收异步通知，并每 5 秒主动查询未过期订单。

## 环境变量（高级选项）

可用环境变量见 `.env.example`：

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `SHOP_DATA_DIR` | 数据库和附件目录 | 当前运行目录下的 `data` |
| `SHOP_PORT` | Web 监听端口，设置后优先于后台配置 | 后台设置值或 50000 |
| `SHOP_HOST` | Web 监听地址 | `0.0.0.0` |
| `SHOP_TRUST_PROXY` | 反向代理后设为 `1` | `0` |
| `NODE_ENV` | 运行环境 | 未设置 |

程序不会自动读取 `.env` 文件。需要通过 Shell、systemd、Docker 或进程管理器注入变量。

Linux 临时设置示例：

```bash
SHOP_DATA_DIR=/opt/tg-shop-bot/data \
SHOP_PORT=50000 \
SHOP_HOST=127.0.0.1 \
SHOP_TRUST_PROXY=1 \
npm start
```

PowerShell 示例：

```powershell
$env:SHOP_DATA_DIR = "C:\tg-shop-bot\data"
$env:SHOP_PORT = "50000"
$env:SHOP_HOST = "0.0.0.0"
npm start
```

## Linux 常驻部署

下面以 `/opt/tg-shop-bot` 为安装目录、`shopbot` 为运行用户。

### 1. 创建运行用户和目录

```bash
sudo useradd --system --home /opt/tg-shop-bot --shell /usr/sbin/nologin shopbot
sudo mkdir -p /opt/tg-shop-bot
sudo chown -R shopbot:shopbot /opt/tg-shop-bot
```

### 2. 下载代码并安装依赖

将仓库地址替换为自己的 GitHub 地址：

```bash
sudo -u shopbot git clone <仓库地址> /opt/tg-shop-bot
cd /opt/tg-shop-bot
sudo -u shopbot npm ci --omit=dev
```

如果目录已经存在且不为空，请先将代码上传到该目录，不要重复执行 `git clone`。

### 3. 安装 systemd 服务

项目提供 `deploy/shop-bot.service.example`：

```bash
sudo cp deploy/shop-bot.service.example /etc/systemd/system/shop-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now shop-bot
sudo systemctl status shop-bot
```

查看实时日志：

```bash
sudo journalctl -u shop-bot -f
```

重启和停止：

```bash
sudo systemctl restart shop-bot
sudo systemctl stop shop-bot
```

如果 Node.js 不在 `/usr/bin/node`，先运行以下命令确认路径，再修改服务文件中的 `ExecStart`：

```bash
command -v node
```

## Nginx 和 HTTPS

生产环境不建议直接把 50000 端口暴露到公网。可以让程序只监听 `127.0.0.1`，由 Nginx 提供 HTTPS。

systemd 服务中增加或修改：

```ini
Environment=SHOP_HOST=127.0.0.1
Environment=SHOP_TRUST_PROXY=1
```

Nginx 配置示例：

```nginx
server {
    listen 80;
    server_name shop.example.com;

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name shop.example.com;

    ssl_certificate /etc/letsencrypt/live/shop.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/shop.example.com/privkey.pem;

    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:50000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

修改配置后检查并重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

然后在后台“系统设置”中填写：

```text
https://shop.example.com
```

系统会生成以下回调地址：

```text
https://shop.example.com/callbacks/okpay/{通道ID}
https://shop.example.com/callbacks/epay/{通道ID}
```

回调路径不需要后台登录。不要在 Nginx 中统一拦截 `/callbacks/`，否则支付服务商无法通知系统。

## Windows 运行

安装 Node.js 18 或更高版本后，在 PowerShell 中执行：

```powershell
cd "C:\tg-shop-bot"
npm ci --omit=dev
npm start
```

后台地址为：

```text
http://127.0.0.1:50000/admin
```

Windows 防火墙需要放行端口后，局域网或公网设备才能访问。生产环境仍建议使用反向代理和 HTTPS，不建议直接开放管理端口。

## 数据目录和备份

默认数据目录结构：

```text
data/
├── shop.sqlite
└── uploads/
    ├── broadcasts/
    └── support/
```

数据库包含管理员密码哈希、系统设置、分类、商品、卡密、订单、事件、客服记录和广播记录。附件保存在 `uploads` 目录中，因此备份时需要复制整个 `data` 目录。

为了得到一致的备份，建议先停止服务：

```bash
sudo systemctl stop shop-bot
sudo tar -czf /var/backups/tg-shop-bot-$(date +%F-%H%M).tar.gz -C /opt/tg-shop-bot data
sudo systemctl start shop-bot
```

恢复备份：

```bash
sudo systemctl stop shop-bot
sudo mv /opt/tg-shop-bot/data /opt/tg-shop-bot/data.before-restore
sudo tar -xzf /var/backups/tg-shop-bot-YYYY-MM-DD-HHMM.tar.gz -C /opt/tg-shop-bot
sudo chown -R shopbot:shopbot /opt/tg-shop-bot/data
sudo systemctl start shop-bot
```

确认恢复成功后再删除 `data.before-restore`。

## 安全建议

- 首次登录后立即修改后台密码并删除 `login.txt`。
- 不要把 `data`、`.env`、日志和登录信息提交到 GitHub。
- 后台尽量只通过 HTTPS、VPN 或 IP 白名单访问。
- 反向代理后设置 `SHOP_TRUST_PROXY=1`。
- Telegram Bot Token、支付密钥和 TronGrid Key 不要写入公开文档或截图。
- 定期备份整个数据目录，并测试备份是否可以恢复。
- API 发货接口应使用 HTTPS，并限制参数权限。
- 需要重试的上游接口应实现幂等。
- 不要同时运行多个使用同一 Telegram Bot Token 的实例，否则 `getUpdates` 会发生冲突。

## 常见问题

### Bot 已连接但不回复消息

检查服务日志：

```bash
sudo journalctl -u shop-bot -f
```

确认以下事项：

- Token 来自 BotFather，并且没有多余空格。
- 没有另一台服务器或另一个进程使用相同 Token 轮询。
- Bot 没有被配置为其他程序的 Webhook。
- 服务器可以访问 `api.telegram.org`。
- 后台显示“消息轮询”正在运行。

如果该 Bot 以前使用过 Webhook，可以先删除旧 Webhook：

```bash
curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook?drop_pending_updates=false"
```

### OKPay 付款后确认较慢

系统每 5 秒主动查询一次待付款订单。通常还需要加上支付服务商响应和自动发货所需时间。

如果订单事件中出现 `okpay_callback_rejected`，说明 OKPay 拒绝了该订单的回调地址，当前订单依靠主动查询确认。请检查公网地址是否为可访问的 HTTPS 域名，并确认 Nginx 没有拦截 `/callbacks/okpay/`。

### TRC20 已付款但没有匹配订单

检查以下内容：

- 交易是否已经确认。
- 转入 Token 是否为官方 USDT 合约。
- 实际到账金额是否与订单金额完全一致。
- 收款地址是否与订单显示的地址一致。
- 付款是否发生在订单有效期内。
- TronGrid 是否返回限流或网络错误。

### 修改后台端口后没有生效

后台端口需要重启程序后生效。如果设置了 `SHOP_PORT` 环境变量，它会覆盖后台保存的端口设置。

### 忘记备份附件

客服图片、文件和广播附件不存储在数据库正文中。只复制 `shop.sqlite` 会丢失附件，必须备份整个 `data` 目录。

## 项目目录

```text
.
├── deploy/                 systemd 服务示例
├── public/                 Web 管理后台静态文件
├── src/                    服务端、Bot、支付和订单代码
├── .env.example            环境变量示例
├── .gitignore              Git 忽略规则
├── package-lock.json       npm 依赖锁定文件
├── package.json            Node.js 项目配置
└── README.md               项目说明
```


## 开发和测试

开发模式：

```bash
npm run dev
```

语法检查：

```bash
npm run check
```

运行测试：

```bash
npm test
```
