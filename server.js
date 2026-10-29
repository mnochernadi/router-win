'use strict';
// Dashboard server. Zero dependencies: node:http only.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const C = require('./lib/config');
const pool = require('./lib/pool');
const lane = require('./lib/lane');
const models = require('./lib/models');

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
    endpoint: `http://127.0.0.1:` + s.port + '/v1',
    apiKey: s.apiKey,
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

  // Bearer check for the API surface. The dashboard itself stays open on loopback.
  if (p.startsWith('/v1/') || p === '/chat/completions') {
    const key = C.settings().apiKey;
    const sent = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (key && sent !== key) {
      return json(res, 401, { error: { message: 'invalid api key', type: 'invalid_request_error' } });
    }
  }
  // ---- OpenAI-compatible surface -------------------------------------------
  if (p === '/v1/models' && req.method === 'GET') {
    try {
      const data = await models.list();
      return json(res, 200, { object: 'list', data });
    } catch (e) {
      return json(res, 502, { error: { message: e.message, type: 'catalog_error' } });
    }
  }

  if ((p === '/v1/chat/completions' || p === '/chat/completions') && req.method === 'POST') {
    const reqBody = await body(req);
    const msgs = Array.isArray(reqBody.messages) ? reqBody.messages : [];
    const prompt = msgs.filter((m) => m.role === 'user').map((m) => m.content).pop();
    if (!prompt) {
      return json(res, 400, { error: { message: 'messages with a user turn required', type: 'invalid_request_error' } });
    }
    if (running) {
      return json(res, 429, { error: { message: 'a run is already in progress', type: 'rate_limit_error' } });
    }

    const s = C.settings();
    let ids = [];
    try { ids = await models.load(); } catch { /* catalog optional */ }
    const wanted = reqBody.model ? models.known(ids, reqBody.model) : null;
    if (reqBody.model && ids.length && !wanted) {
      return json(res, 404, { error: { message: `unknown model: ${reqBody.model}`, type: 'invalid_request_error' } });
    }
    const settings = wanted ? { ...s, model: `opencode/${wanted}` } : s;

    const id = `chatcmpl-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    const modelName = wanted || settings.model.replace(/^[^/]+\//, '');
    const stream = Boolean(reqBody.stream);

    running = true;
    broadcast({ type: 'state' });
    log(`api run: ${modelName} :: ${String(prompt).slice(0, 100)}`);

    if (stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const chunk = (delta, finish = null) => send({
        id, object: 'chat.completion.chunk', created, model: modelName,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      chunk({ role: 'assistant', content: '' });
      try {
        const r = await lane.run(prompt, settings, (ev) => {
          if (ev.type === 'data') {
            const t = lane.clean(ev.text).replace(/^[ \t]*>?[ \t]*build.*$/gm, '');
            if (t.trim()) chunk({ content: t });
          }
          else if (ev.type === 'log') log(ev.message);
        });
        chunk({}, 'stop');
        res.write('data: [DONE]\n\n');
        log(r.ok ? `api done via ${r.exit}` : `api failed: ${r.text}`);
      } catch (e) {
        chunk({ content: `\n[error] ${e.message}` }, 'stop');
        res.write('data: [DONE]\n\n');
      } finally {
        running = false;
        broadcast({ type: 'state' });
        res.end();
      }
      return;
    }

    try {
      const r = await lane.run(prompt, settings, (ev) => { if (ev.type === 'log') log(ev.message); });
      lastRun = { ok: r.ok, text: r.text, exit: r.exit, attempts: r.attempts, at: Date.now() };
      broadcast({ type: 'done', ...lastRun });
      if (!r.ok) {
        return json(res, 502, { error: { message: r.text, type: 'upstream_error', exit: r.exit } });
      }
      return json(res, 200, {
        id, object: 'chat.completion', created, model: modelName,
        choices: [{ index: 0, message: { role: 'assistant', content: r.text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        'x-router-exit': r.exit,
        'x-router-attempts': r.attempts,
      });
    } catch (e) {
      return json(res, 502, { error: { message: e.message, type: 'upstream_error' } });
    } finally {
      running = false;
      broadcast({ type: 'state' });
    }
  }

  // ---- dashboard actions ---------------------------------------------------
  if (p === '/api/subs' && req.method === 'POST') {
    if (running) return json(res, 409, { error: 'a run is in progress' });
    log('updating subscriptions');
    pool.fetchSubs(C.settings().subs)
      .then((links) => { log(`subscriptions updated: ${links.length} links`); broadcast({ type: 'state' }); })
      .catch((e) => log(`subscription update failed: ${e.message}`));
    return json(res, 202, { started: true });
  }

  if (p === '/api/test' && req.method === 'POST') {
    if (running) return json(res, 409, { error: 'a run is in progress' });
    const s = C.settings();
    log(`testing exits, target ${s.poolTarget}`);
    pool.refresh(s, log)
      .then((exits) => {
        log(`test done: ${exits.length} working exits in the pool`);
        broadcast({ type: 'state' });
      })
      .catch((e) => log(`test failed: ${e.message}`));
    return json(res, 202, { started: true });
  }

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
    if (Array.isArray(patch.subs) && !patch.subs.length) delete patch.subs; // never wipe the list
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
