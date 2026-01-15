
const socket = io();

const el = {
  socketStatus: document.getElementById('socketStatus'),
  pageTitle: document.getElementById('pageTitle'),
  currentMode: document.getElementById('currentMode'),
  queuedList: document.getElementById('queuedList'),
  unqueuedList: document.getElementById('unqueuedList'),
  unqueuedBadge: document.getElementById('unqueuedBadge'),
  unqueuedBadgeBack: document.getElementById('unqueuedBadgeBack'),
  unqueuedBtnBadge: document.getElementById('unqueuedBtnBadge'),
  unqueuedTag: document.getElementById('unqueuedTag'),
  statusMessage: document.getElementById('statusMessage'),
  allDone: document.getElementById('allDone'),
  flipInner: document.getElementById('queueFlipInner'),
  btnFlipToUnqueued: document.getElementById('btnFlipToUnqueued'),
  btnFlipToQueued: document.getElementById('btnFlipToQueued'),
  qrImg: document.getElementById('qrImg'),
  mobileUrl: document.getElementById('mobileUrl'),
};

let stallType = '';
let currentMode = 'idle';
let currentQtyFilter = 'single';
let showingUnqueued = false;

function updateMobileQr() {
  if (!el.qrImg || !el.mobileUrl) return;
  const url = `${window.location.origin}/mobile/index.html`;
  el.mobileUrl.textContent = url;
  const qr = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(url)}`;
  el.qrImg.src = qr;
}

function getFilterLabel(qtyFilter) {
  return qtyFilter === 'multi' ? '多摊位' : '单摊位';
}

function setSocketStatus(connected) {
  el.socketStatus.textContent = connected ? '已连接' : '未连接';
  el.socketStatus.classList.toggle('pill-ok', connected);
  el.socketStatus.classList.toggle('pill-warn', !connected);
}

function isStarted() {
  return Boolean(stallType) && currentMode === 'queue';
}

function updateTitle() {
  if (!stallType) {
    el.pageTitle.textContent = '等待开始 - 排号';
    return;
  }
  el.pageTitle.textContent = `${stallType} · ${getFilterLabel(currentQtyFilter)} · 排号`;
}

function renderList(target, rows, { showQueueNo = false, emptyText = '暂无数据', muted = false } = {}) {
  target.innerHTML = '';
  if (!Array.isArray(rows) || rows.length === 0) {
    target.innerHTML = `<div class="muted">${emptyText}</div>`;
    return;
  }

  for (const r of rows) {
    const div = document.createElement('div');
    div.className = `item ${muted ? 'item-muted' : ''}`;
    if (showQueueNo) {
      div.innerHTML = `<strong>${r.queueNo}</strong><span>${r.name}</span>`;
    } else {
      div.innerHTML = `<span>${r.name}</span>`;
    }
    target.appendChild(div);
  }
}

async function refresh() {
  updateTitle();

  if (!stallType) {
    el.statusMessage.textContent = '未开始：请在设置页选择类型并点击“开始排号”';
    el.queuedList.innerHTML = '';
    el.unqueuedList.innerHTML = '';
    el.allDone.textContent = '';
    el.unqueuedBadge.textContent = '0';
    if (el.unqueuedBadgeBack) el.unqueuedBadgeBack.textContent = '0';
    if (el.unqueuedBtnBadge) el.unqueuedBtnBadge.textContent = '0';
    if (el.unqueuedTag) el.unqueuedTag.classList.toggle('hidden', true);
    return;
  }

  if (!isStarted()) {
    el.statusMessage.textContent = '当前未在排号模式，请回到设置页点击“开始排号”。';
    el.queuedList.innerHTML = '';
    el.unqueuedList.innerHTML = '';
    el.allDone.textContent = '';
    el.unqueuedBadge.textContent = '0';
    if (el.unqueuedBadgeBack) el.unqueuedBadgeBack.textContent = '0';
    if (el.unqueuedBtnBadge) el.unqueuedBtnBadge.textContent = '0';
    if (el.unqueuedTag) el.unqueuedTag.classList.toggle('hidden', true);
    return;
  }

  el.statusMessage.textContent = '';
  const snap = await socket.emitWithAck('bigscreen:getSnapshot', { stallType });
  if (!snap || !snap.ok) return;

  const queued = snap.queued || [];
  const unqueued = snap.unqueued || [];

  renderList(el.queuedList, queued, { showQueueNo: true, emptyText: '暂无排号' });
  renderList(el.unqueuedList, unqueued, { showQueueNo: false, emptyText: '暂无未排号', muted: true });

  el.unqueuedBadge.textContent = String(unqueued.length);
  if (el.unqueuedBadgeBack) el.unqueuedBadgeBack.textContent = String(unqueued.length);
  if (el.unqueuedBtnBadge) el.unqueuedBtnBadge.textContent = String(unqueued.length);
  if (el.unqueuedTag) el.unqueuedTag.classList.toggle('hidden', unqueued.length === 0);

  if (queued.length > 0 && unqueued.length === 0) {
    el.allDone.textContent = '所有报名人员已完成排号';
  } else {
    el.allDone.textContent = '';
  }
}

socket.on('connect', () => setSocketStatus(true));
socket.on('disconnect', () => setSocketStatus(false));

socket.on('server:currentType', (msg) => {
  stallType = (msg && msg.stallType) || '';
  refresh();
});

socket.on('server:mode', (msg) => {
  currentMode = (msg && msg.mode) || 'idle';
  currentQtyFilter = (msg && msg.qtyFilter) || currentQtyFilter;
  el.currentMode.textContent = currentMode === 'queue' ? '排号中' : currentMode === 'draw' ? '抽签中' : '未开始';
  refresh();
});

socket.on('server:ownerQueued', async (msg) => {
  if (!msg || !msg.stallType) return;
  if (String(msg.stallType) !== String(stallType)) return;
  if (!isStarted()) return;
  await refresh();
});

function setFlip(showUnqueued) {
  showingUnqueued = Boolean(showUnqueued);
  if (!el.flipInner) return;
  el.flipInner.classList.toggle('is-flipped', showingUnqueued);
}

if (el.btnFlipToUnqueued) {
  el.btnFlipToUnqueued.addEventListener('click', () => {
    setFlip(true);
  });
}

if (el.btnFlipToQueued) {
  el.btnFlipToQueued.addEventListener('click', () => {
    setFlip(false);
  });
}

updateMobileQr();
setFlip(false);

refresh();
