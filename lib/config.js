'use strict';
// Paths and persisted settings. Everything the lane owns lives under runtime/ so the
// repo stays clean and the isolated profile is easy to inspect or delete.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname.replace(/lib$/, '').replace(/[\\/]$/, '');
const RUNTIME = path.join(ROOT, 'runtime');
const BIN = path.join(ROOT, 'bin');
const PUBLIC = path.join(ROOT, 'public');
const SETTINGS_FILE = path.join(RUNTIME, 'settings.json');

const DEFAULTS = {
  port: 8790,
  model: 'opencode/deepseek-v4.1-flash-free',
  proxyPort: 18080,
  poolTarget: 12,
  poolTtlHours: 12,
  probeConcurrency: 8,
  runTimeoutSec: 90,
  firstByteSec: 25,
  apiKey: '',
  cwd: '',
  cliPath: 'C:\\Users\\MONO\\AppData\\Local\\Programs\\@opencodedesktop\\resources\\opencode-cli.exe',
  subs: [
    'https://raw.githubusercontent.com/papa8274/sub-mirror/main/subscription.txt',
    'https://raw.githubusercontent.com/papa8274/sub-mirror/main/subscription1000.txt',
  ],
};

function ensureDirs() {
  for (const d of [RUNTIME, BIN, path.join(RUNTIME, 'home'), path.join(RUNTIME, 'data'),
    path.join(RUNTIME, 'config'), path.join(RUNTIME, 'cache'), path.join(RUNTIME, 'proj'),
    path.join(RUNTIME, 'subs')]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function settings() {
  ensureDirs();
  let merged;
  try {
    merged = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    merged = { ...DEFAULTS };
  }
  if (!merged.apiKey) {
    merged.apiKey = `sk-rw-${require('node:crypto').randomBytes(24).toString('hex')}`;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  }
  return merged;
}

function saveSettings(patch) {
  const next = { ...settings(), ...patch };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

module.exports = {
  ROOT, RUNTIME, BIN, PUBLIC, SETTINGS_FILE, DEFAULTS,
  ensureDirs, settings, saveSettings,
  poolFile: path.join(RUNTIME, 'pool.json'),
  badFile: path.join(RUNTIME, 'bad.json'),
  metaFile: path.join(RUNTIME, 'pool.meta'),
  xrayCfg: path.join(RUNTIME, 'xray.json'),
  xrayExe: path.join(BIN, 'xray.exe'),
  logFile: path.join(RUNTIME, 'lane.log'),
};
