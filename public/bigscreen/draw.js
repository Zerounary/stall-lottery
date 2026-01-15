const socket = io();

const el = {
  socketStatus: document.getElementById('socketStatus'),
  pageTitle: document.getElementById('pageTitle'),
  currentType: document.getElementById('currentType'),
  currentMode: document.getElementById('currentMode'),
  remaining: document.getElementById('remaining'),
  currentFilter: document.getElementById('currentFilter'),
  currentPerson: document.getElementById('currentPerson'),
  btnNext: document.getElementById('btnNext'),
  btnDraw: document.getElementById('btnDraw'),
  hint: document.getElementById('hint'),
  resultDisplay: document.getElementById('resultDisplay'),
};

let stallType = '';
let currentOwner = null;
let currentMode = 'idle';
let currentQtyFilter = 'single';
let drawEnded = false;
let controlsEnabled = false;
let rollingTimer = null;
let rollingTimeout = null;
let rollingStartTime = 0;
let isRolling = false;

function setDrawButtonState(drawn) {
  if (!el.btnDraw) return;
  if (drawn) {
    el.btnDraw.textContent = '已抽签';
    el.btnDraw.disabled = true;
  } else {
    el.btnDraw.textContent = '立即抽签';
  }
}

function getRandomRollingStallRangeText(needCount) {
  const c = Math.max(1, Number(needCount || 1));
  const start = Math.floor(Math.random() * 90 + 1);
  const end = start + c - 1;
  const showNo = c > 1 ? `${start}-${end}` : String(start);
  return `摊位号 ${showNo}`;
}

function startRollingEffect() {
  if (!el.resultDisplay) return;
  if (rollingTimer) clearInterval(rollingTimer);
  if (rollingTimeout) clearTimeout(rollingTimeout);
  isRolling = true;
  rollingStartTime = Date.now();
  el.resultDisplay.classList.add('is-rolling');
  const qty = currentOwner ? Math.max(1, Number(currentOwner.qty || 1)) : 1;
  const drawnCount = currentOwner ? Number(currentOwner.drawnCount || 0) : 0;
  const remainingSlots = Math.max(1, qty - drawnCount);
  el.resultDisplay.textContent = getRandomRollingStallRangeText(remainingSlots);
  rollingTimer = setInterval(() => {
    el.resultDisplay.textContent = getRandomRollingStallRangeText(remainingSlots);
  }, 90);
}

function stopRollingEffect(finalText) {
  if (rollingTimer) {
    clearInterval(rollingTimer);
    rollingTimer = null;
  }
  if (rollingTimeout) {
    clearTimeout(rollingTimeout);
    rollingTimeout = null;
  }
  isRolling = false;
  if (!el.resultDisplay) return;
  el.resultDisplay.classList.remove('is-rolling');
  const text = typeof finalText === 'string' ? finalText : '等待抽签...';
  el.resultDisplay.textContent = text;
}

function settleRollingEffect(finalText) {
  if (!isRolling) {
    stopRollingEffect(finalText);
    return;
  }
  const elapsed = Date.now() - rollingStartTime;
  const minDuration = 1200;
  const delay = Math.max(0, minDuration - elapsed);
  if (rollingTimeout) clearTimeout(rollingTimeout);
  rollingTimeout = setTimeout(() => {
    stopRollingEffect(finalText);
  }, delay);
}

function updateActionButtons() {
  const hasOwner = Boolean(currentOwner);
  const qty = hasOwner ? Math.max(1, Number(currentOwner.qty || 1)) : 1;
  const drawnCount = hasOwner ? Number(currentOwner.drawnCount || 0) : 0;
  const ownerFinished = drawnCount >= qty;
  const showDraw = controlsEnabled && hasOwner && !drawEnded && !ownerFinished;
  const showNext = !showDraw;

  if (el.btnDraw) {
    el.btnDraw.classList.toggle('hidden', !showDraw);
    el.btnDraw.disabled = !showDraw;
  }

  if (el.btnNext) {
    el.btnNext.classList.toggle('hidden', !showNext);
    el.btnNext.disabled = !controlsEnabled || drawEnded;
  }
}

function getFilterLabel(qtyFilter) {
  if (qtyFilter === 'multi') return '多摊位';
  return '单摊位';
}

function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatResultText(result) {
  if (!result) return '等待抽签...';
  const nos = Array.isArray(result.stallNos) ? result.stallNos : [];
  const showNo = nos.length > 1 ? `${nos[0]}-${nos[nos.length - 1]}` : String(nos[0] ?? '');
  const queue = result.queueNo ? String(result.queueNo) : '-';
  const name = result.name ? String(result.name) : '-';
  return `排号 ${queue}  ${name}  抽到 ${showNo}`;
}

function setSocketStatus(connected) {
  el.socketStatus.textContent = connected ? '已连接' : '未连接';
  el.socketStatus.classList.toggle('pill-ok', connected);
  el.socketStatus.classList.toggle('pill-warn', !connected);
}

function setControlsEnabled(enabled) {
  controlsEnabled = Boolean(enabled);
  if (enabled) setDrawButtonState(false);
  updateActionButtons();
}

function renderEnded() {
  if (!el.currentPerson) return;
  el.currentPerson.innerHTML = '<div class="draw-ended">本轮抽签结束</div>';
  if (el.hint) el.hint.textContent = '';
  setDrawButtonState(true);
  if (el.btnNext) el.btnNext.disabled = true;
  updateActionButtons();
  stopRollingEffect('本轮抽签结束');
}

function updateTitle() {
  if (!el.pageTitle) return;
  if (!stallType) {
    el.pageTitle.textContent = '等待开始 · 抽签';
    return;
  }
  el.pageTitle.textContent = `${stallType} · ${getFilterLabel(currentQtyFilter)} · 抽签`;
}

function isStarted() {
  return Boolean(stallType) && currentMode === 'draw';
}

function renderCurrentOwner() {
  if (drawEnded) {
    renderEnded();
    return;
  }
  if (!currentOwner) {
    el.currentPerson.innerHTML = '<div class="current-empty">暂无待抽签人员</div>';
    updateActionButtons();
    stopRollingEffect('等待抽签...');
    return;
  }
  const drawn = typeof currentOwner.drawnCount === 'number' ? currentOwner.drawnCount : 0;
  const qty = typeof currentOwner.qty === 'number' ? currentOwner.qty : 1;
  const remainingSlots = Math.max(0, qty - drawn);
  const queueNo = escapeHtml(currentOwner.queueNo ?? '-');
  const name = escapeHtml(currentOwner.name ?? '-');
  el.currentPerson.innerHTML = `
    <div class="current-queue">#${queueNo}</div>
    <div class="current-name">${name}</div>
  `;
  updateActionButtons();
}

async function nextOwner() {
  if (!stallType) {
    el.hint.textContent = '未开始：请先在设置页选择类型并点击“开始抽签”';
    return;
  }
  if (!isStarted()) {
    el.hint.textContent = '未开始：请在设置页点击“开始抽签”';
    return;
  }
  const res = await socket.emitWithAck('bigscreen:draw:next', { stallType });
  if (!res || !res.ok) {
    el.hint.textContent = (res && res.message) || '获取失败';
    return;
  }
  currentOwner = res.owner;
  if (!currentOwner) {
    drawEnded = true;
    renderEnded();
    return;
  } else {
    el.hint.textContent = '';
    drawEnded = false;
    setDrawButtonState(false);
  }
  renderCurrentOwner();
}

socket.on('connect', () => setSocketStatus(true));
socket.on('disconnect', () => setSocketStatus(false));

socket.on('server:currentType', (msg) => {
  stallType = (msg && msg.stallType) || '';
  const remaining = msg && typeof msg.remaining === 'number' ? msg.remaining : 0;
  el.currentType.textContent = stallType || '未选择';
  el.remaining.textContent = `剩余:${stallType ? remaining : '-'}`;
  setControlsEnabled(isStarted());
  updateTitle();
  drawEnded = false;
  if (isStarted()) setDrawButtonState(false);
  updateActionButtons();
});

socket.on('server:mode', (msg) => {
  currentMode = (msg && msg.mode) || 'idle';
  currentQtyFilter = (msg && msg.qtyFilter) || currentQtyFilter;
  el.currentMode.textContent = currentMode === 'queue' ? '排号模式' : currentMode === 'draw' ? '抽签模式' : '未开始';
  if (el.currentFilter) {
    el.currentFilter.textContent = getFilterLabel(currentQtyFilter);
    el.currentFilter.classList.toggle('pill-warn', currentQtyFilter === 'multi');
  }
  setControlsEnabled(isStarted());
  updateTitle();
  drawEnded = false;

  if (!isStarted()) {
    currentOwner = null;
    renderCurrentOwner();
    setDrawButtonState(false);
    el.hint.textContent = stallType ? '未开始：请在设置页点击“开始抽签”' : '未开始：请先在设置页选择类型并点击“开始抽签”';
  } else {
    el.hint.textContent = '';
    nextOwner();
  }
  updateActionButtons();
});

socket.on('server:drawResultBroadcast', (msg) => {
  if (!msg || !msg.ok || !msg.result) return;
  const finalText = formatResultText(msg.result);
  settleRollingEffect(finalText);
});

el.btnNext.addEventListener('click', nextOwner);

el.btnDraw.addEventListener('click', async () => {
  if (!stallType) {
    el.hint.textContent = '未开始：请先在设置页选择类型并点击“开始抽签”';
    return;
  }
  if (!isStarted()) {
    el.hint.textContent = '未开始：请在设置页点击“开始抽签”';
    return;
  }
  if (!currentOwner) {
    el.hint.textContent = '请先点“下一位”';
    return;
  }
  if (el.btnDraw.disabled) return;
  startRollingEffect();
  el.hint.textContent = '抽签中，请稍候...';
  const res = await socket.emitWithAck('bigscreen:draw:doDraw', { stallType, idCard: currentOwner.idCard });
  if (!res || !res.ok) {
    el.hint.textContent = (res && res.message) || '抽签失败';
    stopRollingEffect('抽签失败');
    return;
  }
  const qty = typeof currentOwner.qty === 'number' ? currentOwner.qty : 1;
  currentOwner.drawnCount = qty;
  renderCurrentOwner();
  setDrawButtonState(true);
  el.hint.textContent = '抽签成功，请点“下一位”切换';
  settleRollingEffect(formatResultText(res.result));
});

setControlsEnabled(false);
updateTitle();
setDrawButtonState(false);
updateActionButtons();
nextOwner();
