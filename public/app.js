'use strict';

/* ---------- 工具 ---------- */

const $ = (sel) => document.querySelector(sel);

function fmt(mhz) {
  // 最多 6 位小数，去掉尾随零
  return parseFloat(Number(mhz).toFixed(6)).toString();
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.hidden = true; }, 3200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

let devices = [];
let lastCoordResult = null; // 最近一次协调结果（用于保存方案）

/* ---------- 设备列表 ---------- */

async function loadDevices() {
  const data = await api('/api/devices');
  devices = data.devices;
  renderDevices(data.max);
  await refreshConflicts();
}

function renderDevices(max) {
  const tbody = $('#device-tbody');
  $('#device-count').textContent = `${devices.length} / ${max}`;
  $('#btn-add').disabled = devices.length >= max;
  $('#btn-seed').style.display = devices.length === 0 ? '' : 'none';

  if (devices.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">尚未录入设备，请在下方添加或载入示例数据</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  devices.forEach((d, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="muted">${i + 1}</td>
      <td><input type="text" data-field="name" value="" maxlength="60"></td>
      <td><input type="number" data-field="frequency" step="0.000001" min="0.000001" class="freq"></td>
      <td><input type="number" data-field="guard" step="0.000001" min="0" class="freq"></td>
      <td><input type="checkbox" data-field="locked"></td>
      <td>
        <button class="btn btn-sm btn-primary" data-act="save">保存</button>
        <button class="btn btn-sm btn-danger" data-act="del">删除</button>
      </td>`;
    tr.querySelector('[data-field="name"]').value = d.name;
    tr.querySelector('[data-field="frequency"]').value = d.frequency;
    tr.querySelector('[data-field="guard"]').value = d.guard;
    tr.querySelector('[data-field="locked"]').checked = d.locked;

    tr.querySelector('[data-act="save"]').addEventListener('click', async () => {
      try {
        await api(`/api/devices/${d.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: tr.querySelector('[data-field="name"]').value,
            frequency: Number(tr.querySelector('[data-field="frequency"]').value),
            guard: Number(tr.querySelector('[data-field="guard"]').value),
            locked: tr.querySelector('[data-field="locked"]').checked,
          }),
        });
        toast(`已保存「${d.name}」`);
        await loadDevices();
      } catch (e) { toast(e.message, true); }
    });

    tr.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(`确定删除设备「${d.name}」？`)) return;
      try {
        await api(`/api/devices/${d.id}`, { method: 'DELETE' });
        toast('已删除');
        await loadDevices();
      } catch (e) { toast(e.message, true); }
    });

    tbody.appendChild(tr);
  });
}

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/devices', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#add-name').value,
        frequency: Number($('#add-freq').value),
        guard: Number($('#add-guard').value),
        locked: $('#add-locked').checked,
      }),
    });
    $('#add-name').value = '';
    $('#add-freq').value = '';
    $('#add-locked').checked = false;
    toast('设备已添加');
    await loadDevices();
  } catch (err) { toast(err.message, true); }
});

$('#btn-seed').addEventListener('click', async () => {
  try {
    await api('/api/seed', { method: 'POST' });
    toast('已载入示例数据');
    await loadDevices();
  } catch (e) { toast(e.message, true); }
});

/* ---------- 互调冲突 ---------- */

async function refreshConflicts() {
  const data = await api('/api/conflicts');
  const box = $('#conflict-result');
  const badge = $('#conflict-count');

  if (devices.length < 2) {
    badge.textContent = '—';
    badge.className = 'badge';
    box.innerHTML = '<p class="empty-state">至少需要 2 个设备才能进行互调分析</p>';
    return;
  }

  badge.textContent = data.count === 0 ? '无冲突' : `${data.count} 处冲突`;
  badge.className = `badge ${data.count === 0 ? 'ok' : 'danger'}`;

  if (data.count === 0) {
    box.innerHTML = '<p class="ok-text" style="margin:10px 0 0">✓ 当前频率配置无互调冲突</p>';
    return;
  }

  const rows = data.conflicts.map((c) => `
    <tr>
      <td><span class="tag">${c.productType}</span></td>
      <td class="freq">${fmt(c.product)}</td>
      <td>${esc(c.source[0].name)} <span class="freq muted">(${fmt(c.source[0].frequency)})</span>
        × ${esc(c.source[1].name)} <span class="freq muted">(${fmt(c.source[1].frequency)})</span></td>
      <td class="danger-text">${esc(c.victim.name)} <span class="freq">(${fmt(c.victim.frequency)} ± ${fmt(c.victim.guard)})</span></td>
      <td class="freq">${(c.deviation * 1000).toFixed(1)} kHz</td>
    </tr>`).join('');

  box.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr>
        <th>互调类型</th><th>互调积 (MHz)</th><th>来源频道</th>
        <th>受影响频道（保护区）</th><th>偏差</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

$('#btn-recalc').addEventListener('click', () => refreshConflicts().catch((e) => toast(e.message, true)));

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/* ---------- 自动协调 ---------- */

/* 现场占用频段（临时参数，仅随协调请求提交，不改动设备数据） */
function addOccupiedRow(lo = '', hi = '') {
  const wrap = $('#occupied-rows');
  const row = document.createElement('div');
  row.className = 'occupied-row';
  row.innerHTML = `
    <span class="muted">占用</span>
    <input type="number" class="occ-lo" step="0.000001" placeholder="下限 MHz" />
    <span class="muted">–</span>
    <input type="number" class="occ-hi" step="0.000001" placeholder="上限 MHz" />
    <button type="button" class="btn btn-sm btn-danger" data-act="del-occ">移除</button>`;
  row.querySelector('.occ-lo').value = lo;
  row.querySelector('.occ-hi').value = hi;
  row.querySelector('[data-act="del-occ"]').addEventListener('click', () => row.remove());
  wrap.appendChild(row);
}

$('#btn-add-occupied').addEventListener('click', () => addOccupiedRow());

/** 读取占用区间：整行留空则忽略；仅填一端或下限大于上限时报错 */
function readOccupiedBands() {
  const bands = [];
  for (const row of $('#occupied-rows').querySelectorAll('.occupied-row')) {
    const loRaw = row.querySelector('.occ-lo').value.trim();
    const hiRaw = row.querySelector('.occ-hi').value.trim();
    if (loRaw === '' && hiRaw === '') continue;
    if (loRaw === '' || hiRaw === '') {
      throw new Error('占用区间需同时填写下限与上限（MHz），或整行留空');
    }
    const lo = Number(loRaw);
    const hi = Number(hiRaw);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      throw new Error('占用频段必须是有效数值（MHz）');
    }
    if (lo > hi) throw new Error(`占用区间无效：下限 ${lo} 不能大于上限 ${hi}`);
    bands.push({ lo, hi });
  }
  return bands;
}

/** 实际参与避让（已合并）的占用区间摘要文本 */
function occupiedSummary(bands) {
  if (!bands || bands.length === 0) return '';
  return bands.map((b) => `${fmt(b.lo)}–${fmt(b.hi)} MHz`).join('、');
}

$('#coord-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  let occupiedBands;
  try {
    occupiedBands = readOccupiedBands();
  } catch (err) {
    toast(err.message, true);
    return;
  }
  const btn = $('#btn-coordinate');
  btn.disabled = true;
  btn.textContent = '协调中…';
  try {
    const result = await api('/api/coordinate', {
      method: 'POST',
      body: JSON.stringify({
        bandMin: Number($('#band-min').value),
        bandMax: Number($('#band-max').value),
        step: Number($('#step').value),
        maxOffset: Number($('#max-offset').value),
        occupiedBands,
      }),
    });
    lastCoordResult = result;
    renderCoordResult(result);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '开始协调';
  }
});

function renderCoordResult(r) {
  const box = $('#coord-result');
  const rows = r.assignments.map((a) => {
    const moved = a.offset > 0;
    return `<tr>
      <td>${esc(a.name)} ${a.locked ? '<span class="tag locked">锁定</span>' : ''}</td>
      <td class="freq">${fmt(a.original)}</td>
      <td class="freq ${moved ? 'ok-text' : ''}">${fmt(a.frequency)}</td>
      <td class="freq">${moved ? `±${fmt(a.offset)}`.replace('+', '') : '0'}</td>
      <td>${moved ? '<span class="tag moved">已调整</span>' : '<span class="muted">不变</span>'}</td>
    </tr>`;
  }).join('');

  const table = `
    <div class="table-wrap"><table>
      <thead><tr><th>频道</th><th>原频率 (MHz)</th><th>新频率 (MHz)</th><th>偏移 (MHz)</th><th>状态</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;

  const occText = occupiedSummary(r.params && r.params.occupiedBands);
  const occLine = occText
    ? `<p class="muted" style="margin:0 0 6px">🚧 现场占用频段（已避让）：${esc(occText)}</p>`
    : '';

  if (r.solved) {
    box.innerHTML = `
      <div class="result-box success">
        <p class="ok-text" style="margin:0 0 4px">✓ 协调成功：找到无冲突方案，总偏移 ${fmt(r.totalOffset)} MHz
          ${r.capped ? '<span class="warn-text">（搜索已截断，可能非全局最优）</span>' : ''}</p>
        ${r.reason ? `<p class="warn-text" style="margin:0 0 4px">${esc(r.reason)}</p>` : ''}
        ${occLine}
        ${table}
        <div class="save-plan-row">
          <button class="btn btn-primary" id="btn-apply-result">应用到设备</button>
          <input type="text" id="plan-name" placeholder="方案名称，如：主舞台 A 组" maxlength="60">
          <button class="btn" id="btn-save-plan">保存方案</button>
        </div>
      </div>`;
    $('#btn-apply-result').addEventListener('click', () => applyAssignments(r.assignments));
    $('#btn-save-plan').addEventListener('click', () => savePlan(r));
  } else {
    box.innerHTML = `
      <div class="result-box failure">
        <p class="warn-text" style="margin:0 0 4px">✗ 未找到无冲突方案，已保持原有频率</p>
        <p class="muted" style="margin:0 0 8px">${esc(r.reason || '')}</p>
        ${occLine}
        ${table}
      </div>`;
  }
}

async function applyAssignments(assignments) {
  try {
    for (const a of assignments) {
      const dev = devices.find((d) => d.id === a.id);
      if (!dev) continue;
      await api(`/api/devices/${a.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: dev.name,
          frequency: a.frequency,
          guard: dev.guard,
          locked: dev.locked,
        }),
      });
    }
    toast('已将协调结果应用到设备');
    await loadDevices();
  } catch (e) { toast(e.message, true); }
}

async function savePlan(r) {
  const nameInput = $('#plan-name');
  const name = nameInput.value.trim() || `方案 ${new Date().toLocaleString('zh-CN')}`;
  try {
    await api('/api/plans', {
      method: 'POST',
      body: JSON.stringify({
        name,
        params: r.params,
        assignments: r.assignments,
        totalOffset: r.totalOffset,
        solved: r.solved,
      }),
    });
    toast(`方案「${name}」已保存`);
    nameInput.value = '';
    await loadPlans();
  } catch (e) { toast(e.message, true); }
}

/* ---------- 已保存方案 ---------- */

async function loadPlans() {
  const plans = await api('/api/plans');
  $('#plan-count').textContent = plans.length;
  const box = $('#plan-list');
  if (plans.length === 0) {
    box.innerHTML = '<p class="empty-state">暂无保存的方案</p>';
    return;
  }
  box.innerHTML = '';
  for (const p of plans) {
    const div = document.createElement('div');
    div.className = 'plan-item';
    const rows = p.assignments.map((a) => `
      <tr>
        <td>${esc(a.name)} ${a.locked ? '<span class="tag locked">锁定</span>' : ''}</td>
        <td class="freq">${fmt(a.original)}</td>
        <td class="freq">${fmt(a.frequency)}</td>
        <td class="freq">${a.offset > 0 ? fmt(a.offset) : '0'}</td>
      </tr>`).join('');
    div.innerHTML = `
      <details>
        <summary><strong>${esc(p.name)}</strong>
          <span class="badge ${p.solved ? 'ok' : 'danger'}">${p.solved ? '无冲突' : '无解'}</span>
        </summary>
        <p class="plan-meta">
          保存时间：${esc(p.createdAt)} ｜ 频段 ${fmt(p.params.bandMin)}–${fmt(p.params.bandMax)} MHz ｜
          步进 ${fmt(p.params.step)} MHz ｜ 最大偏移 ${fmt(p.params.maxOffset)} MHz ｜
          总偏移 <span class="freq">${fmt(p.totalOffset)}</span> MHz
        </p>
        <p class="plan-meta">现场占用频段：${occupiedSummary(p.params.occupiedBands) ? '🚧 ' + esc(occupiedSummary(p.params.occupiedBands)) : '无'}</p>
        <div class="table-wrap"><table>
          <thead><tr><th>频道</th><th>原频率 (MHz)</th><th>方案频率 (MHz)</th><th>偏移 (MHz)</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <div class="plan-actions">
          <button class="btn btn-sm btn-primary" data-act="preview">应用前预览</button>
          <button class="btn btn-sm btn-danger" data-act="del">删除方案</button>
        </div>
        <div class="plan-preview" data-role="preview" hidden></div>
      </details>`;
    div.querySelector('[data-act="preview"]').addEventListener('click', () => previewPlan(p, div));
    div.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(`确定删除方案「${p.name}」？`)) return;
      try {
        await api(`/api/plans/${p.id}`, { method: 'DELETE' });
        toast('方案已删除');
        await loadPlans();
      } catch (e) { toast(e.message, true); }
    });
    box.appendChild(div);
  }
}

/** 应用前预览：按设备 id 展示当前频率与目标频率，并做服务端检查 */
async function previewPlan(plan, itemEl) {
  const panel = itemEl.querySelector('[data-role="preview"]');
  const btn = itemEl.querySelector('[data-act="preview"]');
  panel.hidden = false;
  panel.innerHTML = '<p class="muted plan-preview-loading">正在复算互调冲突与占用区间…</p>';
  btn.disabled = true;
  try {
    const res = await api(`/api/plans/${plan.id}/preview`, { method: 'POST' });
    renderPreviewOk(plan, res, panel, itemEl);
  } catch (e) {
    if (e.status === 422 && e.data) {
      renderPreviewFailed(plan, e.data, panel);
    } else {
      panel.innerHTML = `<p class="warn-text">预览失败：${esc(e.message)}</p>`;
    }
  } finally {
    btn.disabled = false;
  }
}

function previewDeviceRows(devices) {
  return devices.map((d) => {
    const hasTarget = d.target !== null && d.target !== undefined;
    return `<tr${d.changed ? ' class="row-changed"' : ''}>
      <td>${esc(d.name)} ${d.locked ? '<span class="tag locked">锁定</span>' : ''}</td>
      <td class="freq">${fmt(d.current)}</td>
      <td class="freq ${d.changed ? 'ok-text' : 'muted'}">${hasTarget ? fmt(d.target) : '—'}</td>
      <td class="freq">${d.changed ? `−${fmt(d.current)} → ${fmt(d.target)}` : '<span class="muted">不变</span>'}</td>
    </tr>`;
  }).join('');
}

/** 预览成功：展示全部设备的当前 → 目标状态与确认按钮（携带凭据） */
function renderPreviewOk(plan, res, panel, itemEl) {
  const occ = occupiedSummary(res.occupiedBands);
  panel.innerHTML = `
    <div class="result-box success plan-preview-box">
      <p class="ok-text" style="margin:0 0 4px">✓ 预览检查通过：互调冲突 ${res.conflictCount} 处，
        目标频率均合法，锁定设备未改频${occ ? '，保护区与现场占用区间不相交' : '（方案无占用区间）'}</p>
      <p class="plan-meta" style="margin:0 0 6px">检查时间：${esc(new Date(res.checkedAt).toLocaleString('zh-CN'))}
        ${occ ? `｜现场占用区间：🚧 ${esc(occ)}` : ''}</p>
      <div class="table-wrap"><table>
        <thead><tr><th>设备（按 ID 对应）</th><th>当前频率 (MHz)</th><th>目标频率 (MHz)</th><th>变化</th></tr></thead>
        <tbody>${previewDeviceRows(res.devices)}</tbody>
      </table></div>
      <p class="hint" style="margin-top:8px">确认后将在同一事务内再次核对凭据与全部检查并一次性写入；
        若期间设备状态变化，应用会被拒绝且不会写入任何设备。</p>
      <div class="save-plan-row">
        <button class="btn btn-primary" data-role="confirm">确认应用（共 ${res.devices.length} 个设备）</button>
        <button class="btn btn-ghost btn-sm" data-role="cancel">取消</button>
      </div>
    </div>`;
  panel.querySelector('[data-role="cancel"]').addEventListener('click', () => {
    panel.hidden = true;
    panel.innerHTML = '';
  });
  panel.querySelector('[data-role="confirm"]').addEventListener('click', async (ev) => {
    const confirmBtn = ev.currentTarget;
    confirmBtn.disabled = true;
    confirmBtn.textContent = '应用中…';
    try {
      const r = await api(`/api/plans/${plan.id}/apply`, {
        method: 'POST',
        body: JSON.stringify({ credential: res.credential }),
      });
      toast(`已应用方案，更新 ${r.applied} 个设备`);
      panel.hidden = true;
      panel.innerHTML = '';
      await loadDevices();
      await loadPlans();
    } catch (e) {
      // 409：状态变化或凭据缺失/无效，不写入任何设备，提示重新预览
      if (e.status === 409 && e.data) {
        renderPreviewStale(plan, e.data, panel, itemEl);
      } else {
        toast(e.message, true);
        confirmBtn.disabled = false;
        confirmBtn.textContent = `确认应用（共 ${res.devices.length} 个设备）`;
      }
    }
  });
}

/** 预览阶段检查失败：列明全部原因，禁止应用（不提供确认按钮） */
function renderPreviewFailed(plan, data, panel) {
  const reasons = (data.errors || []).map((msg) => `<li>${esc(msg)}</li>`).join('');
  const rows = data.devices && data.devices.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>设备</th><th>当前频率 (MHz)</th><th>目标频率 (MHz)</th><th>变化</th></tr></thead>
      <tbody>${previewDeviceRows(data.devices)}</tbody>
    </table></div>` : '';
  panel.innerHTML = `
    <div class="result-box failure plan-preview-box">
      <p class="warn-text" style="margin:0 0 6px">✗ 应用前检查未通过，该方案禁止应用：</p>
      <ul class="preview-errors">${reasons || `<li>${esc(data.error || '检查失败')}</li>`}</ul>
      ${rows}
    </div>`;
}

/** 确认阶段被拒（409）：凭据失效或设备状态已变，引导重新预览 */
function renderPreviewStale(plan, data, panel, itemEl) {
  const reasons = (data.errors || []).map((msg) => `<li>${esc(msg)}</li>`).join('');
  panel.innerHTML = `
    <div class="result-box failure plan-preview-box">
      <p class="warn-text" style="margin:0 0 6px">⚠ ${esc(data.error || '确认凭据已失效')}，未写入任何设备。</p>
      ${reasons ? `<ul class="preview-errors">${reasons}</ul>` : ''}
      <div class="save-plan-row">
        <button class="btn btn-primary" data-role="represent">重新预览</button>
      </div>
    </div>`;
  panel.querySelector('[data-role="represent"]').addEventListener('click', () => previewPlan(plan, itemEl));
}

$('#btn-refresh-plans').addEventListener('click', () => loadPlans().catch((e) => toast(e.message, true)));

/* ---------- 启动 ---------- */

(async () => {
  addOccupiedRow(); // 默认提供一行（留空即不启用避让）
  try {
    await loadDevices();
    await loadPlans();
  } catch (e) {
    toast(`初始化失败：${e.message}`, true);
  }
})();
