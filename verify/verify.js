'use strict';

/**
 * 一次性验收服务：
 *   1) 构建检查：对所有 JS 源文件执行 node --check
 *   2) 规则测试：直接驱动 DrillStore（含重开回放、WAL 撕裂恢复）
 *   3) API/HTTP 冒烟：
 *      - 若设置 BASE_URL（编排内指向 app 服务），对其跑跨容器冒烟
 *      - 始终在本地以临时数据目录拉起真实 HTTP 子进程，验证健康、
 *        接受、点读冲突、幻读、重传回显、异载荷拒绝，并在杀进程重启后
 *        重传同一事务标识只能回显原结果
 * 退出码 0 = 验收通过，非 0 = 失败。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { execFileSync } = require('child_process');
const { DrillStore, REASON } = require('../src/store');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'calib-verify-'));
}

function freshStore() {
  const dir = tempDir();
  return { dir, store: DrillStore.create(dir) };
}

// ---------------------------------------------------------------- 规则测试

function testDisjointAndWriteSkew() {
  console.log('\n[规则] 互不相交提交成功；写偏斜后一提交不得越过读取校验');
  const { store } = freshStore();
  store.bootstrap({ a: '1', b: '2', c: '3' });

  // 两个工程师在 gen0 快照上读取互不相交的键并写互不相交的键
  const t1 = store.commit({ txnId: 't1', gen: 0, reads: [{ key: 'a', value: '1' }], scans: [], writes: [{ key: 'a', value: '10' }] });
  eq('T1 接受并推进到 gen1', t1.decision.status, 'accepted');
  eq('T1 newGen', t1.decision.newGen, 1);

  const t2 = store.commit({ txnId: 't2', gen: 0, reads: [{ key: 'b', value: '2' }], scans: [], writes: [{ key: 'b', value: '20' }] });
  eq('读取/写入互不相交的 T2 仍成功', t2.decision.status, 'accepted');
  eq('T2 newGen', t2.decision.newGen, 2);

  eq('当前 a', store.valueAt('a', store.gen), '10');
  eq('当前 b', store.valueAt('b', store.gen), '20');

  // 写偏斜：双方都读了 a 与 b，却各写一边；后一提交必须被点读校验拦下
  const w1 = store.commit({ txnId: 'ws1', gen: 2, reads: [{ key: 'a', value: '10' }, { key: 'b', value: '20' }], scans: [], writes: [{ key: 'a', value: '100' }] });
  eq('写偏斜第一笔接受', w1.decision.status, 'accepted');
  const w2 = store.commit({ txnId: 'ws2', gen: 2, reads: [{ key: 'a', value: '10' }, { key: 'b', value: '20' }], scans: [], writes: [{ key: 'b', value: '200' }] });
  eq('写偏斜后一提交被点读校验拒绝', w2.decision.status, 'rejected');
  eq('拒绝原因稳定', w2.decision.reason, REASON.POINT_READ_CONFLICT);
  eq('冲突证据定位到被改写的键', w2.decision.evidence.key, 'a');
  eq('拒绝不推进代次', w2.decision.newGen, store.gen);
}

function testPointRead() {
  console.log('\n[规则] 点读：快照后改写拒绝；快照自洽性校验');
  const { store } = freshStore();
  store.bootstrap({ k: 'v1', untouched: 'x' });
  store.commit({ txnId: 'c1', gen: 0, reads: [{ key: 'k', value: 'v1' }], writes: [{ key: 'k', value: 'v2' }] });

  const stale = store.commit({ txnId: 'stale', gen: 0, reads: [{ key: 'k', value: 'v1' }], writes: [{ key: 'untouched', value: 'y' }] });
  eq('过期快照点读被改写 → POINT_READ_CONFLICT', stale.decision.reason, REASON.POINT_READ_CONFLICT);
  eq('证据给出快照值与现值', [stale.decision.evidence.snapshotValue, stale.decision.evidence.currentValue], ['v1', 'v2']);

  const lie = store.commit({ txnId: 'lie', gen: 0, reads: [{ key: 'k', value: 'fabricated' }], writes: [] });
  eq('点读值与快照本身不符 → READ_SNAPSHOT_MISMATCH', lie.decision.reason, REASON.READ_SNAPSHOT_MISMATCH);

  const future = store.commit({ txnId: 'future', gen: 99, reads: [], writes: [] });
  eq('未知（未来）代次 → UNKNOWN_GENERATION', future.decision.reason, REASON.UNKNOWN_GENERATION);
}

function testScans() {
  console.log('\n[规则] 前缀扫描：新增/删除/改写均为幻读；扫描证据必须自洽');
  const { store } = freshStore();
  store.bootstrap({ 'g.1': 'a', 'g.2': 'b', 'other': 'z' });

  // gen1：前缀内新增键
  const add = store.commit({
    txnId: 'add-g3', gen: 0,
    reads: [{ key: 'other', value: 'z' }],
    writes: [{ key: 'g.3', value: 'c' }],
  });
  eq('新增 g.3 的事务接受', add.decision.status, 'accepted');

  const phNew = store.commit({
    txnId: 'phantom-new', gen: 0,
    reads: [], scans: [{ prefix: 'g.', keys: ['g.1', 'g.2'] }], writes: [],
  });
  eq('快照后前缀新增 → PHANTOM_READ', phNew.decision.reason, REASON.PHANTOM_READ);
  eq('幻读证据 kind=new', phNew.decision.evidence.kind, 'new');
  eq('幻读证据定位新键', phNew.decision.evidence.key, 'g.3');

  // gen2：改写 g.1
  store.commit({ txnId: 'mod-g1', gen: 1, reads: [{ key: 'g.1', value: 'a' }], writes: [{ key: 'g.1', value: 'A' }] });
  const phMod = store.commit({
    txnId: 'phantom-mod', gen: 1,
    scans: [{ prefix: 'g.', keys: ['g.1', 'g.2', 'g.3'] }], writes: [],
  });
  eq('快照后前缀内改写 → PHANTOM_READ', phMod.decision.reason, REASON.PHANTOM_READ);
  eq('幻读证据 kind=modified', phMod.decision.evidence.kind, 'modified');

  // gen3：删除 g.2（null 写入，墓碑留在不可变历史）
  store.commit({ txnId: 'del-g2', gen: 2, reads: [{ key: 'g.2', value: 'b' }], writes: [{ key: 'g.2', value: null }] });
  const phDel = store.commit({
    txnId: 'phantom-del', gen: 2,
    scans: [{ prefix: 'g.', keys: ['g.1', 'g.2', 'g.3'] }], writes: [],
  });
  eq('快照后前缀删除 → PHANTOM_READ', phDel.decision.reason, REASON.PHANTOM_READ);
  eq('幻读证据 kind=deleted', phDel.decision.evidence.kind, 'deleted');

  // 声称的扫描结果与快照不符
  const lie = store.commit({
    txnId: 'scan-lie', gen: 0, scans: [{ prefix: 'g.', keys: ['g.1'] }], writes: [],
  });
  eq('扫描键集与快照不符 → SCAN_SNAPSHOT_MISMATCH', lie.decision.reason, REASON.SCAN_SNAPSHOT_MISMATCH);

  // 当前代次自洽扫描可以通过（只读提交也冻结裁决）
  const ok = store.commit({
    txnId: 'scan-ok', gen: store.gen,
    scans: [{ prefix: 'g.', keys: ['g.1', 'g.3'] }], writes: [],
  });
  eq('与当前快照一致的扫描提交接受', ok.decision.status, 'accepted');
  eq('扫描摘要含快照值', ok.decision.scanSummary[0].keys, [{ key: 'g.1', value: 'A' }, { key: 'g.3', value: 'c' }]);
}

function testRetransmitAndReopen() {
  console.log('\n[规则] 重传回显 / 异载荷重用拒绝 / 重开放冻结果');
  const { dir, store } = freshStore();
  store.bootstrap({ a: '1' });

  const body = { txnId: 'fix-1', gen: 0, reads: [{ key: 'a', value: '1' }], scans: [], writes: [{ key: 'a', value: '2' }] };
  const first = store.commit(body);
  eq('首次提交接受', first.decision.status, 'accepted');
  check('首次非回显', first.echoed === false);

  const again = store.commit({ ...body });
  check('同标识同规范载荷重传 → echoed', again.echoed === true);
  eq('回显同一终局 newGen', again.decision.newGen, first.decision.newGen);
  eq('代次没有因重传再次推进', store.gen, 1);

  // 键顺序不同的 JSON 仍是同一规范载荷
  const reordered = { writes: body.writes, scans: [], txnId: 'fix-1', gen: 0, reads: [{ value: '1', key: 'a' }] };
  const echo2 = store.commit(reordered);
  check('字段/键序不同但规范载荷相同 → 仍回显', echo2.echoed === true);

  let reuseErr = null;
  try {
    store.commit({ txnId: 'fix-1', gen: 0, reads: [{ key: 'a', value: '1' }], writes: [{ key: 'a', value: '999' }] });
  } catch (e) { reuseErr = e; }
  check('异载荷重用抛出冲突', !!reuseErr);
  eq('冲突稳定代码', reuseErr && reuseErr.code, REASON.PAYLOAD_REUSE_CONFLICT);

  // 被拒绝事务的重传也必须回显原拒绝
  const rej1 = store.commit({ txnId: 'fix-2', gen: 0, reads: [{ key: 'a', value: 'stale' }], writes: [] });
  eq('伪造快照值的拒绝', rej1.decision.reason, REASON.READ_SNAPSHOT_MISMATCH);
  const rej2 = store.commit({ txnId: 'fix-2', gen: 0, reads: [{ key: 'a', value: 'stale' }], writes: [] });
  check('拒绝结果重传 → echoed', rej2.echoed === true);
  eq('回显相同拒绝原因', rej2.decision.reason, REASON.READ_SNAPSHOT_MISMATCH);

  // 重开：用同一目录重建存储，回放不可变历史与裁决
  const reopened = DrillStore.create(dir);
  eq('重开后代次', reopened.gen, 1);
  eq('重开后存活值', reopened.valueAt('a', reopened.gen), '2');
  eq('重开后第 0 代不可变历史仍可查', reopened.valueAt('a', 0), '1');
  const afterReopen = reopened.commit({ ...body });
  check('重开后同标识重传只回显原结果', afterReopen.echoed === true);
  eq('回显的仍是 gen1 裁决', afterReopen.decision.newGen, 1);

  let reuseErr2 = null;
  try {
    reopened.commit({ txnId: 'fix-1', gen: 0, reads: [], writes: [{ key: 'a', value: '777' }] });
  } catch (e) { reuseErr2 = e; }
  eq('重开后异载荷重用仍拒绝', reuseErr2 && reuseErr2.code, REASON.PAYLOAD_REUSE_CONFLICT);
}

function testTornWal() {
  console.log('\n[规则] 结果落盘前中断：撕裂尾行在重开时被丢弃，已 fsync 裁决完整');
  const { dir, store } = freshStore();
  store.bootstrap({ a: '1' });
  const ok = store.commit({ txnId: 'durable', gen: 0, reads: [{ key: 'a', value: '1' }], writes: [{ key: 'a', value: '2' }] });
  eq('裁决接受', ok.decision.status, 'accepted');

  // 模拟崩溃时只写进半条 bound 记录（没有结尾换行）
  fs.appendFileSync(path.join(dir, 'wal.log'), '{"type":"bound","txnId":"ghost","paylo');
  const reopened = DrillStore.create(dir);
  eq('重开回放到已落盘代次', reopened.gen, 1);
  check('幽灵事务未进入绑定表', !reopened.bindings.has('ghost'));
  const ghost = reopened.commit({ txnId: 'ghost', gen: 1, reads: [], writes: [{ key: 'a', value: '3' }] });
  eq('幽灵事务可作为全新事务提交', ghost.decision.status, 'accepted');
}

function runRuleTests() {
  testDisjointAndWriteSkew();
  testPointRead();
  testScans();
  testRetransmitAndReopen();
  testTornWal();
}

// ---------------------------------------------------------------- 构建检查

function runBuildCheck() {
  console.log('\n[构建] node --check 全部 JavaScript 源文件');
  const roots = ['src', 'verify', 'public'];
  const files = [];
  for (const root of roots) {
    for (const ent of fs.readdirSync(path.join(__dirname, '..', root), { withFileTypes: true })) {
      if (ent.isFile() && ent.name.endsWith('.js')) files.push(path.join(__dirname, '..', root, ent.name));
    }
  }
  let allOk = true;
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
      passed++;
      console.log(`  ✔ 语法检查 ${path.relative(path.join(__dirname, '..'), f)}`);
    } catch (e) {
      failed++; allOk = false;
      console.log(`  ✗ 语法错误 ${f}: ${e.stderr ? e.stderr.toString() : e.message}`);
    }
  }
  check('所有源文件通过构建检查', allOk);
}

// ---------------------------------------------------------------- HTTP 冒烟

function request(method, urlPath, body, target) {
  const t = typeof target === 'number' ? { hostname: '127.0.0.1', port: target } : (target || {});
  const hostname = t.hostname || '127.0.0.1';
  const port = t.port;
  const payload = body ? Buffer.from(JSON.stringify(body)) : null;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname, port, path: urlPath, method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = text; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitHealthy(target, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await request('GET', '/healthz', null, target);
      if (r.status === 200) return;
    } catch { /* 尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  const t = typeof target === 'number' ? `127.0.0.1:${target}` : `${target.hostname}:${target.port}`;
  throw new Error(`目标 ${t} 上的服务未在 ${timeoutMs}ms 内就绪`);
}

function startServer(dataDir, port) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  return child;
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.on('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

async function smokeScenario(target, label) {
  const tgt = typeof target === 'number' ? { hostname: '127.0.0.1', port: target } : target;
  console.log(`\n[HTTP 冒烟 · ${label}] ${tgt.hostname || '127.0.0.1'}:${tgt.port}`);
  const h = await request('GET', '/healthz', null, tgt);
  eq(`${label} 健康响应 200`, h.status, 200);
  eq(`${label} 健康体 status`, h.body && h.body.status, 'ok');

  const page = await request('GET', '/', null, target);
  check(`${label} 首页可访问`, page.status === 200 && typeof page.body === 'string' && page.body.includes('快照裁决控制台'));

  const drillId = 'smoke-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const created = await request('POST', '/api/drills', {
    id: drillId,
    entries: { 's.1': 'v1', 's.2': 'v2', 'keep': '0' },
  }, target);
  eq(`${label} 建立演练 201`, created.status, 201);

  const base = `/api/drills/${drillId}`;

  const ok1 = await request('POST', `${base}/commit`, {
    txnId: 'e1', gen: 0,
    reads: [{ key: 's.1', value: 'v1' }],
    scans: [], writes: [{ key: 's.1', value: 'V1' }],
  }, target);
  eq(`${label} 首笔接受`, ok1.body.decision.status, 'accepted');

  const disjoint = await request('POST', `${base}/commit`, {
    txnId: 'e2', gen: 0,
    reads: [{ key: 's.2', value: 'v2' }],
    writes: [{ key: 's.2', value: 'V2' }],
  }, target);
  eq(`${label} 互不相交提交成功`, disjoint.body.decision.status, 'accepted');

  const pc = await request('POST', `${base}/commit`, {
    txnId: 'e3', gen: 0,
    reads: [{ key: 's.1', value: 'v1' }], writes: [{ key: 'keep', value: '1' }],
  }, target);
  eq(`${label} 点读冲突拒绝`, pc.body.decision.reason, REASON.POINT_READ_CONFLICT);
  eq(`${label} 拒绝仍以 200 返回冻结终局`, pc.status, 200);

  const ph = await request('POST', `${base}/commit`, {
    txnId: 'e4', gen: 0,
    scans: [{ prefix: 's.', keys: ['s.1', 's.2'] }], writes: [],
  }, target);
  eq(`${label} 幻读拒绝`, ph.body.decision.reason, REASON.PHANTOM_READ);

  const echo = await request('POST', `${base}/commit`, {
    txnId: 'e1', gen: 0,
    reads: [{ key: 's.1', value: 'v1' }], scans: [], writes: [{ key: 's.1', value: 'V1' }],
  }, target);
  check(`${label} 重传回显 echoed=true`, echo.body.echoed === true);
  eq(`${label} 回显原终局`, echo.body.decision.newGen, 1);

  const reuse = await request('POST', `${base}/commit`, {
    txnId: 'e1', gen: 0, reads: [{ key: 's.1', value: 'v1' }], writes: [{ key: 's.1', value: 'HACK' }],
  }, target);
  eq(`${label} 异载荷重用 409`, reuse.status, 409);
  eq(`${label} 异载荷稳定原因`, reuse.body.error.code, REASON.PAYLOAD_REUSE_CONFLICT);

  const state = await request('GET', `${base}/state`, null, target);
  eq(`${label} 当前代次为 2`, state.body.gen, 2);
  // 4 个不同标识各冻结一笔终局；e1 的重传与异载荷重用都不得新增终局
  eq(`${label} 终局数量恰为 4（重传不复制终局）`, state.body.transactions.length, 4);
  const acceptedTxn = state.body.transactions.find((t) => t.txnId === 'e1');
  check(`${label} 已接受结果含写入与读/扫描摘要`,
    acceptedTxn.writes.length === 1 && acceptedTxn.readSummary.points.length === 1);

  return { drillId };
}

async function localRestartTest(dataDir, port, drillId) {
  console.log(`\n[HTTP 冒烟 · 杀进程重开] 复用数据目录 ${dataDir}`);
  // 服务此前已被 SIGKILL：重启后重传同一标识必须回显原结果
  const child2 = startServer(dataDir, port);
  await waitHealthy(port);
  try {
    const base = `/api/drills/${drillId}`;
    const state = await request('GET', `${base}/state`, null, port);
    eq('重开后当前代次仍为 2', state.body.gen, 2);
    eq('重开后写入值已冻结', state.body.entries['s.1'], 'V1');

    const echo = await request('POST', `${base}/commit`, {
      txnId: 'e1', gen: 0,
      reads: [{ key: 's.1', value: 'v1' }], scans: [], writes: [{ key: 's.1', value: 'V1' }],
    }, port);
    check('重开后重传同一标识 → echoed', echo.body.echoed === true);
    eq('回显原始 gen1 裁决', echo.body.decision.newGen, 1);

    const reuse = await request('POST', `${base}/commit`, {
      txnId: 'e1', gen: 0, reads: [], writes: [{ key: 'keep', value: 'x' }],
    }, port);
    eq('重开后异载荷重用仍拒绝', reuse.body.error.code, REASON.PAYLOAD_REUSE_CONFLICT);

    // 重开后新事务可在最新代次继续推进
    const next = await request('POST', `${base}/commit`, {
      txnId: 'after-restart', gen: 2,
      reads: [{ key: 'keep', value: '0' }], writes: [{ key: 'keep', value: '1' }],
    }, port);
    eq('重开后新事务接受并推进代次', next.body.decision.newGen, 3);
  } finally {
    await stopServer(child2);
  }
}

async function main() {
  console.log('=== 地面标定库 · 验收（规则测试 + 构建检查 + API/HTTP 冒烟）===');

  runRuleTests();
  runBuildCheck();

  // 编排内：先对 app 服务跨容器冒烟
  if (process.env.BASE_URL) {
    console.log(`\n[HTTP 冒烟 · 编排 app 服务] ${process.env.BASE_URL}`);
    const u = new URL(process.env.BASE_URL);
    const target = { hostname: u.hostname, port: Number(u.port || 80) };
    await waitHealthy(target);
    await smokeScenario(target, 'compose-app');
  }

  // 本地真实 HTTP 子进程 + 杀进程重开（验证持久化裁决）
  const dataDir = tempDir();
  const port = 40000 + Math.floor(Math.random() * 8000);
  const child = startServer(dataDir, port);
  let drillId;
  try {
    await waitHealthy(port);
    ({ drillId } = await smokeScenario(port, 'local-child'));
  } finally {
    await stopServer(child);
  }
  await localRestartTest(dataDir, port, drillId);

  console.log(`\n=== 验收结果：通过 ${passed} 项，失败 ${failed} 项 ===`);
  if (failed) {
    for (const f of failures) console.log('  FAIL: ' + f);
    process.exit(1);
  }
  console.log('验收通过（退出码 0）');
  process.exit(0);
}

main().catch((e) => {
  console.error('验收执行异常：', e);
  process.exit(1);
});
