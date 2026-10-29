'use strict';
// Exit pool: fetch the subscriptions, parse the (malformed) vless URIs, probe each
// candidate through the bundled xray, keep the ones that carry traffic.

const fs = require('node:fs');
const { spawn, execFile } = require('node:child_process');
const C = require('./config');

const KEYS = ['fp', 'security', 'type', 'sni', 'host', 'alpn', 'flow'];
const NO_WINDOW = 0x08000000;

function readPool() {
  try { return JSON.parse(fs.readFileSync(C.poolFile, 'utf8')); } catch { return []; }
}
function writePool(p) { fs.writeFileSync(C.poolFile, JSON.stringify(p, null, 2)); }
function readBad() {
  try { return new Set(JSON.parse(fs.readFileSync(C.badFile, 'utf8'))); } catch { return new Set(); }
}
function writeBad(s) { fs.writeFileSync(C.badFile, JSON.stringify([...s].sort(), null, 2)); }
function park(tag) { const b = readBad(); b.add(tag); writeBad(b); }
function unpark(tag) { const b = readBad(); b.delete(tag); writeBad(b); }

function poolAgeHours() {
  try {
    const t = Number(fs.readFileSync(C.metaFile, 'utf8').trim());
    return (Date.now() / 1000 - t) / 3600;
  } catch { return Infinity; }
}

// The subscription glues the following keys onto `path` ("path=/fp=chrome&security=tls").
// Split the real path out before anything else.
function splitPath(raw, q) {
  let real = raw || '/';
  for (const k of KEYS) {
    const at = real.indexOf(k + '=');
    if (at > 0) {
      const tail = real.slice(at);
      real = real.slice(0, at);
      for (const part of tail.split(new RegExp(`(?=${KEYS.join('|')}=)`))) {
        const eq = part.indexOf('=');
        if (eq > 0) {
          const kk = part.slice(0, eq);
          if (KEYS.includes(kk) && !q.has(kk)) q.set(kk, part.slice(eq + 1));
        }
      }
      break;
    }
  }
  return real || '/';
}

function parse(link, tag) {
  let u;
  try { u = new URL(link); } catch { return null; }
  const q = u.searchParams;
  const g = (k, d = '') => q.get(k) || d;

  const real = splitPath(g('path', '/'), q);
  const host = (u.hostname || '').replace(/\.$/, '');
  if (!host || !u.port) return null;
  const sec = g('security');
  const net = g('type', 'tcp');
  if (!['tls', 'reality'].includes(sec) || !['ws', 'xhttp', 'grpc'].includes(net)) return null;

  const sni = (g('sni') || g('host') || host).replace(/\.$/, '');
  const wsHost = (g('host') || sni).replace(/\.$/, '');

  const out = {
    protocol: 'vless',
    tag,
    settings: {
      vnext: [{
        address: host,
        port: Number(u.port),
        users: [{ id: decodeURIComponent(u.username), encryption: g('encryption', 'none') || 'none' }],
      }],
    },
  };
  const ss = { network: net };
  if (sec === 'tls') {
    ss.security = 'tls';
    ss.tlsSettings = { serverName: sni, fingerprint: g('fp') || 'chrome' };
    if (g('alpn')) ss.tlsSettings.alpn = g('alpn').split(',');
  } else {
    ss.security = 'reality';
    ss.realitySettings = {
      serverName: sni, fingerprint: g('fp') || 'chrome',
      publicKey: g('pbk'), shortId: g('sid'), spiderX: g('spx', '/') || '/',
    };
  }
  if (net === 'ws') ss.wsSettings = { path: real, host: wsHost };
  else if (net === 'xhttp') ss.xhttpSettings = { path: real, host: wsHost, mode: g('mode', 'auto') || 'auto' };
  else ss.grpcSettings = { serviceName: g('serviceName') || real.replace(/^\/|\/$/g, '') };

  out.streamSettings = ss;
  return out;
}

async function fetchSubs(subs) {
  const links = [];
  for (let i = 0; i < subs.length; i++) {
    let raw;
    try {
      const r = await fetch(subs[i], { headers: { 'user-agent': 'curl/8' }, signal: AbortSignal.timeout(40000) });
      raw = await r.text();
    } catch (e) {
      console.log(`sub ${i + 1} fetch failed: ${e.message}`);
      continue;
    }
    fs.writeFileSync(`${C.RUNTIME}/subs/sub${i + 1}.txt`, raw);
    if (!raw.includes('://')) {
      try { raw = Buffer.from(raw.replace(/\s/g, ''), 'base64').toString('utf8'); } catch { /* keep */ }
    }
    const got = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('vless://'));
    console.log(`sub ${i + 1}: ${got.length} links`);
    links.push(...got);
  }
  return links;
}

function probe(exit, port) {
  return new Promise((resolve) => {
    const cfg = {
      log: { loglevel: 'warning' },
      inbounds: [{ listen: '127.0.0.1', port, protocol: 'http' }],
      outbounds: [exit],
    };
    const cfgFile = `${C.RUNTIME}/probe-${port}.json`;
    fs.writeFileSync(cfgFile, JSON.stringify(cfg));
    const x = spawn(C.xrayExe, ['run', '-c', cfgFile], { windowsHide: true, stdio: 'ignore' });
    const done = (ok) => {
      try { x.kill(); } catch { /* gone */ }
      try { fs.unlinkSync(cfgFile); } catch { /* gone */ }
      resolve(ok);
    };
    setTimeout(() => {
      execFile('curl.exe', ['-s', '-m', '9', '-x', `http://127.0.0.1:${port}`, 'https://api.ipify.org'],
        { windowsHide: true, timeout: 12000 }, (err, stdout) => {
          done(!err && /^\d+\.\d+\.\d+\.\d+/.test((stdout || '').trim()));
        });
    }, 1300);
  });
}

async function refresh(settings, onLog = console.log) {
  const s = settings || C.settings();
  onLog('refreshing pool from the subscriptions');
  const links = await fetchSubs(s.subs);
  const seen = new Set();
  const cands = [];
  for (const l of links) {
    const o = parse(l, 'tmp');
    if (!o) continue;
    const v = o.settings.vnext[0];
    const k = `${v.address}:${v.port}`;
    if (seen.has(k)) continue;
    seen.add(k);
    cands.push(l);
  }
  onLog(`${cands.length} distinct candidates`);

  const ok = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, s.probeConcurrency) }, async (_, w) => {
    while (cursor < cands.length && ok.length < s.poolTarget) {
      const i = cursor++;
      const exit = parse(cands[i], `ex-${i}`);
      if (!exit) continue;
      const v = exit.settings.vnext[0];
      if (await probe(exit, s.proxyPort + 1 + (w % 25))) {
        if (ok.length < s.poolTarget) {
          exit.tag = `ex-${ok.length}`;
          ok.push(exit);
          onLog(`OK ${v.address}:${v.port}`);
        }
      }
    }
  });
  await Promise.all(workers);

  writePool(ok);
  writeBad(new Set());
  fs.writeFileSync(C.metaFile, String(Math.floor(Date.now() / 1000)));
  onLog(`pool: ${ok.length} working exits`);
  return ok;
}

async function ensurePool(settings, onLog) {
  const s = settings || C.settings();
  if (readPool().length && poolAgeHours() < s.poolTtlHours) return readPool();
  return refresh(s, onLog);
}

module.exports = {
  readPool, writePool, readBad, writeBad, park, unpark, poolAgeHours,
  parse, refresh, ensurePool, fetchSubs,
};
