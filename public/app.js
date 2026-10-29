'use strict';

const $ = (id) => document.getElementById(id);
const out = $('out');
const logEl = $('log');

function append(el, text, cls) {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json().catch(() => ({}));
}

function render(s) {
  $('anon').textContent = s.anonymous ? 'anonymous' : 'credential present';
  $('anon').className = 'badge ' + (s.anonymous ? 'ok' : 'warn');

  const age = Number.isFinite(s.ageHours) ? s.ageHours.toFixed(1) : '-';
  $('poolinfo').textContent = `${s.pool.length} exits Â· ${age} h`;
  $('poolinfo').className = 'badge ' + (s.pool.length ? 'ok' : 'warn');

  $('run').disabled = s.running;
  $('refresh').disabled = s.running;
  $('subsBtn').disabled = s.running;
  $('test').disabled = s.running;

  const tbody = $('pool');
  tbody.textContent = '';
  for (const e of s.pool) {
    const tr = document.createElement('tr');
    if (e.parked) tr.className = 'parked';
    tr.innerHTML = `<td><span class="dot ${e.parked ? 'parked' : 'ok'}"></span></td>` +
      `<td>${e.address}:${e.port}</td><td>${e.network}/${e.security}</td><td></td>`;
    const btn = document.createElement('button');
    btn.textContent = e.parked ? 'unpark' : 'park';
    btn.onclick = () => api('/api/park', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag: e.tag, parked: !e.parked }),
    });
    tr.lastChild.appendChild(btn);
    tbody.appendChild(tr);
  }

  $('endpoint').value = s.endpoint;
  $('apikey').value = s.apiKey;
  const st = s.settings;
  if (document.activeElement !== $('cwd')) $('cwd').value = st.cwd || '';
  if (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
    $('model').value = st.model;
    $('poolTarget').value = st.poolTarget;
    $('poolTtlHours').value = st.poolTtlHours;
    $('subs').value = st.subs.join('\n');
  }
  $('clihint').textContent = st.cliPath;
}

async function refreshState() {
  try { render(await api('/api/state')); } catch { /* server restarting */ }
}

$('run').onclick = async () => {
  const prompt = $('prompt').value.trim() || 'say OK';
  out.textContent = '';
  append(out, `> ${prompt}\n`, 'warn');
  try {
    await api('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, cwd: $('cwd').value.trim() || undefined }),
    });
  } catch (e) {
    append(out, `\n${e.message}\n`, 'bad');
  }
};

$('refresh').onclick = async () => {
  out.textContent = '';
  append(out, 'rebuilding pool from the subscriptions...\n', 'warn');
  try { await api('/api/refresh', { method: 'POST' }); } catch (e) { append(out, `${e.message}\n`, 'bad'); }
};

$('subsBtn').onclick = async () => {
  out.textContent = '';
  append(out, 'downloading fresh subscriptions...\n', 'warn');
  try { await api('/api/subs', { method: 'POST' }); } catch (e) { append(out, `${e.message}\n`, 'bad'); }
};

$('test').onclick = async () => {
  out.textContent = '';
  append(out, 'testing exits until the pool target is reached...\n', 'warn');
  try { await api('/api/test', { method: 'POST' }); } catch (e) { append(out, `${e.message}\n`, 'bad'); }
};

$('save').onclick = async () => {
  try {
    await api('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: $('model').value.trim(),
        poolTarget: $('poolTarget').value,
        poolTtlHours: $('poolTtlHours').value,
        subs: $('subs').value,
        cwd: $('cwd').value.trim(),
      }),
    });
    append(out, 'settings saved\n', 'ok');
  } catch (e) { append(out, `${e.message}\n`, 'bad'); }
};

const copy = (id) => navigator.clipboard.writeText($(id).value).then(() => append(out, 'copied\n', 'ok'));
$('copyEndpoint').onclick = () => copy('endpoint');
$('copyKey').onclick = () => copy('apikey');

$('prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('run').click();
});

const es = new EventSource('/api/stream');
es.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === 'data') append(out, m.text);
  else if (m.type === 'log') {
    append(logEl, `${m.message}\n`);
    if (/limit on|refreshing|error on/.test(m.message)) append(out, `\n${m.message}\n`, 'warn');
  } else if (m.type === 'done') {
    append(out, `\n${m.ok ? 'done' : 'failed'} via ${m.exit} (attempt ${m.attempts})\n`, m.ok ? 'ok' : 'bad');
  } else if (m.type === 'state') refreshState();
};

fetch('/api/log').then((r) => r.text()).then((t) => { logEl.textContent = t; logEl.scrollTop = logEl.scrollHeight; });
refreshState();
setInterval(refreshState, 5000);
