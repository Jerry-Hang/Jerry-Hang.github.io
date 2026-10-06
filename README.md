# JerryHang Blog Server

> **想直接部署？** 本项目有**三种部署方式**（手机/Termux、Windows、VPS/Linux），各自一个分支。
> 见 [DEPLOY.md](DEPLOY.md)，或直接切到对应分支：`deploy/android` · `deploy/windows` · `deploy/vps`
<!-- deploy-branches -->


**中文** | [English](README.en.md)

一个**零前端框架、纯 Rust 编写**的轻量级动态博客后端 + 自托管方案。

它把"公网只读博客"与"本机管理后台"从**物理上拆成两个端口**，
内置请求日志与威胁监控、SQLite + WAL、Markdown 安全渲染、
双信任等级会话、并发门控与内存熔断，以及 iOS / Windows 11 风格
（Frosted Glass / Acrylic）的响应式后台。

配合 `cloudflared` 隧道，可以做到**没有服务器、没有公网 IP、
闲置手机常驻**的个人博客。

```
   访客 ──https──▶ Cloudflare 边缘 ──隧道──▶ cloudflared ──▶ 127.0.0.1:8090 ──▶ blog_server
                                                                                    ▲
   你   ────────────────── SSH 隧道 / 本机浏览器 ──────────────────────────────────┘
                                                          127.0.0.1:8091（管理口，公网不可达）
```

---

## 目录

- [核心特性](#核心特性)
- [快速开始](#快速开始)
- [部署教程](#部署教程)
- [架构说明](#架构说明)
- [项目结构](#项目结构)
- [配置项](#配置项)
- [常见问题](#常见问题)
- [开源协议](#开源协议)

---

## 核心特性

### 安全隔离

**双端口物理隔离**是本项目最重要的设计：

| | 公网口 `0.0.0.0:8090` | 管理口 `127.0.0.1:8091` |
|---|---|---|
| 谁能访问 | 任何人 | 只有本机 |
| 允许方法 | 仅 `GET` / `HEAD`，其他一律 `404` | 全部 |
| API | **无**（`/api/*` 在这里当静态文件 404） | 完整管理 API |
| 认证 | 不需要 | 需要登录 |
| 并发门控 | 有（超限 `503`） | 无（管理流量豁免） |

管理口除了绑回环，handler 里还会**二次校验 peer 地址是 loopback**，
双重保险。

### 认证分层

| 层级 | 获取方式 | 有效期 | 权限 |
|---|---|---|---|
| `blog_admin` | 表单登录 | **7 天** | 文章 CRUD、统计、日志、仪表盘 |
| `blog_priv` | **HTTP Basic 再次输密码** | **24 小时** | 以上全部 + 执行 shell 命令 + 读任意文件 |

特权操作（`/api/admin/exec`、`/api/admin/file`）需要 `blog_priv`。
这样即使浏览器会话被攻破，攻击者拿到的是后台读写权限，**而不是 shell**。

### 数据与渲染

- **SQLite + WAL**（`journal_mode=WAL`, `synchronous=NORMAL`）
  单文件、零外部服务、掉电不损坏
- **Markdown 安全渲染**：`pulldown-cmark` 渲染后经**白名单净化器**过滤
- **自动清理**：正常日志留 30 天，安全日志留 90 天，每天 `wal_checkpoint(TRUNCATE)`

### 请求日志与威胁监控

`request_logs` 表按规则分类：

| 规则 | 分类 |
|---|---|
| UA 含 `bot` / `crawler` / `spider` / `scanner` | `crawler` |
| `404` | `scan` |
| `503` | `blocked` |
| `401` | `bruteforce` |
| 其他 | `normal` |

后台按 **`scope`** 维度过滤：只有 `public` 的请求会显示在面板上，
本机和局域网的访问（绝大多数是自己的调试流量）被隐藏。

访客真实 IP 从 `CF-Connecting-IP` → `True-Client-IP` → `X-Real-IP`
→ `X-Forwarded-For` 依次取（因为 cloudflared 是反向连接，
peer 地址永远是回环，不能直接用）。

### 资源防护

- **并发门控**：`AtomicUsize` CAS 计数，超限返回 `503` 而不是无脑挂起
- **内存熔断**：每秒采样 RSS，`>1 GiB` 并发上限减半，`<512 MiB` 恢复
  （带滞回，避免在两个阈值之间抖动）
- **CPU 亲和**：启动时把进程绑到指定核。
  Linux/Android 用 `sched_setaffinity`，Windows 用 `SetProcessAffinityMask`。
  **尽力而为**——失败只在 stderr 打警告，不中止启动

### 零依赖倾向

只用标准库自己实现的部分：

- `sha256.rs` —— 纯 Rust FIPS 180-4 SHA-256（密码哈希）
- `base64.rs` —— 纯 Rust Base64 解码（解析 `Authorization: Basic`）
- 前端全部原生 HTML/CSS/JS，**无任何 CDN 引用**

---

## 快速开始

### 1. 编译

```bash
git clone https://github.com/Jerry-Hang/Jerry-Hang.github.io.git blog
cd blog
cargo build --release
```

> **手机上内存小**，用 `cargo build --release --jobs 1` 避免被 OOM 杀掉。

### 2. 生成密码哈希

```bash
./target/release/blog_server --hash '你的强密码'
```

### 3. 写配置

```bash
cat > config.toml <<'EOF'
username = admin
password_sha256 = 把上一步的输出粘到这里
EOF
```

> 这个文件**绝对不要提交**（`.gitignore` 已排除）。
> 它不存在时服务会自动生成一份，默认密码 `change-me-on-first-login`——
> **对外之前务必改掉。**

### 4. 启动

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

看到这三行就成功了（Rust 侧全走 `eprintln!`，输出在 **stderr**）：

```
cpu affinity set to 0-3
external 0.0.0.0:8090 (tunnel), local 127.0.0.1:8091 (management)
serving /path/to/frontend, gate=2400, db=/path/to/blog.db
```

### 5. 验证

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8090/   # 期望 200
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8091/   # 期望 302（跳登录页）
```

> **8091 返回 302 才是对的。** 返回 200 说明认证没生效，别对外发布。

### 6. 打开后台

浏览器访问 `http://127.0.0.1:8091/`，用第 2 步设的账号密码登录。

---

## 部署教程

| 平台 | 教程 |
|---|---|
| **Android / Termux**（手机常驻） | [docs/部署-Termux安卓.md](docs/部署-Termux安卓.md) |
| **Windows**（本机/台式机） | [deploy/Windows部署说明.md](deploy/Windows部署说明.md) |
| **Cloudflare 隧道**（双平台通用） | [docs/CLOUDFLARE_TUNNEL.md](docs/CLOUDFLARE_TUNNEL.md) |
| **安全与脱敏**（提交前必读） | [docs/SECURITY.md](docs/SECURITY.md) |

### 持续集成

仓库内置 [GitHub Actions](.github/workflows/ci.yml)，
push / PR 到 `main` 时自动执行：

- `cargo build --locked --release`
- `cargo clippy --all-targets -- -W clippy::all`
- `cargo test --locked`

---

## 架构说明

### 两个端口，两条路由

**没有声明式的路由表。** 两个端口都是
`Router::new().fallback(<handler>)`，所有路由在
`external_dispatch` / `local_dispatch` 里**手工字符串比对分发**。

**公网口**（只接受 `GET` / `HEAD`）：

| 路径 | 行为 |
|---|---|
| `/posts.json` | 全部文章的 JSON 数组 |
| `/post/{slug}` | 单篇文章 HTML 页（内联样式） |
| 其他任何路径 | 静态文件，目录则取 `index.html` |
| 非 GET/HEAD | `404` |

**管理口**（先校验 peer 是 loopback，否则 `403`）：

| 路径 | 方法 | 说明 |
|---|---|---|
| `/api/login` | POST | JSON 登录 |
| `/api/logout` | * | 删除服务端会话 + 清 Cookie |
| `/login` | GET | 登录页（已登录则 302 → `/`） |
| `/` | GET | 管理仪表盘（未登录 302 → `/login`） |
| `/api/posts` | GET/POST | 列表 / 新建 |
| `/api/posts/{id}` | PUT/DELETE | 更新 / 删除 |
| `/api/search?q=` | * | 搜索 |
| `/api/status` | * | 文章数 + 库大小 |
| `/api/admin/logs` | * | 请求日志（分页/分类/IP/方法过滤） |
| `/api/admin/stats` | * | 今日总量、分类统计、高峰时段、分布 |
| `/api/admin/system` | * | CPU、RSS、库大小、运行时长、会话数、门控状态 |
| `/api/admin/exec` | * | ★ **需 priv**：`sh -c <cmd>` |
| `/api/admin/file` | * | ★ **需 priv**：读任意路径文件 |

### 缓存策略

| 内容 | `Cache-Control` |
|---|---|
| 图片等静态资源 | `public, max-age=600, s-maxage=600` |
| `.js` / `.css` | `no-cache, must-revalidate` |
| HTML 页面 | `no-store` |
| JSON API | `no-store` |

另加 `X-Content-Type-Options: nosniff`，
文章页和静态文件另加 `X-Frame-Options: SAMEORIGIN`。

### 数据库结构

```sql
posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,        -- 显式指定，保证 URL 稳定
  title TEXT NOT NULL,
  content_md TEXT NOT NULL,         -- Markdown 原文
  content_html TEXT NOT NULL,       -- 渲染 + 净化后的 HTML（写入时生成）
  categories TEXT NOT NULL,         -- JSON 数组
  tags TEXT NOT NULL,               -- JSON 数组
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
  token TEXT PRIMARY KEY,           -- 32 位十六进制，getrandom 生成
  tier TEXT NOT NULL,               -- admin / priv
  expires_at INTEGER NOT NULL       -- unix 秒
)
```

> **`scope` 列是后加的**，`Db::open` 里有迁移逻辑：
> 检查 `pragma_table_info` 有没有该列，没有就 `ALTER TABLE` 补上，
> 然后用 SQL `CASE` 回填历史数据。
>
> **没有建任何索引。** `request_logs` 上的 `scope`/`category`/`timestamp`
> 过滤都是全表扫描。数据量到几十万行时会明显变慢——
> 那时该加 `CREATE INDEX`。

### `blog_ctl`：文章构建工具

`frontend/src/main.rs` 是一个纯标准库的小工具：

```bash
cd frontend
cargo run --release -- new "文章标题"    # 新建 _posts/<日期>-<slug>.md
cargo run --release -- list              # 列出全部文章
cargo run --release -- build             # 构建静态产物
cargo run --release -- push "提交说明"   # build + git add/commit/push
```

**`build` 做了什么**（产物写在**当前工作目录**）：

| 文件 | 内容 |
|---|---|
| `posts.json` | 文章元数据 + **未渲染的 Markdown 正文** |
| `feed.xml` | RSS 2.0 |
| `sitemap.xml` | 首页 + 每篇文章 |
| `robots.txt` | 允许全部 + sitemap 地址 |
| `blog/<slug>/index.html` | 每篇文章的静态页 |

> ### ⚠️ 关键：`index.html` 是**输入模板**，不是产物
>
> `generate_pages` 是 `fs::read_to_string("index.html")` **读**它，
> 找到第一处 `<script src="/app.js` 标记，
> 在它**前面**插入一行 `<script>window.__ARTICLE__ = "<slug>";</script>`，
> 然后写出 `blog/<slug>/index.html`。
>
> **它从不生成 `index.html`。** 那个文件是手写的，
> `blog_ctl build` 不会覆盖它。
>
> **两个后果**：
> 1. 找不到 `index.html` → 打印"未找到 index.html 模板，跳过独立页生成"，
>    **静默跳过**，不报错
> 2. 找不到 `<script src="/app.js` 标记 → 写出**未经注入**的模板，
>    页面没有文章内容，**同样不报错**

### `blog_hub`：手机端控制台

`frontend/src/bin/blog_hub.rs` 是给手机用的交互式菜单（同样纯标准库）：

```bash
cargo run --release --bin blog_hub              # 交互菜单
cargo run --release --bin blog_hub -- --list
cargo run --release --bin blog_hub -- --status
cargo run --release --bin blog_hub -- --new "标题"
cargo run --release --bin blog_hub -- --publish "提交说明"
```

它从当前目录向上找同时含 `_posts/` 和 `.git/` 的目录作为仓库根，
然后驱动 `blog_ctl build` 和 `git`。

### `import_posts`：从 Markdown 重建文章

```bash
./target/release/import_posts blog.db frontend/_posts          # 导入
./target/release/import_posts blog.db frontend/_posts --force  # 覆盖同 slug
```

**为什么必须有这个工具**：服务端的 `POST /api/posts`
**不允许指定 slug**——slug 由 `slugify(title)` 生成，
而它只把空格换成 `-`，**不处理中文**。
标题「自我介绍」推不出 `about-me`，会导致**原有链接全部失效**。

`import_posts` 直接读 frontmatter 里的 `slug` 保住 URL，
并且 `#[path = "../db.rs"]` 复用服务端的 `render_markdown` + `sanitize_html`，
保证渲染结果与服务端运行时**完全一致**。

frontmatter 格式（**不支持 YAML 嵌套和多行值**）：

```markdown
---
title: 自我介绍
slug: about-me
date: 2026-08-23
desc: 一句话摘要
categories: 生活,随想
tags: 自我介绍,开始
pinned: false
---

正文 Markdown……
```

> `slug` 为空会被跳过（注释里写明了原因：必须显式指定才能保住 URL）。

---

## 项目结构

```text
blog/
├── Cargo.toml                 依赖与二进制定义
├── Cargo.lock                 锁定依赖版本
├── LICENSE                    MIT
├── README.md                  中文说明（本文件）
├── README.en.md               English README
├── .gitignore                 排除 config.toml / blog.db* / 日志（防泄密）
├── .github/workflows/ci.yml   CI
│
├── src/                       后端（Rust）
│   ├── main.rs                入口：解析 env → 绑核 → 构建 Tokio 运行时
│   ├── server.rs              核心：双端口 axum、请求日志、会话、管理 API、内嵌后台
│   ├── db.rs                  SQLite 层 + Markdown 渲染 + XSS 净化
│   ├── platform.rs            跨平台层（Win32 / Unix 条件编译）
│   ├── sha256.rs              纯 Rust SHA-256
│   ├── base64.rs              纯 Rust Base64 解码
│   ├── admin/                 ★ 编译期内嵌的管理后台
│   │   ├── admin.html         （include_str! 打进二进制）
│   │   ├── admin.css
│   │   ├── admin.js
│   │   └── login.html
│   └── bin/import_posts.rs    Markdown → SQLite 导入工具
│
├── frontend/                  静态前端（BLOG_ROOT）
│   ├── index.html             ★ 前台模板（手写，不被 build 覆盖）
│   ├── app.js                 前端逻辑（原生 JS）
│   ├── assets/                图片素材
│   ├── _posts/*.md            文章 Markdown 源
│   ├── blog/<slug>/index.html blog_ctl build 生成的静态页
│   ├── posts.json / feed.xml / sitemap.xml / robots.txt
│   ├── 404.html / CNAME / .nojekyll
│   ├── src/main.rs            blog_ctl
│   ├── src/bin/blog_hub.rs    手机端控制台
│   └── Cargo.toml
│
├── deploy/                    部署脚本
│   ├── 启动博客.ps1            Windows 启动器
│   ├── 看门狗.ps1              Windows 看门狗（15s 自检）
│   ├── 安装计划任务.ps1        注册开机自启
│   ├── 启动隧道.ps1 / 配置隧道.ps1
│   ├── config.env.ps1          环境变量覆盖
│   ├── Windows部署说明.md
│   ├── blog_server.run         Termux runit 服务脚本
│   ├── blog_health.run         Termux 看门狗
│   └── termux-boot-start.sh    Termux 开机脚本
│
├── docs/                      文档
│   ├── 部署-Termux安卓.md
│   ├── CLOUDFLARE_TUNNEL.md
│   └── SECURITY.md
│
├── config.toml                ★ 账号+密码哈希（不入库）
├── blog.db                    ★ 文章+日志+会话（不入库）
└── logs/                      运行日志（不入库）
```

### 管理后台为什么在内嵌在 `src/admin/`

后台的 HTML/CSS/JS 用 `include_str!` **在编译期打进二进制**，
运行时替换占位符：

| 占位符 | 替换成 |
|---|---|
| `/*__CSS__*/` | `admin.css` 全文 |
| `//__JS__` | `admin.js` 全文 |
| `__PUBLIC_URL__` | 博客前台地址 |
| `__USERNAME__` | 配置里的用户名 |

**好处**：部署物就是一个 exe / 一个可执行文件，没有外部资源依赖，
拷过去就能跑。改后台样式需要**重新编译**。

---

## 配置项

全部通过环境变量配置：

| 变量 | 默认 | 说明 |
|---|---|---|
| `BLOG_ROOT` | `$HOME/DSH_work/blog_ctl` | 静态资源根目录 |
| `BLOG_DB` | `$HOME/DSH_work/blog_server_rust/blog.db` | SQLite 路径 |
| `BLOG_CONFIG` | `$HOME/DSH_work/blog_server_rust/config.toml` | 配置文件路径 |
| `BLOG_EXT_ADDR` | `0.0.0.0:8080` | 公网端口监听地址 |
| `BLOG_LOCAL_ADDR` | `127.0.0.1:8081` | 管理端口监听地址 |
| `BLOG_MAX_CONCURRENT` | `2400` | 并发上限，超限返 503 |
| `BLOG_WORKERS` | `4` | Tokio 工作线程数 |
| `BLOG_CPUS` | `0-3` | 绑定的 CPU 核，如 `16-31` 或 `0,2,4` |

> **关于 `BLOG_CPUS`**：写 `16-31` 表示独占第二个 CCD。
> 如果你的机器同时跑 ComfyUI 这类会吃满一个 CCD 的任务，
> 让它们分属不同 CCD 可以互不抢核。
>
> Windows 的亲和性掩码是 64 位，**一个处理器组最多 64 个逻辑核**，
> 超出的会被忽略并打警告。

---

## 常见问题

### 编译相关

**编译被 OOM 杀掉（手机）**

```bash
cargo build --release --jobs 1
```

**`failed to remove ... blog_server.exe: 拒绝访问 (os error 5)`（Windows）**

exe 正在运行，文件被锁。编译前必须先停服务和看门狗：

```powershell
Stop-ScheduledTask -TaskName "JerryHang-Blog"
Get-Process blog_server | Stop-Process -Force
# 编译
Start-ScheduledTask -TaskName "JerryHang-Blog"
```

> ⚠️ 用 `CommandLine -like '*看门狗*'` 过滤进程时，
> **你自己的查询命令里也含这三个字，会把自己匹配进去然后杀掉**。
> 要匹配具体脚本名 `*看门狗.ps1*`，而且别在同一个命令里既过滤又终止。

**`ar: not found` / `linker 'cc' not found`（Termux）**

```bash
pkg install -y binutils clang
ln -sf $PREFIX/bin/clang $PREFIX/bin/cc
```

### 运行相关

**`password_sha256 is empty`**

`config.toml` 格式不对。必须是**等号两边无引号**的纯文本，
且解析器**只认 `username` 和 `password_sha256` 两个键**，
其他键**静默忽略**（不报错，容易误以为生效了）。

**`database is locked`**

两个进程同时写同一个库。WAL 允许多读一写，不允许两个写：

```bash
pgrep -af blog_server   # 应该只有一个
```

**绑核没生效**

```bash
cat /proc/$(pgrep -f blog_server)/status | grep Cpus_allowed_list
```

部分安卓 cgroup 会钳制亲和性设置，这是**宿主限制，不是 bug**。
代码里是**尽力而为**，失败只在 stderr 打警告。

### 后台相关

**点了「执行命令」弹出 Basic 认证框**

**这是设计如此，不是 bug。** `blog_priv` 只能通过 HTTP Basic 获得，
表单登录只发 `blog_admin`。

**「前台 ↗」链接点了没反应 / 回到登录页**

管理口在 8091、前台在 8090，是**两个端口**。
相对路径 `/` 在管理页里会指回管理口自己，被 302 弹回登录页。

服务端会**优先使用请求的 `Host` 头**拼地址：
从隧道访问就用域名，从局域网访问就用那个 IP。
只有 `Host` 是回环地址时才回落到 `BLOG_PUBLIC_URL`。

### 前端相关

**改了 `index.html` 会不会被 `blog_ctl build` 覆盖？**

**不会。** `blog_ctl` 把 `index.html` 当**模板读进来**，
在 `<script src="/app.js` 标记前插入一行文章 slug，
然后写到 `blog/<slug>/index.html`。它从不写 `index.html` 本身。

**文章页没有内容 / 只有空壳**

检查 `frontend/index.html` 里有没有 `<script src="/app.js` 这个**字面量**标记。
没有的话 `blog_ctl build` 会写出未注入的模板，**而且不报错**。

**Markdown 表格 / 删除线不渲染**

`pulldown-cmark` 用的是 `Options::empty()`，**没开任何扩展**。
虽然净化器允许 `<table>` `<del>`，但解析器不会生成它们。

**改页面后公网看不到更新**

HTML 和 JS/CSS 是 `no-cache`，但**图片等静态资源**是 `max-age=600`，
Cloudflare 边缘缓存 10 分钟。`Ctrl+F5` 强制刷新，或者后台 Purge Cache。

---

## 开源协议

本项目采用 **MIT License** —— 见 [LICENSE](LICENSE)。

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

### MIT 协议意味着什么

**你可以**：

- ✅ 商业使用
- ✅ 修改
- ✅ 分发
- ✅ 私有使用
- ✅ 再授权（sublicense）

**你必须**：

- 📌 **保留版权声明和许可声明**——分发时（含二进制）要带上 LICENSE 全文
  或版权声明

**你不可以**：

- ❌ 让作者承担任何责任（软件按"原样"提供，无任何担保）
- ❌ 用作者的名义做背书

**你不需要**：

- 公开你的修改（与 GPL 不同，MIT **不要求**开源衍生作品）
- 为衍生作品使用同样的协议

> **为什么选 MIT 而不是 GPL**：这个项目的定位是"自己拿来就能用"的工具。
> MIT 让任何人（包括公司）可以随便拿走改成自己的东西，**没有传染性**。
> 对个人博客这类项目，减少使用门槛比强制开源更有意义。

### 第三方依赖

本项目自身代码为 MIT。通过 Cargo 引入的依赖各自遵循其协议：

| 依赖 | 协议 |
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

全部为**宽松协议**（MIT / Apache-2.0），
允许商业使用、修改和闭源再分发，只需保留版权声明。

> SQLite 本身是 **Public Domain**，`rusqlite` 的 `bundled` 特性
> 会把 SQLite 源码一起编进二进制，不引入额外协议约束。

---

## 致谢

- [axum](https://github.com/tokio-rs/axum) —— 人体工学极佳的 Web 框架
- [pulldown-cmark](https://github.com/raphlinus/pulldown-cmark) —— 纯 Rust CommonMark 解析器
- [rusqlite](https://github.com/rusqlite/rusqlite) —— SQLite 绑定，`bundled` 特性让部署无外部依赖
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) —— 让"没有公网 IP"不再是障碍
- [Termux](https://termux.dev/) —— 让闲置安卓手机变成 Linux 服务器
