'use strict';
// Model catalog for /v1/models. Only the free models are listed: the lane runs
// anonymously, so anything else would answer 402/429 and confuse a harness.

const fs = require('node:fs');
const path = require('node:path');
const C = require('./config');

const CATALOG_URL = 'https://models.dev/api.json';
const CACHE = path.join(C.RUNTIME, 'models.json');
const TTL_MS = 6 * 3600 * 1000;

let memory = null;

function isFree(id) {
  return /-free$/.test(id) || id === 'big-pickle';
}

async function load() {
  if (memory && Date.now() - memory.at < TTL_MS) return memory.ids;
  try {
    const st = fs.statSync(CACHE);
    if (Date.now() - st.mtimeMs < TTL_MS) {
      const ids = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
      memory = { at: st.mtimeMs, ids };
      return ids;
    }
  } catch { /* no cache */ }

  const r = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`catalog fetch failed: HTTP ${r.status}`);
  const data = await r.json();
  const models = data?.opencode?.models || {};
  const ids = Object.keys(models).filter(isFree).sort();
  fs.writeFileSync(CACHE, JSON.stringify(ids, null, 2));
  memory = { at: Date.now(), ids };
  return ids;
}

async function list() {
  const ids = await load();
  return ids.map((id) => ({
    id,
    object: 'model',
    owned_by: 'opencode',
    free: true,
    context_window: null,
  }));
}

function known(ids, requested) {
  const bare = String(requested || '').replace(/^[^/]+\//, '');
  return ids.includes(bare) ? bare : null;
}

module.exports = { list, load, known, isFree };
