const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbFile = path.join(__dirname, 'stall.db');
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) {
    console.error('SQLite连接失败:', err.message);
    return;
  }
  console.log('SQLite连接成功:', dbFile);
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function ensureColumnExists({ table, column, definition }) {
  const rows = await all(`PRAGMA table_info(${table})`);
  const exists = rows.some((r) => String(r.name).toLowerCase() === String(column).toLowerCase());
  if (exists) return;
  await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function init() {
  await run(
    `CREATE TABLE IF NOT EXISTS stall_owner (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      id_card TEXT NOT NULL,
      stall_type TEXT NOT NULL,
      sell_class TEXT NOT NULL,
      qty INTEGER NOT NULL DEFAULT 1,
      queue_no INTEGER DEFAULT 0,
      is_queued INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(id_card, stall_type)
    )`
  );

  await ensureColumnExists({ table: 'stall_owner', column: 'qty', definition: 'INTEGER NOT NULL DEFAULT 1' });

  await run(
    `CREATE TABLE IF NOT EXISTS lottery_result (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      id_card TEXT NOT NULL,
      stall_type TEXT NOT NULL,
      sell_class TEXT NOT NULL,
      queue_no INTEGER NOT NULL,
      stall_no TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(stall_type, stall_no)
    )`
  );

  await ensureColumnExists({ table: 'stall_owner', column: 'sell_class', definition: 'TEXT' });
  await ensureColumnExists({ table: 'lottery_result', column: 'sell_class', definition: 'TEXT' });

  await run(
    `CREATE TABLE IF NOT EXISTS stall_class (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stall_type TEXT NOT NULL,
      sell_class TEXT NOT NULL,
      person_count INTEGER DEFAULT 0,
      stall_count INTEGER DEFAULT 0,
      order_no INTEGER DEFAULT 0,
      UNIQUE(stall_type, sell_class)
    )`
  );

  await run(
    `CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
}

async function setAppConfig(key, value) {
  const k = String(key || '').trim();
  if (!k) throw new Error('app_config key required');
  const v = value == null ? '' : String(value);
  return run(
    `INSERT INTO app_config (key, value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [k, v]
  );
}

async function getAppConfig(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  const row = await get(
    `SELECT value
     FROM app_config
     WHERE key = ?`,
    [k]
  );
  return row ? row.value : null;
}

async function getOwnerByIdCardAndType(idCard, stallType) {
  return get(
    `SELECT id, name, id_card AS idCard, stall_type AS stallType, qty, queue_no AS queueNo, is_queued AS isQueued, created_at AS createdAt
     FROM stall_owner
     WHERE id_card = ? AND stall_type = ?`,
    [idCard, stallType]
  );
}

async function getOwnersByIdCardAndName(idCard, name) {
  return all(
    `SELECT id, name, id_card AS idCard, stall_type AS stallType, qty, queue_no AS queueNo, is_queued AS isQueued, created_at AS createdAt
     FROM stall_owner
     WHERE id_card = ? AND name = ?
     ORDER BY id ASC`,
    [idCard, name]
  );
}

async function validateOwnerLogin({ idCard, name }) {
  const owners = await getOwnersByIdCardAndName(idCard, name);
  if (!owners || owners.length === 0) {
    return { ok: false, message: '未找到报名信息', owners: [] };
  }
  return { ok: true, message: '验证通过', owners };
}

async function getNextQueueNo(stallType) {
  return getNextQueueNoByTypeAndQtyFilter({ stallType, qtyFilter: null });
}

function getQtyFilterClause(qtyFilter) {
  const v = String(qtyFilter || '').trim();
  if (v === 'single') return { clause: ' AND qty = 1', params: [] };
  if (v === 'multi') return { clause: ' AND qty > 1', params: [] };
  return { clause: '', params: [] };
}

async function getNextQueueNoByTypeAndQtyFilter({ stallType, qtyFilter }) {
  const cond = getQtyFilterClause(qtyFilter);
  const row = await get(
    `SELECT MAX(queue_no) AS maxQueueNo
     FROM stall_owner
     WHERE stall_type = ? AND is_queued = 1${cond.clause}`,
    [stallType, ...cond.params]
  );
  const maxQueueNo = row && row.maxQueueNo ? Number(row.maxQueueNo) : 0;
  return maxQueueNo + 1;
}

async function setOwnerQueued({ idCard, stallType, queueNo }) {
  return run(
    `UPDATE stall_owner
     SET queue_no = ?, is_queued = 1
     WHERE id_card = ? AND stall_type = ?`,
    [queueNo, idCard, stallType]
  );
}

async function allocateQueueNoAndQueueOwner({ idCard, stallType, qtyFilter = null }) {
  const cond = getQtyFilterClause(qtyFilter);

  await run('BEGIN IMMEDIATE');
  try {
    const existing = await get(
      `SELECT queue_no AS queueNo, is_queued AS isQueued
       FROM stall_owner
       WHERE id_card = ? AND stall_type = ?`,
      [idCard, stallType]
    );

    if (existing && Number(existing.isQueued) === 1 && Number(existing.queueNo) > 0) {
      await run('COMMIT');
      return { ok: true, queueNo: Number(existing.queueNo) };
    }

    const row = await get(
      `SELECT MAX(queue_no) AS maxQueueNo
       FROM stall_owner
       WHERE stall_type = ? AND is_queued = 1${cond.clause}`,
      [stallType, ...cond.params]
    );
    const maxQueueNo = row && row.maxQueueNo ? Number(row.maxQueueNo) : 0;
    const queueNo = maxQueueNo + 1;

    const updated = await run(
      `UPDATE stall_owner
       SET queue_no = ?, is_queued = 1
       WHERE id_card = ? AND stall_type = ? AND is_queued = 0`,
      [queueNo, idCard, stallType]
    );

    if (!updated || Number(updated.changes) === 0) {
      await run('ROLLBACK');
      return { ok: false, message: '排号失败' };
    }

    await run('COMMIT');
    return { ok: true, queueNo };
  } catch (e) {
    await run('ROLLBACK');
    throw e;
  }
}

async function getQueuedListByType(stallType, qtyFilter = null) {
  const cond = getQtyFilterClause(qtyFilter);
  return all(
    `SELECT id, name, id_card AS idCard, stall_type AS stallType, qty, queue_no AS queueNo, is_queued AS isQueued
     FROM stall_owner
     WHERE stall_type = ? AND is_queued = 1${cond.clause}
     ORDER BY queue_no ASC`,
    [stallType, ...cond.params]
  );
}

async function getUnqueuedOwnersByType(stallType, qtyFilter = null) {
  const cond = getQtyFilterClause(qtyFilter);
  return all(
    `SELECT id, name, id_card AS idCard, stall_type AS stallType, qty, queue_no AS queueNo, is_queued AS isQueued
     FROM stall_owner
     WHERE stall_type = ? AND is_queued = 0${cond.clause}
     ORDER BY id ASC`,
    [stallType, ...cond.params]
  );
}

async function countQueuedOwnersByType(stallType, qtyFilter = null) {
  const cond = getQtyFilterClause(qtyFilter);
  const row = await get(
    `SELECT COUNT(1) AS cnt
     FROM stall_owner
     WHERE stall_type = ? AND is_queued = 1${cond.clause}`,
    [stallType, ...cond.params]
  );
  return row && row.cnt ? Number(row.cnt) : 0;
}

async function countUnqueuedOwnersByType(stallType, qtyFilter = null) {
  const cond = getQtyFilterClause(qtyFilter);
  const row = await get(
    `SELECT COUNT(1) AS cnt
     FROM stall_owner
     WHERE stall_type = ? AND is_queued = 0${cond.clause}`,
    [stallType, ...cond.params]
  );
  return row && row.cnt ? Number(row.cnt) : 0;
}

async function getOwnerByQueueNo({ stallType, queueNo }) {
  return get(
    `SELECT id, name, id_card AS idCard, stall_type AS stallType, qty, queue_no AS queueNo, is_queued AS isQueued
     FROM stall_owner
     WHERE stall_type = ? AND queue_no = ? AND is_queued = 1`,
    [stallType, queueNo]
  );
}

async function insertLotteryResult({ name, idCard, stallType, queueNo, stallNo }) {
  return run(
    `INSERT INTO lottery_result (name, id_card, stall_type, queue_no, stall_no)
     VALUES (?, ?, ?, ?, ?)`,
    [name, idCard, stallType, queueNo, stallNo]
  );
}

async function getDrawnStallNosByType(stallType) {
  const rows = await all(
    `SELECT stall_no AS stallNo
     FROM lottery_result
     WHERE stall_type = ?`,
    [stallType]
  );
  return rows.map((r) => r.stallNo);
}

async function countLotteryResultsByOwnerType({ idCard, stallType }) {
  const row = await get(
    `SELECT COUNT(1) AS cnt
     FROM lottery_result
     WHERE id_card = ? AND stall_type = ?`,
    [idCard, stallType]
  );
  return row && row.cnt ? Number(row.cnt) : 0;
}

async function sumQtyByType(stallType) {
  return sumQtyByTypeAndQtyFilter(stallType, null);
}

async function sumQtyByTypeAndQtyFilter(stallType, qtyFilter = null) {
  const cond = getQtyFilterClause(qtyFilter);
  const row = await get(
    `SELECT COALESCE(SUM(qty), 0) AS totalQty
     FROM stall_owner
     WHERE stall_type = ?${cond.clause}`,
    [stallType, ...cond.params]
  );
  return row && row.totalQty ? Number(row.totalQty) : 0;
}

async function insertLotteryResultsBulk({ name, idCard, stallType, queueNo, stallNos }) {
  if (!Array.isArray(stallNos) || stallNos.length === 0) return { inserted: 0 };

  await run('BEGIN TRANSACTION');
  try {
    for (const stallNo of stallNos) {
      await insertLotteryResult({ name, idCard, stallType, queueNo, stallNo: String(stallNo) });
    }
    await run('COMMIT');
    return { inserted: stallNos.length };
  } catch (e) {
    await run('ROLLBACK');
    throw e;
  }
}

async function insertOwnersBulk(owners) {
  if (!Array.isArray(owners) || owners.length === 0) return { inserted: 0 };

  await run('BEGIN TRANSACTION');
  try {
    for (const o of owners) {
      await run(
        `INSERT OR IGNORE INTO stall_owner (name, id_card, stall_type, qty, sell_class)
         VALUES (?, ?, ?, ?, ?)`,
        [o.name, o.idCard, o.stallType, Number(o.qty || 1), String(o.sellClass || '')]
      );
    }
    await run('COMMIT');
    return { inserted: owners.length };
  } catch (e) {
    await run('ROLLBACK');
    throw e;
  }
}

async function getStallClasses() {
  return all('SELECT * FROM stall_class ORDER BY order_no ASC, id ASC');
}

async function addStallClass({ stallType, sellClass, stallCount, orderNo }) {
  return run(
    `INSERT INTO stall_class (stall_type, sell_class, stall_count, order_no)
     VALUES (?, ?, ?, ?)`,
    [stallType, sellClass, stallCount || 0, orderNo || 0]
  );
}

async function updateStallClass({ id, stallType, sellClass, stallCount, orderNo }) {
  return run(
    `UPDATE stall_class
     SET stall_type = ?, sell_class = ?, stall_count = ?, order_no = ?
     WHERE id = ?`,
    [stallType, sellClass, stallCount || 0, orderNo || 0, id]
  );
}

async function deleteStallClass(id) {
  return run('DELETE FROM stall_class WHERE id = ?', [id]);
}

async function syncStallClassStats() {
  // Sync person_count based on stall_owner data
  const stats = await all(
    `SELECT stall_type, sell_class, COUNT(DISTINCT id_card) as cnt
     FROM stall_owner
     WHERE sell_class IS NOT NULL AND sell_class != ''
     GROUP BY stall_type, sell_class`
  );

  await run('BEGIN TRANSACTION');
  try {
    for (const s of stats) {
      await run(
        `INSERT INTO stall_class (stall_type, sell_class, person_count)
         VALUES (?, ?, ?)
         ON CONFLICT(stall_type, sell_class) DO UPDATE SET person_count = excluded.person_count`,
        [s.stall_type, s.sell_class, s.cnt]
      );
    }
    await run('COMMIT');
  } catch (e) {
    await run('ROLLBACK');
    throw e;
  }
}

module.exports = {
  init,
  setAppConfig,
  getAppConfig,
  validateOwnerLogin,
  getOwnersByIdCardAndName,
  getOwnerByIdCardAndType,
  getNextQueueNo,
  getNextQueueNoByTypeAndQtyFilter,
  setOwnerQueued,
  allocateQueueNoAndQueueOwner,
  getQueuedListByType,
  getUnqueuedOwnersByType,
  countQueuedOwnersByType,
  countUnqueuedOwnersByType,
  getOwnerByQueueNo,
  insertLotteryResult,
  insertLotteryResultsBulk,
  getDrawnStallNosByType,
  countLotteryResultsByOwnerType,
  sumQtyByType,
  sumQtyByTypeAndQtyFilter,
  insertOwnersBulk,
  getStallClasses,
  addStallClass,
  updateStallClass,
  deleteStallClass,
  syncStallClassStats,
};
