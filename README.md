# JerryHang 博客服务器（Rust · Tokio · Axum · SQLite）

一个**零前端框架、纯 Rust 编写**的轻量级动态博客后端 + 自托管方案。它同时提供“公网只读博客”与“本机管理后台”两个完全隔离的端口，内置**请求日志与威胁监控**、**SQLite + WAL**、**Markdown 安全渲染**、**Basic Auth + 会话双信任等级**、**并发门控与内存熔断**，以及 **iOS / Windows 11 风格（Frosted Glass / Acrylic）** 的响应式后台。可配合 `cloudflared` 隧道暴露到公网，实现**无需服务器、手机常驻**的博客方案。

---

## 目录

- [项目简介](#项目简介)
- [功能特性](#功能特性)
- [项目文件结构树解析](#项目文件结构树解析)
- [安全概念解析](#安全概念解析)
- [部署教程](#部署教程)
- [常见问题与处理](#常见问题与处理)
- [开源许可](#开源许可)

---

## 项目简介

本项目把“博客前台”与“博客后台”从物理上拆开：

- **外网端口 `0.0.0.0:8080`**：只读、匿名、公网可见。仅允许 `GET/HEAD`，其它方法一律返回 `404`；路径穿越被严格拦截；支持并发门控与内存熔断；返回带 `Cache-Control: public, max-age=600, s-maxage=600`，便于 Cloudflare 边缘缓存。
- **本机端口 `127.0.0.1:8081`**：唯一管理入口。必须 `Basic Auth` 才能进入；提供文章增删改查、搜索、威胁监控、系统状态等 API，并内嵌一个**原生 HTML/CSS/JS** 的亚克力后台。

日志、文章、会话全部落在**单个 SQLite 文件**（`blog.db`）中，并启用 `WAL` 模式，防止进程崩溃导致的数据损坏，同时允许并发读。

---

## 功能特性

- **双端口隔离**：外网只读 + 本机管理，职责完全分开。
- **SQLite + WAL**：单文件、零外部数据库服务、`PRAGMA journal_mode=WAL`。
- **Markdown 安全渲染**：`pulldown-cmark` 渲染后经**白名单净化器**（`sanitize_html`）过滤 `script/iframe/style` 等危险标签与 `on*`、`javascript:` 等危险属性，防存储型 XSS。
- **请求日志与威胁监控**：`request_logs` 表按规则分类：`200→normal`、`404→scan`、`UA bot/crawler/spider/scanner→crawler`、`503→blocked`、`401→bruteforce`；后台提供 `/api/admin/logs`、`/api/admin/stats`、`/api/admin/system` 与可视化图表、来源 IP / 路径分析。
- **会话双信任等级**：首次密码登录后下发 **7 天管理 Cookie**；系统命令执行 / 读博客目录外文件等**特权操作**需再次密码校验，通过后下发 **24 小时特权 Cookie**。
- **并发门控 + 内存熔断**：基于 `AtomicUsize` 的连接门控（默认 2400），并每秒采样 `/proc/self/status` 的 `VmRSS`：`>1GiB` 减半、`<512MiB` 恢复。
- **CPU 亲和**：启动时通过 `sched_setaffinity` 将进程（含 Tokio worker）绑定到指定核（默认 `0-3`，4 个 A520），配合 `worker_threads=4`。
- **响应式后台**：iOS / Win11 毛玻璃（`backdrop-filter: blur(16px)`）+ 极光渐变 + 噪点纹理，全部原生实现，无任何 CDN。

---

## 项目文件结构树解析

```text
blog_server_rust/
├── Cargo.toml            # 依赖与二进制定义（tokio / axum / rusqlite / pulldown-cmark / libc …）
├── Cargo.lock            # 锁定依赖版本（保证可复现构建）
├── README.md             # 本项目说明文档
├── LICENSE               # MIT 开源许可
├── .gitignore            # 排除 target/、config.toml、blog.db*、日志与本地脚本（防泄密）
├── src/                  # 后端（Rust）
│   ├── main.rs           # 入口：解析 env、sched_setaffinity 绑核、构建 multi-thread Tokio 运行时
│   ├── server.rs         # 核心：双端口 axum 服务、请求日志、会话认证、管理 API、Admin 仪表盘 HTML
│   ├── db.rs             # SQLite 层：posts / request_logs / sessions 表，Markdown 渲染与 XSS 净化
│   ├── sha256.rs         # 纯 Rust SHA-256（Basic Auth 密码校验）
│   └── base64.rs         # 纯 Rust Base64 解码（解析 Authorization: Basic）
└── frontend/              # 静态前端（源自 blog_ctl，由服务器经 BLOG_ROOT 读取）
    ├── index.html         # 前台 SPA（iOS 锁屏 + Win11 桌面风 + 毛玻璃/极光）
    ├── app.js             # 前端逻辑（纯原生 JS）
    ├── assets/            # 图片、壁纸等素材
    ├── blog/              # 静态文章目录页
    ├── _posts/            # Markdown 文章源
    ├── CNAME 404.html robots.txt sitemap.xml feed.xml .nojekyll
    └── README.md          # 前端自身的说明
```

> 说明：`frontend/posts.json` 由服务器在运行时根据 SQLite 动态生成，故**不入库**；克隆仓库后，服务器首次启动会自动写出。

**各文件职责**
- `main.rs`：读取 `BLOG_*` 环境变量，`sched_setaffinity` 把主线程锁到指定 CPU（所有子线程继承），再以 `worker_threads` 构建 Tokio 多线程运行时并 `block_on(server::run)`。
- `server.rs`：`Config` 与 `load_config`；`Gate`（原子并发门控 + 内存熔断）；外部/本地 handler；请求日志中间件（内联在 handler 中）；`check_auth` 双会话；`/api/*` 与 `/api/admin/*`；内嵌后台 `ADMIN_HTML`（含图表 tooltip、来源分析弹层）。
- `db.rs`：`Db` 持有 `Mutex<Connection>`；文章 CRUD、搜索、统计；请求日志写入与查询；会话创建/校验；`render_markdown`（pulldown + `sanitize_html`）。
- `sha256.rs` / `base64.rs`：无第三方加密依赖，纯标准库实现，用于密码哈希与 HTTP Basic 解析。

---

## 持续集成（CI）

仓库内置 [GitHub Actions](.github/workflows/ci.yml)：在 push/PR 到 `main` 时自动执行

- `cargo build --locked --release`（构建）
- `cargo clippy --all-targets -- -W clippy::all`（静态检查，警告不阻断）
- `cargo test --locked`（测试）

---

## 安全概念解析

1. **最小暴露面**：公网只读（GET/HEAD），其余 `404`；写入/管理只能从 `127.0.0.1` 进入。
2. **认证分层**：
   - 普通后台（文章、统计、日志、仪表盘）：首次 Basic Auth → 7 天 `blog_admin` Cookie；后续免密。
   - 特权（系统命令 `/api/admin/exec`、读任意文件 `/api/admin/file`）：强制再次输密码 → 24 小时 `blog_priv` Cookie。$*普通会话不授予特权$*。
3. **存储安全**：密码以 **SHA-256 哈希**存于 `config.toml`（该文件已被 `.gitignore` 排除，不入库）；会话 token 用 `/dev/urandom` 生成，存于 DB 带 `expires_at`，定期清理。
4. **XSS 防护**：Markdown 渲染后做**白名单净化**，并溢出转义标题/日期；后台渲染用户输入用 `esc()`。
5. **路径/注入防护**：静态文件 `resolve_target` 做规范化与 `..` 拦截、`%2e%2e` 解码检查、`canonicalize` 并校验在根目录内；SQL 全部使用参数绑定，无拼接。
6. **资源防护**：并发门控返回 `503` 而不是无脑挂起；内存 >`1GiB` 自动减半并发；`Session` 表只统计未过期会话。
7. **密钥脱敏**：本仓库**不提交** `config.toml`、`blog.db*`、日志、任何 API key。仓库源码里**不含真实密码/令牌**；默认密码为占位符 `change-me-on-first-login`，首次运行务必修改。

---

## 部署教程

### 0. 前置条件
- 已安装 `cargo`/`rustc`（本项目用 Rust 2024 edition）。
- Termux：`pkg install rust binutils clang`（编译 C 依赖如 SQLite）。

### 1. 克隆与编译
```bash
git clone https://github.com/你的账号/blog_server_rust.git
cd blog_server_rust
cargo build --release
```
> 首次会拉取 `tokio / axum / rusqlite(pulldown-cmark)`，已配置 `rsproxy` 镜像可加速；安卓/手机内存小可用 `--jobs 1` 串行编译防 OOM。

### 2. 配置
创建 `config.toml`（用占位密码）并生成自己的哈希：
```bash
./target/release/blog_server --hash '你的强密码'
# 写入 config.toml：
# username=admin
# password_sha256=<上一步输出>
```

### 3. 环境变量
```bash
export BLOG_WORKERS=4
# 绑定的 CPU 列表（4 个小核）
export BLOG_CPUS=0-3
export BLOG_MAX_CONCURRENT=2400
export BLOG_DB=$PWD/blog.db
export BLOG_EXT_ADDR=0.0.0.0:8080
export BLOG_LOCAL_ADDR=127.0.0.1:8081
```

### 4. 启动
```bash
taskset -c 0-3 env BLOG_CPUS=0-3 BLOG_WORKERS=4 nohup ./target/release/blog_server >> blog_server.log 2>&1 &
```
> 也可由 `termux-services`（runit）托管，并配 `~/.termux/boot/start_blog.sh` 开机自启。

### 5. Cloudflare Tunnel
```bash
cloudflared tunnel login
cloudflared tunnel create myblog
# DNS 指向隧道
cloudflared tunnel route dns myblog your.domain
cloudflared tunnel run myblog
```

### 6. 后台访问
浏览器打开 `http://127.0.0.1:8081/`，输入第一步设置的账号密码。

---

## 常见问题与处理

- **编译被 OOM 杀**：用 `cargo build --release --jobs 1`，或临时关闭其他大进程。
- **端口被占用**：确认旧进程已退出；`sv stop blog_server` 或 `kill $(pgrep -f blog_server)` 后重启。
- **绑核未生效**：读取 `/proc/<pid>/status` 的 `Cpus_allowed_list`；部分 Android cgroup 会钳制，属宿主限制；代码内 `sched_setaffinity` 为最佳努力。
- **SQLite `database is locked`**：确保只有一个进程打开 DB；`PRAGMA journal_mode=WAL` 已开启，避免在写入时强制 kill。
- **公网 530 / 502**：通常是隧道掉线或源站未启动；`cloudflared tunnel list` 看连接数，`sv status cloudflared` 是否 run。
- **缓存不刷新**：响应已带 `Cache-Control`；若 Cloudflare 对 HTML 显示 `cf-cache-status: DYNAMIC`，请在 Cloudflare 添加一条 **Cache Everything + Respect Origin** 的缓存规则。

## 开源许可

本项目采用 MIT License（你可在 LICENSE 中写明你的署名）。
