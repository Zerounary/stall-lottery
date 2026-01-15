const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const ExcelJS = require('exceljs');

const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/export/lottery-result.xlsx', async (req, res) => {
  try {
    const stallType = String((req.query && req.query.stallType) || '').trim();
    if (!stallType) {
      res.status(400).send('stallType required');
      return;
    }

    const rows = await db.getLotteryResultsByStallType(stallType);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('抽签结果');

    ws.columns = [
      { header: '姓名', key: 'name', width: 14 },
      { header: '身份证号', key: 'idCard', width: 22 },
      { header: '摊位类型', key: 'stallType', width: 14 },
      { header: '经营分类', key: 'sellClass', width: 14 },
      { header: '排号', key: 'queueNo', width: 10 },
      { header: '摊位号', key: 'stallNo', width: 12 },
      { header: '抽签时间', key: 'createdAt', width: 20 },
    ];

    for (const r of rows) {
      ws.addRow({
        name: r.name,
        idCard: r.idCard,
        stallType: r.stallType,
        sellClass: r.sellClass || '',
        queueNo: r.queueNo,
        stallNo: r.stallNo,
        createdAt: r.createdAt,
      });
    }

    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const filename = `抽签结果_${stallType}.xlsx`;
    const filenameStar = encodeURIComponent(filename);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filenameStar}`);

    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error(e);
    res.status(500).send('export failed');
  }
});

app.get('/api/export/stall-class.xlsx', async (req, res) => {
  try {
    const rows = await db.getStallClasses();
    const rangesById = new Map();
    const grouped = new Map();
    for (const r of rows) {
      const type = String(r.stall_type || '').trim();
      if (!grouped.has(type)) grouped.set(type, []);
      grouped.get(type).push(r);
    }
    for (const [type, list] of grouped.entries()) {
      const sorted = list.slice().sort((a, b) => {
        const ao = Number(a.order_no || 0);
        const bo = Number(b.order_no || 0);
        if (ao !== bo) return ao - bo;
        return Number(a.id || 0) - Number(b.id || 0);
      });
      let cursor = 1;
      for (const row of sorted) {
        const count = Math.max(0, Number(row.stall_count || 0));
        const start = cursor;
        const end = count > 0 ? cursor + count - 1 : 0;
        cursor = end + 1;
        rangesById.set(row.id, { start, end, count, type });
      }
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('摊位分类');

    ws.columns = [
      { header: '摊位类型', key: 'stallType', width: 16 },
      { header: '经营分类', key: 'sellClass', width: 18 },
      { header: '号段', key: 'range', width: 16 },
      { header: '摊位数', key: 'stallCount', width: 12 },
      { header: '顺序', key: 'orderNo', width: 10 },
      { header: '需求人数', key: 'personCount', width: 12 },
    ];

    for (const r of rows) {
      const rangeInfo = rangesById.get(r.id) || null;
      const rangeText =
        rangeInfo && rangeInfo.count > 0 ? `${rangeInfo.start}-${rangeInfo.end}` : '-';
      ws.addRow({
        stallType: r.stall_type,
        sellClass: r.sell_class,
        range: rangeText,
        stallCount: r.stall_count,
        orderNo: r.order_no,
        personCount: r.person_count,
      });
    }

    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const filename = '摊位分类.xlsx';
    const filenameStar = encodeURIComponent(filename);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filenameStar}`);

    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error(e);
    res.status(500).send('export failed');
  }
});

let currentStallType = '';
let currentMode = 'idle';
let currentQtyFilter = 'multi';
let currentStallNumbers = null;
// Map<stallType, Map<sellClass, number[]>>
const stallPools = new Map();
const typeStates = new Map();
const drawCursors = new Map();

function getTypePoolMap(stallType) {
  const m = stallPools.get(stallType);
  return m && typeof m === 'object' ? m : null;
}

function getTypeRemaining(stallType) {
  const m = getTypePoolMap(stallType);
  if (!m) return 0;
  let total = 0;
  for (const pool of m.values()) {
    total += Array.isArray(pool) ? pool.length : 0;
  }
  return total;
}

async function buildPoolsForTypeFromStallClass(stallType) {
  const list = await db.getStallClasses();
  const rows = Array.isArray(list) ? list.filter((r) => String(r.stall_type || '').trim() === stallType) : [];
  rows.sort((a, b) => {
    const ao = Number(a.order_no || 0);
    const bo = Number(b.order_no || 0);
    if (ao !== bo) return ao - bo;
    return Number(a.id || 0) - Number(b.id || 0);
  });

  const total = rows.reduce((sum, r) => sum + Math.max(0, Number(r.stall_count || 0)), 0);
  const stallNumbers = Array.from({ length: total }, (_, i) => i + 1);

  const drawn = new Set((await db.getDrawnStallNosByType(stallType)).map((x) => Number(x)).filter((n) => Number.isFinite(n)));

  const poolsByClass = new Map();
  let cursor = 1;
  for (const r of rows) {
    const sellClass = String(r.sell_class || '').trim();
    const count = Math.max(0, Number(r.stall_count || 0));
    const start = cursor;
    const end = cursor + count - 1;
    cursor = end + 1;

    const pool = [];
    for (let n = start; n <= end; n += 1) {
      if (!drawn.has(n)) pool.push(n);
    }
    poolsByClass.set(sellClass, pool);
  }

  stallPools.set(stallType, poolsByClass);
  currentStallNumbers = stallNumbers;

  return {
    total,
    remaining: getTypeRemaining(stallType),
  };
}

function pickContiguousAndRemove(pool, count) {
  if (!Array.isArray(pool) || pool.length === 0) return [];
  const c = Math.max(1, Number(count || 1));
  if (pool.length < c) return [];

  if (c === 1) {
    const idx = Math.floor(Math.random() * pool.length);
    const val = pool[idx];
    pool.splice(idx, 1);
    return [val];
  }

  const candidates = [];
  let runStart = 0;
  for (let i = 1; i <= pool.length; i += 1) {
    const isBreak = i === pool.length || pool[i] !== pool[i - 1] + 1;
    if (!isBreak) continue;

    const runEnd = i - 1;
    const runLen = runEnd - runStart + 1;
    if (runLen >= c) {
      for (let s = runStart; s <= runEnd - c + 1; s += 1) {
        candidates.push(s);
      }
    }
    runStart = i;
  }

  if (candidates.length === 0) return [];
  const startIdx = candidates[Math.floor(Math.random() * candidates.length)];
  return pool.splice(startIdx, c);
}

function getCurrentTypeSnapshot() {
  if (!currentStallType) return { stallType: '', remaining: 0 };
  return { stallType: currentStallType, remaining: getTypeRemaining(currentStallType) };
}

function normalizeQtyFilter(v) {
  const s = String(v || '').trim();
  if (s === 'single' || s === 'multi') return s;
  return 'single';
}

function toTypeStatesPayload() {
  return Array.from(typeStates.entries()).map(([stallType, s]) => ({ stallType, ...s }));
}

function getModeSnapshot() {
  return { stallType: currentStallType, mode: currentMode, qtyFilter: currentQtyFilter };
}

async function buildStatusSnapshot() {
  const stallType = String(currentStallType || '').trim();
  const mode = currentMode;
  const qtyFilter = currentQtyFilter;

  if (!stallType) {
    return { ok: true, stallType: '', mode: mode || 'idle', qtyFilter };
  }

  if (mode === 'queue') {
    const nextQueueNo = await db.getNextQueueNoByTypeAndQtyFilter({ stallType, qtyFilter });
    const queuedCount = await db.countQueuedOwnersByType(stallType, qtyFilter);
    const unqueuedCount = await db.countUnqueuedOwnersByType(stallType, qtyFilter);
    return {
      ok: true,
      stallType,
      mode,
      qtyFilter,
      queue: { nextQueueNo, queuedCount, unqueuedCount },
    };
  }

  if (mode === 'draw') {
    const cursor = drawCursors.get(stallType) || 0;
    const stallNumbers = Array.isArray(currentStallNumbers) ? currentStallNumbers : [];
    const drawnStallNos = await db.getDrawnStallNosByType(stallType);

    const remainingCount = getTypeRemaining(stallType);
    const total = stallNumbers.length;
    const drawnCount = Math.max(0, total - remainingCount);

    return {
      ok: true,
      stallType,
      mode,
      qtyFilter,
      draw: {
        cursor,
        total,
        drawnCount,
        remainingCount,
        stallNumbers,
        drawnStallNos,
      },
    };
  }

  return { ok: true, stallType, mode: mode || 'idle', qtyFilter };
}

function safeJsonParse(v, fallback) {
  try {
    return JSON.parse(String(v));
  } catch {
    return fallback;
  }
}

async function persistRuntimeConfig() {
  await db.setAppConfig('config:stallType', currentStallType);
  await db.setAppConfig('config:mode', currentMode);
  await db.setAppConfig('config:qtyFilter', currentQtyFilter);
  await db.setAppConfig('config:stallNumbers', currentStallNumbers ? JSON.stringify(currentStallNumbers) : '');
}

async function restoreRuntimeConfigFromDb() {
  const stallType = String((await db.getAppConfig('config:stallType')) || '').trim();
  const mode = String((await db.getAppConfig('config:mode')) || 'idle').trim();
  const qtyFilter = normalizeQtyFilter(await db.getAppConfig('config:qtyFilter'));
  await db.getAppConfig('config:stallNumbers');

  if (!stallType) return;

  currentStallType = stallType;
  currentMode = mode === 'queue' || mode === 'draw' ? mode : 'idle';
  currentQtyFilter = qtyFilter;
  currentStallNumbers = null;

  if (currentStallType) {
    drawCursors.set(currentStallType, 0);
  }

  if (currentMode === 'draw') {
    const info = await buildPoolsForTypeFromStallClass(stallType);
    typeStates.set(stallType, { started: true, ended: info.remaining === 0, remaining: info.remaining });
    return;
  }

  if (currentMode === 'queue') {
    stallPools.delete(stallType);
    typeStates.set(stallType, { started: true, ended: false, remaining: 0 });
    return;
  }

  stallPools.delete(stallType);
  typeStates.set(stallType, { started: false, ended: false, remaining: 0 });
}

async function findNextDrawableOwner({ stallType }) {
  const list = await db.getQueuedListByType(stallType, currentQtyFilter);
  const cursor = drawCursors.get(stallType) || 0;

  for (const o of list) {
    const q = Number(o.queueNo || 0);
    if (!q || q < cursor) continue;
    const drawnCount = await db.countLotteryResultsByOwnerType({ idCard: o.idCard, stallType });
    const qty = Number(o.qty || 1);
    if (drawnCount < qty) {
      return { ...o, drawnCount };
    }
  }
  return null;
}

async function doDrawForOwner({ stallType, owner }) {
  const idCard = String(owner.idCard || '').trim();
  const alreadyDrawn = await db.countLotteryResultsByOwnerType({ idCard, stallType });
  const qty = Number(owner.qty || 1);
  if (alreadyDrawn >= qty) {
    return { ok: false, message: '该类型已抽完次数' };
  }

  const sellClass = String(owner.sellClass || '').trim();
  if (!sellClass) {
    return { ok: false, message: '该用户缺少品类信息' };
  }

  const typePoolMap = getTypePoolMap(stallType);
  const pool = typePoolMap ? typePoolMap.get(sellClass) : null;
  if (!pool || pool.length === 0) {
    return { ok: false, message: '抽签完毕' };
  }

  const needCount = Math.max(1, qty - alreadyDrawn);
  if (pool.length < needCount) {
    return { ok: false, message: '剩余摊位号不足' };
  }

  const stallNos = pickContiguousAndRemove(pool, needCount);
  if (!stallNos || stallNos.length !== needCount) {
    return { ok: false, message: '无法从剩余号段中抽取连续摊位' };
  }

  await db.insertLotteryResultsBulk({
    name: owner.name,
    idCard: owner.idCard,
    stallType,
    sellClass,
    queueNo: owner.queueNo,
    stallNos,
  });

  const drawnCount = alreadyDrawn + needCount;
  drawCursors.set(stallType, Number(owner.queueNo || 0) + 1);

  typeStates.set(stallType, {
    started: true,
    ended: getTypeRemaining(stallType) === 0,
    remaining: getTypeRemaining(stallType),
  });

  const typeRemaining = getTypeRemaining(stallType);

  return {
    ok: true,
    message: '抽签成功',
    result: {
      name: owner.name,
      idCard: owner.idCard,
      stallType,
      queueNo: owner.queueNo,
      stallNos,
    },
    draw: {
      qty,
      drawnCount,
      remainingCount: Math.max(0, qty - drawnCount),
    },
    remaining: typeRemaining,
  };
}

io.on('connection', (socket) => {
  console.log('Socket连接:', socket.id);

  socket.emit('server:currentType', getCurrentTypeSnapshot());
  socket.emit('server:typeStates', toTypeStatesPayload());
  socket.emit('server:mode', getModeSnapshot());

  socket.on('client:getCurrentType', (payload = {}, ack) => {
    if (typeof ack === 'function') ack({ ok: true, ...getCurrentTypeSnapshot() });
  });

  socket.on('bigscreen:getConfig', (payload = {}, ack) => {
    if (typeof ack === 'function') {
      ack({
        ok: true,
        stallType: currentStallType,
        mode: currentMode,
        qtyFilter: currentQtyFilter,
        stallNumbers: currentStallNumbers,
      });
    }
  });

  socket.on('bigscreen:getDefaultRange', async (payload = {}, ack) => {
    if (typeof ack === 'function') {
      const stallType = String(payload.stallType || '').trim();
      let defaultRange = '';

      const totalQty = await db.sumQtyByType(stallType);
      defaultRange = `1-${totalQty}`;

      ack({
        ok: true,
        defaultRange,
      });
    }
  });

  socket.on('bigscreen:setConfig', async (payload = {}, ack) => {
    try {
      const stallType = String(payload.stallType || '').trim();
      const mode = String(payload.mode || '').trim();
      if (!stallType || (mode !== 'idle' && mode !== 'queue' && mode !== 'draw')) {
        if (typeof ack === 'function') ack({ ok: false, message: '参数错误' });
        return;
      }
      const qtyFilter = normalizeQtyFilter(payload.qtyFilter || currentQtyFilter);

      currentStallType = stallType;
      currentMode = mode;
      currentQtyFilter = qtyFilter;

      if (mode === 'draw') {
        drawCursors.set(stallType, 0);
      } else {
        drawCursors.delete(stallType);
      }

      if (mode !== 'draw') {
        currentStallNumbers = null;
        stallPools.delete(stallType);
      }

      if (mode === 'draw') {
        const info = await buildPoolsForTypeFromStallClass(stallType);
        typeStates.set(stallType, { started: true, ended: info.remaining === 0, remaining: info.remaining });
      }

      if (mode === 'queue') {
        stallPools.delete(stallType);
        typeStates.set(stallType, { started: true, ended: false, remaining: 0 });
      }

      if (mode === 'idle') {
        stallPools.delete(stallType);
        typeStates.set(stallType, { started: false, ended: false, remaining: 0 });
      }

      await persistRuntimeConfig();

      io.emit('server:mode', getModeSnapshot());
      io.emit('server:currentType', getCurrentTypeSnapshot());
      io.emit('server:typeStates', toTypeStatesPayload());

      if (typeof ack === 'function') ack({ ok: true, stallType, mode, qtyFilter });
    } catch (e) {
      console.error(e);
      if (typeof ack === 'function') ack({ ok: false, message: '服务异常' });
    }
  });

  socket.on('bigscreen:getSnapshot', async (payload = {}, ack) => {
    try {
      const stallType = String(payload.stallType || currentStallType || '').trim();
      if (!stallType) {
        if (typeof ack === 'function') ack({ ok: false, message: '未选择摊位类型' });
        return;
      }
      const queued = await db.getQueuedListByType(stallType, currentQtyFilter);
      const unqueued = await db.getUnqueuedOwnersByType(stallType, currentQtyFilter);
      if (typeof ack === 'function') ack({ ok: true, stallType, qtyFilter: currentQtyFilter, queued, unqueued });
    } catch (e) {
      console.error(e);
      if (typeof ack === 'function') ack({ ok: false, message: '服务异常' });
    }
  });

  socket.on('bigscreen:getUnqueued', async (payload = {}, ack) => {
    try {
      const stallType = String(payload.stallType || currentStallType || '').trim();
      if (!stallType) {
        if (typeof ack === 'function') ack({ ok: false, message: '未选择摊位类型' });
        return;
      }
      const list = await db.getUnqueuedOwnersByType(stallType, currentQtyFilter);
      if (typeof ack === 'function') ack({ ok: true, stallType, qtyFilter: currentQtyFilter, list });
    } catch (e) {
      console.error(e);
      if (typeof ack === 'function') ack({ ok: false, message: '服务异常' });
    }
  });

  socket.on('bigscreen:getStallClasses', async (payload = {}, ack) => {
    try {
      const list = await db.getStallClasses();
      if (typeof ack === 'function') ack({ ok: true, list });
    } catch (e) {
      console.error(e);
      if (typeof ack === 'function') ack({ ok: false, message: '服务异常' });
    }
  });

  socket.on('bigscreen:updateStallClass', async (payload = {}, ack) => {
    try {
      const id = Number(payload.id);
      if (!Number.isFinite(id) || id <= 0) {
        if (typeof ack === 'function') ack({ ok: false, message: '参数错误' });
        return;
      }

      const stallType = String(payload.stallType || '').trim();
      const sellClass = String(payload.sellClass || '').trim();
      const stallCount = Number(payload.stallCount || 0);
      const orderNo = Number(payload.orderNo || 0);
      if (!stallType || !sellClass || !Number.isFinite(stallCount) || !Number.isFinite(orderNo)) {
        if (typeof ack === 'function') ack({ ok: false, message: '参数错误' });
        return;
      }

      await db.updateStallClass({
        id,
        stallType,
        sellClass,
        stallCount,
        orderNo,
      });
      const list = await db.getStallClasses();
      if (typeof ack === 'function') ack({ ok: true, list });
    } catch (e) {
      console.error(e);
      if (typeof ack === 'function') ack({ ok: false, message: '更新失败' });
    }
  });

  socket.on('bigscreen:updateStallClasses', async (payload = {}, ack) => {
    try {
      const items = Array.isArray(payload.items) ? payload.items : [];
      if (items.length === 0) {
        if (typeof ack === 'function') ack({ ok: false, message: '没有可更新的数据' });
        return;
      }

      for (const item of items) {
        const id = Number(item && item.id);
        const stallType = String((item && item.stallType) || '').trim();
        const sellClass = String((item && item.sellClass) || '').trim();
        const stallCount = Number(item && item.stallCount);
        const orderNo = Number(item && item.orderNo);
        if (!Number.isFinite(id) || id <= 0 || !stallType || !sellClass || !Number.isFinite(stallCount) || !Number.isFinite(orderNo)) {
          if (typeof ack === 'function') ack({ ok: false, message: '存在无效的行数据' });
          return;
        }
        await db.updateStallClass({ id, stallType, sellClass, stallCount, orderNo });
      }

      const list = await db.getStallClasses();
      if (typeof ack === 'function') ack({ ok: true, list });
    } catch (e) {
      console.error(e);
      if (typeof ack === 'function') ack({ ok: false, message: '批量更新失败' });
    }
  });

  socket.on('bigscreen:stallClass:list', async (payload = {}, ack) => {
    try {
      const list = await db.getStallClasses();
      if (typeof ack === 'function') ack({ ok: true, list });
    } catch (e) {
      console.error(e);
      if (typeof ack === 'function') ack({ ok: false, message: '服务异常' });
    }
  });

  socket.on('bigscreen:stallClass:add', async (payload = {}, ack) => {
    try {
      await db.addStallClass(payload);
      const list = await db.getStallClasses();
      if (typeof ack === 'function') ack({ ok: true, list });
    } catch (e) {
      console.error(e);
      if (typeof ack === 'function') ack({ ok: false, message: '添加失败' });
    }
  });

  socket.on('bigscreen:stallClass:update', async (payload = {}, ack) => {
    try {
      await db.updateStallClass(payload);
      const list = await db.getStallClasses();
      if (typeof ack === 'function') ack({ ok: true, list });
    } catch (e) {
      console.error(e);
      if (typeof ack === 'function') ack({ ok: false, message: '更新失败' });
    }
  });

  socket.on('bigscreen:stallClass:delete', async (payload = {}, ack) => {
    try {
      await db.deleteStallClass(payload.id);
      const list = await db.getStallClasses();
      if (typeof ack === 'function') ack({ ok: true, list });
    } catch (e) {
      console.error(e);
      if (typeof ack === 'function') ack({ ok: false, message: '删除失败' });
    }
  });

  socket.on('mobile:login', async (payload = {}, ack) => {
    try {
      const idCard = String(payload.idCard || '').trim();
      const name = String(payload.name || '').trim();
      if (!idCard || !name) {
        if (typeof ack === 'function') ack({ ok: false, message: '信息不完整' });
        return;
      }

      const result = await db.validateOwnerLogin({ idCard, name });
      if (!result.ok) {
        if (typeof ack === 'function') ack(result);
        return;
      }

      const ownersWithDrawn = await Promise.all(
        result.owners.map(async (o) => {
          const drawnCount = await db.countLotteryResultsByOwnerType({ idCard: o.idCard, stallType: o.stallType });
          return { ...o, drawnCount };
        })
      );

      if (typeof ack === 'function') ack({ ok: true, message: '验证通过', owners: ownersWithDrawn });
    } catch (e) {
      console.error(e);
      if (typeof ack === 'function') ack({ ok: false, message: '服务异常' });
    }
  });

  socket.on('mobile:queue', async (payload = {}, ack) => {
    try {
      const idCard = String(payload.idCard || '').trim();
      const stallType = String(payload.stallType || '').trim();
      if (!idCard || !stallType) {
        if (typeof ack === 'function') ack({ ok: false, message: '信息不完整' });
        return;
      }
      if (!currentStallType || stallType !== currentStallType) {
        if (typeof ack === 'function') ack({ ok: false, message: '当前不是该类型抽签阶段' });
        return;
      }

      if (currentMode !== 'queue') {
        if (typeof ack === 'function') ack({ ok: false, message: '当前不是排号模式' });
        return;
      }

      const owner = await db.getOwnerByIdCardAndType(idCard, stallType);
      if (!owner) {
        if (typeof ack === 'function') ack({ ok: false, message: '未找到报名信息' });
        return;
      }

      const qty = Number(owner.qty || 1);
      if (currentQtyFilter === 'single' && qty !== 1) {
        if (typeof ack === 'function') ack({ ok: false, message: '当前仅允许单摊位（认购数量 = 1）用户排号' });
        return;
      }
      if (currentQtyFilter === 'multi' && qty <= 1) {
        if (typeof ack === 'function') ack({ ok: false, message: '当前仅允许多摊位（认购数量 > 1）用户排号' });
        return;
      }

      let queueNo = owner.queueNo;
      if (!owner.isQueued) {
        const allocated = await db.allocateQueueNoAndQueueOwner({ idCard, stallType, qtyFilter: currentQtyFilter });
        if (!allocated || !allocated.ok || !allocated.queueNo) {
          if (typeof ack === 'function') ack({ ok: false, message: (allocated && allocated.message) || '排号失败' });
          return;
        }
        queueNo = allocated.queueNo;
      }

      const updated = await db.getOwnerByIdCardAndType(idCard, stallType);

      const drawnCount = await db.countLotteryResultsByOwnerType({ idCard, stallType });
      const res = { ok: true, message: '排号成功', owner: { ...updated, drawnCount } };

      socket.emit('server:queueUpdated', res);
      io.emit('server:ownerQueued', { stallType, owner: updated });

      if (typeof ack === 'function') ack(res);
    } catch (e) {
      console.error(e);
      if (typeof ack === 'function') ack({ ok: false, message: '服务异常' });
    }
  });

  socket.on('bigscreen:draw:next', async (payload = {}, ack) => {
    try {
      const stallType = String(payload.stallType || currentStallType || '').trim();
      if (!stallType) {
        if (typeof ack === 'function') ack({ ok: false, message: '未选择摊位类型' });
        return;
      }
      if (currentMode !== 'draw') {
        if (typeof ack === 'function') ack({ ok: false, message: '当前不是抽签模式' });
        return;
      }
      const owner = await findNextDrawableOwner({ stallType });
      if (!owner) {
        if (typeof ack === 'function') ack({ ok: true, owner: null, message: '暂无可抽签人员' });
        return;
      }
      if (typeof ack === 'function') ack({ ok: true, owner });
    } catch (e) {
      console.error(e);
      if (typeof ack === 'function') ack({ ok: false, message: '服务异常' });
    }
  });

  socket.on('bigscreen:draw:doDraw', async (payload = {}, ack) => {
    try {
      const stallType = String(payload.stallType || currentStallType || '').trim();
      const idCard = String(payload.idCard || '').trim();
      if (!stallType || !idCard) {
        if (typeof ack === 'function') ack({ ok: false, message: '参数错误' });
        return;
      }
      if (currentMode !== 'draw') {
        if (typeof ack === 'function') ack({ ok: false, message: '当前不是抽签模式' });
        return;
      }

      const owner = await db.getOwnerByIdCardAndType(idCard, stallType);
      if (!owner) {
        if (typeof ack === 'function') ack({ ok: false, message: '未找到报名信息' });
        return;
      }

      const qty = Number(owner.qty || 1);
      if (currentQtyFilter === 'single' && qty !== 1) {
        if (typeof ack === 'function') ack({ ok: false, message: '当前仅允许单摊位（认购数量 = 1）用户抽签' });
        return;
      }
      if (currentQtyFilter === 'multi' && qty <= 1) {
        if (typeof ack === 'function') ack({ ok: false, message: '当前仅允许多摊位（认购数量 > 1）用户抽签' });
        return;
      }
      if (!owner.isQueued || !owner.queueNo) {
        if (typeof ack === 'function') ack({ ok: false, message: '该用户未排号' });
        return;
      }

      const res = await doDrawForOwner({ stallType, owner });
      if (res.ok) {
        io.emit('server:drawResult', res);
        io.emit('server:drawResultBroadcast', res);
        io.emit('server:currentType', { stallType, remaining: res.remaining });
        io.emit('server:typeStates', toTypeStatesPayload());
      }
      if (typeof ack === 'function') ack(res);
    } catch (e) {
      console.error(e);
      if (typeof ack === 'function') ack({ ok: false, message: '服务异常' });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('Socket断开:', socket.id, reason);
  });
});

const PORT = Number(process.env.PORT || 3000);

(async () => {
  await db.init();
  await restoreRuntimeConfigFromDb();

  server.listen(PORT, () => {
    console.log(`服务启动成功: http://localhost:${PORT}`);
    console.log(`大屏端: http://localhost:${PORT}/bigscreen/index.html`);
    console.log(`手机端: http://localhost:${PORT}/mobile/index.html`);
  });
})();
