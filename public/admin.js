'use strict';

function preferredTheme() {
  try {
    const saved = localStorage.getItem('admin-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {}
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme, persist = false) {
  const selected = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = selected;
  document.documentElement.style.colorScheme = selected;
  if (persist) {
    try { localStorage.setItem('admin-theme', selected); } catch {}
  }
  const button = document.querySelector('#theme-btn');
  if (button) {
    button.textContent = selected === 'dark' ? '☀ 浅色' : '☾ 深色';
    button.title = selected === 'dark' ? '切换到浅色主题' : '切换到深色主题';
  }
}

applyTheme(preferredTheme());

const state = {
  csrf: '',
  route: 'dashboard',
  categories: [],
  products: [],
  orderPage: 1,
  orderFilters: {},
  selectedThread: null,
  supportTimer: null,
  supportRefreshRunning: false,
  broadcastTimer: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const page = $('#page');

function e(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmtDate(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(value));
}

function money(value, digits = 2) {
  return Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const statusNames = {
  pending_payment: '待付款', expired: '已超时', processing: '处理中', completed: '已完成',
  pending_manual: '待处理', cancelled: '已取消', paid: '已付款', unpaid: '未付款',
  queued: '排队中', running: '发送中'
};

function badge(status, label) {
  return `<span class="badge ${e(status)}">${e(label || statusNames[status] || status)}</span>`;
}

function loading() {
  page.innerHTML = '<div class="loading"><div><div class="spinner"></div>正在加载数据…</div></div>';
}

function empty(symbol, title, description) {
  return `<div class="empty-state"><div><div class="empty-symbol">${e(symbol)}</div><h4>${e(title)}</h4><p>${e(description)}</p></div></div>`;
}

function toast(message, type = 'success') {
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.textContent = message;
  $('#toast-root').append(item);
  setTimeout(() => item.remove(), 3600);
}

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = { ...(options.headers || {}) };
  let body = options.body;
  if (!['GET', 'HEAD'].includes(method)) headers['x-csrf-token'] = state.csrf;
  if (body && !(body instanceof FormData) && typeof body !== 'string') {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const response = await fetch(`/api${path}`, { ...options, method, headers, body });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    showLogin();
    throw new Error(data.error || '登录已过期');
  }
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function showLogin() {
  state.csrf = '';
  $('#app-shell').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
  setTimeout(() => $('#login-form input[name=password]')?.focus(), 20);
}

function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
}

function updateBotStatus(bot) {
  const card = $('#bot-status-card');
  card.classList.toggle('online', Boolean(bot?.ready));
  $('div span', card).textContent = bot?.ready ? `@${bot.username}` : (bot?.lastError || '未配置或未连接');
}

async function boot() {
  try {
    const data = await api('/auth/me');
    state.csrf = data.csrfToken;
    showApp();
    updateBotStatus(data.bot);
    route();
  } catch {
    showLogin();
  }
}

const routeTitles = {
  dashboard: '后台首页', categories: '分类列表', products: '商品列表', orders: '订单列表',
  support: '客服系统', payments: '支付通道', broadcast: '广播通知', settings: '系统设置'
};

function clearPageTimers() {
  if (state.supportTimer) clearInterval(state.supportTimer);
  if (state.broadcastTimer) clearInterval(state.broadcastTimer);
  state.supportTimer = null;
  state.broadcastTimer = null;
}

async function route() {
  clearPageTimers();
  const name = location.hash.replace(/^#/, '') || 'dashboard';
  state.route = routeTitles[name] ? name : 'dashboard';
  page.classList.toggle('support-page', state.route === 'support');
  $('#page-title').textContent = routeTitles[state.route];
  $$('.nav button').forEach((button) => button.classList.toggle('active', button.dataset.route === state.route));
  $('.sidebar').classList.remove('open');
  loading();
  try {
    const renders = {
      dashboard: renderDashboard, categories: renderCategories, products: renderProducts,
      orders: renderOrders, support: renderSupport, payments: renderPayments,
      broadcast: renderBroadcast, settings: renderSettings
    };
    await renders[state.route]();
  } catch (error) {
    page.innerHTML = empty('!', '页面加载失败', error.message);
  }
}

function openModal({ title, body, size = '', footer = '' }) {
  $('#modal-root').innerHTML = `
    <div class="modal-backdrop" data-action="close-modal-bg">
      <section class="modal ${e(size)}" role="dialog" aria-modal="true" aria-label="${e(title)}">
        <header class="modal-head"><h3>${e(title)}</h3><button class="modal-close" data-action="close-modal" aria-label="关闭">×</button></header>
        <div class="modal-body">${body}</div>
        ${footer ? `<footer class="modal-foot">${footer}</footer>` : ''}
      </section>
    </div>`;
}

function closeModal() {
  $('#modal-root').innerHTML = '';
}

async function confirmDialog(title, description, confirmText = '确认删除') {
  return new Promise((resolve) => {
    openModal({
      title,
      body: `<p style="color:var(--muted);margin:0">${e(description)}</p>`,
      footer: `<button class="btn btn-quiet" data-action="confirm-no">取消</button><button class="btn btn-danger" data-action="confirm-yes">${e(confirmText)}</button>`
    });
    const root = $('#modal-root');
    root.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'confirm-yes') { closeModal(); resolve(true); }
      if (['confirm-no', 'close-modal', 'close-modal-bg'].includes(action)) { closeModal(); resolve(false); }
    }, { once: false });
  });
}

async function renderDashboard() {
  const data = await api('/dashboard');
  updateBotStatus(data.bot);
  $('#pending-badge').textContent = data.metrics.pendingOrders;
  $('#pending-badge').classList.toggle('hidden', !data.metrics.pendingOrders);
  $('#support-badge').textContent = data.metrics.unreadSupport;
  $('#support-badge').classList.toggle('hidden', !data.metrics.unreadSupport);
  page.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">REAL-TIME OVERVIEW</p><h3>运营概览</h3><p>订单、成交与待办数据。</p></div>
      <div class="head-actions"><button class="btn btn-secondary" data-route-link="orders">查看订单</button><button class="btn btn-primary" data-route-link="products">管理商品</button></div>
    </div>
    <section class="stats-grid">
      <article class="stat-card"><span class="stat-label">今日订单</span><strong>${data.metrics.todayOrders}</strong><p class="stat-delta">历史累计 ${data.metrics.totalOrders} 笔</p></article>
      <article class="stat-card accent"><span class="stat-label">今日交易额</span><strong>$${money(data.metrics.todayRevenue)}</strong><p class="stat-delta">按付款成功时间统计</p></article>
      <article class="stat-card"><span class="stat-label">历史交易额</span><strong>$${money(data.metrics.totalRevenue)}</strong><p class="stat-delta">全渠道 USDT 口径</p></article>
      <article class="stat-card"><span class="stat-label">当前待办</span><strong>${data.metrics.pendingOrders + data.metrics.unreadSupport}</strong><p class="stat-delta">${data.metrics.pendingOrders} 个订单 · ${data.metrics.unreadSupport} 条客服未读</p></article>
    </section>
    <section class="dashboard-grid">
      <article class="panel"><div class="panel-head"><div><h4>近 7 日流水</h4><span>已付款订单交易额 / USDT</span></div><span>自动更新</span></div><div class="chart-wrap"><canvas id="revenue-chart"></canvas></div></article>
      <article class="panel"><div class="panel-head"><div><h4>最新订单</h4><span>最近进入系统的 8 笔订单</span></div><button class="link-btn" data-route-link="orders">全部订单</button></div>
        <div class="quick-list">${data.recentOrders.length ? data.recentOrders.map((order) => `
          <button class="quick-item link-btn" data-action="view-order" data-id="${order.id}">
            <span><strong>${e(order.product_name)}</strong><span>${e(order.order_no)} · ${fmtDate(order.created_at)}</span></span>
            <span class="amount">$${money(order.amount_usdt)}</span>
          </button>`).join('') : empty('≡', '暂无订单', '有用户下单后会显示在这里')}</div>
      </article>
    </section>`;
  drawChart(data.chart);
}

function drawChart(points) {
  const canvas = $('#revenue-chart');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = rect.width; const h = rect.height; const pad = { l: 44, r: 14, t: 15, b: 31 };
  const max = Math.max(1, ...points.map((item) => Number(item.revenue)));
  const styles = getComputedStyle(document.documentElement);
  const chartAccent = styles.getPropertyValue('--accent').trim();
  const chartAccentSoft = styles.getPropertyValue('--accent-soft').trim();
  const chartFaint = styles.getPropertyValue('--faint').trim();
  const chartLine = styles.getPropertyValue('--line').trim();
  ctx.font = '10px system-ui'; ctx.fillStyle = chartFaint; ctx.strokeStyle = chartLine; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.t + (h - pad.t - pad.b) * i / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(money(max * (4 - i) / 4, max < 10 ? 1 : 0), 2, y + 3);
  }
  const xStep = (w - pad.l - pad.r) / Math.max(1, points.length - 1);
  const coords = points.map((item, index) => ({ x: pad.l + xStep * index, y: pad.t + (h - pad.t - pad.b) * (1 - Number(item.revenue) / max) }));
  const gradient = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  gradient.addColorStop(0, chartAccentSoft); gradient.addColorStop(1, 'transparent');
  ctx.beginPath(); coords.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.lineTo(coords.at(-1).x, h - pad.b); ctx.lineTo(coords[0].x, h - pad.b); ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
  ctx.beginPath(); coords.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.strokeStyle = chartAccent; ctx.lineWidth = 2; ctx.stroke();
  points.forEach((item, index) => { const p = coords[index]; ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fillStyle = chartAccent; ctx.fill(); ctx.fillStyle = chartFaint; ctx.textAlign = 'center'; ctx.fillText(item.date, p.x, h - 9); });
}

function pageHead(kicker, title, description, actions = '') {
  return `<div class="page-head"><div><p class="eyebrow">${e(kicker)}</p><h3>${e(title)}</h3><p>${e(description)}</p></div><div class="head-actions">${actions}</div></div>`;
}

async function renderCategories() {
  state.categories = await api('/categories');
  page.innerHTML = pageHead('CATALOG STRUCTURE', '分类列表', '拖拽调整 Bot 内分类展示顺序；分类之间相互独立。', '<button class="btn btn-primary" data-action="new-category">＋ 新建分类</button>') +
    (state.categories.length ? `<div class="table-wrap"><table><thead><tr><th></th><th>分类</th><th>商品数</th><th>状态</th><th>更新时间</th><th></th></tr></thead><tbody id="category-sort">${state.categories.map((item) => `
      <tr draggable="true" data-id="${item.id}"><td class="drag-handle">⠿</td><td><div class="cell-title">${e(item.name)}</div><div class="cell-sub">${e(item.description || '暂无说明')}</div></td><td>${item.product_count}</td><td>${item.enabled ? badge('success', '展示中') : badge('neutral', '已隐藏')}</td><td>${fmtDate(item.updated_at)}</td><td><div class="cell-actions"><button class="btn btn-quiet btn-sm" data-action="edit-category" data-id="${item.id}">编辑</button><button class="btn btn-danger btn-sm" data-action="delete-category" data-id="${item.id}">删除</button></div></td></tr>`).join('')}</tbody></table></div>` : empty('◫', '还没有分类', '创建第一个分类后即可继续添加商品。'));
  setupSortable($('#category-sort'), async (ids) => { await api('/category-order', { method: 'PUT', body: { ids } }); toast('分类顺序已保存'); });
}

function categoryModal(item = null) {
  openModal({
    title: item ? '编辑分类' : '新建分类',
    body: `<form id="category-form" data-id="${item?.id || ''}">
      <label class="field"><span>分类名称</span><input name="name" required maxlength="80" value="${e(item?.name || '')}" placeholder="例如：数字账号"></label>
      <label class="field"><span>分类说明</span><textarea name="description" maxlength="500" placeholder="仅在后台用于辨识，可留空">${e(item?.description || '')}</textarea></label>
      <label class="check"><input type="checkbox" name="enabled" ${item?.enabled !== 0 ? 'checked' : ''}> 在 Bot 中展示此分类</label>
    </form>`,
    footer: '<button class="btn btn-quiet" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="submit-category">保存分类</button>'
  });
}

function setupSortable(container, onSave) {
  if (!container) return;
  let dragged = null;
  container.addEventListener('dragstart', (event) => { dragged = event.target.closest('[data-id]'); dragged?.classList.add('dragging'); });
  container.addEventListener('dragend', async () => {
    dragged?.classList.remove('dragging');
    $$('.drag-over', container).forEach((row) => row.classList.remove('drag-over'));
    const ids = $$(':scope > [data-id]', container).map((row) => Number(row.dataset.id));
    dragged = null;
    try { await onSave(ids); } catch (error) { toast(error.message, 'error'); route(); }
  });
  container.addEventListener('dragover', (event) => {
    event.preventDefault();
    const target = event.target.closest('[data-id]');
    if (!dragged || !target || target === dragged) return;
    $$('.drag-over', container).forEach((row) => row.classList.remove('drag-over'));
    target.classList.add('drag-over');
    const box = target.getBoundingClientRect();
    target.parentNode.insertBefore(dragged, event.clientY < box.top + box.height / 2 ? target : target.nextSibling);
  });
}

async function renderProducts() {
  [state.products, state.categories] = await Promise.all([api('/products'), api('/categories')]);
  const groups = state.categories.map((category) => ({ category, products: state.products.filter((product) => product.category_id === category.id) }));
  page.innerHTML = pageHead('PRODUCT & FULFILLMENT', '商品列表', '商品按分类展示；自动发卡库存与 API 发货配置集中管理。', '<button class="btn btn-primary" data-action="new-product">＋ 新建商品</button>') +
    (!state.categories.length ? empty('◇', '请先创建分类', '每件商品必须归属于一个固定的上游分类。') : groups.map(({ category, products }) => `
      <section class="panel" style="margin-bottom:14px">
        <div class="panel-head"><div><h4>${e(category.name)}</h4><span>${products.length} 件商品 · 拖拽调整同分类顺序</span></div>${category.enabled ? badge('success', '分类展示中') : badge('neutral', '分类已隐藏')}</div>
        ${products.length ? `<div class="table-wrap"><table><thead><tr><th></th><th>商品</th><th>价格 / 限购</th><th>发货方式</th><th>库存</th><th>状态</th><th></th></tr></thead><tbody class="product-sort" data-category="${category.id}">${products.map((item) => `
          <tr draggable="true" data-id="${item.id}"><td class="drag-handle">⠿</td><td><div class="cell-title">${e(item.name)}</div><div class="cell-sub">${e((item.description || '暂无介绍').slice(0, 60))}</div></td><td><strong>$${money(item.price_usdt)}</strong><div class="cell-sub">最多 ${item.max_quantity} 件</div></td><td>${item.product_type === 'card' ? badge('success', '自动发卡') : badge('warning', 'API 发货')}</td><td>${item.product_type === 'card' ? `<strong>${item.available_stock || 0}</strong><span class="cell-sub"> / ${item.total_stock || 0}</span>` : '—'}</td><td>${item.enabled ? badge('success', '上架') : badge('neutral', '下架')}</td><td><div class="cell-actions">${item.product_type === 'card' ? `<button class="btn btn-secondary btn-sm" data-action="manage-cards" data-id="${item.id}">卡密管理</button>` : ''}<button class="btn btn-quiet btn-sm" data-action="edit-product" data-id="${item.id}">编辑</button><button class="btn btn-danger btn-sm" data-action="delete-product" data-id="${item.id}">删除</button></div></td></tr>`).join('')}</tbody></table></div>` : empty('◇', '分类下暂无商品', '点击右上角“新建商品”开始添加。')}
      </section>`).join(''));
  $$('.product-sort').forEach((container) => setupSortable(container, async (ids) => {
    await api('/product-order', { method: 'PUT', body: { category_id: Number(container.dataset.category), ids } });
    toast('商品顺序已保存');
  }));
}

function optionRow(option = {}) {
  const choices = Array.isArray(option.choices) ? option.choices.join(',') : (option.choices || '');
  return `<div class="option-row">
    <div class="option-row-grid">
      <label class="field" style="margin:0"><span>显示名称</span><input data-option="name" maxlength="50" value="${e(option.name || '')}" placeholder="例如：服务器"></label>
      <label class="field" style="margin:0"><span>变量字段</span><input data-option="field_key" maxlength="40" value="${e(option.field_key || '')}" placeholder="server"></label>
      <label class="field" style="margin:0"><span>类型</span><select data-option="option_type"><option value="choice" ${option.option_type === 'choice' ? 'selected' : ''}>选项类</option><option value="text" ${option.option_type === 'text' ? 'selected' : ''}>文本类</option></select></label>
      <button type="button" class="icon-btn danger" data-action="remove-option" title="删除选项">×</button>
    </div>
    <label class="field option-choices" style="${option.option_type === 'text' ? 'display:none' : ''}"><span>可选值（英文逗号分隔）</span><input data-option="choices" value="${e(choices)}" placeholder="A区,B区,C区"></label>
  </div>`;
}

function productModal(item = null) {
  if (!state.categories.length) return toast('请先创建分类', 'error');
  const options = item?.options || [];
  openModal({
    title: item ? '编辑商品' : '新建商品', size: 'wide',
    body: `<form id="product-form" data-id="${item?.id || ''}">
      <div class="form-grid">
        <label class="field"><span>商品名称</span><input name="name" required maxlength="120" value="${e(item?.name || '')}"></label>
        <label class="field"><span>上游分类</span><select name="category_id">${state.categories.map((category) => `<option value="${category.id}" ${category.id === item?.category_id ? 'selected' : ''}>${e(category.name)}</option>`).join('')}</select></label>
        <label class="field wide"><span>商品介绍（支持 Telegram Markdown）</span><textarea name="description" maxlength="8000" style="min-height:125px" placeholder="可使用 *粗体*、_斜体_ 等 Markdown 格式">${e(item?.description || '')}</textarea></label>
        <label class="field"><span>价格（USDT / 美元）</span><input name="price_usdt" type="number" min="0.000001" step="0.000001" required value="${item?.price_usdt ?? ''}"></label>
        <label class="field"><span>单次最大购买数量</span><input name="max_quantity" type="number" min="1" max="10000" required value="${item?.max_quantity ?? 1}"></label>
        <label class="field"><span>商品类型</span><select name="product_type"><option value="card" ${item?.product_type !== 'api' ? 'selected' : ''}>自动发卡</option><option value="api" ${item?.product_type === 'api' ? 'selected' : ''}>自动 API 发货</option></select></label>
        <label class="field"><span>状态</span><select name="enabled"><option value="1" ${item?.enabled !== 0 ? 'selected' : ''}>上架展示</option><option value="0" ${item?.enabled === 0 ? 'selected' : ''}>下架隐藏</option></select></label>
        <label class="field wide"><span>购买后提示（可留空）</span><textarea name="post_purchase_message" maxlength="4000" placeholder="发货成功后追加发送的提示消息">${e(item?.post_purchase_message || '')}</textarea></label>
      </div>
      <div id="api-fields" class="form-grid" style="${item?.product_type === 'api' ? '' : 'display:none'}">
        <label class="field wide"><span>发货 API URL</span><input name="api_url" maxlength="4000" value="${e(item?.api_url || '')}" placeholder="https://example.com/deliver?num=[num]&server=[server]"><span class="field-hint">系统变量 [num] 为数量；扩展字段可使用 [字段名]，请求时会自动替换并 URL 编码。</span></label>
        <label class="field wide"><span>API 成功标志（可留空）</span><input name="api_success_marker" maxlength="1000" value="${e(item?.api_success_marker || '')}" placeholder="success"><span class="field-hint">留空时，只要接口完成响应就视为提交成功。</span></label>
      </div>
      <div class="section-label"><div><strong>扩展选项</strong><div class="cell-sub">字段用于 API 变量，也会完整保存在订单中</div></div><button type="button" class="btn btn-secondary btn-sm" data-action="add-option">＋ 添加选项</button></div>
      <div id="option-list">${options.map(optionRow).join('')}</div>
    </form>`,
    footer: '<button class="btn btn-quiet" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="submit-product">保存商品</button>'
  });
}

async function cardsModal(productId) {
  const product = state.products.find((item) => item.id === productId);
  const cards = await api(`/products/${productId}/cards`);
  openModal({
    title: `${product?.name || '商品'} · 卡密管理`, size: 'xwide',
    body: `<div class="cards-layout">
      <form id="cards-bulk-form" data-product-id="${productId}">
        <label class="field"><span>批量添加卡密</span><textarea name="content" style="min-height:300px" placeholder="一行一个卡密，支持一次粘贴多行"></textarea><span class="field-hint">单次最多添加 10,000 条；付款成功后按录入顺序发放。</span></label>
        <button class="btn btn-primary btn-block" type="submit">添加到库存</button>
      </form>
      <div><div class="panel-head"><div><h4>库存明细</h4><span>${cards.filter((card) => !card.is_used).length} 未使用 · ${cards.filter((card) => card.is_used).length} 已使用</span></div></div>
        <div class="card-list">${cards.length ? cards.map((card) => `<div class="card-row"><span>${card.is_used ? badge('neutral', '已使用') : badge('success', '可用')}</span><code title="${e(card.content)}">${e(card.content)}</code><button class="btn btn-quiet btn-sm" data-action="edit-card" data-id="${card.id}" data-content="${e(card.content)}">编辑</button><button class="btn btn-danger btn-sm" data-action="delete-card" data-id="${card.id}">删除</button></div>`).join('') : empty('◇', '暂无卡密', '在左侧按一行一个的格式批量添加。')}</div>
      </div>
    </div>`,
    footer: '<button class="btn btn-quiet" data-action="close-modal">关闭</button>'
  });
}

async function renderOrders() {
  const query = new URLSearchParams({ page: state.orderPage, limit: 30, ...state.orderFilters });
  const data = await api(`/orders?${query}`);
  const totalPages = Math.max(1, Math.ceil(data.total / data.limit));
  page.innerHTML = pageHead('ORDER LEDGER', '订单列表', '所有已付款与未付款订单永久保留；可重试自动发货或人工补单。') + `
    <form id="order-filter" class="toolbar">
      <input class="search" name="search" value="${e(state.orderFilters.search || '')}" placeholder="搜索订单号、商品、TG ID、用户名">
      <select name="status" style="width:150px"><option value="">全部订单状态</option>${Object.entries(statusNames).slice(0, 6).map(([value, name]) => `<option value="${value}" ${state.orderFilters.status === value ? 'selected' : ''}>${name}</option>`).join('')}</select>
      <select name="payment_status" style="width:135px"><option value="">全部付款状态</option><option value="paid" ${state.orderFilters.payment_status === 'paid' ? 'selected' : ''}>已付款</option><option value="unpaid" ${state.orderFilters.payment_status === 'unpaid' ? 'selected' : ''}>未付款</option></select>
      <button class="btn btn-secondary" type="submit">筛选</button><button class="btn btn-quiet" type="button" data-action="reset-order-filter">清空</button>
    </form>
    ${data.rows.length ? `<div class="table-wrap"><table><thead><tr><th>订单号 / 时间</th><th>商品</th><th>购买用户</th><th>金额</th><th>支付通道</th><th>付款</th><th>状态</th><th></th></tr></thead><tbody>${data.rows.map((order) => `
      <tr><td><div class="cell-title">${e(order.order_no)}</div><div class="cell-sub">${fmtDate(order.created_at)}</div></td><td><div class="cell-title">${e(order.product_name)}</div><div class="cell-sub">× ${order.quantity} · ${order.product_type === 'card' ? '自动发卡' : 'API 发货'}</div></td><td><div class="cell-title">${e(order.tg_display_name || '-')}</div><div class="cell-sub">${order.tg_username ? `@${e(order.tg_username)} · ` : ''}${e(order.tg_user_id)}</div></td><td><strong>$${money(order.amount_usdt)}</strong><div class="cell-sub">应付 ${money(order.payable_amount, order.payable_currency === 'USDT' ? 6 : 2)} ${e(order.payable_currency)}</div></td><td>${e(order.payment_channel_name)}</td><td>${badge(order.payment_status)}</td><td>${badge(order.status)}</td><td><button class="btn btn-quiet btn-sm" data-action="view-order" data-id="${order.id}">查看详情</button></td></tr>`).join('')}</tbody></table></div>` : empty('≡', '没有匹配的订单', '调整筛选条件或等待用户下单。')}
    <div class="pagination"><button class="btn btn-quiet btn-sm" data-action="order-page" data-page="${Math.max(1, data.page - 1)}" ${data.page <= 1 ? 'disabled' : ''}>上一页</button><span>第 ${data.page} / ${totalPages} 页 · 共 ${data.total} 笔</span><button class="btn btn-quiet btn-sm" data-action="order-page" data-page="${Math.min(totalPages, data.page + 1)}" ${data.page >= totalPages ? 'disabled' : ''}>下一页</button></div>`;
}

function optionText(options) {
  const entries = Object.entries(options || {});
  return entries.length ? entries.map(([key, value]) => `<div class="detail-item"><span>${e(key)}</span><strong>${e(value)}</strong></div>`).join('') : '<div class="cell-sub">该订单没有扩展参数</div>';
}

async function orderModal(id) {
  const order = await api(`/orders/${id}`);
  openModal({
    title: `订单 ${order.order_no}`, size: 'xwide',
    body: `<div class="detail-grid">
      <div class="detail-item"><span>订单状态</span><strong>${badge(order.status)}</strong></div>
      <div class="detail-item"><span>付款状态</span><strong>${badge(order.payment_status)}</strong></div>
      <div class="detail-item"><span>订单金额</span><strong>$${money(order.amount_usdt)} USDT</strong></div>
      <div class="detail-item"><span>商品 / 数量</span><strong>${e(order.product_name)} × ${order.quantity}</strong></div>
      <div class="detail-item"><span>购买用户</span><strong>${e(order.tg_display_name || '-')} · ${e(order.tg_user_id)}</strong></div>
      <div class="detail-item"><span>支付通道</span><strong>${e(order.payment_channel_name)}</strong></div>
      <div class="detail-item"><span>应付金额</span><strong>${money(order.payable_amount, order.payable_currency === 'USDT' ? 6 : 2)} ${e(order.payable_currency)}</strong></div>
      <div class="detail-item"><span>交易号</span><strong>${e(order.transaction_id || '-')}</strong></div>
      <div class="detail-item"><span>时间</span><strong>${fmtDate(order.created_at)} → ${order.completed_at ? fmtDate(order.completed_at) : '尚未完成'}</strong></div>
    </div>
    <div class="section-label"><strong>扩展参数</strong></div><div class="detail-grid">${optionText(order.options)}</div>
    ${order.failure_reason ? `<div class="section-label"><strong>处理说明</strong></div><div class="notice">${e(order.failure_reason)}</div>` : ''}
    ${order.product_type === 'card' && order.delivery_result ? `<div class="section-label"><strong>发货内容</strong></div><pre class="code-block">${e(order.delivery_result)}</pre>` : ''}
    ${order.product_type === 'api' && order.api_response ? `<div class="section-label"><strong>API 原始返回</strong></div><pre class="code-block">${e(order.api_response)}</pre>` : ''}
    ${order.product_type === 'api' && order.delivery_result && order.delivery_result !== order.api_response ? `<div class="section-label"><strong>自定义发货内容</strong></div><pre class="code-block">${e(order.delivery_result)}</pre>` : ''}
    <div class="section-label"><strong>订单事件</strong></div><div class="timeline">${order.events.map((event) => `<div class="timeline-item"><strong>${e(event.event_type)}</strong><p>${e(event.detail || '')}</p><time>${fmtDate(event.created_at)}</time></div>`).join('')}</div>`,
    footer: `${order.status === 'pending_manual' && order.payment_status === 'paid' ? `<button class="btn btn-secondary" data-action="retry-order" data-id="${order.id}">重新自动处理</button>` : ''}${order.status !== 'completed' ? `<button class="btn btn-primary" data-action="manual-order" data-id="${order.id}" data-paid="${order.payment_status === 'paid' ? '1' : '0'}" data-product-type="${e(order.product_type)}">补单处理</button>` : ''}<button class="btn btn-quiet" data-action="close-modal">关闭</button>`
  });
}

function manualOrderModal(id, paid, productType) {
  const defaultLabel = productType === 'card' ? '执行默认自动发卡流程' : '执行默认 API 发货流程';
  openModal({
    title: '补单处理',
    body: `<form id="manual-order-form" data-id="${id}">
      <label class="field"><span>补单方式</span><select name="mode"><option value="default" selected>${defaultLabel}</option><option value="custom">发送自定义发货内容</option></select><span class="field-hint">默认已选择自动处理：系统会重新取卡或再次请求商品 API；请确认上游接口允许重试。</span></label>
      <label class="field" id="manual-custom-field" style="display:none"><span>发送给用户的发货内容</span><textarea name="content" maxlength="10000" style="min-height:180px" placeholder="输入卡密、账号信息或人工处理结果"></textarea></label>
      ${paid ? '' : '<label class="check"><input type="checkbox" name="forcePaid"> 同时将此未付款订单强制标记为已付款</label><p class="notice">强制标记付款会计入交易额，请确认已经线下核实款项。</p>'}
    </form>`,
    footer: '<button class="btn btn-quiet" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="submit-manual-order">确认执行</button>'
  });
}

function supportThreadItems(threads) {
  if (!threads.length) return empty('◌', '暂无客服会话', '用户在 Bot 内点击“联系客服”后会显示在这里。');
  return threads.map((thread) => `<button class="thread ${String(thread.tg_id) === String(state.selectedThread) ? 'active' : ''}" data-action="select-thread" data-id="${e(thread.tg_id)}"><span class="avatar">${e((thread.display_name || thread.username || '?').slice(0, 1).toUpperCase())}</span><span><strong>${e(thread.display_name || thread.username || thread.tg_id)}</strong><span>${e(thread.last_text || (thread.active ? '客服对话进行中' : '对话已关闭'))}</span></span>${thread.unread_count ? `<b class="unread">${thread.unread_count}</b>` : ''}</button>`).join('');
}

function updateSupportThreads(threads) {
  const total = $('#thread-total');
  const items = $('#thread-items');
  if (total) total.textContent = String(threads.length);
  if (items) items.innerHTML = supportThreadItems(threads);
}

function updateSupportLiveState(online) {
  const indicator = $('#support-live-state');
  if (!indicator) return;
  indicator.classList.toggle('offline', !online);
  indicator.innerHTML = `<i></i>${online ? '消息自动更新中' : '自动更新暂时中断'}`;
}

async function renderSupport() {
  const threads = await api('/support/threads');
  if (!state.selectedThread && threads.length) state.selectedThread = threads[0].tg_id;
  page.innerHTML = pageHead('HUMAN SUPPORT', '客服系统', '仿 Telegram 双栏会话；支持文本、图片与文件收发。', '<span class="live-indicator" id="support-live-state"><i></i>消息自动更新中</span>') + `
    <section id="support-shell" class="support-shell ${state.selectedThread ? 'chat-open' : ''}">
      <aside class="thread-list"><div class="thread-head">全部对话 <span class="cell-sub" id="thread-total">${threads.length}</span></div><div id="thread-items">${supportThreadItems(threads)}</div></aside>
      <section class="chat" id="chat-pane">${state.selectedThread ? '<div class="loading"><div><div class="spinner"></div>加载会话…</div></div>' : empty('◌', '选择一个会话', '从左侧选择用户开始回复')}</section>
    </section>`;
  if (state.selectedThread) await renderMessages(state.selectedThread, false, threads);
  state.supportTimer = setInterval(refreshSupport, 2000);
}

async function refreshSupport() {
  if (state.route !== 'support' || state.supportRefreshRunning) return;
  state.supportRefreshRunning = true;
  try {
    const threads = await api('/support/threads');
    if (!state.selectedThread && threads.length) {
      state.selectedThread = threads[0].tg_id;
      $('#support-shell')?.classList.add('chat-open');
    }
    updateSupportThreads(threads);
    if (state.selectedThread) await renderMessages(state.selectedThread, true, threads);
    updateSupportLiveState(true);
  } catch {
    updateSupportLiveState(false);
  } finally {
    state.supportRefreshRunning = false;
  }
}

async function renderMessages(tgId, quiet = false, knownThreads = null) {
  const [messages, threads] = await Promise.all([
    api(`/support/${encodeURIComponent(tgId)}/messages`),
    knownThreads ? Promise.resolve(knownThreads) : api('/support/threads')
  ]);
  const thread = threads?.find((item) => String(item.tg_id) === String(tgId));
  const pane = $('#chat-pane');
  if (!pane || String(state.selectedThread) !== String(tgId)) return;
  const currentLast = pane.dataset.lastId;
  const nextLast = String(messages.at(-1)?.id || '');
  const sameThread = pane.dataset.threadId === String(tgId);
  if (quiet && sameThread && currentLast === nextLast) return;
  const messageHtml = messages.map((message) => {
    const photo = message.message_type === 'photo' && message.file_url
      ? `<a href="${e(message.file_url)}" target="_blank"><img src="${e(message.file_url)}" alt="客服图片"></a>`
      : '';
    const file = message.message_type === 'file' && message.file_url
      ? `<a class="file-chip" href="${e(message.file_url)}" download>▣ <span>${e(message.original_name || '下载文件')}</span></a>`
      : '';
    const text = message.text ? `<div class="message-text">${e(message.text)}</div>` : '';
    return `<div class="message ${message.direction}"><div class="bubble">${photo}${file}${text}</div><div class="message-time">${message.direction === 'admin' ? '管理员 · ' : ''}${fmtDate(message.created_at)}</div></div>`;
  }).join('');
  const headerHtml = `<header class="chat-head"><button class="icon-btn mobile-only" data-action="back-threads">←</button><div><strong>${e(thread?.display_name || thread?.username || tgId)}</strong><span>${thread?.username ? `@${e(thread.username)} · ` : ''}TG ID ${e(tgId)} · ${thread?.active ? '客服模式中' : '用户已退出客服模式'}</span></div>${thread?.active ? badge('success', '对话中') : badge('neutral', '已关闭')}</header>`;
  const existingList = $('#message-list', pane);
  if (quiet && sameThread && existingList && $('#support-composer', pane)) {
    const nearBottom = existingList.scrollHeight - existingList.scrollTop - existingList.clientHeight < 90;
    const previousTop = existingList.scrollTop;
    existingList.innerHTML = messages.length ? messageHtml : empty('◌', '还没有消息', '在下方输入第一条回复。');
    existingList.scrollTop = nearBottom ? existingList.scrollHeight : previousTop;
  } else {
    pane.innerHTML = `${headerHtml}<div class="messages" id="message-list">${messages.length ? messageHtml : empty('◌', '还没有消息', '在下方输入第一条回复。')}</div><form id="support-composer" class="composer" data-tg-id="${e(tgId)}"><label class="file-picker" title="选择图片或文件">＋<input type="file" name="file"></label><textarea name="text" rows="1" maxlength="4000" placeholder="输入回复内容…"></textarea><button class="btn btn-primary" type="submit">发送</button></form>`;
    const list = $('#message-list', pane);
    if (list) list.scrollTop = list.scrollHeight;
  }
  pane.dataset.threadId = String(tgId);
  pane.dataset.lastId = nextLast;
}

async function renderPayments() {
  const channels = await api('/payment-channels');
  page.innerHTML = pageHead('PAYMENT ROUTING', '支付通道', '内置 TRC20-USDT、OKPay 与通用易支付；每个通道名称全局唯一。', '<button class="btn btn-primary" data-action="new-payment">＋ 新增通道</button>') +
    (channels.length ? `<div class="table-wrap"><table><thead><tr><th>通道名称</th><th>模式</th><th>单笔上限</th><th>关键参数</th><th>状态</th><th></th></tr></thead><tbody>${channels.map((item) => {
      const key = item.mode === 'trc20_usdt' ? item.config.address : item.mode === 'okpay' ? `App ID ${item.config.app_id}` : `${item.config.pay_type} · PID ${item.config.pid}`;
      return `<tr><td><div class="cell-title">${e(item.name)}</div><div class="cell-sub">#${item.id}</div></td><td>${badge(item.mode === 'trc20_usdt' ? 'success' : 'warning', item.mode === 'trc20_usdt' ? 'TRC20-USDT' : item.mode === 'okpay' ? 'OKPay' : '易支付')}</td><td>${item.max_amount_usdt > 0 ? `${money(item.max_amount_usdt)} USDT` : '不限制'}</td><td><div class="cell-sub">${e(key)}</div></td><td>${item.enabled ? badge('success', '启用') : badge('neutral', '停用')}</td><td><div class="cell-actions"><button class="btn btn-quiet btn-sm" data-action="edit-payment" data-id="${item.id}">编辑</button><button class="btn btn-danger btn-sm" data-action="delete-payment" data-id="${item.id}">删除</button></div></td></tr>`;
    }).join('')}</tbody></table></div>` : empty('◈', '暂无支付通道', '添加至少一个支付通道后，用户才能完成下单。'));
  state.paymentChannels = channels;
}

function paymentFields(mode, config = {}) {
  if (mode === 'trc20_usdt') return `
    <label class="field wide"><span>唯一收款地址</span><input name="address" required value="${e(config.address || '')}" placeholder="T 开头的 TRON 主网地址"></label>
    <label class="field wide"><span>TronGrid API Key（可选）</span><input name="trongrid_key" value="${e(config.trongrid_key || '')}" autocomplete="off"><span class="field-hint">系统仅查询官方 USDT 合约，每 20 秒轮询已确认转入。</span></label>`;
  if (mode === 'okpay') return `
    <label class="field"><span>App ID</span><input name="app_id" required value="${e(config.app_id || '')}"></label>
    <label class="field"><span>密钥</span><input name="secret" type="password" required value="${e(config.secret || '')}" autocomplete="new-password"></label>
    <label class="field wide"><span>API 地址</span><input name="api_url" required value="${e(config.api_url || 'https://api.okaypay.me/shop/')}"></label>
    <div class="notice wide">保存后，推荐回调地址会按“系统设置 → 公网访问地址”生成；系统同时每 5 秒主动查询待付款订单。</div>`;
  return `
    <label class="field wide"><span>支付程序 URL</span><input name="api_url" required value="${e(config.api_url || '')}" placeholder="https://pay.example.com/"><span class="field-hint">通用易支付服务地址，不绑定任何默认服务商。</span></label>
    <label class="field"><span>商户 ID（PID）</span><input name="pid" required value="${e(config.pid || '')}"></label>
    <label class="field"><span>商户密钥（KEY）</span><input name="key" type="password" required value="${e(config.key || '')}" autocomplete="new-password"></label>
    <label class="field"><span>支付类型</span><select name="pay_type"><option value="alipay" ${config.pay_type !== 'wxpay' ? 'selected' : ''}>支付宝 alipay</option><option value="wxpay" ${config.pay_type === 'wxpay' ? 'selected' : ''}>微信 wxpay</option></select></label>
    <div class="notice wide">订单金额按系统 USDT/CNY 汇率换算为人民币；系统同时支持异步回调与每 30 秒主动查询。</div>`;
}

function paymentModal(item = null) {
  const mode = item?.mode || 'trc20_usdt';
  openModal({
    title: item ? '编辑支付通道' : '新增支付通道', size: 'wide',
    body: `<form id="payment-form" data-id="${item?.id || ''}">
      <div class="form-grid"><label class="field"><span>通道名称（全局唯一）</span><input name="name" required maxlength="80" value="${e(item?.name || '')}"></label>
      <label class="field"><span>通道模式</span><select name="mode"><option value="trc20_usdt" ${mode === 'trc20_usdt' ? 'selected' : ''}>TRC20-USDT</option><option value="okpay" ${mode === 'okpay' ? 'selected' : ''}>OKPay</option><option value="epay" ${mode === 'epay' ? 'selected' : ''}>易支付</option></select></label>
      <label class="field"><span>最大金额（USDT）</span><input name="max_amount_usdt" type="number" min="0" step="0.01" value="${item?.max_amount_usdt ?? 0}"><span class="field-hint">0 表示不限制</span></label>
      <label class="field"><span>状态</span><select name="enabled"><option value="1" ${item?.enabled !== 0 ? 'selected' : ''}>启用</option><option value="0" ${item?.enabled === 0 ? 'selected' : ''}>停用</option></select></label></div>
      <div class="section-label"><strong>模式参数</strong></div><div id="payment-fields" class="form-grid">${paymentFields(mode, item?.config)}</div>
    </form>`,
    footer: '<button class="btn btn-quiet" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="submit-payment">保存通道</button>'
  });
}

async function renderBroadcast() {
  const rows = await api('/broadcasts');
  page.innerHTML = pageHead('MASS DELIVERY', '广播通知', '向每一位使用过 Bot 的客户发送文本、图片或文件，并实时查看进度。') + `
    <section class="broadcast-grid">
      <article class="panel"><div class="panel-head"><div><h4>创建全局广播</h4><span>图片与文本同时填写时，将以上图下文形式发送</span></div></div>
        <form id="broadcast-form"><label class="field"><span>消息文本（可留空）</span><textarea name="text" maxlength="4000" style="min-height:180px" placeholder="输入要发送给所有用户的通知…"></textarea></label>
          <label class="drop-zone"><input type="file" name="file" hidden><span><strong>＋ 添加图片或文件</strong><br><span id="broadcast-file-name">点击选择，最大 20MB</span></span></label>
          <div class="notice" style="margin:13px 0">发送后任务会在后台逐个投递。被用户拉黑或失效的会话会计入失败数量。</div>
          <button class="btn btn-primary btn-block" type="submit">发送全局广播</button>
        </form>
      </article>
      <article class="panel"><div class="panel-head"><div><h4>发送记录</h4><span>最近 50 次广播任务</span></div></div><div id="broadcast-list">
        ${rows.length ? rows.map(broadcastRow).join('') : empty('⌁', '还没有广播记录', '创建广播后可在这里实时查看进度。')}
      </div></article>
    </section>`;
  state.broadcastTimer = setInterval(refreshBroadcasts, 2000);
}

function broadcastRow(item) {
  const done = item.success_count + item.failure_count;
  const percent = item.total_count ? Math.round(done / item.total_count * 100) : 100;
  return `<div class="broadcast-row" data-broadcast-id="${item.id}"><div class="broadcast-meta"><span>${badge(item.status, item.status === 'completed' ? '已完成' : statusNames[item.status])} · ${fmtDate(item.created_at)}</span><span>${done} / ${item.total_count}</span></div><div class="progress"><span style="width:${percent}%"></span></div><div class="cell-sub" style="margin-top:7px">成功 ${item.success_count} · 失败 ${item.failure_count} · ${item.message_type === 'photo' ? '图片消息' : item.message_type === 'file' ? '文件消息' : '文本消息'} · ${e((item.text || '').slice(0, 70))}</div></div>`;
}

async function refreshBroadcasts() {
  if (state.route !== 'broadcast') return;
  try {
    const rows = await api('/broadcasts');
    const list = $('#broadcast-list');
    if (list) list.innerHTML = rows.length ? rows.map(broadcastRow).join('') : empty('⌁', '还没有广播记录', '创建广播后可在这里实时查看进度。');
  } catch {}
}

async function renderSettings() {
  const data = await api('/settings');
  updateBotStatus(data.bot);
  const s = data.settings;
  const callbackBaseUrl = String(s.public_base_url || `http://127.0.0.1:${s.web_port}`).replace(/\/+$/, '');
  const tokenConfigured = Boolean(String(s.telegram_bot_token || '').trim());
  page.innerHTML = pageHead('SYSTEM CONFIGURATION', '系统设置', '保存后会立即连接 Telegram；Web 监听端口修改后需重启程序。', `${tokenConfigured ? '<button class="btn btn-secondary" data-action="retry-bot">重新连接 Bot</button>' : ''}<button class="btn btn-primary" data-action="submit-settings">保存并连接</button>`) + `
    <section class="settings-layout">
      <article class="panel"><form id="settings-form">
        <section class="settings-section"><h4>Telegram Bot</h4><p>控制 Bot 身份、管理员通知接收人与前端展示名称。</p><div class="form-grid">
          <label class="field"><span>BOT 名称</span><input name="bot_name" required maxlength="120" value="${e(s.bot_name)}"></label>
          <label class="field"><span>Telegram 管理员 ID</span><input name="telegram_admin_id" required inputmode="numeric" value="${e(s.telegram_admin_id)}"></label>
          <label class="field wide"><span>Telegram Bot API Token</span><input name="telegram_bot_token" type="password" autocomplete="new-password" value="${e(s.telegram_bot_token)}" placeholder="从 @BotFather 获取"></label>
          <label class="field wide"><span>同款开源 BOT 链接</span><input name="open_source_url" type="url" value="${e(s.open_source_url)}"></label>
        </div></section>
        <section class="settings-section"><h4>订单与换算</h4><p>统一以 USDT（美元）定价，易支付按汇率换算人民币。</p><div class="form-grid">
          <label class="field"><span>订单超时时间（分钟）</span><input name="order_timeout_min" type="number" min="1" max="1440" value="${e(s.order_timeout_min)}"></label>
          <label class="field"><span>USDT / CNY 汇率</span><input name="usdt_cny_rate" type="number" min="0.0001" step="0.0001" value="${e(s.usdt_cny_rate)}"></label>
        </div></section>
        <section class="settings-section"><h4>Web 与回调</h4><p>公网地址用于 OKPay 与易支付生成推荐回调 URL。</p><div class="form-grid">
          <label class="field"><span>Web 监听端口</span><input name="web_port" type="number" min="1" max="65535" value="${e(s.web_port)}"><span class="field-hint">修改后重启程序生效</span></label>
          <label class="field"><span>公网访问地址（可留空）</span><input name="public_base_url" type="url" value="${e(s.public_base_url)}" placeholder="https://shop.example.com"><span class="field-hint">OKPay 实时回调建议使用 HTTPS 域名；若服务商拒绝回调地址，系统会自动改用快速主动查询。</span></label>
        </div></section>
      </form></article>
      <aside><article class="panel"><div class="panel-head"><div><h4>运行状态</h4><span>当前进程检测结果</span></div></div><div class="status-stack">
        <div class="status-line"><span>Token 配置</span>${tokenConfigured ? badge('success', '已保存') : badge('danger', '未保存')}</div>
        <div class="status-line"><span>Telegram 连接</span>${data.bot.ready ? badge('success', '正常') : badge('danger', '未连接')}</div>
        <div class="status-line"><span>消息轮询</span>${data.bot.pollingActive ? badge('success', '运行中') : badge('danger', '未运行')}</div>
        <div class="status-line"><span>Bot 用户名</span><strong>${data.bot.username ? `@${e(data.bot.username)}` : '-'}</strong></div>
        <div class="status-line"><span>SQLite</span>${badge('success', '本地运行')}</div>
        <div class="status-line"><span>订单监听</span>${badge('success', '运行中')}</div>
      </div>${!tokenConfigured ? '<div class="notice" style="margin-top:13px">当前数据库中没有 Token。填写后请点击页面右上角“保存并连接”。</div>' : ''}${data.bot.lastError ? `<div class="notice" style="margin-top:13px">最近错误：${e(data.bot.lastError)}</div>` : ''}</article>
      <article class="panel" style="margin-top:14px"><div class="panel-head"><h4>回调地址示例</h4></div><p class="cell-sub">OKPay：${e(`${callbackBaseUrl}/callbacks/okpay/{通道ID}`)}</p><p class="cell-sub">易支付：${e(`${callbackBaseUrl}/callbacks/epay/{通道ID}`)}</p></article></aside>
    </section>`;
}

function passwordModal() {
  openModal({
    title: '修改管理员密码',
    body: `<form id="password-form"><label class="field"><span>原密码</span><input name="oldPassword" type="password" required autocomplete="current-password"></label><label class="field"><span>新密码</span><input name="newPassword" type="password" required minlength="10" maxlength="128" autocomplete="new-password"></label><label class="field"><span>确认新密码</span><input name="confirmPassword" type="password" required minlength="10" maxlength="128" autocomplete="new-password"></label></form>`,
    footer: '<button class="btn btn-quiet" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="submit-password">更新密码</button>'
  });
}

function formObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function submitCategory() {
  const form = $('#category-form'); const id = form.dataset.id; const data = formObject(form); data.enabled = Boolean(form.elements.enabled.checked);
  await api(id ? `/categories/${id}` : '/categories', { method: id ? 'PUT' : 'POST', body: data });
  closeModal(); toast(id ? '分类已更新' : '分类已创建'); renderCategories();
}

function productFormData() {
  const form = $('#product-form'); const data = formObject(form);
  data.enabled = data.enabled === '1';
  data.options = $$('.option-row', form).map((row) => ({
    name: $('[data-option=name]', row).value,
    field_key: $('[data-option=field_key]', row).value,
    option_type: $('[data-option=option_type]', row).value,
    choices: $('[data-option=choices]', row).value
  }));
  return data;
}

async function submitProduct() {
  const form = $('#product-form'); const id = form.dataset.id;
  await api(id ? `/products/${id}` : '/products', { method: id ? 'PUT' : 'POST', body: productFormData() });
  closeModal(); toast(id ? '商品已更新' : '商品已创建'); renderProducts();
}

async function submitPayment() {
  const form = $('#payment-form'); const id = form.dataset.id; const raw = formObject(form); const mode = raw.mode;
  const config = mode === 'trc20_usdt' ? { address: raw.address, trongrid_key: raw.trongrid_key } : mode === 'okpay' ? { app_id: raw.app_id, secret: raw.secret, api_url: raw.api_url } : { api_url: raw.api_url, pid: raw.pid, key: raw.key, pay_type: raw.pay_type };
  await api(id ? `/payment-channels/${id}` : '/payment-channels', { method: id ? 'PUT' : 'POST', body: { name: raw.name, mode, max_amount_usdt: raw.max_amount_usdt, enabled: raw.enabled === '1', config } });
  closeModal(); toast(id ? '支付通道已更新' : '支付通道已创建'); renderPayments();
}

async function submitSettings() {
  const form = $('#settings-form');
  if (!form) return;
  const result = await api('/settings', { method: 'PUT', body: formObject(form) });
  toast(result.restartRequired ? '设置已保存；Web 端口将在重启后生效' : '系统设置已保存');
  setTimeout(renderSettings, 600);
}

async function guarded(action, button) {
  if (button) button.disabled = true;
  try { await action(); } catch (error) { toast(error.message, 'error'); }
  finally { if (button?.isConnected) button.disabled = false; }
}

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (form.id === 'login-form') {
    event.preventDefault();
    const error = $('#login-error'); error.textContent = '';
    const button = $('button[type=submit]', form); button.disabled = true;
    fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(formObject(form)) })
      .then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error); state.csrf = data.csrfToken; showApp(); updateBotStatus(data.bot); route(); })
      .catch((err) => { error.textContent = err.message || '登录失败'; })
      .finally(() => { button.disabled = false; });
    return;
  }
  if (form.id === 'category-form') { event.preventDefault(); guarded(submitCategory, event.submitter); }
  if (form.id === 'product-form') { event.preventDefault(); guarded(submitProduct, event.submitter); }
  if (form.id === 'payment-form') { event.preventDefault(); guarded(submitPayment, event.submitter); }
  if (form.id === 'order-filter') { event.preventDefault(); const values = formObject(form); state.orderFilters = Object.fromEntries(Object.entries(values).filter(([, value]) => value)); state.orderPage = 1; renderOrders(); }
  if (form.id === 'cards-bulk-form') {
    event.preventDefault(); guarded(async () => { const data = formObject(form); await api(`/products/${form.dataset.productId}/cards/bulk`, { method: 'POST', body: data }); toast('卡密已添加到库存'); await renderProducts(); await cardsModal(Number(form.dataset.productId)); }, event.submitter);
  }
  if (form.id === 'manual-order-form') {
    event.preventDefault(); guarded(async () => { const data = formObject(form); data.forcePaid = Boolean(form.elements.forcePaid?.checked); await api(`/orders/${form.dataset.id}/manual-fulfill`, { method: 'POST', body: data }); closeModal(); toast(data.mode === 'default' ? '默认发货流程已执行' : '自定义发货内容已发送'); route(); }, event.submitter);
  }
  if (form.id === 'support-composer') {
    event.preventDefault(); guarded(async () => { const tgId = form.dataset.tgId; const data = new FormData(form); await api(`/support/${encodeURIComponent(tgId)}/reply`, { method: 'POST', body: data }); form.reset(); await renderMessages(tgId); }, event.submitter);
  }
  if (form.id === 'broadcast-form') {
    event.preventDefault(); guarded(async () => { const data = new FormData(form); await api('/broadcasts', { method: 'POST', body: data }); toast('广播任务已开始'); form.reset(); $('#broadcast-file-name').textContent = '点击选择，最大 20MB'; await refreshBroadcasts(); }, event.submitter);
  }
  if (form.id === 'settings-form') { event.preventDefault(); guarded(submitSettings, event.submitter); }
  if (form.id === 'password-form') {
    event.preventDefault(); guarded(async () => { const data = formObject(form); if (data.newPassword !== data.confirmPassword) throw new Error('两次输入的新密码不一致'); await api('/auth/password', { method: 'POST', body: data }); closeModal(); toast('密码已更新，其他后台会话已退出'); }, event.submitter);
  }
});

document.addEventListener('change', (event) => {
  if (event.target.matches('#product-form [name=product_type]')) $('#api-fields').style.display = event.target.value === 'api' ? '' : 'none';
  if (event.target.matches('[data-option=option_type]')) $('.option-choices', event.target.closest('.option-row')).style.display = event.target.value === 'choice' ? '' : 'none';
  if (event.target.matches('#payment-form [name=mode]')) $('#payment-fields').innerHTML = paymentFields(event.target.value, {});
  if (event.target.matches('#broadcast-form input[type=file]')) $('#broadcast-file-name').textContent = event.target.files[0]?.name || '点击选择，最大 20MB';
  if (event.target.matches('#manual-order-form [name=mode]')) {
    const field = $('#manual-custom-field');
    const textarea = field?.querySelector('textarea');
    const custom = event.target.value === 'custom';
    if (field) field.style.display = custom ? '' : 'none';
    if (textarea) textarea.required = custom;
  }
});

document.addEventListener('input', (event) => {
  if (!event.target.matches('#support-composer textarea')) return;
  event.target.style.height = '42px';
  event.target.style.height = `${Math.min(event.target.scrollHeight, 110)}px`;
});

window.addEventListener('focus', () => {
  if (state.route === 'support') refreshSupport();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.route === 'support') refreshSupport();
});

document.addEventListener('click', async (event) => {
  const routeTarget = event.target.closest('[data-route-link], [data-route]');
  if (routeTarget && !routeTarget.closest('#login-view')) { location.hash = routeTarget.dataset.routeLink || routeTarget.dataset.route; return; }
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'close-modal') return closeModal();
  if (action === 'close-modal-bg' && event.target === target) return closeModal();
  if (action === 'new-category') return categoryModal();
  if (action === 'edit-category') return categoryModal(state.categories.find((item) => item.id === Number(target.dataset.id)));
  if (action === 'submit-category') return guarded(submitCategory, target);
  if (action === 'delete-category') return guarded(async () => { if (await confirmDialog('删除分类', '分类删除后不可恢复；包含商品的分类无法删除。')) { await api(`/categories/${target.dataset.id}`, { method: 'DELETE' }); toast('分类已删除'); renderCategories(); } });
  if (action === 'new-product') return productModal();
  if (action === 'edit-product') return productModal(state.products.find((item) => item.id === Number(target.dataset.id)));
  if (action === 'submit-product') return guarded(submitProduct, target);
  if (action === 'add-option') { $('#option-list').insertAdjacentHTML('beforeend', optionRow({ option_type: 'choice' })); return; }
  if (action === 'remove-option') { target.closest('.option-row').remove(); return; }
  if (action === 'delete-product') return guarded(async () => { if (await confirmDialog('删除商品', '商品与剩余卡密将删除，历史订单快照仍会保留。')) { await api(`/products/${target.dataset.id}`, { method: 'DELETE' }); toast('商品已删除'); renderProducts(); } });
  if (action === 'manage-cards') return guarded(() => cardsModal(Number(target.dataset.id)));
  if (action === 'edit-card') return openModal({ title: '编辑卡密', body: `<form id="card-edit-form" data-id="${target.dataset.id}"><label class="field"><span>卡密内容</span><textarea name="content" required maxlength="4000">${e(target.dataset.content)}</textarea></label></form>`, footer: '<button class="btn btn-quiet" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="save-card">保存</button>' });
  if (action === 'save-card') return guarded(async () => { const form = $('#card-edit-form'); await api(`/cards/${form.dataset.id}`, { method: 'PUT', body: formObject(form) }); closeModal(); toast('卡密已更新'); renderProducts(); }, target);
  if (action === 'delete-card') return guarded(async () => { if (await confirmDialog('删除卡密', '确认删除这条卡密记录吗？已使用卡密也会从库存明细中移除，但订单发货快照不受影响。')) { await api(`/cards/${target.dataset.id}`, { method: 'DELETE' }); closeModal(); toast('卡密已删除'); renderProducts(); } });
  if (action === 'view-order') return guarded(() => orderModal(Number(target.dataset.id)));
  if (action === 'retry-order') return guarded(async () => { target.disabled = true; await api(`/orders/${target.dataset.id}/retry`, { method: 'POST' }); closeModal(); toast('订单已重新处理'); route(); }, target);
  if (action === 'manual-order') return manualOrderModal(Number(target.dataset.id), target.dataset.paid === '1', target.dataset.productType);
  if (action === 'submit-manual-order') return $('#manual-order-form')?.requestSubmit();
  if (action === 'reset-order-filter') { state.orderFilters = {}; state.orderPage = 1; return renderOrders(); }
  if (action === 'order-page') { state.orderPage = Number(target.dataset.page); return renderOrders(); }
  if (action === 'select-thread') { state.selectedThread = target.dataset.id; $$('.thread').forEach((item) => item.classList.toggle('active', item === target)); $('#support-shell').classList.add('chat-open'); return renderMessages(state.selectedThread); }
  if (action === 'back-threads') { $('#support-shell').classList.remove('chat-open'); return; }
  if (action === 'new-payment') return paymentModal();
  if (action === 'edit-payment') return paymentModal(state.paymentChannels.find((item) => item.id === Number(target.dataset.id)));
  if (action === 'submit-payment') return guarded(submitPayment, target);
  if (action === 'delete-payment') return guarded(async () => { if (await confirmDialog('删除支付通道', '历史订单会保留通道名称与配置快照；删除后用户无法再选择该通道。')) { await api(`/payment-channels/${target.dataset.id}`, { method: 'DELETE' }); toast('支付通道已删除'); renderPayments(); } });
  if (action === 'submit-settings') return guarded(submitSettings, target);
  if (action === 'retry-bot') return guarded(async () => { const result = await api('/bot/reconnect', { method: 'POST' }); toast(result.restarted ? '已重新发起 Telegram 连接' : '消息轮询正在自动重试'); setTimeout(renderSettings, 1500); }, target);
  if (action === 'submit-password') return $('#password-form')?.requestSubmit();
});

$('#mobile-menu').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
$('#theme-btn').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true);
  if (state.route === 'dashboard') renderDashboard().catch((error) => toast(error.message, 'error'));
});
$('#password-btn').addEventListener('click', passwordModal);
$('#logout-btn').addEventListener('click', () => guarded(async () => { await api('/auth/logout', { method: 'POST' }); showLogin(); toast('已安全退出'); }));
window.addEventListener('hashchange', route);
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); });

setInterval(() => {
  const clock = $('#clock-text');
  if (clock) clock.textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
}, 1000);

boot();
