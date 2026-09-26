'use strict';

// 方案应用（预览 → 凭据确认）两阶段流程的端到端测试。
// 每个测试文件由 node:test 在独立进程中运行，可在 require 前指定独立 DATA_DIR。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-apply-'));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = 'test';

const app = require('../server');

let server;
let base;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function req(method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/** 清空并重建设备，返回新建设备列表 */
async function resetDevices(specs) {
  const cur = await req('GET', '/api/devices');
  for (const d of cur.json.devices) {
    await req('DELETE', `/api/devices/${d.id}`);
  }
  const out = [];
  for (const s of specs) {
    const r = await req('POST', '/api/devices', {
      name: s.name,
      frequency: s.frequency,
      guard: s.guard ?? 0.25,
      locked: !!s.locked,
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    out.push(r.json);
  }
  return out;
}

async function savePlan(body) {
  const r = await req('POST', '/api/plans', body);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
}

/** 按当前设备与目标频率构造方案分配（字段与 /api/coordinate 的 assignments 对齐） */
function craftAssignments(devices, targets) {
  return devices.map((d, i) => ({
    id: d.id,
    name: d.name,
    locked: d.locked,
    original: d.frequency,
    frequency: targets[i],
    offset: Math.abs(targets[i] - d.frequency),
  }));
}

const GOOD_PARAMS = { bandMin: 470, bandMax: 608, step: 0.025, maxOffset: 5, occupiedBands: [] };

/* ---------- 成功路径 ---------- */

test('完整流程：协调 → 保存 → 预览（按设备展示当前/目标频率）→ 凭据确认一次性写入', async () => {
  const devices = await resetDevices([
    { name: 'A', frequency: 500.0, locked: true },
    { name: 'B', frequency: 500.1 },
    { name: 'C', frequency: 510.0 },
  ]);

  const coord = await req('POST', '/api/coordinate', {
    bandMin: 490, bandMax: 520, step: 0.025, maxOffset: 5, occupiedBands: [],
  });
  assert.equal(coord.status, 200);
  assert.equal(coord.json.solved, true, coord.json.reason);

  const planId = await savePlan({
    name: 'good',
    params: coord.json.params,
    assignments: coord.json.assignments,
    totalOffset: coord.json.totalOffset,
    solved: true,
  });

  const preview = await req('POST', `/api/plans/${planId}/preview`);
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(preview.json.ok, true);
  assert.equal(preview.json.conflictCount, 0);
  assert.equal(preview.json.devices.length, 3);
  assert.ok(typeof preview.json.credential === 'string' && preview.json.credential.includes('.'));
  assert.ok(preview.json.checkedAt);

  // 按设备 id 展示当前频率与目标频率
  const rowB = preview.json.devices.find((d) => d.id === devices[1].id);
  assert.equal(rowB.current, 500.1);
  assert.notEqual(rowB.target, 500.1);
  assert.equal(rowB.changed, true);
  const rowA = preview.json.devices.find((d) => d.id === devices[0].id);
  assert.equal(rowA.target, 500.0);
  assert.equal(rowA.changed, false);
  assert.equal(rowA.locked, true);

  const apply = await req('POST', `/api/plans/${planId}/apply`, { credential: preview.json.credential });
  assert.equal(apply.status, 200, JSON.stringify(apply.json));
  assert.equal(apply.json.ok, true);
  assert.equal(apply.json.applied, 3);

  const after = await req('GET', '/api/devices');
  const byId = new Map(after.json.devices.map((d) => [d.id, d]));
  assert.equal(byId.get(devices[0].id).frequency, 500.0);
  assert.equal(byId.get(devices[1].id).frequency, rowB.target);
  assert.equal(byId.get(devices[2].id).frequency, 510.0);
});

/* ---------- 凭据问题：409 且不写入 ---------- */

test('确认时缺少凭据 → 409，needRepreview，不写入任何设备', async () => {
  const devices = await resetDevices([
    { name: 'A', frequency: 500.0 },
    { name: 'B', frequency: 510.0 },
  ]);
  const planId = await savePlan({
    name: 'p',
    params: GOOD_PARAMS,
    assignments: craftAssignments(devices, [500, 510]),
    totalOffset: 0,
    solved: true,
  });

  const r1 = await req('POST', `/api/plans/${planId}/apply`, {});
  assert.equal(r1.status, 409);
  assert.equal(r1.json.needRepreview, true);
  const r2 = await req('POST', `/api/plans/${planId}/apply`);
  assert.equal(r2.status, 409);

  const after = await req('GET', '/api/devices');
  assert.deepEqual(after.json.devices.map((d) => d.frequency), [500, 510]);
});

test('伪造/篡改凭据 → 409', async () => {
  const devices = await resetDevices([
    { name: 'A', frequency: 500.0 },
    { name: 'B', frequency: 510.0 },
  ]);
  const planId = await savePlan({
    name: 'p', params: GOOD_PARAMS,
    assignments: craftAssignments(devices, [500, 510]), solved: true,
  });
  const preview = await req('POST', `/api/plans/${planId}/preview`);
  const good = preview.json.credential;
  const tampered = good.slice(0, -2) + (good.endsWith('aa') ? 'bb' : 'aa');

  for (const credential of ['not-a-token', `${good}.extra`, tampered]) {
    const r = await req('POST', `/api/plans/${planId}/apply`, { credential });
    assert.equal(r.status, 409, `credential=${credential}`);
    assert.equal(r.json.needRepreview, true);
  }
});

test('A 方案的凭据用于 B 方案 → 409', async () => {
  const devices = await resetDevices([
    { name: 'A', frequency: 500.0 },
    { name: 'B', frequency: 510.0 },
  ]);
  const planA = await savePlan({
    name: 'A', params: GOOD_PARAMS,
    assignments: craftAssignments(devices, [500, 510]), solved: true,
  });
  const planB = await savePlan({
    name: 'B', params: GOOD_PARAMS,
    assignments: craftAssignments(devices, [500, 510]), solved: true,
  });
  const previewA = await req('POST', `/api/plans/${planA}/preview`);
  const r = await req('POST', `/api/plans/${planB}/apply`, { credential: previewA.json.credential });
  assert.equal(r.status, 409);
});

test('预览后设备状态变化 → 确认 409 且不写入，需重新预览', async () => {
  const devices = await resetDevices([
    { name: 'A', frequency: 500.0, locked: true },
    { name: 'B', frequency: 500.1 },
  ]);
  const coord = await req('POST', '/api/coordinate', {
    bandMin: 490, bandMax: 520, step: 0.025, maxOffset: 5,
  });
  assert.equal(coord.json.solved, true);
  const movedTarget = coord.json.assignments.find((a) => a.id === devices[1].id).frequency;
  const planId = await savePlan({
    name: 'p', params: coord.json.params,
    assignments: coord.json.assignments, totalOffset: coord.json.totalOffset, solved: true,
  });

  const preview = await req('POST', `/api/plans/${planId}/preview`);
  assert.equal(preview.status, 200);

  // 预览之后、确认之前改动设备（改名即改变设备指纹；频率保持不变以验证“不写入”）
  const renamed = await req('PUT', `/api/devices/${devices[0].id}`, {
    name: 'A-renamed', frequency: 500.0, guard: 0.25, locked: true,
  });
  assert.equal(renamed.status, 200);

  const apply = await req('POST', `/api/plans/${planId}/apply`, { credential: preview.json.credential });
  assert.equal(apply.status, 409);
  assert.equal(apply.json.needRepreview, true);

  const after = await req('GET', '/api/devices');
  const byId = new Map(after.json.devices.map((d) => [d.id, d]));
  assert.equal(byId.get(devices[1].id).frequency, 500.1); // 未被写入
  assert.notEqual(movedTarget, 500.1);

  // 重新预览后凭据恢复有效
  const preview2 = await req('POST', `/api/plans/${planId}/preview`);
  assert.equal(preview2.status, 200);
  const apply2 = await req('POST', `/api/plans/${planId}/apply`, { credential: preview2.json.credential });
  assert.equal(apply2.status, 200, JSON.stringify(apply2.json));
  const after2 = await req('GET', '/api/devices');
  assert.equal(after2.json.devices.find((d) => d.id === devices[1].id).frequency, movedTarget);
});

test('方案在应用前被删除 → 404', async () => {
  const devices = await resetDevices([{ name: 'A', frequency: 500.0 }]);
  const planId = await savePlan({
    name: 'p', params: GOOD_PARAMS,
    assignments: craftAssignments(devices, [500]), solved: true,
  });
  const del = await req('DELETE', `/api/plans/${planId}`);
  assert.equal(del.status, 200);
  const r = await req('POST', `/api/plans/${planId}/apply`, { credential: 'whatever.sig' });
  assert.equal(r.status, 404);
});

/* ---------- 预览检查失败：422 并列明原因 ---------- */

test('未求解方案 → 预览 422 且禁止应用', async () => {
  const devices = await resetDevices([
    { name: 'A', frequency: 500.0 },
    { name: 'B', frequency: 510.0 },
  ]);
  const planId = await savePlan({
    name: 'unsolved', params: GOOD_PARAMS,
    assignments: craftAssignments(devices, [500, 510]), solved: false,
  });
  const r = await req('POST', `/api/plans/${planId}/preview`);
  assert.equal(r.status, 422);
  assert.equal(r.json.ok, false);
  assert.match(r.json.errors.join('\n'), /已求解/);
});

test('分配引用已删除设备 / 当前设备缺少对应分配 → 422', async () => {
  const devices = await resetDevices([
    { name: 'A', frequency: 500.0 },
    { name: 'B', frequency: 510.0 },
  ]);
  const planId = await savePlan({
    name: 'stale', params: GOOD_PARAMS,
    assignments: [
      { id: devices[0].id, name: 'A', frequency: 500 },
      { id: devices[1].id + 999, name: 'Gone', frequency: 510 },
    ],
    solved: true,
  });
  const r = await req('POST', `/api/plans/${planId}/preview`);
  assert.equal(r.status, 422);
  const msg = r.json.errors.join('\n');
  assert.match(msg, /不存在/);
  assert.match(msg, /未出现在方案分配中/);
});

test('设备 id 重复 → 422 并指出重复', async () => {
  const devices = await resetDevices([
    { name: 'A', frequency: 500.0 },
    { name: 'B', frequency: 510.0 },
  ]);
  const planId = await savePlan({
    name: 'dup', params: GOOD_PARAMS,
    assignments: [
      { id: devices[0].id, frequency: 500 },
      { id: devices[0].id, frequency: 501 },
    ],
    solved: true,
  });
  const r = await req('POST', `/api/plans/${planId}/preview`);
  assert.equal(r.status, 422);
  assert.match(r.json.errors.join('\n'), /重复/);
});

test('目标频率越界或非有限正数 → 422', async () => {
  const devices = await resetDevices([
    { name: 'A', frequency: 500.0 },
    { name: 'B', frequency: 510.0 },
  ]);
  const planId = await savePlan({
    name: 'badfreq', params: GOOD_PARAMS,
    assignments: [
      { id: devices[0].id, frequency: 12000 },
      { id: devices[1].id, frequency: 0 },
    ],
    solved: true,
  });
  const r = await req('POST', `/api/plans/${planId}/preview`);
  assert.equal(r.status, 422);
  const msg = r.json.errors.join('\n');
  assert.match(msg, /目标频率无效/);
  // 两个问题都应列明
  assert.ok(r.json.errors.length >= 2);
});

test('锁定设备目标频率与当前不同 → 422', async () => {
  const devices = await resetDevices([
    { name: 'A', frequency: 500.0, locked: true },
    { name: 'B', frequency: 510.0 },
  ]);
  const planId = await savePlan({
    name: 'locked', params: GOOD_PARAMS,
    assignments: craftAssignments(devices, [500.5, 510]), solved: true,
  });
  const r = await req('POST', `/api/plans/${planId}/preview`);
  assert.equal(r.status, 422);
  assert.match(r.json.errors.join('\n'), /锁定/);
});

test('目标配置互调冲突（按当前保护间隔复算）→ 422', async () => {
  // guard = 0：两个同频频道的 |f1-f2|=0 命中载频
  const devices = await resetDevices([
    { name: 'A', frequency: 500.0, guard: 0 },
    { name: 'B', frequency: 510.0, guard: 0 },
  ]);
  const planId = await savePlan({
    name: 'conflict', params: GOOD_PARAMS,
    assignments: craftAssignments(devices, [500, 500]), solved: true,
  });
  const r = await req('POST', `/api/plans/${planId}/preview`);
  assert.equal(r.status, 422);
  assert.match(r.json.errors.join('\n'), /互调冲突/);
  assert.ok(r.json.conflicts.length > 0);
});

test('保护区与方案所存占用区间闭区间相交（含端点相接）→ 422', async () => {
  const devices = await resetDevices([{ name: 'A', frequency: 500.0, guard: 0.25 }]);
  // 目标 500 的保护区 [499.75, 500.25] 与占用 [500.25, 500.3] 在端点 500.25 相接
  const planId = await savePlan({
    name: 'occ',
    params: { ...GOOD_PARAMS, occupiedBands: [{ lo: 500.25, hi: 500.3 }] },
    assignments: craftAssignments(devices, [500]),
    solved: true,
  });
  const r = await req('POST', `/api/plans/${planId}/preview`);
  assert.equal(r.status, 422);
  assert.match(r.json.errors.join('\n'), /占用区间/);

  // 不相接则通过：占用 [500.26, 500.3]
  const planId2 = await savePlan({
    name: 'occ-ok',
    params: { ...GOOD_PARAMS, occupiedBands: [{ lo: 500.26, hi: 500.3 }] },
    assignments: craftAssignments(devices, [500]),
    solved: true,
  });
  const r2 = await req('POST', `/api/plans/${planId2}/preview`);
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
});

test('旧方案缺少占用区间字段 → 按空数组处理，预览通过', async () => {
  const devices = await resetDevices([
    { name: 'A', frequency: 500.0 },
    { name: 'B', frequency: 510.0 },
  ]);
  const planId = await savePlan({
    name: 'legacy',
    params: { bandMin: 470, bandMax: 608, step: 0.025, maxOffset: 5 }, // 无 occupiedBands
    assignments: craftAssignments(devices, [500, 510]),
    solved: true,
  });
  const r = await req('POST', `/api/plans/${planId}/preview`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.occupiedBands, []);
});

test('非法结构的方案（assignments 不是数组）→ 422 而不是 500', async () => {
  await resetDevices([{ name: 'A', frequency: 500.0 }]);
  // 绕过保存接口的入参校验，直接写入损坏结构（模拟历史脏数据）
  const db = require('../db');
  const info = db
    .prepare('INSERT INTO plans (name, params, assignments, total_offset, solved) VALUES (?, ?, ?, ?, ?)')
    .run('broken', JSON.stringify(GOOD_PARAMS), JSON.stringify({ oops: true }), 0, 1);
  const r = await req('POST', `/api/plans/${info.lastInsertRowid}/preview`);
  assert.equal(r.status, 422);
});
