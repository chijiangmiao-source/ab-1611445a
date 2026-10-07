'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { DrillManager } = require('./store');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

const manager = new DrillManager(DATA_DIR);

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(buf),
  });
  res.end(buf);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1 << 20) {
        reject(Object.assign(new Error('请求体超过 1MiB'), { status: 413, code: 'PAYLOAD_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400, code: 'INVALID_JSON' }));
      }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(__dirname, '..', 'public', rel));
  const root = path.normalize(path.join(__dirname, '..', 'public'));
  if (!file.startsWith(root + path.sep) && file !== root) {
    return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: '禁止访问' } });
  }
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '页面不存在' } });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/healthz' || p === '/health')) {
      return sendJson(res, 200, { status: 'ok', service: 'calibration-snapshot-store', gen: 'v1', time: new Date().toISOString() });
    }

    const drillsPrefix = '/api/drills';
    if (p === drillsPrefix && req.method === 'GET') {
      return sendJson(res, 200, { drills: manager.list() });
    }
    if (p === drillsPrefix && req.method === 'POST') {
      const body = await readJson(req);
      const id = manager.create(body.id, body.entries);
      const store = manager.get(id);
      return sendJson(res, 201, { id, ...store.snapshot() });
    }

    const m = p.match(new RegExp('^' + drillsPrefix + '/([^/]+)(/([^/]+))?/?$'));
    if (m && req.method === 'GET') {
      const store = manager.get(decodeURIComponent(m[1]));
      if (!m[3] || m[3] === 'state') {
        return sendJson(res, 200, {
          id: decodeURIComponent(m[1]),
          ...store.snapshot(),
          transactions: store.listTransactions().map((d) => ({
            txnId: d.txnId,
            status: d.status,
            reason: d.reason,
            message: d.message,
            gen: d.gen,
            newGen: d.newGen,
            evidence: d.evidence,
            writes: d.writes,
            readSummary: d.readSummary,
            scanSummary: d.scanSummary,
            committedAt: d.committedAt,
          })),
        });
      }
      if (m[3] === 'snapshot') {
        return sendJson(res, 200, { id: decodeURIComponent(m[1]), ...store.snapshot() });
      }
      if (m[3] === 'transactions') {
        return sendJson(res, 200, { transactions: store.listTransactions() });
      }
    }
    if (m && m[3] === 'commit' && req.method === 'POST') {
      const body = await readJson(req);
      const result = manager.get(decodeURIComponent(m[1])).commit(body);
      // 拒绝仍是“已持久化的终局”，以 200 返回完整裁决；载荷绑定冲突返回 409
      return sendJson(res, 200, { echoed: result.echoed, decision: result.decision });
    }

    if (req.method === 'GET') return serveStatic(res, p);
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `未知路由 ${req.method} ${p}` } });
  } catch (err) {
    const status = err.status || 500;
    sendJson(res, status, {
      error: { code: err.code || 'INTERNAL', message: err.message || '内部错误', evidence: err.evidence || undefined },
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[calibration-store] 监听 http://${HOST}:${PORT}  数据目录=${DATA_DIR}`);
});

module.exports = { server, manager };
