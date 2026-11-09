# Security

Block Detective is a **local, single-user tool**. The server binds to `127.0.0.1` only and has no login, so anything that can reach that port on your machine is trusted. Do not expose it to a network (port forwarding, tunnels or reverse proxies) or run it on a shared server.

## What is protected

| Threat | Protection |
|---|---|
| A website you visit sends requests to `localhost:8765` (CSRF) | Requests whose `Origin` or `Sec-Fetch-Site` header shows another site are rejected with 403. |
| DNS rebinding (an attacker's domain resolves to 127.0.0.1) | Only `Host: 127.0.0.1 / localhost / [::1]:<port>` is accepted. |
| Malicious token names, labels or case files containing HTML or JS | All rendered data is escaped. A Content-Security-Policy allows only same-origin script files, so inline scripts and `on*=` handlers cannot run even if escaping were missed. Links are URL-encoded. |
| Clickjacking | `X-Frame-Options: DENY` and `frame-ancestors 'none'` |
| CSV formula injection (cells starting with `= + - @`) | Such cells are prefixed with `'` in both CSV exports. |
| Oversized requests | Request bodies over 5 MB are rejected. |
| Scam tokens in the copy-trading simulator (Pro extension) | GoPlus check (honeypot, high tax, owner privileges) plus a "buys but no sells" heuristic. These checks can still miss well-disguised scams. |

## Where your data lives

- **API keys.** By default they are in `data/config.json`. On macOS you can move them to the system Keychain under **Settings → Move to macOS Keychain**; this also removes the plain text from `config.json` and from the backups. If the project sits on an external drive, keep in mind that such drives usually have no file permissions.
- **Runtime data.** `data/` holds labels, the watchlist, the leaderboard, the simulated ledger, the research database and the cache. It is never committed (`.gitignore`).
- **Extensions.** Anything in `ext/` runs inside the server process with the same privileges as the core, so only install extensions you trust. Their static files are served under `/ext/<name>/` from the extension's own `static/` folder only.
- **Backups.** Daily copies of `data/` go to `~/Library/Application Support/BlockDetective/backups` on macOS or `%APPDATA%\BlockDetective\backups` on Windows. The last 14 days are kept.
- **Outbound requests.** The tool only contacts the public HTTPS data APIs listed in the README. Addresses you look up are therefore visible to those providers.

## Reporting a vulnerability

Please report security issues privately through GitHub's **"Report a vulnerability"** (security advisory) on the repository instead of opening a public issue. Include steps to reproduce and the affected version or commit. If that isn't available, send a DM on X to [@FuturEvoLab](https://x.com/FuturEvoLab) and don't post the details publicly.
