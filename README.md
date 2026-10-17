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

### 安全隔离与访问控制

**双端口物理隔离、可信设备配对与最小权限原则**是本项目最重要的设计：

| | 公网口 `0.0.0.0:80`（或 8090） | 管理通道（SSH + CLI / 本机回环 / 可信配对） |
|---|---|---|
| 谁能访问 | 任何人（只读/查询/文章互动）；可信配对设备可访问后台 | 仅经过 SSH 公私钥配对受信任的设备 |
| 允许方法 | 未配对：**仅 `GET` / `HEAD`** 与受控点赞/配对 API，其余一律 `404`；已配对设备放行受鉴权管理接口 | CLI 直接操作数据库；或已配对设备受控鉴权访问 |
| 后台入口 | **全网 404 伪装隐身**（未配对请求统一 404）；已配对设备顶栏动态呈现「后台」按钮 | 本地 `blog_server ctl` CLI 命令集 / 回环管理口 |
| 认证机制 | 可信设备单次令牌配对（`blog_server ctl pair`）+ 密码哈希认证 | **仅限 SSH Ed25519 密钥配对**（禁用密码认证） |
| 并发门控 | 有（超限 `503`，带 IP 频率限流与配对防爆破） | 免门控 |

> 🔒 **可信设备配对与 404 伪装隐身后台（零资产暴露面）**：
> - 外部扫描器、黑客探测或非受信任设备访问 `/admin`、`/login`、`/_admin/*`、`/api/admin/*` 统一伪装返回 **`404 Not Found`**（绝不返回 401/403），外部完全无法感知后台管理界面的存在。
> - 管理员可在 SSH 终端运行 `blog_server ctl pair [设备名]` 生成 15 分钟单次有效的专属安全配对链接（如 `https://your-domain/?pair=...`）。手机或电脑打开后自动完成安全握手并写入 `blog_trusted` 凭证。
> - 配对成功后，顶栏导航自动呈现专属「后台」灵动胶囊按钮；管理员亦可随时在后台或 SSH 命令行一键吊销设备，吊销后立即重归 404 隐身状态。
> - 配对接口（`/api/auth/pair-device`）内置防暴力破解机制：严格限制单 IP 请求频率，3 次配对失败立即锁定封禁该 IP 5 分钟。
> - 彻底移除 Web 端 `/api/admin/exec`（执行系统命令）与 `/api/admin/file`（任意绝对路径读取）。二进制内不包含任何 `sh -c` 执行逻辑，**杜绝任何以博客为跳板控制 VPS 的风险**。

### 资源防护与多级内存熔断

- **并发门控**：`AtomicUsize` CAS 计数，超限返回 `503 Service Unavailable` 快速断开连接，避免无脑挂起吃满连接池。
- **VPS 内存硬限制与多级熔断**：
  - **CGroup v2 硬上限**：systemd 单元配置 `MemoryMax=512M`、`MemoryHigh=384M`，内核层防 OOM 击穿。
  - **应用层多级熔断（滞后阻尼）**：
    - `RSS >= 384 MB`：触发一级限流，最大并发承载直接减半；
    - `RSS >= 448 MB`：触发重度降级，并发限制压至 10%；
    - `RSS >= 480 MB`：紧急熔断，新连接直接返回 503，誓死避免触发 512MB 内核杀进程；
    - `RSS <= 256 MB`：常驻内存彻底回落后完全恢复 100% 满血并发。
- **防爆破与防 DDoS 洪水限流**：
  - 纯内存滑动窗口频率限制器（`IpRateLimiter`），基于真实访客 IP：
    - 仅当连接底层 TCP peer 为回环地址（来自本机 Cloudflare Tunnel 反向代理）时才解析转发头；直连公网 TCP 时强制锁定真实 IP，杜绝假头欺骗；
    - 所有提取出的 IP 必须严格通过 IPv4/IPv6 格式解析验证，阻断恶意超长注入串；
    - 10 秒窗口超 120 次请求判定为洪水/爬虫，直接返回 `429 Too Many Requests`（带 `Retry-After: 60`）；
    - 连续 15 次 404 探测路径判定为恶意漏洞扫描器，直接封禁 5 分钟；
    - 限制器引入内存容量上限保护（上限 4,000 个 IP，占用内存 < 300KB），且被封禁的恶意 IP 誓死持久锁定，无法通过伪造大量随机 IP 触发清空脱逃。
- **路径穿越与静态文件安全白名单**：
  - 静态资源严格白名单机制（仅放行 `html`, `css`, `js`, `json`, `xml`, `txt`, `png`, `jpg`, `svg`, `webp`, `woff2` 等合法媒体格式）；
  - 全面阻断以 `.` 开头的隐藏文件/目录（如 `.git`, `.env`, `.gitignore`）以及源码与构建目录（`src/`, `target/`, `deploy/`, `_posts/`）；
  - 坚决阻断任何对 `.db`, `.toml`, `.rs`, `.sh`, `.ps1` 等敏感配置或数据库的读取，外部探测直接 404。
- **XSS 伪协议与实体编码深度过滤**：
  - Markdown 渲染除标签与属性白名单外，对 `href` / `src` 协议引入实体编码解码与严格校验，彻底阻断 `javascript:`, `vbscript:`, `data:` 及其十六进制/十进制实体变体（如 `jav&#x61;script:`）。
- **协商缓存与性能优化**：
  - 为所有静态资源（壁纸、头像、JS、CSS）与 `/posts.json` 全面支持弱 `ETag` 与 `If-None-Match` 协商，未修改响应 `304 Not Modified`（0 字节传输、0 内存读盘）。
- **CPU 亲和**：启动时把进程绑到指定核（Linux/Android 用 `sched_setaffinity`，Windows 用 `SetProcessAffinityMask`）。

### 数据与渲染

- **SQLite + WAL**（`journal_mode=WAL`, `synchronous=NORMAL`）
  单文件、零外部服务、掉电不损坏
- **Markdown 安全渲染**：`pulldown-cmark` 渲染后经**白名单净化器**过滤
- **自动清理**：正常日志留 30 天，安全日志留 90 天，每天 `wal_checkpoint(TRUNCATE)`

### 请求日志、后台监控与威胁防御

`request_logs` 表按规则自动归类记录：

| 规则 | 分类 |
|---|---|
| UA 含 `bot` / `crawler` / `spider` / `scanner` | `crawler` |
| `404` | `scan` |
| `503` / `429` | `blocked` |
| `401` | `bruteforce` |
| 其他 | `normal` |

后台面板与 CLI 提供全方位的防御管理与运维遥测：
- **CGroup 内存水位仪表盘**：可视化展示当前真实 RSS 内存占用，并实时标注 256MB 满血基线、384MB 减半限流线与 512MB 熔断红线。
- **动态封禁防护与一键解封（Unban）**：安全面板实时展示当前被限制器封禁的恶意扫描/爬虫 IP 及解封倒计时，支持后台管理员一键解除封禁。
- **可信设备生命周期管理**：后台专设「设备」面板，支持在线生成临时配对码、审计所有已授权受信任设备列表与一键吊销设备权限。
- **全站互动与获赞 KPI**：概览页集中展示全站点赞互动总数与受信任设备数，并支持按文章统计点赞热度。
- **命令行审计**：支持在 SSH 终端通过 `blog_server ctl logs`、`blog_server ctl devices`、`blog_server ctl likes` 快速审计与管理。

### 交互体验与前端视觉

- **瑞士国际平面风格（Swiss Style）与排版美学**：融合苏黎世派严谨的网格式排版、高对比度黑白灰层级、Neo-Grotesque 无衬线字体序列（`-apple-system, Helvetica Neue, Arial`）与充裕而克制的留白，杜绝花哨繁杂的 AI 生成模板味。
- **摒弃表情符号与花哨装饰**：全站坚决杜绝 Unicode Emoji、花哨霓虹渐变与杂乱符号堆叠；统一采用纯 CSS / 1.5px 精细矢量线框 SVG 图标，保持界面冷静、严谨、现代。
- **保留原生 iOS 毛玻璃质感**：采用多层 `backdrop-filter: blur(28px)`、高动态微反光边框与灵动胶囊导航组件，搭配触控微阻尼过渡，在移动端与桌面端兼具通透感与温润质感。
- **文章轻量互动点赞**：文章末尾集成 iOS 灵动胶囊点赞模块，支持心跳缩放动效、持久化状态记忆与防重复刷赞，后端支持并发安全原子递增。
- **零依赖纯本地矢量二维码分享**：文章末尾集成离线分享弹窗，内置纯原生 JavaScript 矢量 QR Code 生成算法（Reed-Solomon 纠错与多项式数学运算），100% 离线生成纯 SVG 矢量码，无需任何外部在线 API 或 CDN，彻底消除隐私泄露。
- **受信任设备无缝后台入口**：受信任设备访问博客时，顶栏动态注入「后台」灵动胶囊按钮；未配对访客则完全不可见且无法探测后台。
- **全局即时搜索（Command Palette）**：支持 `Ctrl+K` / `Cmd+K` 或点击顶栏放大镜实时呼出，纯原生 JS 毫秒级模糊匹配标题、摘要、标签、分类及正文片段，支持关键词高亮与方向键/Enter键盘顺畅导航。
- **友链展示（Blogroll）与一键交换**：专设友链视图，网格化展示站点卡片与站长头像，附带一键复制本站申请信息交互。
- **代码块一键复制与微动画**：代码段右上角集成一键复制按钮与已复制状态反馈，阅读体验顺畅自然。
- **阅读辅助与大纲导航**：文章页实时阅读进度指示、字数与预计阅读时间统计、右侧智能悬浮大纲目录与底部上下一篇卡片。
- **纯粹的零依赖**：前端纯原生 HTML5 / CSS3 / Vanilla JS 实现，全站资源本地化，无任何外部 CDN 依赖，隐私与安全零妥协。

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

**公网口**（只读、受控互动与受信任设备管理通道）：

| 路径 | 方法 | 行为 |
|---|---|---|
| `/posts.json` | GET/HEAD | 全部文章的 JSON 数组 |
| `/post/{slug}` | GET/HEAD | 单篇文章 HTML 页（内联样式） |
| `/api/posts/{slug}/likes` | GET/HEAD, POST | 点赞数据获取 / 递增（带 IP 频控防刷） |
| `/api/likes/summary` | GET/HEAD | 全站点赞总数摘要 |
| `/api/auth/check` | GET/HEAD | 客户端探测是否为受信任设备（决定是否渲染「后台」按钮） |
| `/api/auth/pair-device` | POST | 提交配对口令激活设备（严格防爆破频控，3 次失败封禁 IP） |
| 静态文件 | GET/HEAD | 严格白名单内静态资源 |
| `/admin`, `/login`, `/api/admin/*` 等 | * | **受信任设备**：无缝直通后台；<br>**非受信任访问**：**统一返回 `404` 隐身伪装** |
| 非法/未放行方法 | * | `404` |

**管理口 / 可信设备通道**（管理口校验 peer 为 loopback；公网直通校验 `blog_trusted`）：

| 路径 | 方法 | 说明 |
|---|---|---|
| `/api/login` | POST | JSON 登录（校验密码哈希并签发 `blog_admin` 会话） |
| `/api/logout` | * | 删除服务端会话 + 清 Cookie |
| `/login` | GET | 登录页（已登录则 302 → `/admin`） |
| `/` 或 `/admin` | GET | 管理仪表盘（未登录 302 → `/login`） |
| `/api/posts` | GET/POST | 列表 / 新建文章 |
| `/api/posts/{id}` | PUT/DELETE | 更新 / 删除文章 |
| `/api/search?q=` | * | 搜索文章 |
| `/api/status` | * | 文章数 + 库大小 |
| `/api/admin/logs` | * | 请求日志（分页/分类/IP/方法过滤） |
| `/api/admin/stats` | * | 今日总量、分类统计、高峰时段、分布 |
| `/api/admin/system` | * | CPU、RSS、CGroup 水位、库大小、运行时长、会话数 |
| `/api/admin/devices` | GET | 获取所有受信任设备授权列表 |
| `/api/admin/pair-code` | POST | 后台在线生成 15 分钟临时单次配对码 |
| `/api/admin/revoke-device`| POST | 实时吊销指定设备的远程访问权限 |
| `/api/admin/banned` | GET | 查询当前实时被封禁的 IP 清单与解封倒计时 |
| `/api/admin/unban` | POST | 手动解除指定 IP 的封禁限制 |
| `/api/admin/likes` | GET | 获取全站文章互动获赞统计明细 |

> 🔒 **注**：原 `/api/admin/exec`（执行系统命令）与 `/api/admin/file`（任意路径读取）接口已被彻底移除，二进制内零 `sh -c` 调用，杜绝任何利用博客作为跳板控制 VPS 的风险。

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

post_likes (
  slug TEXT PRIMARY KEY,            -- 文章 slug
  count INTEGER NOT NULL DEFAULT 0, -- 获赞总数
  updated_at TEXT NOT NULL
)

trusted_devices (
  id TEXT PRIMARY KEY,              -- 32 位十六进制设备标识（由服务端安全随机生成）
  device_name TEXT NOT NULL,        -- 设备备注（如「管理员的手机」）
  created_at INTEGER NOT NULL,      -- 配对时间（unix 秒）
  last_active INTEGER NOT NULL,     -- 最近活跃时间
  is_active INTEGER NOT NULL DEFAULT 1 -- 是否有效（0 为已吊销）
)

device_pair_codes (
  code TEXT PRIMARY KEY,            -- 64 位十六进制单次配对令牌
  device_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,      -- 默认 15 分钟失效
  is_used INTEGER NOT NULL DEFAULT 0 -- 单次消费保证（0 未用，1 已用）
)
```

> **数据库索引优化**：
> 已在 SQLite 中全量建立以下高性能索引：
> - `idx_logs_scope_id`：加速公网日志按 ID 倒序分页查询；
> - `idx_logs_timestamp`：加速按时间范围统计与 30/90 天自动修剪；
> - `idx_logs_category`：加速分类统计与恶意行为过滤；
> - `idx_logs_ip`：加速 IP 频率统计与恶意扫描封禁追踪；
> - `idx_likes_slug`：加速文章点赞查询与自增更新；
> - `idx_trusted_devices_active`：加速受信任设备在线鉴权过滤。
> 保证在几十万级数据量下查询与清理依然毫秒级响应。
### `blog_server ctl`：服务端命令行控制台（SSH 专属运维工具）

本项目支持通过 SSH 登录 VPS 或主机后，直接使用 `blog_server ctl` 进行无网关依赖的本地运维与管理：

```bash
# 文章直接管理
blog_server ctl list                                    # 列出全部文章及 ID/Slug
blog_server ctl show <id|slug>                          # 查看指定文章正文与元数据
blog_server ctl new --title "标题" --slug "my-slug"     # 快速新建文章
blog_server ctl edit <id> --title "新标题"              # 编辑已有文章
blog_server ctl rm <id>                                 # 删除文章
blog_server ctl import <dir> [--force]                  # 从 Markdown 目录批量导入

# 可信设备管理与后台配对
blog_server ctl pair [设备备注名]                       # 生成 15 分钟单次配对链接与配对码（如配对手机）
blog_server ctl devices                                 # 查看当前已授权受信任设备列表
blog_server ctl revoke <device_id>                      # 实时吊销指定设备的远程访问权限

# 遥测、日志与互动
blog_server ctl logs [--cat C] [--ip I] [--page N]      # 分类/IP 审计真实访问日志
blog_server ctl likes                                   # 查看全站文章点赞明细与总获赞数
blog_server ctl count                                   # 查看文章总数
```

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
> **注意事项**：
> 1. 找不到 `index.html` → 打印明确错误提示，并终止生成
> 2. 找不到 `<script src="/app.js` 标记 → 控制台给出明确警告提示，避免空壳排查困惑

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

**关于 Slug 与导入机制**：
- 服务端 `POST /api/posts` 与本地命令行 `blog_server ctl new --slug <slug>` 现已支持显式指定自定义 `slug`。
- 若未显式指定，`slugify(title)` 现已全面支持 Unicode/中文 CJK 字符与英文小写归一化，并自动剔除 `?`、`#`、`/` 等 URL 不安全字符；若修改标题，`update_post` 默认锁定已有 `slug`，彻底避免文章 URL 意外变动失效。
- `import_posts`（或 `blog_server ctl import`）工具可直接批量解析 Markdown 文件的 frontmatter，保留既有历史文章的所有固定 URL，并且 `#[path = "../db.rs"]` 复用服务端的 `render_markdown` + `sanitize_html`，保证渲染结果与服务端运行时**完全一致**。

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

`config.toml` 格式不对。必须是**等号两边无引号**的键值对纯文本。
解析器支持 `username` 与 `password_sha256` 两个核心配置项；
若写错键名或缺少等号，服务启动时会在控制台输出明确的 `警告: 发现未识别的键...` 帮助排查手误配置。

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

**为什么扫描或直接访问 `/admin`、`/login` 返回 404？**

这是**设计如此**（404 伪装隐身后台）。为了实现真正的零攻击面，任何未经 SSH 信任配对的外部请求访问 `/admin`、`/login` 或 `/api/admin/*` 均统一返回 `404 Not Found`（绝不返回 401/403），外部扫描器和恶意爬虫完全无法感知管理后台的存在。

若需从手机或外部受信任设备访问后台：
1. 通过 SSH 登录 VPS 终端运行：`blog_server ctl pair 我的手机`
2. 使用该设备浏览器打开生成的 15 分钟单次配对链接
3. 配对成功后顶栏自动常驻「后台」按钮，无缝登录管理控制台。

**为什么移除了 Web 端的命令执行功能？**

为了杜绝任何可能将博客作为提权跳板或执行任意 Shell 命令的系统安全隐患，服务端代码已彻底删除所有 `sh -c` 调用与 `/api/admin/exec` 接口。对 VPS 的系统运维全部回归到经过公私钥强加密的 SSH 终端，最小化攻击暴露面。

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
`blog_ctl build` 若未检测到该标记会给出明确终端警告，避免排查困惑。

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
