'use strict';
// One-time setup: fetch the xray binary, seed the model catalog, verify the CLI.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const C = require('./config');
const lane = require('./lane');

const XRAY_URL = 'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-windows-64.zip';

async function download(url, dest) {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

function seedCatalog() {
  const src = path.join(os.homedir(), '.local', 'share', 'opencode');
  const dst = path.join(C.RUNTIME, 'data', 'opencode');
  fs.mkdirSync(dst, { recursive: true });
  let copied = 0;
  for (const f of ['opencode.db', 'opencode.db-wal', 'opencode.db-shm']) {
    const s = path.join(src, f);
    if (fs.existsSync(s)) { fs.copyFileSync(s, path.join(dst, f)); copied++; }
  }
  const stripped = lane.strip();
  return { copied, stripped };
}

async function main() {
  C.ensureDirs();
  const s = C.settings();

  if (!fs.existsSync(C.xrayExe)) {
    console.log('downloading xray...');
    const zip = path.join(C.BIN, 'xray.zip');
    await download(XRAY_URL, zip);
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${C.BIN}' -Force`], { stdio: 'inherit' });
    fs.unlinkSync(zip);
  }
  const ver = execFileSync(C.xrayExe, ['-version'], { encoding: 'utf8' }).split('\n')[0];
  console.log(`xray: ${ver.trim()}`);

  if (!fs.existsSync(s.cliPath)) throw new Error(`opencode CLI not found: ${s.cliPath}`);
  console.log(`cli: ${s.cliPath}`);

  const seed = seedCatalog();
  console.log(`catalog: ${seed.copied} file(s) copied, ${seed.stripped} credential row(s) cleared`);

  console.log('building the exit pool...');
  const pool = require('./pool');
  const exits = await pool.refresh(s, (m) => console.log(`  ${m}`));
  console.log(`\nready: ${exits.length} working exits. start the dashboard with: npm start`);
}

main().catch((e) => { console.error(`setup failed: ${e.message}`); process.exit(1); });
