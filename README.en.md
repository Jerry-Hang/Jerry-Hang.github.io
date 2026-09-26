# JerryHang Blog Server

[中文](README.md) | **English**

A lightweight, self-hosted dynamic blog backend written in **pure Rust with
zero frontend frameworks**.

It splits the public read-only blog and the local admin panel into **two
physically separate ports**, and ships with request logging and threat
monitoring, SQLite + WAL, safe Markdown rendering, two-tier sessions,
a concurrency gate with a memory circuit breaker, and a responsive
iOS / Windows 11 style (Frosted Glass / Acrylic) admin UI.

Paired with a `cloudflared` tunnel, it gives you a personal blog with
**no server rental, no public IP, and an idle Android phone as the host**.

```
  visitor ──https──▶ Cloudflare edge ──tunnel──▶ cloudflared ──▶ 127.0.0.1:8090 ──▶ blog_server
                                                                                       ▲
  you     ──────────────────── SSH tunnel / local browser ─────────────────────────────┘
                                                        127.0.0.1:8091 (admin, not publicly reachable)
```

---

## Table of Contents

- [Highlights](#highlights)
- [Quick Start](#quick-start)
- [Deployment Guides](#deployment-guides)
- [Architecture](#architecture)
- [Project Layout](#project-layout)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Highlights

### Security by physical isolation

The two-port split is the single most important design decision here:

| | Public port `0.0.0.0:8090` | Admin port `127.0.0.1:8091` |
|---|---|---|
| Who can reach it | Anyone | Local machine only |
| Allowed methods | `GET` / `HEAD` only — everything else `404` | All |
| API | **None** (`/api/*` falls through to static and 404s) | Full admin API |
| Authentication | Not required | Required |
| Concurrency gate | Yes (returns `503` when saturated) | No (admin traffic is exempt) |

Beyond binding to loopback, the admin handler **re-checks that the peer
address is a loopback address** — belt and braces.

### Two-tier authentication

| Tier | How to obtain | Lifetime | Can do |
|---|---|---|---|
| `blog_admin` | Form login | **7 days** | Post CRUD, stats, logs, dashboard |
| `blog_priv` | **HTTP Basic, re-entering the password** | **24 hours** | Everything above **plus** shell execution and arbitrary file reads |

Privileged endpoints (`/api/admin/exec`, `/api/admin/file`) require
`blog_priv`. So if a browser session is ever compromised, the attacker gets
admin read/write — **not a shell**.

### Data and rendering

- **SQLite + WAL** (`journal_mode=WAL`, `synchronous=NORMAL`) — single file,
  no external service, survives power loss.
- **Safe Markdown rendering** — `pulldown-cmark` output is passed through a
  tag/attribute **allow-list** sanitiser (unknown tags are escaped, not
  dropped).
- **Automatic retention** — normal logs kept 30 days, security-category logs
  90 days, followed by `wal_checkpoint(TRUNCATE)` once a day.

### Request logging and threat monitoring

`request_logs` rows are classified by rule:

| Rule | Category |
|---|---|
| UA contains `bot` / `crawler` / `spider` / `scanner` | `crawler` |
| `404` | `scan` |
| `503` | `blocked` |
| `401` | `bruteforce` |
| Anything else | `normal` |

The dashboard filters on a **`scope`** column: only `public` traffic is
shown, hiding local and LAN requests (which, in practice, are almost all
your own testing).

The real visitor IP is taken from `CF-Connecting-IP` → `True-Client-IP` →
`X-Real-IP` → `X-Forwarded-For`, in that order. This matters because
`cloudflared` connects *back* to the origin, so the peer address is always
loopback and useless for this purpose.

### Resource protection

- **Concurrency gate** — an `AtomicUsize` CAS counter; over the limit it
  returns `503` rather than piling up.
- **Memory circuit breaker** — samples RSS once a second; halves the
  concurrency ceiling above 1 GiB and restores it below 512 MiB (with
  hysteresis so it does not oscillate between the two thresholds).
- **CPU affinity** — pins the process at startup via `sched_setaffinity` on
  Linux/Android or `SetProcessAffinityMask` on Windows. Strictly
  **best-effort**: on failure it warns on stderr and continues.

### Minimal dependencies

Implemented from scratch on the standard library:

- `sha256.rs` — pure-Rust FIPS 180-4 SHA-256 (password hashing)
- `base64.rs` — pure-Rust Base64 decoding (parsing `Authorization: Basic`)
- The entire frontend is hand-written HTML/CSS/JS with **no CDN references**.

---

## Quick Start

### 1. Build

```bash
git clone https://github.com/Jerry-Hang/Jerry-Hang.github.io.git blog
cd blog
cargo build --release
```

> **On a phone**, use `cargo build --release --jobs 1` to avoid being
> OOM-killed mid-build.

### 2. Generate a password hash

```bash
./target/release/blog_server --hash 'your-strong-password'
```

### 3. Write the config

```bash
cat > config.toml <<'EOF'
username = admin
password_sha256 = paste-the-hash-here
EOF
```

> **Never commit this file** (`.gitignore` already excludes it).
> If it is missing, the server auto-creates one with the default password
> `change-me-on-first-login` — **change it before exposing the service.**

### 4. Run

```bash
export BLOG_ROOT="$PWD/frontend"
export BLOG_DB="$PWD/blog.db"
export BLOG_CONFIG="$PWD/config.toml"
export BLOG_EXT_ADDR="0.0.0.0:8090"
export BLOG_LOCAL_ADDR="127.0.0.1:8091"
export BLOG_WORKERS=4
export BLOG_CPUS="0-3"

./target/release/blog_server
```

You are up when you see these three lines (the Rust side uses `eprintln!`
throughout, so this goes to **stderr**):

```
cpu affinity set to 0-3
external 0.0.0.0:8090 (tunnel), local 127.0.0.1:8091 (management)
serving /path/to/frontend, gate=2400, db=/path/to/blog.db
```

### 5. Verify

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8090/   # expect 200
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8091/   # expect 302 (redirect to login)
```

> **`302` on 8091 is correct.** A `200` there means authentication is not
> working — do not expose the service until that is fixed.

### 6. Open the admin panel

Browse to `http://127.0.0.1:8091/` and sign in with the credentials from
step 2.

---

## Deployment Guides

| Platform | Guide |
|---|---|
| **Android / Termux** (phone as an always-on host) | [docs/部署-Termux安卓.md](docs/部署-Termux安卓.md) *(Chinese)* |
| **Windows** (desktop / laptop) | [deploy/Windows部署说明.md](deploy/Windows部署说明.md) *(Chinese)* |
| **Cloudflare Tunnel** (both platforms) | [docs/CLOUDFLARE_TUNNEL.md](docs/CLOUDFLARE_TUNNEL.md) *(Chinese)* |
| **Security and secret scrubbing** (read before pushing) | [docs/SECURITY.md](docs/SECURITY.md) *(Chinese)* |

> The deployment guides are currently written in Chinese, matching the
> primary audience. The code, comments, and CI configuration are all
> English-friendly, and this README covers the full configuration surface
> needed to deploy on any platform.

### Continuous integration

[GitHub Actions](.github/workflows/ci.yml) runs on every push / PR to `main`:

- `cargo build --locked --release`
- `cargo clippy --all-targets -- -W clippy::all`
- `cargo test --locked`

---

## Architecture

### Two ports, two hand-rolled dispatchers

**There is no declarative routing table.** Both ports are
`Router::new().fallback(<handler>)`, and every route is dispatched by string
comparison inside `external_dispatch` / `local_dispatch`.

**Public port** (accepts `GET` / `HEAD` only):

| Path | Behaviour |
|---|---|
| `/posts.json` | JSON array of all posts |
| `/post/{slug}` | Single post as an inline-styled HTML page |
| Any other path | Static file; directories resolve to `index.html` |
| Non-GET/HEAD | `404` |

**Admin port** (loopback peer required first, else `403`):

| Path | Method | Purpose |
|---|---|---|
| `/api/login` | POST | JSON login |
| `/api/logout` | * | Delete server-side session + clear cookies |
| `/login` | GET | Login page (302 → `/` when already signed in) |
| `/` | GET | Admin dashboard (302 → `/login` when not) |
| `/api/posts` | GET/POST | List / create |
| `/api/posts/{id}` | PUT/DELETE | Update / delete |
| `/api/search?q=` | * | Search |
| `/api/status` | * | Post count + database size |
| `/api/admin/logs` | * | Request logs (paged; filter by category/IP/method) |
| `/api/admin/stats` | * | Today's total, category counts, peak hour, distributions |
| `/api/admin/system` | * | CPU, RSS, DB size, uptime, session count, gate state |
| `/api/admin/exec` | * | ★ **priv required**: runs `sh -c <cmd>` |
| `/api/admin/file` | * | ★ **priv required**: reads any readable path |

### Cache policy

| Content | `Cache-Control` |
|---|---|
| Images and other static assets | `public, max-age=600, s-maxage=600` |
| `.js` / `.css` | `no-cache, must-revalidate` |
| HTML pages | `no-store` |
| JSON API | `no-store` |

Plus `X-Content-Type-Options: nosniff` everywhere, and
`X-Frame-Options: SAMEORIGIN` on post pages and static files.

### Database schema

```sql
posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,        -- explicit, so URLs stay stable
  title TEXT NOT NULL,
  content_md TEXT NOT NULL,         -- raw Markdown
  content_html TEXT NOT NULL,       -- rendered + sanitised once, at write time
  categories TEXT NOT NULL,         -- JSON array
  tags TEXT NOT NULL,               -- JSON array
  desc TEXT NOT NULL,
  date TEXT NOT NULL,
  updated_at TEXT NOT NULL
)

request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  ip TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  user_agent TEXT NOT NULL,
  category TEXT NOT NULL,           -- crawler/scan/blocked/bruteforce/normal
  scope TEXT NOT NULL DEFAULT 'unknown'   -- local/lan/public/unknown
)

sessions (
  token TEXT PRIMARY KEY,           -- 32 hex chars, from getrandom
  tier TEXT NOT NULL,               -- admin / priv
  expires_at INTEGER NOT NULL       -- unix seconds
)
```

> **The `scope` column was added later**, and `Db::open` migrates for it:
> it checks `pragma_table_info` for the column, issues `ALTER TABLE` if
> missing, then backfills historical rows with a SQL `CASE`.
>
> **No indexes are created.** Every `scope` / `category` / `timestamp`
> filter on `request_logs` is a full table scan. At a few hundred thousand
> rows this becomes noticeably slow — that is the point to add
> `CREATE INDEX`.

### `blog_ctl` — the post build tool

`frontend/src/main.rs` is a standard-library-only helper:

```bash
cd frontend
cargo run --release -- new "Post title"   # create _posts/<date>-<slug>.md
cargo run --release -- list               # list all posts
cargo run --release -- build              # generate static output
cargo run --release -- push "commit msg"  # build + git add/commit/push
```

**What `build` produces** (all paths relative to the **current working
directory**):

| File | Contents |
|---|---|
| `posts.json` | Post metadata plus the **unrendered Markdown body** |
| `feed.xml` | RSS 2.0 |
| `sitemap.xml` | Home page plus one entry per post |
| `robots.txt` | Allow-all plus the sitemap URL |
| `blog/<slug>/index.html` | A static page per post |

> ### ⚠️ Critical: `index.html` is a **template input**, not an output
>
> `generate_pages` calls `fs::read_to_string("index.html")` to **read** it,
> finds the first literal `<script src="/app.js` marker, splices
> `<script>window.__ARTICLE__ = "<slug>";</script>` in **before** that
> marker, and writes the result to `blog/<slug>/index.html`.
>
> **It never generates `index.html`.** That file is hand-maintained and
> `blog_ctl build` will not overwrite it.
>
> **Two consequences:**
> 1. If `index.html` is missing, it prints
>    "未找到 index.html 模板，跳过独立页生成" and **silently skips** —
>    no error, no pages.
> 2. If the `<script src="/app.js` marker is missing, it writes the
>    template **without** the injection — pages with no post content, and
>    **still no error**.

### `blog_hub` — the phone-side console

`frontend/src/bin/blog_hub.rs` is an interactive menu for Termux (also
standard-library only):

```bash
cargo run --release --bin blog_hub              # interactive menu
cargo run --release --bin blog_hub -- --list
cargo run --release --bin blog_hub -- --status
cargo run --release --bin blog_hub -- --new "Title"
cargo run --release --bin blog_hub -- --publish "commit message"
```

It walks up from the current directory to find a repo containing **both**
`_posts/` and `.git/`, then drives `blog_ctl build` and `git`.

### `import_posts` — rebuilding posts from Markdown

```bash
./target/release/import_posts blog.db frontend/_posts          # import
./target/release/import_posts blog.db frontend/_posts --force  # overwrite same slug
```

**Why this tool has to exist:** the server's `POST /api/posts` **cannot
accept an explicit slug** — the slug comes from `slugify(title)`, which only
replaces spaces with `-` and **does not handle CJK characters**. A title
like 「自我介绍」 cannot produce `about-me`, so every existing post URL
would break.

`import_posts` reads the `slug` straight from the frontmatter to preserve
URLs, and pulls in `db.rs` via `#[path = "../db.rs"]` so it reuses the
server's exact `render_markdown` + `sanitize_html` path — the rendered HTML
is **byte-identical** to what the server would produce.

Frontmatter format (**no nested YAML, no multi-line values**):

```markdown
---
title: Self Introduction
slug: about-me
date: 2026-08-23
desc: One-line summary
categories: life,notes
tags: intro,hello
pinned: false
---

Markdown body……
```

> Rows with an empty `slug` are skipped — the code comments explain why:
> the slug must be explicit to keep URLs stable.

---

## Project Layout

```text
blog/
├── Cargo.toml                 dependencies and binary definitions
├── Cargo.lock                 pinned dependency versions
├── LICENSE                    MIT
├── README.md                  Chinese README
├── README.en.md               English README (this file)
├── .gitignore                 excludes config.toml / blog.db* / logs
├── .github/workflows/ci.yml   CI
│
├── src/                       backend (Rust)
│   ├── main.rs                entry: parse env → pin CPUs → build Tokio runtime
│   ├── server.rs              core: dual-port axum, logging, sessions, admin API
│   ├── db.rs                  SQLite layer + Markdown rendering + XSS sanitiser
│   ├── platform.rs            cross-platform layer (Win32 / Unix cfg)
│   ├── sha256.rs              pure-Rust SHA-256
│   ├── base64.rs              pure-Rust Base64 decode
│   ├── admin/                 ★ admin UI, embedded at compile time
│   │   ├── admin.html         (include_str! into the binary)
│   │   ├── admin.css
│   │   ├── admin.js
│   │   └── login.html
│   └── bin/import_posts.rs    Markdown → SQLite importer
│
├── frontend/                  static frontend (BLOG_ROOT)
│   ├── index.html             ★ site template (hand-written, never overwritten)
│   ├── app.js                 frontend logic (vanilla JS)
│   ├── assets/                images
│   ├── _posts/*.md            Markdown sources
│   ├── blog/<slug>/index.html pages generated by blog_ctl build
│   ├── posts.json / feed.xml / sitemap.xml / robots.txt
│   ├── 404.html / CNAME / .nojekyll
│   ├── src/main.rs            blog_ctl
│   ├── src/bin/blog_hub.rs    phone-side console
│   └── Cargo.toml
│
├── deploy/                    deployment scripts
│   ├── 启动博客.ps1            Windows launcher
│   ├── 看门狗.ps1              Windows watchdog (15 s health check)
│   ├── 安装计划任务.ps1        registers the startup scheduled task
│   ├── 启动隧道.ps1 / 配置隧道.ps1
│   ├── config.env.ps1          env var overrides
│   ├── Windows部署说明.md
│   ├── blog_server.run         Termux runit service script
│   ├── blog_health.run         Termux watchdog
│   └── termux-boot-start.sh    Termux boot script
│
├── docs/                      documentation
│   ├── 部署-Termux安卓.md
│   ├── CLOUDFLARE_TUNNEL.md
│   └── SECURITY.md
│
├── config.toml                ★ credentials + password hash (not committed)
├── blog.db                    ★ posts + logs + sessions (not committed)
└── logs/                      runtime logs (not committed)
```

### Why the admin UI lives inside `src/admin/`

The admin HTML/CSS/JS is compiled into the binary with `include_str!`, and
placeholders are substituted at runtime:

| Placeholder | Replaced with |
|---|---|
| `/*__CSS__*/` | full `admin.css` |
| `//__JS__` | full `admin.js` |
| `__PUBLIC_URL__` | the public blog URL |
| `__USERNAME__` | the configured username |

**The payoff** is a single self-contained executable with no external asset
dependencies — copy it anywhere and it runs. **The cost** is that changing
admin styling requires a rebuild.

---

## Configuration

Everything is configured through environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `BLOG_ROOT` | `$HOME/DSH_work/blog_ctl` | Static asset root |
| `BLOG_DB` | `$HOME/DSH_work/blog_server_rust/blog.db` | SQLite path |
| `BLOG_CONFIG` | `$HOME/DSH_work/blog_server_rust/config.toml` | Config file path |
| `BLOG_EXT_ADDR` | `0.0.0.0:8080` | Public listen address |
| `BLOG_LOCAL_ADDR` | `127.0.0.1:8081` | Admin listen address |
| `BLOG_MAX_CONCURRENT` | `2400` | Concurrency ceiling; over it returns 503 |
| `BLOG_WORKERS` | `4` | Tokio worker threads |
| `BLOG_CPUS` | `0-3` | CPU affinity, e.g. `16-31` or `0,2,4` |

> **About `BLOG_CPUS`:** `16-31` means "take the whole second CCD". If the
> machine also runs something like ComfyUI that saturates one CCD during
> sampling, putting the blog on the *other* CCD keeps them out of each
> other's way.
>
> Windows affinity masks are 64-bit, so **a single processor group holds at
> most 64 logical cores**; higher indices are ignored with a warning.

---

## Troubleshooting

### Build

**OOM-killed during compilation (phone)**

```bash
cargo build --release --jobs 1
```

**`failed to remove ... blog_server.exe: 拒绝访问 (os error 5)` (Windows)**

The executable is running and the file is locked. Stop the service and the
watchdog before building:

```powershell
Stop-ScheduledTask -TaskName "JerryHang-Blog"
Get-Process blog_server | Stop-Process -Force
# build
Start-ScheduledTask -TaskName "JerryHang-Blog"
```

> ⚠️ When filtering processes with
> `CommandLine -like '*watchdog*'`, **your own query command contains that
> string too** and will match itself — then get killed. Match the specific
> script name, and never filter and terminate in the same command.

**`ar: not found` / `linker 'cc' not found` (Termux)**

```bash
pkg install -y binutils clang
ln -sf $PREFIX/bin/clang $PREFIX/bin/cc
```

### Runtime

**`password_sha256 is empty`**

Malformed `config.toml`. It must be plain `key = value` with **no quotes**,
and the parser **recognises only `username` and `password_sha256`** — every
other key is **silently ignored** (no error, which makes the mistake easy
to miss).

**`database is locked`**

Two processes are writing the same database. WAL allows many readers but
only one writer:

```bash
pgrep -af blog_server   # there should be exactly one
```

**CPU affinity did not take effect**

```bash
cat /proc/$(pgrep -f blog_server)/status | grep Cpus_allowed_list
```

Some Android cgroups clamp affinity settings — that is a **host
restriction, not a bug**. The code is best-effort and only warns on stderr.

### Admin panel

**Clicking "run command" pops up a Basic auth dialog**

**That is by design.** `blog_priv` can only be obtained via HTTP Basic;
form login issues `blog_admin` only.

**The "front-end ↗" link does nothing, or bounces back to the login page**

The admin port is 8091 and the public port is 8090 — they are **two
different ports**. A relative path `/` inside the admin page points back at
the admin port itself and gets 302'd to the login page.

The server prefers the request's `Host` header when building that URL: via
the tunnel it uses your domain, on the LAN it uses that IP. Only when
`Host` is a loopback address does it fall back to `BLOG_PUBLIC_URL`.

### Frontend

**Will editing `index.html` be overwritten by `blog_ctl build`?**

**No.** `blog_ctl` treats `index.html` as a **template it reads**, splices a
`window.__ARTICLE__` script tag in before the `<script src="/app.js`
marker, and writes the result to `blog/<slug>/index.html`. It never writes
`index.html` itself.

**Post pages are empty / just a shell**

Check that `frontend/index.html` contains the **literal**
`<script src="/app.js` marker. Without it, `blog_ctl build` writes
un-injected templates and **reports no error**.

**Markdown tables / strikethrough do not render**

`pulldown-cmark` is invoked with `Options::empty()` — **no extensions are
enabled**. The sanitiser would permit `<table>` and `<del>`, but the parser
never generates them.

**Page edits do not show up publicly**

HTML and JS/CSS are `no-cache`, but **images and other assets** are
`max-age=600`, so the Cloudflare edge caches them for 10 minutes. Use
`Ctrl+F5`, or purge the cache from the dashboard.

---

## License

This project is released under the **MIT License** — see [LICENSE](LICENSE).

```
MIT License

Copyright (c) 2026 Jerry-Hang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### What MIT means in practice

**You may:**

- ✅ Use commercially
- ✅ Modify
- ✅ Distribute
- ✅ Use privately
- ✅ Sublicense

**You must:**

- 📌 **Keep the copyright and licence notice** — when redistributing
  (including binaries), include the full licence text or the copyright
  notice.

**You may not:**

- ❌ Hold the author liable (the software is provided "as is", with no
  warranty of any kind)
- ❌ Use the author's name to endorse your derivative

**You do not have to:**

- Publish your modifications (unlike the GPL, MIT **does not** require
  derivative works to be open-sourced)
- Licence your derivative under the same terms

> **Why MIT rather than the GPL:** this is meant to be a tool you can pick
> up and use. MIT lets anyone — including companies — take it and adapt it
> freely, with no copyleft obligations. For a personal blog project,
> lowering the barrier to use matters more than forcing openness.

### Third-party dependencies

This project's own code is MIT. Cargo dependencies carry their own licences:

| Dependency | Licence |
|---|---|
| `tokio` | MIT |
| `axum` | MIT |
| `rusqlite` | MIT |
| `pulldown-cmark` | MIT |
| `serde` / `serde_json` | MIT OR Apache-2.0 |
| `getrandom` | MIT OR Apache-2.0 |
| `libc` | MIT OR Apache-2.0 |
| `windows-sys` | MIT OR Apache-2.0 |
| `bytes` | MIT |

All are **permissive** (MIT / Apache-2.0): commercial use, modification,
and closed-source redistribution are allowed, provided copyright notices
are retained.

> SQLite itself is in the **public domain**, and `rusqlite`'s `bundled`
> feature compiles the SQLite source into the binary without adding any
> further licence constraints.

---

## Credits

- [axum](https://github.com/tokio-rs/axum) — an exceptionally ergonomic web framework
- [pulldown-cmark](https://github.com/raphlinus/pulldown-cmark) — pure-Rust CommonMark parser
- [rusqlite](https://github.com/rusqlite/rusqlite) — SQLite bindings; the `bundled` feature removes external dependencies
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — makes "no public IP" a non-issue
- [Termux](https://termux.dev/) — turns an idle Android phone into a Linux server
