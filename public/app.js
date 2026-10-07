'use strict';

const $ = (id) => document.getElementById(id);
let currentDrill = null;
let filter = 'all';

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast-item ' + kind;
  el.textContent = msg;
  $('toast').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.code = data.error?.code;
    err.evidence = data.error?.evidence;
    throw err;
  }
  return data;
}

function parseJsonField(el, label) {
  const txt = el.value.trim();
  if (!txt) return [];
  try {
    const v = JSON.parse(txt);
    if (!Array.isArray(v)) throw new Error('应为数组');
    return v;
  } catch (e) {
    throw new Error(`${label} 不是合法 JSON 数组：${e.message}`);
  }
}

async function checkHealth() {
  try {
    const h = await api('GET', '/healthz');
    $('health').textContent = `健康 ${h.status} · ${h.service}`;
  } catch {
    $('health').textContent = '服务不可达';
  }
}

async function loadDrillList(selectId) {
  const { drills } = await api('GET', '/api/drills');
  const box = $('drillList');
  if (!drills.length) {
    box.innerHTML = '<div class="muted">尚未建立演练</div>';
  } else {
    box.innerHTML = '';
    for (const d of drills) {
      const item = document.createElement('div');
      item.className = 'drill-item' + (d.id === currentDrill ? ' active' : '');
      item.innerHTML = `<span><b></b><div class="meta"></div></span><span class="gen-pill">gen&nbsp;</span>`;
      item.querySelector('b').textContent = d.id;
      item.querySelector('.meta').textContent = `${d.keyCount} 个存活键`;
      item.querySelector('.gen-pill').textContent = 'gen ' + d.gen;
      item.onclick = () => selectDrill(d.id);
      box.appendChild(item);
    }
  }
  if (selectId && drills.some((d) => d.id === selectId)) currentDrill = selectId;
}

async function selectDrill(id) {
  currentDrill = id;
  await refreshState();
  await loadDrillList();
}

async function refreshState() {
  if (!currentDrill) return;
  const state = await api('GET', `/api/drills/${encodeURIComponent(currentDrill)}/state`);
  $('commitPanel').style.display = '';
  $('curGenHint').textContent = state.gen;
  $('stateGen').textContent = `gen ${state.gen}`;
  $('gen').value = state.gen;
  const keys = Object.keys(state.entries);
  $('stateEmpty').style.display = keys.length ? 'none' : '';
  const grid = $('kvState');
  grid.innerHTML = '';
  for (const k of keys) {
    const a = document.createElement('div');
    a.textContent = k;
    const b = document.createElement('div');
    b.textContent = state.entries[k];
    grid.append(a, b);
  }
  renderTransactions(state.transactions || []);
}

function badgeHtml(d) {
  if (d.status === 'accepted') return `<span class="badge accepted">✔ 已接受 · gen ${d.gen}→${d.newGen}</span>`;
  if (d.reason === 'POINT_READ_CONFLICT' || d.reason === 'READ_SNAPSHOT_MISMATCH')
    return `<span class="badge rejected-point">● 点读冲突 · ${d.reason}</span>`;
  if (d.reason === 'PHANTOM_READ') {
    const kind = d.evidence?.kind === 'new' ? '前缀新增' : d.evidence?.kind === 'deleted' ? '前缀删除' : '前缀改写';
    return `<span class="badge rejected-phantom">◆ 幻读拒绝 · ${kind}</span>`;
  }
  return `<span class="badge rejected-other">▲ ${d.reason}</span>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderTransactions(txns) {
  const box = $('txnList');
  let list = [...txns].reverse();
  if (filter !== 'all') {
    list = list.filter((d) => {
      if (filter === 'accepted') return d.status === 'accepted';
      if (filter === 'point') return ['POINT_READ_CONFLICT', 'READ_SNAPSHOT_MISMATCH'].includes(d.reason);
      if (filter === 'phantom') return d.reason === 'PHANTOM_READ';
      if (filter === 'other') return d.status === 'rejected' &&
        !['POINT_READ_CONFLICT', 'READ_SNAPSHOT_MISMATCH', 'PHANTOM_READ'].includes(d.reason);
      return true;
    });
  }
  if (!list.length) {
    box.innerHTML = '<div class="muted">当前筛选下暂无事务</div>';
    return;
  }
  box.innerHTML = '';
  for (const d of list) {
    const card = document.createElement('div');
    card.className = 'txn';
    card.innerHTML = `
      <div class="txn-head">
        <span class="txnid"></span>
        ${badgeHtml(d)}
        <span style="flex:1"></span>
        <span class="muted" style="font-size:11.5px">${esc(d.committedAt || '')}</span>
      </div>
      <div class="txn-body">
        <div class="sec-title">快照 / 终局</div>
        <div>事务基于快照代次 <b>${d.gen}</b>；终局代次 <b>${d.newGen}</b>。
          ${d.echoed ? '<span class="badge echo">重传回显</span>' : ''}</div>
        ${d.status === 'rejected' ? evidenceBlock(d) : ''}
        ${d.status === 'accepted' ? writesBlock(d) : ''}
        <div class="sec-title">点读摘要（快照证据）</div>
        ${summaryPoints(d)}
        <div class="sec-title">前缀扫描摘要（点击展开该快照中看到的键）</div>
        ${summaryScans(d)}
      </div>`;
    card.querySelector('.txnid').textContent = d.txnId;
    card.querySelector('.txn-head').onclick = () => card.classList.toggle('open');
    box.appendChild(card);
  }
}

function evidenceBlock(d) {
  const isPoint = ['POINT_READ_CONFLICT', 'READ_SNAPSHOT_MISMATCH'].includes(d.reason);
  const isPhantom = d.reason === 'PHANTOM_READ';
  const cls = isPoint ? 'point' : isPhantom ? 'phantom' : 'other';
  const e = d.evidence || {};
  let detail = esc(d.message || '');
  if (isPhantom && e.kind) {
    const label = { new: '快照后新增键', deleted: '快照后删除键', modified: '快照后改写值' }[e.kind];
    detail += `<div style="margin-top:6px"><b>${label}：</b><code>${esc(e.key)}</code>` +
      `（快照值 <code>${esc(e.snapshotValue)}</code> → 现值 <code>${esc(e.currentValue)}</code>，前缀 <code>${esc(e.prefix)}</code>）</div>`;
  }
  if (isPoint && e.key) {
    detail += `<div style="margin-top:6px"><code>${esc(e.key)}</code>：快照值 <code>${esc(e.snapshotValue)}</code>` +
      (Object.prototype.hasOwnProperty.call(e, 'currentValue') ? ` → 现值 <code>${esc(e.currentValue)}</code>` : '') + `</div>`;
  }
  return `<div class="evbox ${cls}"><b>拒绝原因（稳定代码）：${esc(d.reason)}</b><div style="margin-top:4px">${detail}</div></div>`;
}

function writesBlock(d) {
  const rows = (d.writes || []).map((w) =>
    `<tr><td class="mono">${esc(w.key)}</td><td class="mono">${w.value === null ? '<i>null（删除）</i>' : esc(w.value)}</td></tr>`).join('');
  return `<div class="sec-title">冻结写入（gen ${d.newGen}）</div>
    <table><thead><tr><th>键</th><th>值</th></tr></thead><tbody>${rows || '<tr><td colspan="2" class="muted">无写入（只读校验提交）</td></tr>'}</tbody></table>`;
}

function summaryPoints(d) {
  const pts = d.readSummary?.points || [];
  if (!pts.length) return '<div class="muted">无点读</div>';
  const rows = pts.map((p) => `<tr><td class="mono">${esc(p.key)}</td><td class="mono">${esc(p.value)}</td></tr>`).join('');
  return `<table><thead><tr><th>读取键</th><th>快照中值</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function summaryScans(d) {
  const scans = d.scanSummary || [];
  if (!scans.length) return '<div class="muted">无前缀扫描</div>';
  return scans.map((s) => {
    const rows = (s.keys || []).map((k) =>
      `<tr><td class="mono">${esc(k.key)}</td><td class="mono">${esc(k.value)}</td></tr>`).join('');
    return `<details>
      <summary>前缀 <code>${esc(s.prefix)}</code> · 快照中 ${s.keys?.length || 0} 个键（展开查看键值）</summary>
      <div class="inner"><table><thead><tr><th>键</th><th>快照值</th></tr></thead><tbody>${rows || '<tr><td colspan="2" class="muted">空前缀</td></tr>'}</tbody></table></div>
    </details>`;
  }).join('');
}

async function buildCommitBody() {
  const txnId = $('txnId').value.trim();
  if (!txnId) throw new Error('必须填写稳定事务标识 txnId');
  const reads = parseJsonField($('reads'), '点读取');
  const scans = parseJsonField($('scans'), '前缀扫描');
  const writes = parseJsonField($('writes'), '拟写入值');
  return { txnId, gen: Number($('gen').value), reads, scans, writes };
}

async function doCommit() {
  try {
    const body = await buildCommitBody();
    const r = await api('POST', `/api/drills/${encodeURIComponent(currentDrill)}/commit`, body);
    const d = r.decision;
    if (d.status === 'accepted') toast(`事务 ${d.txnId} 已接受，新代次 gen ${d.newGen}${r.echoed ? '（重传回显）' : ''}`);
    else toast(`事务 ${d.txnId} 被拒绝：${d.reason}`, 'err');
    await refreshState();
  } catch (e) {
    toast(e.message, 'err');
  }
}

$('createBtn').onclick = async () => {
  try {
    let entries;
    const txt = $('initEntries').value.trim();
    entries = txt ? JSON.parse(txt) : {};
    if (typeof entries !== 'object' || Array.isArray(entries)) throw new Error('初始键值必须是 JSON 对象');
    const id = $('drillId').value.trim() || undefined;
    const created = await api('POST', '/api/drills', { id, entries });
    toast(`演练 ${created.id} 已建立于 gen 0`);
    await loadDrillList(created.id);
    await refreshState();
  } catch (e) {
    toast(e.message, 'err');
  }
};

$('refreshList').onclick = () => loadDrillList();
$('refreshState').onclick = () => refreshState();
$('commitBtn').onclick = doCommit;
$('resendBtn').onclick = doCommit; // 同标识重传：后端按规范载荷回显或拒绝
document.querySelectorAll('.filterbar button').forEach((b) => {
  b.onclick = () => {
    filter = b.dataset.f;
    document.querySelectorAll('.filterbar button').forEach((x) => x.classList.toggle('on', x === b));
    refreshState();
  };
});

checkHealth();
loadDrillList();
setInterval(checkHealth, 10000);
