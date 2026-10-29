# router-win

Anonymous OpenCode lane for Windows with a dashboard. It runs the OpenCode CLI in an
isolated profile with no credential, pushes its traffic through a rotating pool of
v2ray exits built from a subscription, and **changes egress IP by itself** when the
free-usage limit lands.

Nothing system-wide is touched: no WinINET proxy, no `netsh`, no PATH change. All
isolation is per-process.

```powershell
npm run setup     # once: fetch xray, seed the model catalog, build the pool
npm start         # dashboard on http://127.0.0.1:8790
```

## Why it exists

The OpenCode free allowance is refused **per egress IP**: measured 2026-10-29, the
same minute answered `429` from one IP and `200` from another, and swapped back. So
the answer to a spent IP is another IP, not a wait and not a sign-in.

The lane keeps a pool of exits that were probed and confirmed to carry traffic. On a
limit it parks the refused exit and retries from the next one, repeatedly, until one
answers. When every exit is parked the pool is rebuilt from the subscription on the
spot, and it is rebuilt on a timer anyway.

## Dashboard

| Panel | What it does |
|---|---|
| Run | prompt box, streamed output, live attempt log |
| Pool | every exit with transport and park/unpark |
| Update subs | re-download the subscriptions without touching the pool |
| Test exits | probe candidates, stop at the pool target, install them as the pool |
| Settings | model, pool target, pool TTL, subscription URLs |
| Log | rolling lane log |

## API

OpenAI-compatible, for pointing a harness at it.

```
base url   http://127.0.0.1:8790/v1
api key    runtime/settings.json -> apiKey   (also shown on the dashboard, with a copy button)
```

```
GET  /v1/models                 every free model, OpenAI list shape
POST /v1/chat/completions       { model, messages, stream? }
```

Every `/v1/*` call needs `Authorization: Bearer <apiKey>`; without it the answer is
`401`. The key is generated on first start and can be replaced by editing `apiKey` in
`runtime/settings.json`.

`/v1/chat/completions` runs the lane with rotation and answers in the OpenAI shape.
`stream: true` returns SSE chunks and `[DONE]`. The chosen exit and attempt count come
back in `x-router-exit` and `x-router-attempts`. The model accepts either the bare id
(`deepseek-v4.1-flash-free`) or the prefixed form (`opencode/deepseek-v4.1-flash-free`);
an id outside the catalog is `404`.

```bash
KEY=$(node -p "require('./runtime/settings.json').apiKey")

curl -s -H "authorization: Bearer $KEY" http://127.0.0.1:8790/v1/models | jq -r '.data[].id'

curl -s -H "authorization: Bearer $KEY" http://127.0.0.1:8790/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"say OK"}]}'
```

### Working directory

The lane runs in the caller's project, never in the router's own folder. Resolution order: `cwd` in the body (or an `x-router-cwd` header), then the saved `cwd` setting, then the directory the server was started from. The router's folder is only a last resort.

```powershell
.\start.cmd C:\my\project    # start with that project as the default
```

The dashboard has a working directory field, persisted in settings.

### In a harness

Any tool that speaks the OpenAI API works: set the base URL to
`http://127.0.0.1:8790/v1`, paste the key, pick a model from `/v1/models`.

```bash
# openai SDK / most CLIs
export OPENAI_BASE_URL=http://127.0.0.1:8790/v1
export OPENAI_API_KEY=$(node -p "require('./runtime/settings.json').apiKey")
```

The server binds `127.0.0.1` only. To reach it from another machine, change the
`listen` call in `server.js` to `0.0.0.0` and keep the key.

One run at a time: a second concurrent request gets `429 rate_limit_error`.

### Error classes

The lane separates three failures so it does not burn the pool on the wrong one:

| Upstream says | Lane does | API returns |
|---|---|---|
| free-usage limit | parks the exit, rotates | retried internally |
| model unavailable | does **not** park, does not rebuild the pool | `404 model_unavailable` |
| anything else | parks the exit, rotates | `502` after the pool is exhausted |

A model the upstream refused is remembered in-process, so the next call fails in one round trip instead of walking every exit.

Dashboard actions, for scripting:

```
POST /api/run       { prompt }      run through the dashboard stream
POST /api/subs                      re-download subscriptions
POST /api/test                      probe and install up to poolTarget exits
POST /api/refresh                   full rebuild
POST /api/park      { tag, parked } park or unpark one exit
GET  /api/state                     pool, settings, status
GET  /api/log                       rolling log tail
```


## Isolation

| Layer | Mechanism |
|---|---|
| Profile | own `USERPROFILE` + `XDG_*` under `runtime/` â€” own `opencode.db`, own auth store |
| Service | `--standalone` on every call, so the desktop app's background service is never used |
| Credential | every credential row is deleted before each run, so the lane cannot ride an account |
| Egress | the bundled xray on `127.0.0.1:18080`, one outbound per attempt |
| Child env | built from a whitelist, not inherited â€” the CLI hangs if it inherits `PORT`/`HOST` |
| Child stdin | ignored â€” the CLI also hangs on an open pipe |

The per-attempt xray config carries **only** the chosen outbound. No `direct`
fallback, so a dead exit fails loudly instead of silently answering from the local IP.

## Layout

```
server.js          dashboard server (node:http, zero dependencies)
lib/config.js      paths, persisted settings
lib/pool.js        subscription fetch, URI parse, probe, refresh
lib/lane.js        isolated env, run loop, rotation
lib/setup.js       one-time setup
public/            dashboard
runtime/           profile, pool, logs (gitignored)
bin/               xray.exe (gitignored, fetched by setup)
```

## Subscription parsing

This subscription ships malformed URIs: the `path` parameter swallows the following
keys, e.g. `path=/fp=chrome&security=tls`, so a naive parser sets the WebSocket path
to `/fp=chrome` and the handshake 404s. `parse()` splits the real path out and keeps
the `Host` header separate from the TLS SNI.

## Settings

`runtime/settings.json`, editable from the dashboard. Defaults: 12 exits, 12 h pool
TTL, 8 concurrent probes, 25 s first-byte watchdog, 90 s run timeout.

## Requirements

Windows, Node 20+, and an OpenCode CLI binary (`cliPath` in settings). `curl.exe` is
used for probing and ships with Windows 10+.
