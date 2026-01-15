const socket = io();

const el = {
  loginCard: document.getElementById('loginCard'),
  mainCard: document.getElementById('mainCard'),
  idCard: document.getElementById('idCard'),
  name: document.getElementById('name'),
  btnLogin: document.getElementById('btnLogin'),
  btnLogout: document.getElementById('btnLogout'),
  loginMsg: document.getElementById('loginMsg'),
  infoName: document.getElementById('infoName'),
  infoIdCard: document.getElementById('infoIdCard'),
  currentTypeMobile: document.getElementById('currentTypeMobile'),
  currentRemainingMobile: document.getElementById('currentRemainingMobile'),
  typeCards: document.getElementById('typeCards'),
  detailType: document.getElementById('detailType'),
  detailStatus: document.getElementById('detailStatus'),
  infoQty: document.getElementById('infoQty'),
  infoQueueNo: document.getElementById('infoQueueNo'),
  btnQueue: document.getElementById('btnQueue'),
  result: document.getElementById('result'),
  socketStatus: document.getElementById('socketStatus'),
};

let session = null;
let selectedStallType = '';
let currentType = { stallType: '', remaining: 0 };
let typeStates = new Map();

const STORAGE_KEY = 'stall_lottery_mobile_session_v1';

function loadStoredSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.idCard || !data.name) return null;
    return {
      idCard: String(data.idCard),
      name: String(data.name),
      selectedStallType: data.selectedStallType ? String(data.selectedStallType) : '',
    };
  } catch {
    return null;
  }
}

function saveStoredSession() {
  if (!session) return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        idCard: session.idCard,
        name: session.name,
        selectedStallType,
      })
    );
  } catch {
    // ignore
  }
}

function clearStoredSession() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

async function refreshSessionFromServer() {
  if (!session || !session.idCard || !session.name) return;

  const res = await socket.emitWithAck('mobile:login', { idCard: session.idCard, name: session.name });
  if (!res || !res.ok) {
    session = null;
    selectedStallType = '';
    clearStoredSession();
    showLogin((res && res.message) || '登录状态已失效，请重新登录');
    return;
  }

  session = {
    idCard: session.idCard,
    name: session.name,
    owners: Array.isArray(res.owners) ? res.owners : [],
  };

  if (!selectedStallType) {
    selectedStallType = session.owners[0] ? session.owners[0].stallType : '';
  }
  showMain();
  rerenderAll();
  saveStoredSession();
}

function setSocketStatus(connected) {
  el.socketStatus.textContent = connected ? '已连接' : '未连接';
}

function showLogin(message) {
  el.loginCard.classList.remove('hidden');
  el.mainCard.classList.add('hidden');
  el.loginMsg.textContent = message || '';
  if (el.btnLogout) el.btnLogout.classList.add('hidden');
}

function showMain() {
  el.loginCard.classList.add('hidden');
  el.mainCard.classList.remove('hidden');
  if (el.btnLogout) el.btnLogout.classList.remove('hidden');
}

function getSelectedOwner() {
  if (!session || !Array.isArray(session.owners)) return null;
  return session.owners.find((o) => String(o.stallType) === String(selectedStallType)) || null;
}

function getTypeState(stallType) {
  const s = typeStates.get(String(stallType));
  return s || { started: false, ended: false, remaining: 0 };
}

function getStatusLabel(stallType) {
  const s = getTypeState(stallType);
  if (!s.started) return '未开始';
  if (s.ended) return '已结束';
  return '进行中';
}

function setButtonState({ isQueued, canDraw }) {
  if (!isQueued) {
    el.btnQueue.classList.remove('hidden');
    return;
  }
  el.btnQueue.classList.add('hidden');
}

function renderSelectedOwner() {
  if (!session) return;

  el.infoName.textContent = session.name;
  el.infoIdCard.textContent = session.idCard;

  const o = getSelectedOwner();
  if (!o) {
    el.detailType.textContent = '-';
    el.detailStatus.textContent = '-';
    el.infoQty.textContent = '-';
    el.infoQueueNo.textContent = '-';
    setButtonState({ isQueued: false, canDraw: false });
    return;
  }

  el.detailType.textContent = o.stallType;
  el.detailStatus.textContent = getStatusLabel(o.stallType);

  const qty = Number(o.qty || 1);
  const drawnCount = Number(o.drawnCount || 0);

  el.infoQty.textContent = String(qty);
  el.infoQueueNo.textContent = o.isQueued ? String(o.queueNo || '-') : '-';

  setButtonState({ isQueued: Boolean(o.isQueued), canDraw: false });
}

function renderCards() {
  el.typeCards.innerHTML = '';
  if (!session || !Array.isArray(session.owners)) return;

  for (const o of session.owners) {
    const status = getStatusLabel(o.stallType);
    const isDisabled = status === '未开始';
    const isDone = status === '已结束';

    const card = document.createElement('div');
    card.className = `type-card${isDisabled ? ' disabled' : ''}`;

    let badgeClass = 'badge';
    if (status === '未开始') badgeClass = 'badge badge-warn';
    if (status === '进行中') badgeClass = 'badge badge-ok';
    if (status === '已结束') badgeClass = 'badge badge-done';

    const rightText = isDone && o.isQueued ? `排号 ${o.queueNo}` : status;

    card.innerHTML = `<div class="type-name">${o.stallType}</div><div class="${badgeClass}">${rightText}</div>`;

    card.addEventListener('click', () => {
      if (isDisabled) return;
      selectedStallType = o.stallType;
      renderSelectedOwner();
      el.result.textContent = status === '已结束' ? '该类型已结束' : '可进行排号，抽签需到大屏端进行';
      saveStoredSession();
    });

    el.typeCards.appendChild(card);
  }
}

function rerenderAll() {
  if (!session) return;
  renderCards();
  if (!selectedStallType && session.owners[0]) selectedStallType = session.owners[0].stallType;
  renderSelectedOwner();
}

socket.on('connect', async () => {
  setSocketStatus(true);

  const stored = loadStoredSession();
  if (!session && stored) {
    el.idCard.value = stored.idCard;
    el.name.value = stored.name;
    session = { idCard: stored.idCard, name: stored.name, owners: [] };
    selectedStallType = stored.selectedStallType || '';
    showMain();
  }

  if (session) {
    await refreshSessionFromServer();
  }
});
socket.on('disconnect', () => setSocketStatus(false));

socket.on('server:currentType', (msg) => {
  currentType = {
    stallType: msg && msg.stallType ? String(msg.stallType) : '',
    remaining: msg && typeof msg.remaining === 'number' ? msg.remaining : 0,
  };
  el.currentTypeMobile.textContent = currentType.stallType || '未开始';
  el.currentRemainingMobile.textContent = currentType.stallType ? String(currentType.remaining) : '-';
});

socket.on('server:typeStates', (list) => {
  typeStates = new Map();
  if (Array.isArray(list)) {
    for (const s of list) {
      if (!s || !s.stallType) continue;
      typeStates.set(String(s.stallType), {
        started: Boolean(s.started),
        ended: Boolean(s.ended),
        remaining: typeof s.remaining === 'number' ? s.remaining : 0,
      });
    }
  }
  rerenderAll();
});

socket.on('server:queueUpdated', (msg) => {
  if (!msg || !msg.ok || !msg.owner) return;
  if (!session) return;
  if (String(msg.owner.idCard) !== String(session.idCard)) return;

  const idx = session.owners.findIndex((o) => String(o.stallType) === String(msg.owner.stallType));
  if (idx >= 0) {
    session.owners[idx] = { ...session.owners[idx], ...msg.owner };
  }

  if (!selectedStallType) selectedStallType = msg.owner.stallType;
  rerenderAll();
  el.result.textContent = `排号成功（${msg.owner.stallType}）：${msg.owner.queueNo}`;
});

socket.on('server:drawResult', (msg) => {
  if (!msg || !msg.ok || !msg.result) return;
  if (!session) return;
  if (String(msg.result.idCard) !== String(session.idCard)) return;
  const nos = Array.isArray(msg.result.stallNos) ? msg.result.stallNos : [];
  const showNo = nos.length > 1 ? `${nos[0]}-${nos[nos.length - 1]}` : String(nos[0] ?? '');
  el.result.textContent = `恭喜！${msg.result.stallType} 抽到摊位号：${showNo}`;

  if (session) {
    const idx = session.owners.findIndex((o) => String(o.stallType) === String(msg.result.stallType));
    if (idx >= 0) {
      const prev = session.owners[idx];
      const drawnCount = msg.draw && typeof msg.draw.drawnCount === 'number' ? msg.draw.drawnCount : Number(prev.drawnCount || 0) + 1;
      session.owners[idx] = { ...prev, drawnCount };
    }
  }

  rerenderAll();
});

el.btnLogin.addEventListener('click', async () => {
  const idCard = String(el.idCard.value || '').trim();
  const name = String(el.name.value || '').trim();
  if (!idCard || !name) {
    el.loginMsg.textContent = '请填写完整信息';
    return;
  }

  const res = await socket.emitWithAck('mobile:login', { idCard, name });
  if (!res || !res.ok) {
    el.loginMsg.textContent = (res && res.message) || '登录失败';
    return;
  }

  session = {
    idCard,
    name,
    owners: Array.isArray(res.owners) ? res.owners : [],
  };
  selectedStallType = session.owners[0] ? session.owners[0].stallType : '';
  showMain();
  rerenderAll();
  el.result.textContent = '请选择一个类型';
  saveStoredSession();
});

if (el.btnLogout) {
  el.btnLogout.addEventListener('click', () => {
    session = null;
    selectedStallType = '';
    clearStoredSession();
    el.idCard.value = '';
    el.name.value = '';
    el.result.textContent = '您已退出登录';
    showLogin('');
  });
}

el.btnQueue.addEventListener('click', async () => {
  if (!session) return;
  const o = getSelectedOwner();
  if (!o) return;
  const res = await socket.emitWithAck('mobile:queue', { stallType: o.stallType, idCard: session.idCard });
  if (!res || !res.ok) {
    el.result.textContent = (res && res.message) || '排号失败';
    return;
  }
});

const stored = loadStoredSession();
if (stored) {
  el.idCard.value = stored.idCard;
  el.name.value = stored.name;
  session = { idCard: stored.idCard, name: stored.name, owners: [] };
  selectedStallType = stored.selectedStallType || '';
  showMain();
} else {
  showLogin('');
}
