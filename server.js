'use strict';
// Dashboard server. Zero dependencies: node:http only.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const C = require('./lib/config');
const pool = require('./lib/pool');
const lane = require('./lib/lane');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const clients = new Set();
let running = false;
let lastRun = null;

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  fs.appendFileSync(C.logFile, line);
  broadcast({ type: 'log', message });
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function body(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
  });
}

function state() {
  const s = C.settings();
  const bad = pool.readBad();
  return {
    pool: pool.readPool().map((e) => ({
      tag: e.tag,
      address: e.settings.vnext[0].address,
      port: e.settings.vnext[0].port,
      network: e.streamSettings.network,
      security: e.streamSettings.security,
      parked: bad.has(e.tag),
    })),
    ageHours: pool.poolAgeHours(),
    anonymous: !lane.hasCredential(),
    running,
    lastRun,
    settings: {
      model: s.model, poolTarget: s.poolTarget, poolTtlHours: s.poolTtlHours,
      proxyPort: s.proxyPort, subs: s.subs, cliPath: s.cliPath,
    },
  };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (p === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/api/state') return json(res, 200, state());

  if (p === '/api/refresh' && req.method === 'POST') {
    if (running) return json(res, 409, { error: 'a run is in progress' });
    pool.refresh(C.settings(), log)
      .then((exits) => { log(`refresh done: ${exits.length} exits`); broadcast({ type: 'state' }); })
      .catch((e) => log(`refresh failed: ${e.message}`));
    return json(res, 202, { started: true });
  }

  if (p === '/api/run' && req.method === 'POST') {
    if (running) return json(res, 409, { error: 'already running' });
    const { prompt } = await body(req);
    if (!prompt || !prompt.trim()) return json(res, 400, { error: 'prompt required' });
    running = true;
    broadcast({ type: 'state' });
    log(`run: ${prompt.slice(0, 120)}`);
    lane.run(prompt, C.settings(), (ev) => {
      if (ev.type === 'log') log(ev.message);
      else broadcast(ev);
    })
      .then((r) => {
        lastRun = { ok: r.ok, text: r.text, exit: r.exit, attempts: r.attempts, at: Date.now() };
        broadcast({ type: 'done', ...lastRun });
        log(r.ok ? `done via ${r.exit} (attempt ${r.attempts})` : `failed: ${r.text}`);
      })
      .catch((e) => {
        lastRun = { ok: false, text: e.message, exit: '-', attempts: 0, at: Date.now() };
        broadcast({ type: 'done', ...lastRun });
        log(`failed: ${e.message}`);
      })
      .finally(() => { running = false; broadcast({ type: 'state' }); });
    return json(res, 202, { started: true });
  }

  if (p === '/api/park' && req.method === 'POST') {
    const { tag, parked } = await body(req);
    if (parked) pool.park(tag); else pool.unpark(tag);
    broadcast({ type: 'state' });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/settings' && req.method === 'POST') {
    const patch = await body(req);
    if (typeof patch.subs === 'string') patch.subs = patch.subs.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    for (const k of ['poolTarget', 'poolTtlHours', 'proxyPort']) {
      if (patch[k] !== undefined) patch[k] = Number(patch[k]);
    }
    C.saveSettings(patch);
    broadcast({ type: 'state' });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/log') {
    let tail = '';
    try { tail = fs.readFileSync(C.logFile, 'utf8').split('\n').slice(-200).join('\n'); } catch { /* none */ }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(tail);
  }

  // static
  const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const file = path.join(C.PUBLIC, rel);
  if (file.startsWith(C.PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

C.ensureDirs();
const s = C.settings();
http.createServer((req, res) => {
  handle(req, res).catch((e) => json(res, 500, { error: e.message }));
}).listen(s.port, '127.0.0.1', () => {
  console.log(`router-win dashboard: http://127.0.0.1:${s.port}`);
  console.log(`pool: ${pool.readPool().length} exits, age ${pool.poolAgeHours().toFixed(1)} h`);
});
