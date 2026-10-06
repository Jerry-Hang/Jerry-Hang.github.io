# Windows 部署说明（博客服务器）

本目录是 **Windows 版部署脚本**，对应原有的 Termux/runit 方案（`blog_server.run` / `blog_health.run` / `termux-boot-start.sh`）。

**部署状态：✅ 已完成（2026-09-24）**
**补充完善：✅ 2026-09-26**（公网访问 + 绑核优化 + 日志保留策略，见文末「2026-09-26 补充」）

> ## 📚 相关文档
>
> | 文档 | 内容 |
> |---|---|
> | [README.md](../README.md) | 项目总览、架构、配置项、常见问题 |
> | [README.en.md](../README.en.md) | English README |
> | [docs/部署-Termux安卓.md](../docs/部署-Termux安卓.md) | 手机 Linux / Termux 部署（本文的对应方案） |
> | [docs/CLOUDFLARE_TUNNEL.md](../docs/CLOUDFLARE_TUNNEL.md) | 隧道完整教程 + 三个坑的详细原理 |
> | [docs/SECURITY.md](../docs/SECURITY.md) | 安全模型、**哪些文件绝不能提交**、脱敏实战 |
>
> ⚠️ **本机端口是 8090 / 8091**（不是代码默认的 8080 / 8081），
> 原因见下文「端口为什么是 8090 / 8091」。

---

## 部署结果

| 项目 | 状态 |
|---|---|
| Rust 代码移植到 Windows | ✅ 完成（新增 `src/platform.rs`） |
| `blog_server.exe` 编译 | ✅ 3.5 MB，单文件 |
| 运行数据迁移 | ✅ `blog.db` + `config.toml` 已从手机拷入 |
| 文章恢复 | ✅ 3 篇，slug 与原 URL 一致 |
| 计划任务（开机自启） | ✅ `JerryHang-Blog` 已注册并运行 |
| 看门狗自愈 | ✅ 实测验证（意外重启后 30 秒内自动拉起，多次生效） |
| **公网访问** | ✅ **2026-09-26 打通 `https://jerry-hang.blog`** |
| 绑核配置 | ✅ 2026-09-26 改为 `16-31`（独占 CCD1） |
| 请求日志保留策略 | ✅ 2026-09-26 加入，每天自动清理 |

**访问地址**：
```
公网     : https://jerry-hang.blog      ← 主入口
局域网   : http://192.168.2.162:8090
本机前台 : http://127.0.0.1:8090
管理后台 : http://127.0.0.1:8091        ← 只绑 127.0.0.1，公网访问不到
```

**登录**：`admin` / 见 `config.toml` 注释

> 🔒 **管理后台（8091）只监听 127.0.0.1，公网无法访问**，这是有意的设计。
> 要在外面管理，需要先连回家里的网络（或另开一条隧道指向 8091）。

---

## 📌 文章是怎么恢复的（重要）

从手机拷回来的 `blog.db` **`posts` 表是空的**（0 行），
但 `sqlite_sequence` 显示 `posts` 曾自增到 5 —— 说明文章记录在手机端被删除过。

**文章内容没有丢**，因为它们同时以 Markdown 源文件形式存在于仓库里：

```
frontend/_posts/
├── 2026-08-23-自我介绍.md            → slug: about-me
├── 2026-08-24-Jerry-Hang的自述史.md   → slug: history
└── 2026-08-24-深夜安卓Agent冒险.md    → slug: android-agent
```

**为什么不能直接用后台的「新建文章」功能导入**：

服务端的 `POST /api/posts` 不支持指定 slug —— slug 由 `slugify(title)` 自动生成，
而 `slugify` 只把空格换成 `-`，**不处理中文**。从标题「自我介绍」无法得到 `about-me`，
会导致原来的文章链接全部失效。

**因此写了个专用导入工具**（`src/bin/import_posts.rs`）：

```powershell
cd D:\3D_Work\Blog
.\target\release\import_posts.exe blog.db frontend\_posts
```

它做了两件事：
1. **直接使用 frontmatter 里声明的 slug**，保住原 URL
2. **复用 `db.rs` 的 `render_markdown` + `sanitize_html`**，
   保证渲染结果和 XSS 净化与服务端运行时**完全一致**

导入结果：
```
[新增] 2026-08-23-自我介绍.md            slug=about-me
[新增] 2026-08-24-Jerry-Hang的自述史.md   slug=history
[新增] 2026-08-24-深夜安卓Agent冒险.md    slug=android-agent
完成：成功 3  跳过 0  失败 0
```

> 该工具保留在项目里。以后若再需要从 `_posts` 重建文章，可直接用。
> 加 `--force` 可覆盖同 slug 的已有文章。

---

## 数据文件说明

| 文件 | 内容 | 来源 |
|---|---|---|
| `blog.db` | 文章 + 请求日志（20521 条）+ 会话 | 从手机 MTP 拷入 |
| `config.toml` | 账号 `admin` + 密码哈希 | 从手机 MTP 拷入 |

**这两个文件不在 Git 里**（被 `.gitignore` 排除）。迁移到新机器时要一起带上。

> 本次是从手机 `内部共享存储空间` 根目录通过 MTP 拷贝的
> （手机 OPPO K12s 5G，插 USB 选「传输文件」模式即可在资源管理器看到）。

---

## 目录说明

```
D:\3D_Work\Blog\
├── src\platform.rs          ★ 新增：跨平台抽象层（Win32 / Linux 双实现）
├── src\main.rs              ← 已改：绑核改走 platform 模块
├── src\server.rs            ← 已改：/proc 与 /dev/urandom 改走 platform 模块
├── Cargo.toml               ← 已改：加 getrandom，加 windows-sys（仅 Windows 编译）
├── target\release\blog_server.exe   ← 编译产物（3.5 MB）
├── frontend\                静态前端（含 3 篇博客的静态页）
├── blog.db                  ← 运行时数据（待从手机拷贝）
├── config.toml              ← 账号密码（待从手机拷贝）
├── logs\                    运行日志（自动创建）
└── deploy\
    ├── 启动博客.ps1          ← 启动服务（对应 blog_server.run）
    ├── 看门狗.ps1            ← 每15秒自检 + 挂了拉起（对应 blog_health.run）
    ├── 安装计划任务.ps1      ← 注册开机自启（对应 termux-boot-start.sh）
    ├── 启动博客.bat          ← 双击启动（日常用这个）
    ├── blog_server.run       Termux 原版（保留，手机端仍可用）
    ├── blog_health.run       Termux 原版
    └── termux-boot-start.sh  Termux 原版
```

---

## 日常使用

### 最简单：双击启动

```
D:\3D_Work\Blog\deploy\启动博客.bat
```

服务在后台运行（不占窗口），关掉命令行窗口也不影响。

### 访问地址

| 用途 | 地址 | 说明 |
|---|---|---|
| **博客前台** | `http://127.0.0.1:8090` | 公网只读，匿名可访问 |
| **管理后台** | `http://127.0.0.1:8091` | 需要账号密码 |

### ⚠️ 端口为什么是 8090 / 8091 而不是原来的 8080 / 8081

**因为本机 8080 和 8081 已被 llama.cpp 占用。**

排查时发现本机有 **6 个 llama.cpp 启动脚本全部绑定 8080**（`llama-server` 的默认端口）：

```
D:\Lama\启动脚本.bat                                      --port 8080
D:\Lama\llama-b10775-bin-win-cuda-13.3-x64\启动脚本.bat     --port 8080
D:\Lama\llama-b9297-bin-win-cuda-13.1-x64\启动.bat         --port 8080
D:\Lama\llama_b10752_V0.30_CUDA13.3\启动脚本.bat           --port 8080
D:\Lama\Qwen3.8_27B\启动Bonsai.bat                        --port 8080
D:\Lama\Qwen3.8_27B\启动LFM25.bat                         --port 8080
```

而 **llama-ui 使用 8081** —— 那正好是博客的**管理后台**端口。
两者撞车时极易混淆（可能把博客后台当成 llama-ui，或反之）。

**因此博客改用 8090 / 8091，完全避开 llama.cpp 生态（8080/8081/8082）。**
**没有改动任何 llama.cpp 脚本**，你的原有用法不受影响。

> 如果以后想换回 8080/8081，需要先改掉那 6 个 llama.cpp 脚本的端口，
> 或者关掉 llama-server 再启动博客 —— 但不建议，容易踩坑。

### 停止服务

```powershell
Get-Process blog_server | Stop-Process -Force
```

---

## 全自动部署（推荐）

装一次计划任务，以后**开机自动运行，服务挂了自动拉起**，完全不用管。

**以管理员身份**运行 PowerShell：

```powershell
cd D:\3D_Work\Blog\deploy
.\安装计划任务.ps1
```

它会：
1. 注册计划任务 `JerryHang-Blog`（SYSTEM 账户，最高权限）
2. 触发器：**开机后 30 秒**启动（等磁盘和网络就绪）
3. 看门狗常驻，每 15 秒检查一次 8090 端口
4. **连续 2 次**无响应才重启（避免偶发抖动误判）
5. 崩溃后自动重启（最多 3 次，间隔 1 分钟）
6. 立即启动一次并验证

**其他命令**：

```powershell
.\安装计划任务.ps1 -Status    # 查看运行状态
.\安装计划任务.ps1 -Remove    # 卸载（同时停进程）
```

---

## 日志

```
D:\3D_Work\Blog\logs\
├── server.log           服务输出（超 5MB 自动切分，保留 5 份）
├── server.err.log       服务错误
└── watchdog.log         看门狗动作记录（超 1MB 切分，保留 3 份）
```

看门狗日志示例：
```
[2026-09-24 01:20:15] 看门狗启动（间隔 15s）
[2026-09-24 01:23:30] 本地 8090 无响应（连续第 1 次）
[2026-09-24 01:23:45] 本地 8090 无响应（连续第 2 次）
[2026-09-24 01:23:47] 已拉起博客服务
```

---

## 配置调整

需要改端口/线程数/绑核，编辑：

```
D:\3D_Work\Blog\deploy\config.env.ps1
```

**这个文件已在 2026-09-26 创建**，当前内容：

```powershell
$BLOG_WORKERS        = '8'          # Tokio 工作线程数
$BLOG_CPUS           = '16-31'      # 绑定到第二个 CCD
$BLOG_MAX_CONCURRENT = '2400'       # 并发上限
$BLOG_EXT_ADDR       = '0.0.0.0:8090'
$BLOG_LOCAL_ADDR     = '127.0.0.1:8091'
```

> **关于绑核**：原项目为手机 4 核 A520 设计，默认绑 `0-3`。
> 本机 Ryzen 9 8940HX 是 16 核 32 线程，分两个 CCD
> （CCD0 = 逻辑核 0-15，CCD1 = 逻辑核 16-31）。
>
> 现在博客独占 **CCD1（16-31）**，ComfyUI 出图时吃 CCD0，互不干扰。
> 启动后日志会打印一行确认：
> ```
> cpu affinity set to 16-31 (Windows mask 0xffff0000)
> ```
>
> 如果你用 Process Lasso 给 ComfyUI 指定了别的核心，改 `$BLOG_CPUS` 避开即可。
>
> 注意：Windows 的 `SetProcessAffinityMask` 掩码是 64 位，
> **一个处理器组最多 64 个逻辑核**，超出范围的核会被忽略并给出警告。

**改完需要重启服务生效**：
```powershell
Get-Process blog_server | Stop-Process -Force
```
看门狗会在 15~30 秒内用新配置自动拉起。

---

## 改密码

```powershell
cd D:\3D_Work\Blog
.\target\release\blog_server.exe --hash "你的新密码"
```

把输出的哈希填进 `config.toml` 的 `password_sha256=`，然后重启服务。

---

## 本次移植改了什么

原代码只针对 Android/Termux（Linux），有 4 处平台专属调用。改动如下：

| 原实现 | 位置 | 改用 |
|---|---|---|
| `libc::sched_setaffinity` | `main.rs` | `SetProcessAffinityMask`（Windows）／`libc`（Unix） |
| 读 `/proc/self/status` 取 VmRSS | `server.rs` | `GetProcessMemoryInfo`（Windows）／`/proc`（Unix） |
| 读 `/proc/self/stat` 取 CPU 时间 | `server.rs` | `GetProcessTimes`（Windows）／`/proc`（Unix） |
| 读 `/dev/urandom` 生成会话 token | `server.rs` | `getrandom` crate（跨平台） |

**新增文件**：`src/platform.rs` —— 用 `#[cfg(unix)]` / `#[cfg(windows)]` 条件编译，
Unix 分支保留原实现（手机端行为完全不变），Windows 分支走 Win32 API。

**顺带修正**：`/api/admin/system` 的 CPU 占用率原来硬编码按 4 核归一化，
现改为读 `available_parallelism()`，不同机型都准确。

**Linux 端兼容性**：代码仍可在 Termux 上 `cargo build --release` 编译运行，
手机端部署方式完全不受影响。

---

## 迁移到其它机器

整个 `D:\3D_Work\Blog` 目录拷过去即可，包含：
- 源码（可重新编译）
- `target\release\blog_server.exe`（可直接运行，无需 Rust 环境）
- `frontend\`（静态资源）

**新机器上只需**：
1. 确认 `blog.db` 和 `config.toml` 在位
2. 双击 `deploy\启动博客.bat`
3. （可选）管理员运行 `deploy\安装计划任务.ps1` 做开机自启

---

## 常见问题

**端口被占用**
```powershell
Get-NetTCPConnection -LocalPort 8090,8091 -State Listen |
  Select-Object LocalPort, OwningProcess
```
找到 PID 后 `Stop-Process -Id <PID> -Force`。

**服务起不来**
看 `logs\server.err.log`。最常见原因：`config.toml` 缺失或格式错误。

**计划任务已装但服务没起**
```powershell
Get-ScheduledTaskInfo -TaskName JerryHang-Blog
Start-ScheduledTask -TaskName JerryHang-Blog
```

**想从公网访问**
需要 `cloudflared` 隧道（和手机端方案一样）。**完整教程见
[docs/CLOUDFLARE_TUNNEL.md](../docs/CLOUDFLARE_TUNNEL.md)**，最短路径：

```powershell
winget install Cloudflare.cloudflared
```

然后**不要**用 `cloudflared tunnel login`（本机不可用，原因见本文档
「弯路 1」），改用 API Token 方案：

```powershell
$env:CF_API_TOKEN = "你的token"      # 权限：Tunnel 编辑 + DNS 编辑
cd D:\3D_Work\Blog\deploy
.\配置隧道.ps1
```

> ⚠️ **隧道常驻绝对不要用 `cloudflared service install`。**
> 它装出来的服务以 `LocalSystem` 运行，读不到你的 `~/.cloudflared/config.yml`，
> 结果公网一直 **530**。详见下面「弯路 3」。
> **正确做法是注册计划任务 `Tunnel-Blog`、以用户账户运行**，见
> [docs/CLOUDFLARE_TUNNEL.md](../docs/CLOUDFLARE_TUNNEL.md) 第 5 节。


---

# 2026-09-26 补充

部署后实际运行了几天，发现两个缺口并已修复。

## 一、绑核配置（原来只用了 4 个核）

**问题**：`config.env.ps1` 一直不存在，服务用的是脚本内置默认值 `BLOG_CPUS='0-3'`
——那是原项目给手机 4 核 A520 定的。本机 32 个逻辑核只用了 4 个（12.5%）。

**修复**：创建了 `config.env.ps1`，改为：

| 参数 | 原默认 | 现在 |
|---|---|---|
| `BLOG_CPUS` | `0-3` | **`16-31`**（独占 CCD1） |
| `BLOG_WORKERS` | `4` | **`8`** |

**为什么是 16-31 而不是 0-7**：ComfyUI 出图时会吃满一个 CCD 做采样。
让博客独占另一个 CCD，两者互不抢核。

**验证**：启动日志会打印
`cpu affinity set to 16-31 (Windows mask 0xffff0000)`，看到这行即生效。

## 二、请求日志无限增长

**问题**：`request_logs` 表**只增不减**（源代码里只清理 `sessions`）。
迁移到本机时已有 2 万多条，公网每天又新增约 1400 条。
后果：
- 数据库和 WAL 文件无限增长
- 管理后台 `/api/admin/system` 的「DB」指标一直涨
- 实测 WAL 达到 4.0 MB，**比主库 2.4 MB 还大**（WAL 卡在 autocheckpoint 触发线附近）

**修复**：在 `src/db.rs` 新增两个方法，并在 `src/server.rs` 的
`session_cleanup` 任务里每天执行一次：

```rust
// 保留策略：区分对待，因为安全审计价值和流量噪声不是一个量级
pub fn prune_request_logs(&self) -> usize {
    const NORMAL_RETAIN_DAYS: i64 = 30;    // 正常访问留 30 天
    const SECURITY_RETAIN_DAYS: i64 = 90;  // scan/crawler/blocked/bruteforce 留 90 天
    // ...
}

// 清理后合并 WAL，让主库文件反映真实数据量
pub fn checkpoint_wal(&self) { /* PRAGMA wal_checkpoint(TRUNCATE) */ }
```

**为什么给安全类别更长的保留期**：`scan`（扫描）、`crawler`（爬虫）、
`blocked`（并发拦截）、`bruteforce`（认证爆破）是攻击痕迹，值得多留；
而 `normal` 占了 98% 的行数（25915 / 26466），是纯粹的流量噪声。

**注意首次清理是空的**：数据库里最早的数据是 2026-08-31，
距今约 26 天，没有超过 30 天，所以**第一次运行会删 0 行**。
这是正常的——策略要等数据老过 30 天才开始生效。
真正生效后每天大约清理 1400 行（30 天前的那些）。

**验证方法**：
```powershell
# 看有没有清理动作（每天一次）
Select-String -Path D:\3D_Work\Blog\logs\server.err.log -Pattern 'pruned'
```

## 三、备份

> **2026-09-26 晚更新：这两个备份文件已经不存在了。**

改动前曾备份过 `blog.db.bak-before-prune` 和 `blog.db.bak-scope`。
它们在 2026-09-26 的仓库脱敏中被处理掉，原因见
[docs/SECURITY.md](../docs/SECURITY.md)：

**它们被误提交进了 Git 的 15 个提交里。** 数据库备份包含
`request_logs`（全部访客 IP）和 `sessions`（有效登录 token），
一旦推送就等于公开泄露。

处理方式：

1. 用 `git filter-branch --index-filter` 从**全部历史**中移除这两个文件
2. 清理 `refs/original/*`、reflog，然后 `git gc --prune=now`
3. 验证 `git cat-file -t <旧提交SHA>` 返回 `fatal: Not a valid object name`
4. 在 `.gitignore` 里补上 `*.db.bak*`、`*.bak`、`*.bak-*`
   （**原来的 `*.db` 规则抓不住 `.bak-before-prune` 这种命名**）

**现在 `blog.db` 的备份策略**：不要再用 `blog.db.bak-*` 这种名字放进仓库目录。
放到仓库外面，或者用带时间戳的独立目录：

```powershell
# 推荐：备份到仓库目录之外
$bak = "D:\BlogBackups\blog-$(Get-Date -Format 'yyyyMMdd_HHmmss').db"
New-Item -ItemType Directory -Force -Path (Split-Path $bak) | Out-Null
Copy-Item D:\3D_Work\Blog\blog.db $bak
```

> SQLite 开着 WAL，**热备份要连 `-wal` 和 `-shm` 一起拷**，
> 或者用 `sqlite3 blog.db ".backup '备份路径'"` 更稳妥。

## 四、重新编译的注意事项

⚠️ **编译前必须先停掉服务和看门狗**，否则 `blog_server.exe` 被占用，
cargo 会报 `failed to remove ... 拒绝访问 (os error 5)`：

```powershell
# 1. 停计划任务（否则它会不停重启看门狗）
Stop-ScheduledTask -TaskName "JerryHang-Blog"

# 2. 停进程
Get-Process blog_server | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*看门狗.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 3. 编译
cd D:\3D_Work\Blog
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cargo build --release

# 4. 恢复
Start-ScheduledTask -TaskName "JerryHang-Blog"
```

> 小心：用 `CommandLine -like '*看门狗*'` 过滤进程时，
> **你自己的查询命令里也含这三个字，会把自己匹配进去然后杀掉**。
> 要匹配具体脚本名 `*看门狗.ps1*`，而且别在同一个命令里既过滤又终止。

---

# 公网访问（cloudflared 隧道）

**状态：✅ 2026-09-26 完成**

## 最终结构

```
浏览器
   ↓  https://jerry-hang.blog
Cloudflare 边缘（自动 HTTPS 证书）
   ↓  隧道（QUIC，出站长连接，不需要开放任何端口）
cloudflared 服务（本机）
   ↓  http://127.0.0.1:8090
blog_server（本机）
```

**出站隧道的好处**：家里路由器**不用做端口映射**，公网也扫不到你的 IP。

## 关键配置

| 项目 | 值 |
|---|---|
| 隧道名 | `myblog`（复用手机端建的那个） |
| 隧道 ID | `ff619622-f033-4a47-9806-0b5edc79a29d` |
| 配置文件 | `C:\Users\Jerry-Huang\.cloudflared\config.yml` |
| 凭据文件 | `C:\Users\Jerry-Huang\.cloudflared\ff619622-....json` |
| DNS | `jerry-hang.blog` → CNAME → `<隧道ID>.cfargotunnel.com`（橙云代理） |
| **自启方式** | **计划任务 `Tunnel-Blog`**（登录后 30 秒启动，用户账户运行） |
| 启动脚本 | `D:\3D_Work\Blog\deploy\启动隧道.ps1` |
| 日志 | `D:\3D_Work\Blog\logs\tunnel.log` / `tunnel.err.log` |

`config.yml` 内容：
```yaml
tunnel: ff619622-f033-4a47-9806-0b5edc79a29d
credentials-file: C:\Users\Jerry-Huang\.cloudflared\ff619622-f033-4a47-9806-0b5edc79a29d.json

ingress:
  - hostname: jerry-hang.blog
    service: http://127.0.0.1:8090
  - service: http_status:404
```

> ⚠️ **注意 `service` 是 8090，不是 8080。**
> 手机端的配置写的是 `http://localhost:8080`，但本机 8080 被 llama.cpp 占着，
> 博客实际在 8090。照搬手机端配置会一直 502。

## 走过的弯路（下次别重走）

### 弯路 1：`cloudflared tunnel login` 在这台机器上不可用

```
ERR Failed to write the certificate.
Your browser will download the certificate instead...
error="Failed to fetch resource"
```

原因：`cloudflared` 拿授权后要回调本机取证书，但
`dash.cloudflare.com` 对非浏览器请求返回 **403 managed challenge**
（响应头 `Cf-Mitigated: challenge`，"Just a moment..." 人机验证页）。
浏览器能过，cloudflared 过不去，所以证书永远拿不到。

**改用 API Token 方案**，完全绕开浏览器授权：
用 token 调 API 取隧道凭据，自己组装成 JSON 文件即可，不需要 `cert.pem`。

### 弯路 2：PowerShell 写的 JSON 带 BOM，cloudflared 解析失败

```
ERR The credentials file ... contained invalid JSON.
ERR Invalid JSON when parsing credentials file: invalid character '茂' looking for beginning of value
```

`Set-Content -Encoding UTF8` 在 PowerShell 5.1 里**会写 BOM**，
而 cloudflared 的 JSON 解析器不认 BOM（报错里那个"茂"就是 BOM 字节被误读）。

**正确写法**（不带 BOM）：
```powershell
[System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
```

`config.yml` 也一并去掉 BOM，虽然 YAML 一般能容忍。

### 弯路 3：`cloudflared service install` 装出来的服务**根本连不上隧道**

这是最坑的一个，表现为**公网返回 HTTP 530**（Cloudflare error 1016，边缘找不到源站）：

```
服务 ImagePath : "C:\...\cloudflared.exe"        ← 没有任何参数
服务运行账户    : LocalSystem
cloudflared 找配置: C:\Windows\System32\config\systemprofile\.cloudflared\config.yml  ← 不存在
配置实际在      : C:\Users\Jerry-Huang\.cloudflared\  ← LocalSystem 不读这里
结果           : 隧道状态 down，公网 530
```

三个问题叠加：
1. **服务以 LocalSystem 运行**，它的 `~` 是 `C:\Windows\System32\config\systemprofile\`，
   不是你的用户目录，所以读不到 `config.yml`
2. **`--config` 参数不会被写进服务的 ImagePath**，试过 `cloudflared --config X service install`，
   装出来的 ImagePath 依然只有 exe 路径
3. 把配置复制到 systemprofile 下**没用**，而且这个服务停止时会卡死
   （`sc stop` 报 `1061: The service cannot accept control messages at this time`）

**改用计划任务方案**（和博客看门狗同一个套路，已验证可靠）：
用 `启动隧道.ps1` 显式指定 `--config` 和隧道 ID，注册成计划任务、
以用户账户运行，这样就用自己的 `~/.cloudflared/` 目录了。

## 常用命令

```powershell
# 看隧道状态
Get-Process cloudflared
Get-ScheduledTask -TaskName Tunnel-Blog | Select-Object TaskName, State

# 重启隧道（先杀进程，任务的重启策略会拉起来；或直接重启任务）
Stop-Process -Name cloudflared -Force
Start-ScheduledTask -TaskName Tunnel-Blog

# 看日志
Get-Content D:\3D_Work\Blog\logs\tunnel.log -Tail 20
Get-Content D:\3D_Work\Blog\logs\tunnel.err.log -Tail 20   # 连接信息在这

# 隧道健康时应看到
#   Registered tunnel connection ... location=lax01 protocol=quic
```

## 以后想再建一条隧道（比如指向别的服务）

用 `deploy\配置隧道.ps1`，它已经处理好了 BOM 和 Account ID 的问题：

```powershell
$env:CF_API_TOKEN = "你的token"
cd D:\3D_Work\Blog\deploy
.\配置隧道.ps1                                  # 默认建 blog.jerry-hang.blog -> 8090
.\配置隧道.ps1 -Subdomain admin -Origin http://127.0.0.1:8091   # 换个目标
```

**需要的 API Token 权限**（两条都要）：
- `账户` → `Cloudflare Tunnel` → `编辑`
- `区域` → `DNS` → `编辑`

> ⚠️ 新隧道建好后，别忘了同步改 `启动隧道.ps1` 里的 `$BLOG_TUNNEL_ID`。

## 安全提醒

隧道建好后，**那个 API Token 就不再需要了**（隧道靠自己的凭据文件运行，
和 token 完全无关）。建议去
https://dash.cloudflare.com/profile/api-tokens 把它 **Delete** 掉。

> Cloudflare 不允许 token 自删（API 返回 `9109 Unauthorized to access requested resource`），
> 所以必须手动去网页删。

另外：管理后台 8091 只绑 `127.0.0.1`，公网访问不到，
所以即使有人知道 `https://jerry-hang.blog` 也进不了后台。

## 公开前的安全检查

现在 `https://jerry-hang.blog` 是**任何人在公网都能访问**的。确认这几件事：

| 检查项 | 状态 |
|---|---|
| 管理后台不对外（只绑 127.0.0.1） | ✅ |
| `config.toml` 里密码不是默认值 | ⚠️ 需要你确认 |
| 文章内容可以公开 | ⚠️ 需要你确认 |
| 请求日志会记录访客 IP | 说明：这是原项目自带的安全监控功能 |
