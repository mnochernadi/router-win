'use strict';
// The lane: isolated child environment, one exit per attempt, rotate on the limit.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const C = require('./config');
const pool = require('./pool');

const NO_WINDOW = 0x08000000;

// The CLI writes a banner and ANSI colour into the stream. Strip both so an API
// client sees only the model's text.
const ANSI = /\u001b\[[0-9;?]*[a-zA-Z]/g;
const BANNER = /^\s*>?\s*build\s*Â·/;

function clean(text) {
  return String(text).replace(ANSI, '');
}

function answer(text) {
  const lines = clean(text).split(/\r?\n/).map((l) => l.trimEnd());
  const keep = lines.filter((l) => l.trim() && !BANNER.test(l));
  return keep.length ? keep[keep.length - 1].trim() : '';
}


// A clean environment, not an inherited one. The CLI boots local services of its own
// and hangs if it inherits the dashboard's env (PORT/HOST and friends), so only the
// Windows essentials are carried over.
const PASSTHROUGH = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData'];

function laneEnv(s) {
  const env = {};
  for (const k of PASSTHROUGH) if (process.env[k]) env[k] = process.env[k];
  env.PATH = process.env.PATH || 'C:\\Windows\\system32;C:\\Windows';
  env.USERPROFILE = path.join(C.RUNTIME, 'home');
  env.HOME = env.USERPROFILE;
  env.TEMP = path.join(C.RUNTIME, 'cache');
  env.TMP = env.TEMP;
  env.XDG_DATA_HOME = path.join(C.RUNTIME, 'data');
  env.XDG_CONFIG_HOME = path.join(C.RUNTIME, 'config');
  env.XDG_CACHE_HOME = path.join(C.RUNTIME, 'cache');
  env.TMPDIR = env.TEMP;
  env.TERM = 'dumb';
  env.LANG = 'C.UTF-8';
  env.TZ = 'UTC';
  env.HTTPS_PROXY = `http://127.0.0.1:${s.proxyPort}`;
  env.HTTP_PROXY = env.HTTPS_PROXY;
  env.ALL_PROXY = env.HTTPS_PROXY;
  env.NO_PROXY = '127.0.0.1,localhost';
  env.NO_COLOR = '1';
  return env;
}

// Remove every credential-bearing row so the lane can never ride an account.
function strip() {
  const db = path.join(C.RUNTIME, 'data', 'opencode', 'opencode.db');
  if (!fs.existsSync(db)) return 0;
  let sqlite;
  try { sqlite = require('node:sqlite'); } catch { return 0; }
  const con = new sqlite.DatabaseSync(db);
  let removed = 0;
  try {
    const names = con.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
    for (const t of ['credential', 'account', 'account_state', 'control_account']) {
      if (!names.includes(t)) continue;
      const n = con.prepare(`select count(*) c from ${t}`).get().c;
      if (n) { con.prepare(`delete from ${t}`).run(); removed += n; }
    }
  } finally { con.close(); }
  return removed;
}

function hasCredential() {
  const db = path.join(C.RUNTIME, 'data', 'opencode', 'opencode.db');
  if (!fs.existsSync(db)) return false;
  let sqlite;
  try { sqlite = require('node:sqlite'); } catch { return false; }
  const con = new sqlite.DatabaseSync(db);
  try {
    const names = con.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
    if (!names.includes('credential')) return false;
    return con.prepare('select count(*) c from credential').get().c > 0;
  } finally { con.close(); }
}

function startXray(exit, port) {
  const cfg = {
    log: { loglevel: 'warning' },
    inbounds: [{ listen: '127.0.0.1', port, protocol: 'http', tag: 'in' }],
    outbounds: [exit],
  };
  fs.writeFileSync(C.xrayCfg, JSON.stringify(cfg, null, 2));
  return spawn(C.xrayExe, ['run', '-c', C.xrayCfg], { windowsHide: true, stdio: 'ignore' });
}

function runOnce(s, prompt, onData, cwd) {
  return new Promise((resolve) => {
    const child = spawn(s.cliPath, ['run', '--standalone', '-m', s.model, prompt], {
      cwd,
      env: laneEnv(s),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let sawData = false;
    const grab = (buf) => {
      const t = buf.toString();
      out += t;
      sawData = true;
      if (onData) onData(t);
    };
    child.stdout.on('data', grab);
    child.stderr.on('data', grab);
    // A dead exit does not fail fast: the client just sits there. Kill it as soon as
    // the first byte is overdue so the lane can move on.
    const watchdog = setTimeout(() => {
      if (!sawData) { try { child.kill(); } catch { /* gone */ } }
    }, (s.firstByteSec || 25) * 1000);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, s.runTimeoutSec * 1000);
    child.on('close', (code) => { clearTimeout(timer); clearTimeout(watchdog); resolve({ code, out }); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a prompt, rotating exits on the free-usage limit.
 * @returns {Promise<{ok:boolean, text:string, exit:string, attempts:number, log:string[]}>}
 */
// The lane must run in the caller's project, not in its own scratch dir.
function resolveWorkdir(cwd, s) {
  const fallback = path.join(C.RUNTIME, 'proj');
  const want = cwd || s.cwd || fallback;
  try {
    if (fs.statSync(want).isDirectory()) return want;
  } catch { /* fall through */ }
  return fallback;
}
async function run(prompt, settings, onEvent = () => {}, cwd) {
  const s = settings || C.settings();
  const log = [];
  const say = (m) => { log.push(m); onEvent({ type: 'log', message: m }); };

  const workdir = resolveWorkdir(cwd, s);

  const stripped = strip();
  if (stripped) say(`stripped ${stripped} credential row(s)`);

  let exits = await pool.ensurePool(s, say);
  if (!exits.length) return { ok: false, text: 'no working exit in the pool', exit: '-', attempts: 0, log };

  let attempts = 0;
  for (;;) {
    const bad = pool.readBad();
    const live = exits.filter((e) => !bad.has(e.tag));
    if (!live.length) {
      say('every exit is parked -- refreshing');
      exits = await pool.refresh(s, say);
      if (!exits.length) return { ok: false, text: 'still nothing working', exit: '-', attempts, log };
      continue;
    }
    const exit = live[0];
    const v = exit.settings.vnext[0];
    const where = `${v.address}:${v.port}`;
    const x = startXray(exit, s.proxyPort);
    await sleep(1300);
    attempts++;
    let res;
    try {
      res = await runOnce(s, prompt, (t) => onEvent({ type: 'data', text: t }), workdir);
    } finally {
      try { x.kill(); } catch { /* gone */ }
      await sleep(200);
    }

    if (/Free usage limit|FreeUsageLimit|\b429\b/.test(res.out)) {
      pool.park(exit.tag);
      say(`limit on ${where} -> next exit`);
      continue;
    }
    if (res.code === 0) {
      const text = answer(res.out);
      say(`exit ${where} (attempt ${attempts})`);
      return { ok: true, text, exit: where, attempts, log };
    }

    // A model the upstream does not serve is not an exit problem: every other exit
    // would fail the same way, so do not park and do not rebuild the pool.
    const missing = /Model unavailable|ModelUnavailable|unknown model|model_not_found/i.test(res.out);
    if (missing) {
      const model = (res.out.match(/Model unavailable:\s*(\S+)/i) || [])[1] || s.model;
      say(`model unavailable: ${model} -- exits are fine, not rotating`);
      return { ok: false, text: `model unavailable: ${model}`, reason: 'model', model, exit: where, attempts, log };
    }

    pool.park(exit.tag);
    say(`error on ${where}: ${res.out.slice(-400).replace(/\s+/g, ' ')}`);
    if (attempts > exits.length + 2) {
      return { ok: false, text: 'every exit failed', reason: 'exit', exit: where, attempts, log };
    }
  }
}

module.exports = { run, strip, hasCredential, laneEnv, clean, answer, resolveWorkdir };
