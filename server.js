'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const { mhzToHz, hzToMhz, computeConflicts, coordinate, normalizeOccupiedBands } = require('./lib/intermod');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MAX_DEVICES = 8;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 工具 ----------

function rowToDevice(row) {
  return {
    id: row.id,
    name: row.name,
    frequency: row.frequency, // MHz
    guard: row.guard,         // MHz
    locked: !!row.locked,
    position: row.position,
  };
}

function listDevices() {
  return db.prepare('SELECT * FROM devices ORDER BY position, id').all().map(rowToDevice);
}

/** 转为核心库使用的 Hz 通道模型（保持录入顺序） */
function toChannels(devices) {
  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    freqHz: mhzToHz(d.frequency),
    guardHz: mhzToHz(d.guard),
    locked: d.locked,
  }));
}

function conflictToJson(c) {
  return {
    productType: c.productType,
    product: hzToMhz(c.productHz),
    source: c.source.map((s) => ({ id: s.id, name: s.name, frequency: hzToMhz(s.freqHz) })),
    victim: {
      id: c.victim.id,
      name: c.victim.name,
      frequency: hzToMhz(c.victim.freqHz),
      guard: hzToMhz(c.victim.guardHz),
    },
    deviation: hzToMhz(c.deviationHz),
  };
}

function assignmentToJson(a) {
  return {
    id: a.id,
    name: a.name,
    locked: a.locked,
    original: hzToMhz(a.originalHz),
    frequency: hzToMhz(a.freqHz),
    offset: hzToMhz(a.offsetHz),
  };
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

/** 校验设备录入字段，返回错误消息或 null */
function validateDeviceInput(body) {
  const { name, frequency, guard } = body;
  if (typeof name !== 'string' || name.trim().length === 0) return '设备名称不能为空';
  if (name.trim().length > 60) return '设备名称过长（最多 60 字符）';
  const f = Number(frequency);
  if (!Number.isFinite(f) || f <= 0 || f > 10000) return '工作频率必须是 0 ~ 10000 MHz 之间的数值';
  const g = Number(guard);
  if (!Number.isFinite(g) || g < 0 || g > 100) return '保护间隔必须是 0 ~ 100 MHz 之间的数值';
  return null;
}

// ---------- 设备管理 ----------

app.get('/api/devices', (req, res) => {
  res.json({ devices: listDevices(), max: MAX_DEVICES });
});

app.post('/api/devices', (req, res) => {
  const err = validateDeviceInput(req.body || {});
  if (err) return badRequest(res, err);

  const count = db.prepare('SELECT COUNT(*) AS c FROM devices').get().c;
  if (count >= MAX_DEVICES) return badRequest(res, `最多只能录入 ${MAX_DEVICES} 个设备`);

  const { name, frequency, guard, locked } = req.body;
  const pos = (db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM devices').get().m) + 1;
  const info = db
    .prepare('INSERT INTO devices (name, frequency, guard, locked, position) VALUES (?, ?, ?, ?, ?)')
    .run(name.trim(), Number(frequency), Number(guard), locked ? 1 : 0, pos);
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(rowToDevice(row));
});

app.put('/api/devices/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '设备不存在' });
  const err = validateDeviceInput(req.body || {});
  if (err) return badRequest(res, err);

  const { name, frequency, guard, locked } = req.body;
  db.prepare('UPDATE devices SET name = ?, frequency = ?, guard = ?, locked = ? WHERE id = ?')
    .run(name.trim(), Number(frequency), Number(guard), locked ? 1 : 0, row.id);
  res.json(rowToDevice(db.prepare('SELECT * FROM devices WHERE id = ?').get(row.id)));
});

app.delete('/api/devices/:id', (req, res) => {
  const info = db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: '设备不存在' });
  res.json({ ok: true });
});

// ---------- 互调冲突分析 ----------

app.get('/api/conflicts', (req, res) => {
  const channels = toChannels(listDevices());
  const conflicts = computeConflicts(channels).map(conflictToJson);
  res.json({ count: conflicts.length, conflicts });
});

// ---------- 自动协调 ----------

app.post('/api/coordinate', (req, res) => {
  const body = req.body || {};
  const bandMin = Number(body.bandMin);
  const bandMax = Number(body.bandMax);
  const step = Number(body.step);
  const maxOffset = Number(body.maxOffset);

  if (!Number.isFinite(bandMin) || !Number.isFinite(bandMax) || bandMin >= bandMax) {
    return badRequest(res, '频段范围无效：下限必须小于上限');
  }
  if (!Number.isFinite(step) || step <= 0) return badRequest(res, '步进必须为正数（MHz）');
  if (!Number.isFinite(maxOffset) || maxOffset < 0) return badRequest(res, '最大偏移必须为非负数（MHz）');

  // 现场占用频段（本次协调参数，不写入设备数据）：校验有限数值、下限 ≤ 上限并合并重叠区间
  let occupiedBands = [];
  if (body.occupiedBands !== undefined && body.occupiedBands !== null) {
    try {
      occupiedBands = normalizeOccupiedBands(body.occupiedBands);
    } catch (e) {
      return badRequest(res, e.message);
    }
  }

  const devices = listDevices();
  if (devices.length === 0) return badRequest(res, '尚未录入任何设备');

  const result = coordinate(toChannels(devices), {
    bandMinHz: mhzToHz(bandMin),
    bandMaxHz: mhzToHz(bandMax),
    stepHz: mhzToHz(step),
    maxOffsetHz: mhzToHz(maxOffset),
    occupiedHz: occupiedBands.map((b) => ({ loHz: mhzToHz(b.lo), hiHz: mhzToHz(b.hi) })),
  });

  // 方案对应的冲突复核（成功时应为 0）
  const solvedChannels = result.assignments.map((a, i) => ({
    id: a.id,
    name: a.name,
    freqHz: a.freqHz,
    guardHz: mhzToHz(devices[i].guard),
    locked: a.locked,
  }));
  const resultConflicts = computeConflicts(solvedChannels).map(conflictToJson);

  res.json({
    solved: result.solved,
    reason: result.reason,
    capped: result.capped,
    totalOffset: hzToMhz(result.totalOffsetHz),
    assignments: result.assignments.map(assignmentToJson),
    conflicts: resultConflicts,
    params: { bandMin, bandMax, step, maxOffset, occupiedBands },
  });
});

// ---------- 方案保存 / 读取 ----------

/** 安全解析 JSON 字段（旧数据损坏时返回兜底值而不是抛错） */
function parseJsonOr(raw, fallback) {
  try {
    const v = JSON.parse(raw);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function rowToPlan(r) {
  return {
    id: r.id,
    name: r.name,
    params: parseJsonOr(r.params, {}),
    assignments: parseJsonOr(r.assignments, []),
    totalOffset: r.total_offset,
    solved: !!r.solved,
    createdAt: r.created_at,
  };
}

app.post('/api/plans', (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
  if (!name) return badRequest(res, '方案名称不能为空');
  if (!body.params || !Array.isArray(body.assignments)) {
    return badRequest(res, '缺少协调参数或分配结果');
  }
  const info = db
    .prepare('INSERT INTO plans (name, params, assignments, total_offset, solved) VALUES (?, ?, ?, ?, ?)')
    .run(
      name,
      JSON.stringify(body.params),
      JSON.stringify(body.assignments),
      Number(body.totalOffset) || 0,
      body.solved === false ? 0 : 1,
    );
  res.status(201).json({ id: info.lastInsertRowid });
});

app.get('/api/plans', (req, res) => {
  const rows = db.prepare('SELECT * FROM plans ORDER BY id DESC').all();
  res.json(rows.map(rowToPlan));
});

app.delete('/api/plans/:id', (req, res) => {
  const info = db.prepare('DELETE FROM plans WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: '方案不存在' });
  res.json({ ok: true });
});

// ---------- 方案应用：预览 → 凭据确认（同一套检查执行两遍） ----------

/**
 * 确认凭据签名密钥：默认每次进程启动随机生成，重启后旧凭据自动失效（界面需重新预览）。
 * 可用环境变量 APPLY_SECRET 固定密钥（如多副本部署时共享）。
 */
const APPLY_SECRET = process.env.APPLY_SECRET
  ? Buffer.from(process.env.APPLY_SECRET, 'utf8')
  : crypto.randomBytes(32);

/** 规范化 JSON（对象键排序）后计算 SHA-256，保证与字段顺序无关 */
function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** 当前全部设备状态指纹（id/名称/频率/保护间隔/锁定，按 id 排序） */
function digestDevices(devices) {
  return sha256Json(
    devices
      .map((d) => [d.id, d.name, d.frequency, d.guard, d.locked ? 1 : 0])
      .sort((a, b) => a[0] - b[0]),
  );
}

/** 方案内容指纹（已求解标记 + 分配目标 + 占用区间），方案内容被改动即失效 */
function digestPlan(plan) {
  return sha256Json([
    plan.solved ? 1 : 0,
    plan.assignments,
    (plan.params && plan.params.occupiedBands) || [],
  ]);
}

/** 颁发确认凭据：base64url(payload).hmacSHA256（无状态，无需建表） */
function issueCredential(plan, devices) {
  const payload = {
    v: 1,
    planId: plan.id,
    planDigest: digestPlan(plan),
    devicesDigest: digestDevices(devices),
    iat: Date.now(),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', APPLY_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * 校验凭据签名与载荷；返回 payload 或 null。
 * 凭据缺失、格式错误、签名不匹配均视为无效。
 */
function verifyCredential(token, expectedPlanId) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', APPLY_SECRET).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1 || payload.planId !== expectedPlanId) return null;
  if (typeof payload.planDigest !== 'string' || typeof payload.devicesDigest !== 'string') return null;
  return payload;
}

/** 占用区间闭区间是否与 [lo, hi] 相交（端点相接也算） */
function bandsIntersect(loA, hiA, loB, hiB) {
  return loA <= hiB && loB <= hiA;
}

/**
 * 应用前检查（预览与确认时各执行一遍，结果必须一致）。
 *
 * 规则：
 *  1. 方案必须标记为已求解（solved）
 *  2. 分配数组中每个设备 id 必须存在，且与当前设备一一对应、无重复、无遗漏、无多余
 *  3. 目标频率必须是 0～10000 MHz 内的有限正数
 *  4. 锁定设备不得改频（目标频率必须等于当前频率）
 *  5. 用各设备当前保护间隔复算目标配置的互调冲突（任一冲突即禁止应用）
 *  6. 任一目标载频的保护区 [f−guard, f+guard] 与方案所存占用区间闭区间相交即禁止应用
 *
 * @returns {{ok:boolean, errors:string[], conflicts:Array, occupiedBands:Array,
 *            rows:Array<{device:object, target:number, changed:boolean, locked:boolean}>}}
 */
function validatePlanApplication(plan, devices) {
  const errors = [];
  const assignments = Array.isArray(plan.assignments) ? plan.assignments : null;

  if (!plan.solved) {
    errors.push('方案未标记为已求解（存在未解决的冲突），禁止应用');
  }
  if (!assignments) {
    errors.push('方案缺少分配结果（assignments 必须是数组）');
    return { ok: false, errors, conflicts: [], occupiedBands: [], rows: [] };
  }

  const deviceById = new Map(devices.map((d) => [d.id, d]));
  const seen = new Set();

  // 先完成全部结构与单条分配校验，收集所有原因
  const entries = [];
  for (const a of assignments) {
    if (!a || typeof a !== 'object' || typeof a.id !== 'number' || !Number.isInteger(a.id)) {
      errors.push('存在无效分配条目：缺少有效的设备 id');
      continue;
    }
    if (seen.has(a.id)) {
      errors.push(`设备 id ${a.id} 在分配中重复出现，分配必须与当前设备一一对应`);
      continue;
    }
    seen.add(a.id);
    const device = deviceById.get(a.id);
    if (!device) {
      errors.push(`分配中的设备 id ${a.id} 在当前设备中不存在（可能已被删除），无法一一对应`);
      continue;
    }
    const target = Number(a.frequency);
    if (!Number.isFinite(target) || target <= 0 || target > 10000) {
      errors.push(`设备「${device.name}」（id ${device.id}）的目标频率无效：必须是 0～10000 MHz 内的有限正数`);
      continue;
    }
    if (device.locked && mhzToHz(target) !== mhzToHz(device.frequency)) {
      errors.push(
        `设备「${device.name}」（id ${device.id}）已锁定，不得改频（当前 ${device.frequency} MHz，目标 ${target} MHz）`,
      );
      continue;
    }
    entries.push({ device, target });
  }

  // 一一对应：当前设备不得有方案未覆盖的
  for (const d of devices) {
    if (!seen.has(d.id)) {
      errors.push(`当前设备「${d.name}」（id ${d.id}）未出现在方案分配中，无法一一对应`);
    }
  }

  // 方案所存占用区间：缺省（旧方案）按空数组处理；解析失败同样列出原因
  let occupiedBands = [];
  const rawOccupied = plan.params && plan.params.occupiedBands;
  if (rawOccupied !== undefined && rawOccupied !== null) {
    try {
      occupiedBands = normalizeOccupiedBands(rawOccupied);
    } catch (e) {
      errors.push(`方案所存现场占用区间无效：${e.message}`);
    }
  }
  const occupiedHz = occupiedBands.map((b) => ({ loHz: mhzToHz(b.lo), hiHz: mhzToHz(b.hi) }));

  // 结构校验全部通过后才进行复算，避免无效数据污染检查
  let conflicts = [];
  if (errors.length === 0) {
    // 用当前保护间隔构造目标配置（Hz，保持设备录入顺序）
    const targetChannels = devices.map((d) => {
      const target = entries.find((e) => e.device.id === d.id).target;
      return {
        id: d.id,
        name: d.name,
        freqHz: mhzToHz(target),
        guardHz: mhzToHz(d.guard),
        locked: d.locked,
      };
    });

    // 1) 目标配置互调冲突复算
    conflicts = computeConflicts(targetChannels).map(conflictToJson);
    for (const c of conflicts.slice(0, 20)) {
      errors.push(
        `目标配置存在互调冲突：${c.productType} = ${fmtFreq(c.product)} MHz 落入「${c.victim.name}」` +
        `保护区（${fmtFreq(c.victim.frequency)} ± ${fmtFreq(c.victim.guard)} MHz，偏差 ${(c.deviation * 1000).toFixed(1)} kHz）`,
      );
    }
    if (conflicts.length > 20) errors.push(`……互调冲突共 ${conflicts.length} 处，仅列出前 20 处`);

    // 2) 保护区与方案所存占用区间的闭区间相交检查
    for (const ch of targetChannels) {
      const guardLoHz = ch.freqHz - ch.guardHz;
      const guardHiHz = ch.freqHz + ch.guardHz;
      const hit = occupiedHz.find((o) => bandsIntersect(guardLoHz, guardHiHz, o.loHz, o.hiHz));
      if (hit) {
        errors.push(
          `设备「${ch.name}」的目标保护区（${fmtFreq(hzToMhz(guardLoHz))}–${fmtFreq(hzToMhz(guardHiHz))} MHz）` +
          `与方案所存占用区间（${fmtFreq(hzToMhz(hit.loHz))}–${fmtFreq(hzToMhz(hit.hiHz))} MHz）闭区间相交`,
        );
      }
    }
  }

  const rows = entries.map(({ device, target }) => ({
    device,
    target,
    locked: device.locked,
    changed: mhzToHz(target) !== mhzToHz(device.frequency),
  }));

  return { ok: errors.length === 0, errors, conflicts, occupiedBands, rows };
}

function fmtFreq(mhz) {
  return parseFloat(Number(mhz).toFixed(6)).toString();
}

/** 应用前预览：按设备 id 展示当前频率与目标频率，返回绑定方案内容与全部设备状态的确认凭据 */
app.post('/api/plans/:id/preview', (req, res) => {
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '方案不存在' });

  const plan = rowToPlan(row);
  const devices = listDevices();
  const check = validatePlanApplication(plan, devices);

  if (!check.ok) {
    // 任一检查失败：列明全部原因，禁止应用
    return res.status(422).json({
      ok: false,
      plan: { id: plan.id, name: plan.name, solved: plan.solved },
      errors: check.errors,
      conflicts: check.conflicts,
      occupiedBands: check.occupiedBands,
      devices: devices.map((d) => {
        const r = check.rows.find((x) => x.device.id === d.id);
        return {
          id: d.id,
          name: d.name,
          current: d.frequency,
          guard: d.guard,
          locked: d.locked,
          target: r ? r.target : null,
          changed: r ? r.changed : false,
        };
      }),
    });
  }

  res.json({
    ok: true,
    plan,
    credential: issueCredential(plan, devices),
    checkedAt: new Date().toISOString(),
    conflictCount: check.conflicts.length,
    occupiedBands: check.occupiedBands,
    devices: check.rows
      .sort((a, b) => a.device.position - b.device.position || a.device.id - b.device.id)
      .map((r) => ({
        id: r.device.id,
        name: r.device.name,
        current: r.device.frequency,
        target: r.target,
        guard: r.device.guard,
        locked: r.locked,
        changed: r.changed,
      })),
  });
});

/**
 * 确认应用：必须携带预览颁发的凭据。
 * 在同一个 SQLite 事务内核对凭据 → 重做全部检查 → 一次性更新；
 * 任一环节失败整体回滚，不写入任何设备。状态变化或凭据问题一律 409，界面需重新预览。
 */
app.post('/api/plans/:id/apply', (req, res) => {
  const planId = Number(req.params.id);
  if (!Number.isInteger(planId)) return res.status(404).json({ error: '方案不存在' });

  try {
    const result = db.transaction(() => {
      const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
      if (!row) return { status: 404, body: { error: '方案不存在' } };
      const plan = rowToPlan(row);
      const devices = listDevices();

      const payload = verifyCredential((req.body || {}).credential, planId);
      if (!payload) {
        return { status: 409, body: { error: '确认凭据缺失或无效，请重新预览后再应用', needRepreview: true } };
      }
      if (payload.planDigest !== digestPlan(plan)) {
        return { status: 409, body: { error: '方案内容与预览时不一致，请重新预览后再应用', needRepreview: true } };
      }
      if (payload.devicesDigest !== digestDevices(devices)) {
        return { status: 409, body: { error: '设备状态自预览后已发生变化，请重新预览后再应用', needRepreview: true } };
      }

      const check = validatePlanApplication(plan, devices);
      if (!check.ok) {
        return {
          status: 409,
          body: {
            error: '应用前复查未通过，请重新预览后再应用',
            needRepreview: true,
            errors: check.errors,
          },
        };
      }

      const update = db.prepare('UPDATE devices SET frequency = ? WHERE id = ?');
      let applied = 0;
      for (const item of check.rows) {
        const info = update.run(item.target, item.device.id);
        if (info.changes !== 1) {
          throw new Error(`设备 id ${item.device.id} 更新行数异常（${info.changes}），事务回滚`);
        }
        applied += 1;
      }
      return { status: 200, body: { ok: true, applied } };
    })();

    return res.status(result.status).json(result.body);
  } catch (e) {
    // 事务内抛错已整体回滚，不会写入任何设备
    console.error('应用方案失败（事务已回滚）:', e);
    return res.status(500).json({ error: '应用失败，数据库事务已回滚，请重试' });
  }
});

// ---------- 示例数据（便于快速体验） ----------

app.post('/api/seed', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS c FROM devices').get().c;
  if (count > 0) return badRequest(res, '已有设备数据，示例数据仅在空库时载入');
  const samples = [
    ['领夹麦 A', 512.000, 0.25, 0],
    ['领夹麦 B', 512.200, 0.25, 0],
    ['手持麦 C', 520.000, 0.25, 0],
    ['头戴麦 D', 536.500, 0.25, 0],
    ['吉他无线 E', 548.000, 0.25, 0],
    ['贝斯无线 F', 560.250, 0.25, 0],
    ['主持麦 G', 574.000, 0.25, 1],
    ['备份麦 H', 590.500, 0.25, 0],
  ];
  const insert = db.prepare('INSERT INTO devices (name, frequency, guard, locked, position) VALUES (?, ?, ?, ?, ?)');
  const tx = db.transaction(() => samples.forEach((s, i) => insert.run(...s, i + 1)));
  tx();
  res.status(201).json({ devices: listDevices() });
});

// ---------- 启动 ----------

app.use((req, res) => res.status(404).json({ error: '接口不存在' }));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`无线麦克风频率协调工具已启动: http://localhost:${PORT}`);
  });
}

module.exports = app;
