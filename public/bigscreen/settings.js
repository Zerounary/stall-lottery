const socket = io();

const el = {
  socketStatus: document.getElementById('socketStatus'),
  stallType: document.getElementById('stallType'),
  mode: document.getElementById('mode'),
  stallNumbersField: document.getElementById('stallNumbersField'),
  stallNumbers: document.getElementById('stallNumbers'),
  btnStartStop: document.getElementById('btnStartStop'),
  hint: document.getElementById('hint'),
  statusSummary: document.getElementById('statusSummary'),
  stallGrid: document.getElementById('stallGrid'),
  qtyFilterGroup: document.getElementById('qtyFilterGroup'),
  btnRefreshStallClass: document.getElementById('btnRefreshStallClass'),
  btnSaveAllStallClass: document.getElementById('btnSaveAllStallClass'),
  stallClassList: document.getElementById('stallClassList'),
};

let isRunning = false;
let serverMode = 'idle';
let stallClassData = [];

function setSocketStatus(connected) {
  el.socketStatus.textContent = connected ? '已连接' : '未连接';
  el.socketStatus.classList.toggle('pill-ok', connected);
  el.socketStatus.classList.toggle('pill-warn', !connected);
}

function getModeText(mode) {
  if (mode === 'queue') return '排号';
  if (mode === 'draw') return '抽签';
  return '未开始';
}

function getStartText(mode) {
  return mode === 'draw' ? '开始抽签' : '开始排号';
}

function getStopText(mode) {
  return mode === 'draw' ? '结束抽签' : '结束排号';
}

function updateUi() {
  const selectedMode = String(el.mode.value || 'queue');
  const activeMode = isRunning ? serverMode : selectedMode;
  const isDraw = activeMode === 'draw';
  el.stallNumbersField.style.display = 'none';
  el.btnStartStop.textContent = isRunning ? getStopText(activeMode) : getStartText(activeMode);
}

function renderStatusSummary({ mode, stallType, queue, draw }) {
  if (!el.statusSummary) return;
  const safeType = stallType ? String(stallType) : '-';
  const safeModeText = getModeText(mode);

  if (mode === 'queue') {
    const nextQueueNo = queue && typeof queue.nextQueueNo === 'number' ? queue.nextQueueNo : '-';
    const queuedCount = queue && typeof queue.queuedCount === 'number' ? queue.queuedCount : '-';
    const unqueuedCount = queue && typeof queue.unqueuedCount === 'number' ? queue.unqueuedCount : '-';
    el.statusSummary.innerHTML = `
      <div><span class="muted">类型：</span><span>${safeType}</span></div>
      <div><span class="muted">模式：</span><span>${safeModeText}</span></div>
      <div><span class="muted">当前序号：</span><span>${nextQueueNo}</span></div>
      <div><span class="muted">已排号：</span><span>${queuedCount}</span></div>
      <div><span class="muted">未排号：</span><span>${unqueuedCount}</span></div>
    `;
    return;
  }

  if (mode === 'draw') {
    const cursor = draw && typeof draw.cursor === 'number' ? draw.cursor : '-';
    const total = draw && typeof draw.total === 'number' ? draw.total : '-';
    const drawnCount = draw && typeof draw.drawnCount === 'number' ? draw.drawnCount : '-';
    const remainingCount = draw && typeof draw.remainingCount === 'number' ? draw.remainingCount : '-';
    el.statusSummary.innerHTML = `
      <div><span class="muted">类型：</span><span>${safeType}</span></div>
      <div><span class="muted">模式：</span><span>${safeModeText}</span></div>
      <div><span class="muted">当前序号：</span><span>${cursor}</span></div>
      <div><span class="muted">摊位状态：</span><span>已中 ${drawnCount} / 总数 ${total} / 剩余 ${remainingCount}</span></div>
    `;
    return;
  }

  el.statusSummary.innerHTML = `
    <div><span class="muted">类型：</span><span>${safeType}</span></div>
    <div><span class="muted">模式：</span><span>${safeModeText}</span></div>
  `;
}

function renderStallGrid({ mode, draw }) {
  if (!el.stallGrid) return;

  if (mode !== 'draw') {
    el.stallGrid.style.display = 'none';
    el.stallGrid.innerHTML = '';
    return;
  }

  el.stallGrid.style.display = '';
  const list = draw && Array.isArray(draw.stallNumbers) ? draw.stallNumbers : [];
  const drawn = draw && Array.isArray(draw.drawnStallNos) ? draw.drawnStallNos : [];
  const drawnSet = new Set(drawn.map((x) => String(x)));

  el.stallGrid.innerHTML = '';
  if (list.length === 0) {
    el.stallGrid.innerHTML = '<div class="muted">暂无摊位号列表</div>';
    return;
  }

  for (const n of list) {
    const v = String(n);
    const div = document.createElement('div');
    div.className = `stall-cell ${drawnSet.has(v) ? 'is-drawn' : 'is-remaining'}`;
    div.textContent = v;
    el.stallGrid.appendChild(div);
  }
}

async function refreshStatus() {
  try {
    const res = await socket.emitWithAck('bigscreen:getStatus', {});
    if (!res || !res.ok) return;
    renderStatusSummary(res);
    renderStallGrid(res);
  } catch {
    // ignore
  }
}

function setQtyFilterValue(qtyFilter) {
  if (!el.qtyFilterGroup) return;
  const v = String(qtyFilter || '').trim();
  const input = el.qtyFilterGroup.querySelector(`input[name="qtyFilter"][value="${v}"]`);
  if (input) input.checked = true;
}

function getQtyFilterValue() {
  if (!el.qtyFilterGroup) return 'single';
  const checked = el.qtyFilterGroup.querySelector('input[name="qtyFilter"]:checked');
  return checked ? checked.value : 'single';
}

function parseNumbers(input) {
  const v = String(input || '').trim();
  if (!v) return [];

  const rangeMatch = v.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0 || end < start) return [];
    const out = [];
    for (let i = start; i <= end; i += 1) out.push(i);
    return out;
  }

  return v
    .split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n));
}

async function applyDefaultRangeForType(stallType) {
  const res = await socket.emitWithAck('bigscreen:getDefaultRange', { stallType });
  if (!res || !res.ok) return;
  el.stallNumbers.value = res.defaultRange;
}

function toInt(v, fallback = 0) {
  const n = Number(String(v || '').trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function computeRangesForAllTypes(list) {
  const rows = Array.isArray(list) ? list.slice() : [];
  const grouped = new Map();
  for (const r of rows) {
    const type = String((r && r.stall_type) || '').trim();
    if (!grouped.has(type)) grouped.set(type, []);
    grouped.get(type).push(r);
  }

  const ranges = new Map();
  for (const [type, group] of grouped.entries()) {
    const sorted = group.slice().sort((a, b) => {
      const ao = Number((a && a.order_no) || 0);
      const bo = Number((b && b.order_no) || 0);
      if (ao !== bo) return ao - bo;
      return Number((a && a.id) || 0) - Number((b && b.id) || 0);
    });

    let cursor = 1;
    for (const r of sorted) {
      const stallCount = Math.max(0, Number((r && r.stall_count) || 0));
      const start = cursor;
      const end = cursor + stallCount - 1;
      cursor = end + 1;
      ranges.set(Number((r && r.id) || 0), { start, end, count: stallCount, stallType: type });
    }
  }
  return ranges;
}

function updateStallClassRowIndicator(rowEl) {
  if (!rowEl) return;
  const index = Number(rowEl.dataset.index);
  const original = Number(index >= 0 && stallClassData[index] ? stallClassData[index].person_count : 0) || 0;
  const input = rowEl.querySelector('input[data-field="stallCount"]');
  const stallCount = toInt(input && input.value, 0);
  rowEl.classList.toggle('is-exceed', original > stallCount);
}

function renderStallClassList(list) {
  if (!el.stallClassList) return;
  el.stallClassList.innerHTML = '';

  stallClassData = Array.isArray(list) ? list.slice() : [];

  const rangeMap = computeRangesForAllTypes(stallClassData);

  if (!Array.isArray(list) || list.length === 0) {
    el.stallClassList.innerHTML = '<div class="muted">暂无数据</div>';
    return;
  }

  list.forEach((row, index) => {
    const wrap = document.createElement('div');
    wrap.className = 'stall-class-row';
    wrap.dataset.index = String(index);

    const meta = document.createElement('div');
    meta.className = 'stall-class-meta';
    const safeType = row && row.stall_type != null ? String(row.stall_type) : '';
    const safeClass = row && row.sell_class != null ? String(row.sell_class) : '';
    const safePersonCount = row && row.person_count != null ? String(row.person_count) : '0';
    const range = rangeMap.get(Number(row && row.id) || 0);
    const rangeText = range && range.count > 0 ? `${range.start}-${range.end}` : '-';
    meta.innerHTML = `
      <div><span class="muted">类型：</span><span>${safeType}</span></div>
      <div><span class="muted">分类：</span><span>${safeClass}</span></div>
      <div><span class="muted">需求数：</span><span>${safePersonCount}</span></div>
      <div><span class="muted">号段：</span><span>${rangeText}</span></div>
    `;

    const edit = document.createElement('div');
    edit.className = 'stall-class-edit';

    const inputStallCount = document.createElement('input');
    inputStallCount.className = 'input stall-class-input';
    inputStallCount.type = 'number';
    inputStallCount.value = row && row.stall_count != null ? String(row.stall_count) : '0';
    inputStallCount.min = '0';
    inputStallCount.dataset.field = 'stallCount';
    inputStallCount.addEventListener('input', () => updateStallClassRowIndicator(wrap));

    const inputOrderNo = document.createElement('input');
    inputOrderNo.className = 'input stall-class-input';
    inputOrderNo.type = 'number';
    inputOrderNo.value = row && row.order_no != null ? String(row.order_no) : '0';
    inputOrderNo.min = '0';
    inputOrderNo.dataset.field = 'orderNo';

    const labelStallCount = document.createElement('div');
    labelStallCount.className = 'stall-class-edit-label';
    labelStallCount.textContent = '摊位数';
    edit.appendChild(labelStallCount);
    edit.appendChild(inputStallCount);

    const labelOrderNo = document.createElement('div');
    labelOrderNo.className = 'stall-class-edit-label';
    labelOrderNo.textContent = '顺序';
    edit.appendChild(labelOrderNo);
    edit.appendChild(inputOrderNo);

    wrap.appendChild(meta);
    wrap.appendChild(edit);
    el.stallClassList.appendChild(wrap);
    updateStallClassRowIndicator(wrap);
  });
}

async function refreshStallClassList() {
  if (!el.stallClassList) return;
  const res = await socket.emitWithAck('bigscreen:getStallClasses', {});
  if (!res || !res.ok) {
    el.stallClassList.innerHTML = '<div class="muted">加载失败</div>';
    return;
  }
  renderStallClassList(res.list);
}

function collectEditedStallClassItems() {
  if (!el.stallClassList) return [];
  const rows = Array.from(el.stallClassList.querySelectorAll('.stall-class-row'));
  const items = [];
  for (const row of rows) {
    const index = Number(row.dataset.index);
    if (!Number.isFinite(index)) continue;
    const original = stallClassData[index];
    if (!original) continue;
    const inputStall = row.querySelector('input[data-field="stallCount"]');
    const inputOrder = row.querySelector('input[data-field="orderNo"]');
    items.push({
      id: original.id,
      stallType: original.stall_type,
      sellClass: original.sell_class,
      stallCount: toInt(inputStall && inputStall.value, 0),
      orderNo: toInt(inputOrder && inputOrder.value, 0),
    });
  }
  return items;
}

async function saveAllStallClasses() {
  if (!el.btnSaveAllStallClass) return;
  const items = collectEditedStallClassItems();
  if (items.length === 0) {
    el.hint.textContent = '没有可保存的数据';
    return;
  }
  el.btnSaveAllStallClass.disabled = true;
  el.btnSaveAllStallClass.textContent = '保存中...';
  try {
    const res = await socket.emitWithAck('bigscreen:updateStallClasses', { items });
    if (!res || !res.ok) {
      el.hint.textContent = (res && res.message) || '保存失败';
      return;
    }
    el.hint.textContent = '已保存全部摊位分类';
    renderStallClassList(res.list);
  } finally {
    el.btnSaveAllStallClass.disabled = false;
    el.btnSaveAllStallClass.textContent = '保存全部';
  }
}

socket.on('connect', () => setSocketStatus(true));
socket.on('disconnect', () => setSocketStatus(false));

socket.on('connect', async () => {
  try {
    const cfg = await socket.emitWithAck('bigscreen:getConfig', {});
    if (!cfg || !cfg.ok) return;

    if (cfg.stallType) el.stallType.value = String(cfg.stallType);
    if (cfg.mode === 'queue' || cfg.mode === 'draw') el.mode.value = String(cfg.mode);
    if (cfg.qtyFilter) setQtyFilterValue(cfg.qtyFilter);

    serverMode = cfg.mode === 'queue' || cfg.mode === 'draw' ? cfg.mode : 'idle';
    isRunning = serverMode === 'queue' || serverMode === 'draw';
    updateUi();

    const selectedMode = String(el.mode.value || 'queue');
    if (selectedMode === 'draw') {
      el.hint.textContent = '抽签模式摊位号范围由“摊位分类”配置自动生成';
    }

    await refreshStallClassList();

    await refreshStatus();
  } catch {
    // ignore
  }
});

socket.on('server:currentType', async () => {
  await refreshStatus();
});

socket.on('server:mode', (msg) => {
  const mode = (msg && msg.mode) || 'idle';
  const serverType = (msg && msg.stallType) || '';
  if (msg && msg.qtyFilter) setQtyFilterValue(msg.qtyFilter);

  serverMode = mode === 'queue' || mode === 'draw' ? mode : 'idle';
  isRunning = serverMode === 'queue' || serverMode === 'draw';

  updateUi();

  if (serverMode === 'draw') {
    const stallType = String(el.stallType.value || '').trim();
    if (stallType) applyDefaultRangeForType(stallType);
  }

  refreshStatus();
});

socket.on('server:ownerQueued', async () => {
  await refreshStatus();
});

socket.on('server:drawResultBroadcast', async () => {
  await refreshStatus();
});

el.stallType.addEventListener('change', async () => {
  const stallType = String(el.stallType.value || '').trim();
  if (!stallType) return;
  if (String(el.mode.value || 'queue') === 'draw') {
    el.hint.textContent = '抽签模式摊位号范围由“摊位分类”配置自动生成';
  }
});

el.mode.addEventListener('change', async () => {
  const mode = String(el.mode.value || 'queue');
  updateUi();

  if (mode === 'draw') el.hint.textContent = '抽签模式摊位号范围由“摊位分类”配置自动生成';
});

if (el.qtyFilterGroup) {
  el.qtyFilterGroup.addEventListener('change', async () => {
    await refreshStatus();
  });
}

if (el.btnRefreshStallClass) {
  el.btnRefreshStallClass.addEventListener('click', async () => {
    await refreshStallClassList();
  });
}

if (el.btnSaveAllStallClass) {
  el.btnSaveAllStallClass.addEventListener('click', async () => {
    await saveAllStallClasses();
  });
}

el.btnStartStop.addEventListener('click', async () => {
  const stallType = String(el.stallType.value || '').trim();
  const mode = String(el.mode.value || '').trim();
  if (!stallType) {
    el.hint.textContent = '请先选择摊位类型';
    return;
  }

  if (isRunning) {
    const res = await socket.emitWithAck('bigscreen:setConfig', { stallType, mode: 'idle' });
    if (!res || !res.ok) {
      el.hint.textContent = (res && res.message) || '结束失败';
      return;
    }
    isRunning = false;
    serverMode = 'idle';
    updateUi();
    el.hint.textContent = '已结束';
    await refreshStatus();
    return;
  }

  let stallNumbers = null;
  if (mode === 'draw') stallNumbers = null;

  const qtyFilter = getQtyFilterValue();

  const res = await socket.emitWithAck('bigscreen:setConfig', {
    stallType,
    mode,
    stallNumbers,
    qtyFilter,
  });
  if (!res || !res.ok) {
    el.hint.textContent = (res && res.message) || '开始失败';
    return;
  }

  isRunning = true;
  serverMode = mode;
  updateUi();
  el.hint.textContent = `已开始：${stallType} / ${mode === 'queue' ? '排号' : '抽签'} / ${qtyFilter === 'single' ? '单摊位' : '多摊位'}`;
  const url = mode === 'queue' ? './queue.html' : './draw.html';
  window.open(url, '_blank', 'noopener');
  await refreshStatus();
});

updateUi();
