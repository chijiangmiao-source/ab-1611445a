'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 拒绝原因（稳定代码，前后端共用语义）
const REASON = Object.freeze({
  UNKNOWN_GENERATION: 'UNKNOWN_GENERATION',
  POINT_READ_CONFLICT: 'POINT_READ_CONFLICT',
  SCAN_SNAPSHOT_MISMATCH: 'SCAN_SNAPSHOT_MISMATCH',
  READ_SNAPSHOT_MISMATCH: 'READ_SNAPSHOT_MISMATCH',
  PHANTOM_READ: 'PHANTOM_READ',
  PAYLOAD_REUSE_CONFLICT: 'PAYLOAD_REUSE_CONFLICT',
});

/** 稳定序列化：对象键排序，保证“首次规范载荷”与字节序无关 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function normalizeCommitPayload(body) {
  if (!body || typeof body !== 'object') throw httpError(400, 'INVALID_PAYLOAD', '请求体必须是对象');
  const gen = Number.isInteger(body.gen) ? body.gen : Number(body.gen);
  if (!Number.isInteger(gen) || gen < 0) throw httpError(400, 'INVALID_PAYLOAD', 'gen 必须是非负整数');

  const normKV = (row, listName) => {
    if (!row || typeof row !== 'object' || typeof row.key !== 'string' || row.key.length === 0) {
      throw httpError(400, 'INVALID_PAYLOAD', `${listName} 中每项必须含非空字符串 key`);
    }
    if (row.value !== null && typeof row.value !== 'string') {
      throw httpError(400, 'INVALID_PAYLOAD', `${listName} 中 ${row.key} 的 value 必须是字符串或 null`);
    }
    return { key: row.key, value: row.value };
  };

  const reads = Array.isArray(body.reads) ? body.reads.map((r) => normKV(r, 'reads')) : [];
  const writes = Array.isArray(body.writes) ? body.writes.map((w) => normKV(w, 'writes')) : [];
  const scans = [];
  if (body.scans) {
    if (!Array.isArray(body.scans)) throw httpError(400, 'INVALID_PAYLOAD', 'scans 必须是数组');
    for (const s of body.scans) {
      if (!s || typeof s.prefix !== 'string') {
        throw httpError(400, 'INVALID_PAYLOAD', 'scans 中每项必须含字符串 prefix');
      }
      const keys = Array.isArray(s.keys) ? s.keys : [];
      if (!keys.every((k) => typeof k === 'string')) {
        throw httpError(400, 'INVALID_PAYLOAD', `scans 中前缀 ${s.prefix} 的 keys 必须全为字符串`);
      }
      scans.push({ prefix: s.prefix, keys: [...keys].sort() });
    }
  }
  return { gen, reads, scans, writes };
}

function httpError(status, code, message) {
  const err = new Error(message || code);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * 单个演练（标定库）的存储引擎。
 *
 * 持久化布局：
 *   <dir>/wal.log  仅追加裁决日志，一行一条 JSON 记录：
 *     {type:'bootstrap', entries, ts}
 *     {type:'bound', txnId, payload, ts}              事务与首次规范载荷绑定（先于校验落盘）
 *     {type:'decision', decision, ts}                 终局裁决（接受/拒绝），单条 fsync
 *
 * history: key -> [{gen, value}]，value=null 表示该代次删除（墓碑保留在不可变历史中）。
 */
class DrillStore {
  constructor(dir) {
    this.dir = dir;
    this.walPath = path.join(dir, 'wal.log');
    this.gen = 0;
    this.bootstrapped = false;
    /** @type {Map<string, {gen:number, value: string|null}[]>} */
    this.history = new Map();
    /** @type {Map<string, string>} txnId -> 首次规范载荷 */
    this.bindings = new Map();
    /** @type {Map<string, object>} txnId -> 终局裁决 */
    this.decisions = new Map();
    this.fd = null;
  }

  static create(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const store = new DrillStore(dir);
    store.replay();
    return store;
  }

  // ---------- 持久化原语 ----------

  replay() {
    if (!fs.existsSync(this.walPath)) {
      this.fd = fs.openSync(this.walPath, 'a');
      return;
    }
    const raw = fs.readFileSync(this.walPath);
    const text = raw.toString('utf8');
    let goodOffset = 0;
    let lineStart = 0;
    let lineIndex = 0;
    while (lineStart < text.length) {
      let lineEnd = text.indexOf('\n', lineStart);
      if (lineEnd === -1) break; // 末尾不完整行（崩溃撕裂）一律丢弃
      const line = text.slice(lineStart, lineEnd);
      try {
        const rec = JSON.parse(line);
        this.applyRecord(rec);
      } catch (e) {
        // 撕裂/损坏行：丢弃该行及之后所有内容，截断到已确认前缀
        break;
      }
      goodOffset = lineEnd + 1;
      lineStart = lineEnd + 1;
      lineIndex++;
    }
    if (goodOffset !== text.length) {
      const fdTmp = fs.openSync(this.walPath, 'r+');
      fs.ftruncateSync(fdTmp, goodOffset);
      fs.fsyncSync(fdTmp);
      fs.closeSync(fdTmp);
    }
    this.fd = fs.openSync(this.walPath, 'a');
  }

  appendRecord(rec) {
    const line = JSON.stringify(rec) + '\n';
    fs.writeSync(this.fd, line);
    fs.fsyncSync(this.fd); // 裁决返回前必须落盘
  }

  applyRecord(rec) {
    if (rec.type === 'bootstrap') {
      this.bootstrapped = true;
      this.gen = 0;
      for (const [key, value] of Object.entries(rec.entries || {})) {
        this.history.set(key, [{ gen: 0, value: String(value) }]);
      }
    } else if (rec.type === 'bound') {
      this.bindings.set(rec.txnId, rec.payload);
    } else if (rec.type === 'decision') {
      const d = rec.decision;
      this.decisions.set(d.txnId, d);
      if (d.status === 'accepted') {
        this.gen = d.newGen;
        for (const w of d.writes) {
          const versions = this.history.get(w.key) || [];
          versions.push({ gen: d.newGen, value: w.value });
          this.history.set(w.key, versions);
        }
      }
    }
  }

  // ---------- 版本历史查询 ----------

  /** 键在指定代次的值；不存在为 null */
  valueAt(key, gen) {
    const versions = this.history.get(key);
    if (!versions) return null;
    let result = null;
    for (const v of versions) {
      if (v.gen <= gen) result = v.value;
      else break;
    }
    return result;
  }

  /** 键在指定代次是否存活（有值且未被删除） */
  existsAt(key, gen) {
    return this.valueAt(key, gen) !== null;
  }

  liveEntriesAt(gen) {
    const out = {};
    for (const key of [...this.history.keys()].sort()) {
      const value = this.valueAt(key, gen);
      if (value !== null) out[key] = value;
    }
    return out;
  }

  scanAt(prefix, gen) {
    const out = [];
    for (const key of [...this.history.keys()].sort()) {
      if (key.startsWith(prefix)) {
        const value = this.valueAt(key, gen);
        if (value !== null) out.push({ key, value });
      }
    }
    return out;
  }

  // ---------- 业务操作 ----------

  bootstrap(entriesRaw) {
    if (this.bootstrapped) throw httpError(409, 'DRILL_EXISTS', '演练已初始化，初始键值不可重写');
    const entries = {};
    if (entriesRaw && typeof entriesRaw === 'object') {
      for (const [k, v] of Object.entries(entriesRaw)) {
        if (typeof k !== 'string' || k.length === 0) throw httpError(400, 'INVALID_PAYLOAD', '初始键必须是非空字符串');
        if (typeof v !== 'string') throw httpError(400, 'INVALID_PAYLOAD', `初始键 ${k} 的值必须是字符串`);
        entries[k] = v;
      }
    }
    // 初始键值即第 0 代不可变版本
    this.appendRecord({ type: 'bootstrap', ts: Date.now(), entries });
    this.applyRecord({ type: 'bootstrap', entries });
    return { gen: 0, entries };
  }

  snapshot() {
    return {
      gen: this.gen,
      bootstrapped: this.bootstrapped,
      entries: this.liveEntriesAt(this.gen),
    };
  }

  listTransactions() {
    return [...this.decisions.values()];
  }

  /**
   * 提交易事裁决。同步执行：bind → 校验 → 裁决，全程不释放事件循环，
   * 与 appendRecord 的单次 write+fsync 一起保证“同一持久化裁决”原子可见。
   */
  commit(body) {
    if (!this.bootstrapped) throw httpError(409, 'DRILL_NOT_INITIALIZED', '演练尚未用初始键值初始化');

    const txnId = typeof body.txnId === 'string' && body.txnId.length > 0 ? body.txnId : null;
    if (!txnId) throw httpError(400, 'INVALID_PAYLOAD', 'txnId 必须是非空字符串（稳定事务标识）');

    const payload = normalizeCommitPayload(body);
    const canonical = stableStringify(payload);

    // 1) 与首次规范载荷绑定 / 幂等回显 / 异载荷重用拒绝
    const boundPayload = this.bindings.get(txnId);
    if (boundPayload !== undefined) {
      if (boundPayload !== canonical) {
        const err = httpError(409, REASON.PAYLOAD_REUSE_CONFLICT,
          `事务 ${txnId} 已绑定不同的首次规范载荷，禁止异载荷重用`);
        err.evidence = { txnId, boundPayloadHash: this.hash(boundPayload), requestPayloadHash: this.hash(canonical) };
        throw err;
      }
      const prior = this.decisions.get(txnId);
      if (prior) return { echoed: true, decision: prior };
      // 仅有 bound 记录而无裁决（上次在落盘裁决前中断）：同载荷允许继续完成裁决
    } else {
      this.appendRecord({ type: 'bound', txnId, payload: canonical, ts: Date.now() });
      this.bindings.set(txnId, canonical);
    }

    // 2) 依据不可变版本历史做快照校验
    const { gen, reads, scans, writes } = payload;
    if (gen > this.gen) {
      return this.freezeRejection(txnId, payload, REASON.UNKNOWN_GENERATION,
        `快照代次 ${gen} 晚于当前代次 ${this.gen}`, { gen, currentGen: this.gen });
    }

    // 2a) 点读：先证快照自洽，再证快照后未被改写（新增/删除/修改均算冲突）
    for (const r of reads) {
      const snapshotValue = this.valueAt(r.key, gen);
      if (snapshotValue !== r.value) {
        return this.freezeRejection(txnId, payload, REASON.READ_SNAPSHOT_MISMATCH,
          `点读 ${r.key} 声称的值与快照代次 ${gen} 不符`,
          { key: r.key, claimedValue: r.value, snapshotValue, gen });
      }
      const currentValue = this.valueAt(r.key, this.gen);
      if (currentValue !== snapshotValue) {
        return this.freezeRejection(txnId, payload, REASON.POINT_READ_CONFLICT,
          `点读 ${r.key} 在快照代次 ${gen} 之后被改写`,
          { key: r.key, snapshotGen: gen, snapshotValue, currentGen: this.gen, currentValue });
      }
    }

    // 2b) 前缀扫描：快照证据必须自洽，且前缀内不得有新增/删除/改写（幻读）
    for (const s of scans) {
      const snapshotRows = this.scanAt(s.prefix, gen);
      const snapshotKeys = snapshotRows.map((r) => r.key);
      if (stableStringify(snapshotKeys) !== stableStringify(s.keys)) {
        return this.freezeRejection(txnId, payload, REASON.SCAN_SNAPSHOT_MISMATCH,
          `前缀 ${s.prefix} 声称的扫描结果与快照代次 ${gen} 不符`,
          { prefix: s.prefix, claimedKeys: s.keys, snapshotKeys, gen });
      }
      const currentRows = this.scanAt(s.prefix, this.gen);
      const currentMap = new Map(currentRows.map((r) => [r.key, r.value]));
      const snapshotMap = new Map(snapshotRows.map((r) => [r.key, r.value]));
      for (const key of s.keys) {
        if (!currentMap.has(key)) {
          return this.phantom(txnId, payload, s.prefix, gen, 'deleted', key, snapshotMap.get(key), null);
        }
        if (currentMap.get(key) !== snapshotMap.get(key)) {
          return this.phantom(txnId, payload, s.prefix, gen, 'modified', key, snapshotMap.get(key), currentMap.get(key));
        }
      }
      for (const [key, value] of currentMap) {
        if (!snapshotMap.has(key)) {
          return this.phantom(txnId, payload, s.prefix, gen, 'new', key, null, value);
        }
      }
    }

    // 3) 接受：在同一裁决记录中冻结新代次、写入与读/扫描摘要
    const newGen = this.gen + 1;
    const decision = {
      txnId,
      status: 'accepted',
      reason: null,
      evidence: null,
      gen,
      newGen,
      writes,
      readSummary: { points: reads.map((r) => ({ key: r.key, value: r.value })) },
      scanSummary: scans.map((s) => ({ prefix: s.prefix, keys: this.scanAt(s.prefix, gen) })),
      committedAt: new Date().toISOString(),
    };
    this.appendRecord({ type: 'decision', decision, ts: Date.now() });
    this.applyRecord({ type: 'decision', decision });
    return { echoed: false, decision };
  }

  phantom(txnId, payload, prefix, gen, kind, key, snapshotValue, currentValue) {
    const label = { new: '新增', deleted: '删除', modified: '改写' }[kind];
    return this.freezeRejection(txnId, payload, REASON.PHANTOM_READ,
      `前缀 ${prefix} 内的键 ${key} 在快照代次 ${gen} 之后被${label}`,
      { prefix, kind, key, snapshotGen: gen, snapshotValue, currentGen: this.gen, currentValue });
  }

  freezeRejection(txnId, payload, reason, message, evidence) {
    const decision = {
      txnId,
      status: 'rejected',
      reason,
      message,
      evidence,
      gen: payload.gen,
      newGen: this.gen, // 拒绝不推进代次
      writes: [],
      readSummary: { points: payload.reads.map((r) => ({ key: r.key, value: r.value })) },
      scanSummary: payload.scans.map((s) => ({
        prefix: s.prefix,
        keys: s.keys.map((key) => ({ key, value: this.valueAt(key, payload.gen) })),
      })),
      committedAt: new Date().toISOString(),
    };
    this.appendRecord({ type: 'decision', decision, ts: Date.now() });
    this.applyRecord({ type: 'decision', decision });
    return { echoed: false, decision };
  }

  hash(text) {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  }
}

/** 管理多个演练存储，每个演练一个独立目录与 WAL */
class DrillManager {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    /** @type {Map<string, DrillStore>} */
    this.stores = new Map();
    for (const id of fs.readdirSync(dataDir)) {
      const wal = path.join(dataDir, id, 'wal.log');
      if (fs.statSync(path.join(dataDir, id)).isDirectory() && fs.existsSync(wal)) {
        this.stores.set(id, DrillStore.create(path.join(dataDir, id)));
      }
    }
  }

  static newDrillId() {
    return 'drill-' + crypto.randomBytes(5).toString('hex');
  }

  list() {
    return [...this.stores.values()]
      .filter((s) => s.bootstrapped)
      .map((s) => ({ id: path.basename(s.dir), gen: s.gen, keyCount: Object.keys(s.liveEntriesAt(s.gen)).length }));
  }

  create(idRaw, entries) {
    const id = idRaw || DrillManager.newDrillId();
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) {
      throw httpError(400, 'INVALID_PAYLOAD', '演练 id 仅允许字母数字及 _.- 且以字母数字开头（1-64 字符）');
    }
    if (this.stores.has(id)) throw httpError(409, 'DRILL_EXISTS', `演练 ${id} 已存在`);
    const dir = path.join(this.dataDir, id);
    const store = DrillStore.create(dir);
    store.bootstrap(entries);
    this.stores.set(id, store);
    return id;
  }

  get(id) {
    const store = this.stores.get(id);
    if (!store) throw httpError(404, 'DRILL_NOT_FOUND', `演练 ${id} 不存在`);
    return store;
  }
}

module.exports = { DrillStore, DrillManager, REASON, stableStringify, normalizeCommitPayload };
