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
| Settings | model, pool target, pool TTL, subscription URLs |
| Log | rolling lane log |

## Isolation

| Layer | Mechanism |
|---|---|
| Profile | own `USERPROFILE` + `XDG_*` under `runtime/` — own `opencode.db`, own auth store |
| Service | `--standalone` on every call, so the desktop app's background service is never used |
| Credential | every credential row is deleted before each run, so the lane cannot ride an account |
| Egress | the bundled xray on `127.0.0.1:18080`, one outbound per attempt |
| Child env | built from a whitelist, not inherited — the CLI hangs if it inherits `PORT`/`HOST` |
| Child stdin | ignored — the CLI also hangs on an open pipe |

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
