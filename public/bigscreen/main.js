const socket = io();

const el = {
  socketStatus: document.getElementById('socketStatus'),
  currentType: document.getElementById('currentType'),
  btnTypeVeg: document.getElementById('btnTypeVeg'),
  btnTypeMeat: document.getElementById('btnTypeMeat'),
  btnTypeFlower: document.getElementById('btnTypeFlower'),
  btnTypeCar: document.getElementById('btnTypeCar'),
  btnTypeExhibit: document.getElementById('btnTypeExhibit'),
  stallNumbers: document.getElementById('stallNumbers'),
  btnApplyType: document.getElementById('btnApplyType'),
  remaining: document.getElementById('remaining'),
  mobileUrl: document.getElementById('mobileUrl'),
  qrImg: document.getElementById('qrImg'),
  queueList: document.getElementById('queueList'),
  btnQueryUnqueued: document.getElementById('btnQueryUnqueued'),
  unqueuedCount: document.getElementById('unqueuedCount'),
  unqueuedList: document.getElementById('unqueuedList'),
  callNo: document.getElementById('callNo'),
  btnCall: document.getElementById('btnCall'),
  callDisplay: document.getElementById('callDisplay'),
  resultDisplay: document.getElementById('resultDisplay'),
};

let selectedType = '';

function setSocketStatus(connected) {
  el.socketStatus.textContent = connected ? '已连接' : '未连接';
  el.socketStatus.classList.toggle('pill-ok', connected);
  el.socketStatus.classList.toggle('pill-warn', !connected);
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
    for (let i = start; i <= end; i += 1) out.push(String(i));
    return out;
  }

  return v
    .split(',')
    .map((s) => String(s).trim())
    .filter(Boolean);
}

function renderQueued(list) {
  el.queueList.innerHTML = '';
  if (!Array.isArray(list) || list.length === 0) {
    el.queueList.innerHTML = '<div class="muted">暂无排号</div>';
    return;
  }
  for (const item of list) {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `<strong>${item.queueNo}</strong><span>${item.name}</span>`;
    el.queueList.appendChild(div);
  }
}

function renderUnqueued(list) {
  el.unqueuedList.innerHTML = '';
  if (!Array.isArray(list) || list.length === 0) {
    el.unqueuedList.innerHTML = '<div class="muted">全部已排号</div>';
    el.unqueuedCount.textContent = '';
    return;
  }
  el.unqueuedCount.textContent = `未排号：${list.length} 人`;
  for (const item of list) {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `<span>${item.name}</span><span class="muted">-</span>`;
    el.unqueuedList.appendChild(div);
  }
}

function updateMobileUrl() {
  const url = `${window.location.origin}/mobile/index.html`;
  el.mobileUrl.textContent = url;
  const qr = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(url)}`;
  el.qrImg.src = qr;
}

async function refreshSnapshot(stallType) {
  const res = await socket.emitWithAck('bigscreen:getSnapshot', { stallType });
  if (!res || !res.ok) return;
  renderQueued(res.queued);
  renderUnqueued(res.unqueued);
}

socket.on('connect', () => {
  setSocketStatus(true);
  updateMobileUrl();
});

socket.on('disconnect', () => {
  setSocketStatus(false);
});

socket.on('server:stallTypeChanged', async (msg) => {
  if (!msg || !msg.ok) return;
  el.currentType.textContent = msg.stallType;
  el.remaining.textContent = `剩余摊位号：${msg.remaining}`;
  await refreshSnapshot(msg.stallType);
});

socket.on('server:ownerQueued', async (msg) => {
  if (!msg || !msg.stallType) return;
  if (String(msg.stallType) !== String(el.currentType.textContent)) return;
  await refreshSnapshot(msg.stallType);
});

socket.on('server:drawResultBroadcast', (msg) => {
  if (!msg || !msg.ok || !msg.result) return;
  const r = msg.result;
  const nos = Array.isArray(r.stallNos) ? r.stallNos : [];
  const showNo = nos.length > 1 ? `${nos[0]}-${nos[nos.length - 1]}` : String(nos[0] ?? '');
  el.resultDisplay.textContent = `排号 ${r.queueNo}  抽到 ${showNo}`;
  if (typeof msg.remaining === 'number') {
    el.remaining.textContent = `剩余摊位号：${msg.remaining}`;
  }
});

async function applyDefaultRangeForType(stallType) {
  const res = await socket.emitWithAck('bigscreen:getDefaultRange', { stallType });
  if (!res || !res.ok) return;
  el.stallNumbers.value = res.defaultRange;
}

el.btnTypeVeg.addEventListener('click', () => {
  selectedType = '蔬菜摊';
  el.currentType.textContent = selectedType;
  applyDefaultRangeForType(selectedType);
});

el.btnTypeMeat.addEventListener('click', () => {
  selectedType = '肉摊';
  el.currentType.textContent = selectedType;
  applyDefaultRangeForType(selectedType);
});

el.btnTypeFlower.addEventListener('click', () => {
  selectedType = '花车';
  el.currentType.textContent = selectedType;
  applyDefaultRangeForType(selectedType);
});

el.btnTypeCar.addEventListener('click', () => {
  selectedType = '车载摊位';
  el.currentType.textContent = selectedType;
  applyDefaultRangeForType(selectedType);
});

el.btnTypeExhibit.addEventListener('click', () => {
  selectedType = '展销摊位';
  el.currentType.textContent = selectedType;
  applyDefaultRangeForType(selectedType);
});

el.btnApplyType.addEventListener('click', async () => {
  const stallType = String(selectedType || '').trim();
  const stallNumbers = parseNumbers(el.stallNumbers.value);
  if (!stallType) {
    alert('请先选择摊位类型');
    return;
  }
  if (stallNumbers.length === 0) {
    alert('摊位号列表不能为空');
    return;
  }

  const res = await socket.emitWithAck('bigscreen:switchType', { stallType, stallNumbers });
  if (!res || !res.ok) {
    alert((res && res.message) || '切换失败');
    return;
  }
});

el.btnQueryUnqueued.addEventListener('click', async () => {
  const stallType = String(el.currentType.textContent || '').trim();
  if (!stallType || stallType === '未选择') {
    alert('请先切换摊位类型');
    return;
  }
  const res = await socket.emitWithAck('bigscreen:getUnqueued', { stallType });
  if (!res || !res.ok) {
    alert((res && res.message) || '查询失败');
    return;
  }
  renderUnqueued(res.list);
});

el.btnCall.addEventListener('click', () => {
  const no = String(el.callNo.value || '').trim();
  if (!no) return;
  el.callDisplay.textContent = `请 ${no} 号上台`;
});
