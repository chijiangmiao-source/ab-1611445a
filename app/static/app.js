"use strict";

// Ground calibration library — exercise UI.
// All arbitration decisions come from the backend; this file only renders them.

const REASON_LABELS = {
  accepted: "已接受",
  phantom_read: "幻读拒绝",
  point_read_conflict: "点读冲突",
  transaction_id_conflict: "事务标识冲突（异载荷重用）",
  stale_generation: "过期快照",
  invalid_payload: "非法载荷",
};

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function parseJsonArea(id, label) {
  const el = document.getElementById(id);
  try {
    return { value: JSON.parse(el.value), ok: true };
  } catch (e) {
    return { ok: false, error: `${label}不是合法 JSON：${e.message}` };
  }
}

function fmt(v) {
  return v === null ? "<不存在/已删除>" : esc(JSON.stringify(v));
}

// --------------------------------------------------------------------- seed
async function seedExercise() {
  const msg = document.getElementById("seed-msg");
  msg.className = "msg";
  msg.textContent = "";
  const initial = parseJsonArea("initial-kv", "初始键值");
  if (!initial.ok) {
    msg.className = "msg err";
    msg.textContent = initial.error;
    return;
  }
  try {
    const r = await api("POST", "/api/exercise", { initial: initial.value });
    msg.className = "msg ok";
    msg.textContent = `已建立第 ${r.generation} 代，共 ${Object.keys(r.keys).length} 个键。`;
    await refreshState();
    await refreshTxns();
  } catch (e) {
    msg.className = "msg err";
    msg.textContent = e.message;
  }
}

// -------------------------------------------------------------------- state
async function refreshState() {
  const view = document.getElementById("state-view");
  try {
    const s = await api("GET", "/api/state");
    document.getElementById("current-gen").textContent = String(s.current_generation);
    document.getElementById("f-gen").value = String(s.current_generation);
    const names = Object.keys(s.keys);
    if (!names.length) {
      view.innerHTML = "<em>（当前无键）</em>";
      return;
    }
    view.innerHTML = names.map((k) =>
      `<div class="k">${esc(k)}</div>` +
      `<div class="v">${fmt(s.keys[k].value)} ` +
      `<small style="color:#8c959f">[gen ${s.keys[k].generation}]</small></div>`
    ).join("");
  } catch (e) {
    view.innerHTML = `<em>无法获取状态：${esc(e.message)}</em>`;
  }
}

// -------------------------------------------------------------------- commit
async function doCommit() {
  const msg = document.getElementById("commit-msg");
  msg.className = "msg";
  msg.textContent = "";

  const points = parseJsonArea("f-points", "点读取");
  if (!points.ok) { msg.className = "msg err"; msg.textContent = points.error; return; }
  const scans = parseJsonArea("f-scans", "前缀扫描");
  if (!scans.ok) { msg.className = "msg err"; msg.textContent = scans.error; return; }
  const writes = parseJsonArea("f-writes", "拟写入");
  if (!writes.ok) { msg.className = "msg err"; msg.textContent = writes.error; return; }

  const txn = {
    transaction_id: document.getElementById("f-txn").value.trim(),
    snapshot_generation: parseInt(document.getElementById("f-gen").value, 10),
    point_reads: points.value,
    prefix_scans: scans.value,
    writes: writes.value,
  };
  try {
    const r = await api("POST", "/api/commit", txn);
    if (r.status === "accepted") {
      msg.className = "msg ok";
      msg.textContent = r.replay
        ? `（重传回显）事务 ${r.transaction_id} 已接受，冻结至第 ${r.new_generation} 代。`
        : `事务 ${r.transaction_id} 已接受，冻结至第 ${r.new_generation} 代。`;
    } else {
      msg.className = "msg err";
      msg.textContent = `事务被拒绝（${REASON_LABELS[r.reason] || r.reason}）——当前代次 ${r.current_generation}。`;
    }
    await Promise.all([refreshState(), refreshTxns()]);
  } catch (e) {
    msg.className = "msg err";
    msg.textContent = e.message;
  }
}

// ------------------------------------------------------------- txn rendering
async function refreshTxns() {
  const el = document.getElementById("txn-list");
  try {
    const { transactions } = await api("GET", "/api/transactions");
    if (!transactions.length) {
      el.innerHTML = "<em>暂无事务。</em>";
      return;
    }
    el.innerHTML = transactions.map(renderTxn).join("");
    el.querySelectorAll(".txn-head").forEach((h) => {
      h.addEventListener("click", () => h.parentElement.classList.toggle("open"));
    });
  } catch (e) {
    el.innerHTML = `<em>无法获取事务列表：${esc(e.message)}</em>`;
  }
}

function renderTxn(t) {
  const cls = t.status === "accepted" ? "accepted" : (t.reason || "unknown");
  const pill = t.status === "accepted"
    ? '<span class="pill accepted">已接受</span>'
    : '<span class="pill rejected">拒绝</span>';
  const reasonPill = t.reason
    ? `<span class="pill reason">${esc(REASON_LABELS[t.reason] || t.reason)}</span>`
    : "";
  const replay = t.replay ? '<span class="replay-tag">重传回显</span>' : "";
  const meta = t.status === "accepted"
    ? `快照 gen ${t.snapshot_generation} → 新代次 <span class="newgen">${t.new_generation}</span>`
    : `快照 gen ${t.snapshot_generation}，当前 gen ${t.current_generation}`;

  return `
  <div class="txn txn-${esc(cls)}">
    <div class="txn-head">
      ${pill} ${reasonPill}
      <span class="tid">${esc(t.transaction_id)}</span>
      ${replay}
      <span class="meta">${meta}</span>
    </div>
    <div class="txn-body">
      ${t.detail ? `<div class="hint">${esc(t.detail)}</div>` : ""}
      ${renderEvidence(t)}
      ${renderConflicts(t)}
      ${t.status === "accepted" ? renderAccepted(t) : ""}
    </div>
  </div>`;
}

function renderEvidence(t) {
  const rs = t.read_summary || {};
  const pts = (rs.point_reads || []).map((p) =>
    `<li><code>${esc(p.key)}</code> = ${fmt(p.value)}</li>`).join("");
  const scans = (rs.prefix_scans || []).map((s) => `
    <details class="scan" open>
      <summary>前缀扫描 <code>${esc(s.prefix)}</code> · 快照中看到 ${s.seen_at_snapshot.length} 个键</summary>
      <div class="section-label">其快照中看到的键：</div>
      <ul class="keylist">
        ${(s.seen_at_snapshot || []).map((k) => `<li>${esc(k)}</li>`).join("") || "<li>（空）</li>"}
      </ul>
      <div class="section-label">当前前缀内的键：</div>
      <ul class="keylist">
        ${(s.current_keys || []).map((k) => `<li>${esc(k)}</li>`).join("") || "<li>（空）</li>"}
      </ul>
    </details>`).join("");
  return `
    <div class="section-label">点读取摘要：</div>
    <ul class="keylist">${pts || "<li>（无）</li>"}</ul>
    ${scans ? `<div class="section-label">扫描摘要（可展开查看快照所见键集合）：</div>${scans}` : ""}
  `;
}

function renderConflicts(t) {
  const boxes = [];
  if (t.point_conflicts) {
    const lines = t.point_conflicts.map((c) =>
      `- ${c.key}: 快照读取值 ${JSON.stringify(c.read_value)} → 当前值 ${JSON.stringify(c.current_value)}`
    ).join("\n");
    boxes.push(`<div class="conflict-box">【点读冲突】\n${esc(lines)}</div>`);
  }
  if (t.phantom_conflicts) {
    const lines = t.phantom_conflicts.map((c) => {
      const parts = [`- 前缀 ${c.prefix}:`];
      if (c.keys_added_after_snapshot.length) {
        parts.push(`    快照后新增: ${c.keys_added_after_snapshot.join(", ")}`);
      }
      if (c.keys_deleted_after_snapshot.length) {
        parts.push(`    快照后删除: ${c.keys_deleted_after_snapshot.join(", ")}`);
      }
      if (c.keys_rewritten_after_snapshot.length) {
        parts.push(`    快照后改写: ${c.keys_rewritten_after_snapshot
          .map((x) => `${x.key}@gen${x.changed_at_generation}`).join(", ")}`);
      }
      return parts.join("\n");
    }).join("\n");
    boxes.push(`<div class="conflict-box">【幻读 / 扫描违例】\n${esc(lines)}</div>`);
  }
  return boxes.join("");
}

function renderAccepted(t) {
  const writes = Object.entries(t.writes || {}).map(([k, v]) =>
    `<li><code>${esc(k)}</code> = ${fmt(v)}</li>`).join("");
  return `
    <div class="section-label">冻结写入（第 ${t.new_generation} 代同一裁决落盘）：</div>
    <ul class="keylist">${writes || "<li>（无写入）</li>"}</ul>`;
}

// --------------------------------------------------------------------- init
document.getElementById("seed-btn").addEventListener("click", seedExercise);
document.getElementById("commit-btn").addEventListener("click", doCommit);
document.getElementById("refresh-btn").addEventListener("click", refreshState);
document.getElementById("reload-txns").addEventListener("click", refreshTxns);

refreshState();
refreshTxns();
