# 手机 Linux（Android / Termux）部署教程

> 平台：Android 7.0+ / Termux
> 目标：把博客服务做成**开机自启 + 崩溃自愈 + 公网可访问**的常驻服务
> 对应脚本：`deploy/blog_server.run`、`deploy/blog_health.run`、`deploy/termux-boot-start.sh`

---

## 目录

- [0. 为什么用手机当服务器](#0-为什么用手机当服务器)
- [1. 环境准备](#1-环境准备)
- [2. 编译](#2-编译)
- [3. 生成密码哈希](#3-生成密码哈希)
- [4. 先手动跑通](#4-先手动跑通)
- [5. 用 runit 托管（崩溃自动重启）](#5-用-runit-托管崩溃自动重启)
- [6. 看门狗（服务/隧道双自愈）](#6-看门狗服务隧道双自愈)
- [7. 开机自启（Termux:Boot）](#7-开机自启termuxboot)
- [8. 公网访问](#8-公网访问)
- [9. 日常运维命令](#9-日常运维命令)
- [10. 省电与后台存活](#10-省电与后台存活)
- [11. 故障排查](#11-故障排查)

---

## 0. 为什么用手机当服务器

这个项目的设计前提就是**没有云服务器**：

| 方案 | 成本 | 常驻 | 公网 |
|---|---|---|---|
| 云服务器 | 每月几十元 | 要自己维护 | 要备案/配证书 |
| **旧手机 + Termux** | 0（闲置设备） | 插着电就一直跑 | Cloudflare 隧道，免备案免证书 |

一台闲置安卓手机的算力对个人博客**绰绰有余**——这个服务是 IO 密集型（静态文件 + SQLite），
实测在 4 核 A520 上编译只要几分钟，运行时 CPU 几乎空转。

三个必须理解的前提：

1. **手机不会被系统杀掉**——需要 Termux 唤醒锁 + 关掉电池优化，见 [第 10 节](#10-省电与后台存活)。
2. **公网靠隧道，不靠端口映射**——`cloudflared` 主动向 Cloudflare 建**出站长连接**，
   所以你**不需要**公网 IP、不需要路由器端口映射、家里 IP 也不会暴露。
3. **管理后台永远不对外**——后台只绑 `127.0.0.1`，公网扫不到。要管理就 SSH 进手机，或用 Termux 本地浏览器。

---

## 1. 环境准备

### 1.1 安装 Termux

**不要从 Google Play 装**——那个版本早已停止更新，`pkg` 源全是 404。

从 [F-Droid](https://f-droid.org/packages/com.termux/) 或
[GitHub Releases](https://github.com/termux/termux-app/releases) 下载 APK。

> ⚠️ 从 F-Droid 装的 Termux 和从 GitHub 装的**签名不同，不能互相覆盖安装**。
> 选一个来源就别换了，否则要卸载重装、数据全丢。

### 1.2 换源并更新

国内网络直连 Termux 官方源很慢，先换清华镜像：

```bash
termux-change-repo
# 交互界面里选「Mirrors by Tsinghua」→ 全选 → 确定
```

或者直接写文件（`$PREFIX` 在 Termux 里就是 `/data/data/com.termux/files/usr`）：

```bash
echo "deb https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main stable main" > $PREFIX/etc/apt/sources.list
pkg update -y && pkg upgrade -y
```

> 第一次 `pkg upgrade` 会问你要不要覆盖配置文件，一路回车用默认（保留现有配置）即可。

### 1.3 装依赖

```bash
pkg install -y rust binutils clang git openssl pkg-config
```

逐个说明为什么要装：

| 包 | 作用 | 不装的后果 |
|---|---|---|
| `rust` | `cargo` + `rustc` | 没编译器 |
| `binutils` | `ar`、`ld` | 链接阶段报 `ar: not found` |
| `clang` | C 编译器 | `rusqlite` 的 bundled SQLite 是 C 代码，编不过 |
| `git` | 拉代码、`blog_ctl push` 要用 | — |
| `openssl` + `pkg-config` | 某些 crate 的构建脚本探测 TLS | 报 `Could not find directory of OpenSSL installation` |

**验证**：

```bash
rustc --version    # 需要 1.85+（本项目用 edition 2024）
cargo --version
clang --version
```

> Rust 版本不够的话：`pkg install rust` 通常已经够新。
> 如果还是旧版，用 `rustup` 管理工具链在 Termux 上比较折腾，建议先试官方源。

---

## 2. 编译

```bash
cd ~
git clone https://github.com/Jerry-Hang/Jerry-Hang.github.io.git blog
cd blog
```

**手机内存小，一定要限制并行任务数**，否则会被系统 OOM 杀掉，而且报错信息往往很迷惑
（`signal: 9, SIGKILL` 或者干脆没输出）：

```bash
cargo build --release --jobs 1
```

首次编译要拉 `tokio`/`axum`/`rusqlite` 等依赖，在 4 核手机上大约 **5~15 分钟**。

> **加速**：配置国内 crates 镜像。在 `~/.cargo/config.toml` 写：
>
> ```toml
> [source.crates-io]
> replace-with = 'rsproxy-sparse'
>
> [source.rsproxy-sparse]
> registry = "sparse+https://rsproxy.cn/index/"
>
> [registries.rsproxy]
> index = "https://rsproxy.cn/crates.io-index"
>
> [net]
> git-fetch-with-cli = true
> ```
>
> 最后那行 `git-fetch-with-cli` 很重要：某些依赖用 git 源，
> 走 libgit2 在手机上容易卡死。

编译产物：

```
target/release/blog_server     ← 主服务
target/release/import_posts    ← 从 Markdown 批量导入文章（见下）
```

### 2.1 如果文章需要从 Markdown 重建

`blog.db` 里没有文章时（比如换了新机器、或数据库损坏），可以从 `frontend/_posts/` 恢复：

```bash
cd ~/blog
./target/release/import_posts blog.db frontend/_posts
```

输出形如：

```
[新增] 2026-08-23-自我介绍.md            slug=about-me
[新增] 2026-08-24-Jerry-Hang的自述史.md   slug=history
[新增] 2026-08-24-深夜安卓Agent冒险.md     slug=android-agent
完成：成功 3  跳过 0  失败 0
```

**为什么必须用这个工具，而不是后台上传**：

服务端的 `POST /api/posts` **不允许指定 slug**——slug 由 `slugify(title)` 生成，
而 `slugify` 只把空格换成 `-`，**不处理中文**。标题「自我介绍」推不出 `about-me`，
结果就是**原有文章链接全部失效**。

`import_posts` 直接读 frontmatter 里声明的 `slug`，保住 URL；并且它
`#[path = "../db.rs"]` 直接复用服务端的 `render_markdown` + `sanitize_html`，
保证**渲染和 XSS 净化结果与服务端运行时完全一致**。

加 `--force` 可以覆盖同 slug 的已有文章。

---

## 3. 生成密码哈希

密码**从不明文存盘**。`config.toml` 里只放 SHA-256 哈希。

```bash
cd ~/blog
./target/release/blog_server --hash '你的强密码'
```

输出一串 64 位十六进制，例如：

```
3f8a2b...（64 位）
```

写进 `config.toml`：

```bash
cat > ~/blog/config.toml <<'EOF'
# 本文件含密码哈希，已被 .gitignore 排除，绝对不要提交
username = admin
password_sha256 = 把上一步的输出粘到这里
EOF
```

> ⚠️ **这个文件千万不要提交到 Git。** 见 [SECURITY.md](SECURITY.md)。
>
> **改密码**：重新跑 `--hash`，把新哈希覆盖进 `config.toml`，重启服务即可。
> 已登录的会话不会失效（token 存在 `sessions` 表里），要踢掉就删表或等 7 天过期。

> **注意**：`config.toml` 不存在时服务会**自动生成**一个默认文件，
> 默认密码是 `change-me-on-first-login`。这很方便，但也意味着
> **你必须在服务对外之前改掉它**。改成别的用户名同理（`username=` 那一行）。

---

## 4. 先手动跑通

**不要一上来就装 runit**。先手动前台启动，确认能跑通：

```bash
cd ~/blog

export BLOG_ROOT="$PWD/frontend"
export BLOG_DB="$PWD/blog.db"
export BLOG_CONFIG="$PWD/config.toml"
export BLOG_EXT_ADDR="0.0.0.0:8090"        # 公网/局域网只读口
export BLOG_LOCAL_ADDR="127.0.0.1:8091"    # 管理口，只绑回环
export BLOG_WORKERS=4                       # 按手机核数调，4 核就写 4
export BLOG_CPUS="0-3"                      # 绑到哪些核
export BLOG_MAX_CONCURRENT=2400             # 并发上限，超了返 503

./target/release/blog_server
```

看到这几行就成功了（Rust 侧全部走 `eprintln!`，所以是 **stderr**）：

```
cpu affinity set to 0-3
external 0.0.0.0:8090 (tunnel), local 127.0.0.1:8091 (management)
serving /data/data/com.termux/files/home/blog/frontend, gate=2400, db=.../blog.db
```

**验证**（另开一个 Termux 会话，或按 `Ctrl+C` 前先在浏览器试）：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8090/     # 期望 200
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8091/     # 期望 302（跳登录页）
```

> **为什么 8091 返回 302 而不是 200 才是对的**：
> 管理首页要求登录，未登录会被重定向到 `/login`。
> 如果 8091 返回 **200**，说明认证没生效——这是严重问题，别对外发布。
>
> **为什么端口是 8090/8091 而不是代码默认的 8080/8081**：
> 纯属这台机器的历史原因（8080/8081 被 llama.cpp 占了）。
> 你在手机上用**默认的 8080/8081 完全没问题**，脚本里改成对应值即可。

### 4.1 后台在哪

管理后台只绑 `127.0.0.1`。手机上直接用 Termux 的浏览器打开
`http://127.0.0.1:8091/`，输入第 3 节设的账号密码。

**从电脑管理**（推荐，屏幕大）：

```bash
# 手机侧：装 sshd
pkg install -y openssh
sshd
whoami        # 记住这个用户名，电脑上要用
passwd        # 设一个 SSH 密码
```

然后在电脑上建 SSH 隧道（**PowerShell / 终端**）：

```bash
ssh -N -L 8091:127.0.0.1:8091 -p 8022 u0_a123@192.168.1.50
```

- `-N` 只转发不开 shell
- `-L 8091:127.0.0.1:8091` 把**手机的** 8091 映射到**电脑的** 8091
- `8022` 是 Termux sshd 的默认端口（不是 22）
- `u0_a123` 换成 `whoami` 的输出，`192.168.1.50` 换成手机 IP

保持这个窗口开着，电脑浏览器访问 `http://127.0.0.1:8091/` 就是手机上的后台。

> **为什么不用 `ssh -L 8091:127.0.0.1:8091` 直接连手机 IP 上的 8091？**
> 因为服务**只绑回环**，从局域网访问手机的 `192.168.1.50:8091` 是连不上的——
> 这正是设计意图。必须用 SSH 隧道从手机内部访问。

---

## 5. 用 runit 托管（崩溃自动重启）

手动启动的进程一关 Termux 就没了。用 `termux-services`（runit）托管。

### 5.1 装 termux-services

```bash
pkg install -y termux-services
```

装完**必须重启 Termux**（完全退出 App 再打开），否则 `SVDIR` 环境变量不生效。

重启后验证：

```bash
echo $SVDIR
# 期望：/data/data/com.termux/files/usr/var/service
```

### 5.2 装服务脚本

先把仓库里的脚本复制过去：

```bash
mkdir -p $PREFIX/var/service/blog_server
cp ~/blog/deploy/blog_server.run $PREFIX/var/service/blog_server/run
chmod +x $PREFIX/var/service/blog_server/run
```

**但默认脚本里的路径是 `$PWD`（当前目录）**，runit 启动时 `$PWD` 是 `/`，
所以**必须改成绝对路径**：

```bash
cat > $PREFIX/var/service/blog_server/run <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
# runit 服务脚本：进程退出 runit 立刻拉起，所以这里用 exec 让 blog_server
# 直接成为 runit 的子进程（少一层 shell，信号能正确传递）

export BLOG_ROOT="/data/data/com.termux/files/home/blog/frontend"
export BLOG_DB="/data/data/com.termux/files/home/blog/blog.db"
export BLOG_CONFIG="/data/data/com.termux/files/home/blog/config.toml"

export BLOG_WORKERS="${BLOG_WORKERS:-4}"
export BLOG_CPUS="${BLOG_CPUS:-0-3}"
export BLOG_MAX_CONCURRENT="${BLOG_MAX_CONCURRENT:-2400}"
export BLOG_EXT_ADDR="0.0.0.0:8090"
export BLOG_LOCAL_ADDR="127.0.0.1:8091"

# 拿唤醒锁：防止 CPU 休眠把服务冻住。失败也不影响启动
termux-wake-lock || true

exec /data/data/com.termux/files/home/blog/target/release/blog_server
EOF
chmod +x $PREFIX/var/service/blog_server/run
```

**两个关键点**：

1. **`exec`** —— 让 `blog_server` 直接替换掉 shell，成为 runit 的子进程。
   不写 `exec` 的话 runit 管的是 bash，bash 再管 blog_server，
   信号传递会多一层、`sv status` 也看不准。
2. **绝对路径** —— runit 的工作目录不是你的 home。

### 5.3 启动并设为自启

```bash
sv-enable blog_server     # 设为自启（建 $SVDIR/blog_server/down → 删掉它）
sv up blog_server         # 立刻启动
sv status blog_server     # 查看状态
```

`sv status` 输出 `run: blog_server: (pid 12345) 5s` 就是正常运行。

> **`sv-enable` 做了什么**：runit 用 `$SVDIR/<svc>/down` 这个**文件的存在与否**
> 表示"是否自启"。`sv-enable` 就是删掉 `down` 文件。
> 所以 `sv down` = 停服务但保留自启；`sv-disable` = 取消自启。

### 5.4 日志去哪了

runit 把服务输出交给 `svlogd`，默认在：

```bash
ls $SVDIR/blog_server/log/
tail -f $SVDIR/blog_server/log/current
```

如果那个目录不存在，说明 `termux-services` 没配日志服务，
可以直接看 runit 的控制台输出（`sv status` 旁边会有提示），
或者自己加一个 `log/run`：

```bash
mkdir -p $PREFIX/var/service/blog_server/log
cat > $PREFIX/var/service/blog_server/log/run <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
exec svlogd -tt /data/data/com.termux/files/home/blog/logs
EOF
chmod +x $PREFIX/var/service/blog_server/log/run
```

> `-tt` 让 svlogd 给每行加 `TAI64N` 时间戳。
> 日志目录要**先建好**，svlogd 不会自动创建。

---

## 6. 看门狗（服务/隧道双自愈）

runit 只能保证"**进程死了**就拉起"。它管不了这种情况：

> 进程活着、端口也通，但**隧道掉线**了——公网返回 530 / 502。

所以要再加一个看门狗，同时检查**本地端口**和**公网可达性**。

```bash
mkdir -p $PREFIX/var/service/blog_health
cp ~/blog/deploy/blog_health.run $PREFIX/var/service/blog_health/run
chmod +x $PREFIX/var/service/blog_health/run
```

先看仓库里那份，再按需改成绝对路径：

```bash
cat > $PREFIX/var/service/blog_health/run <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
# 每 15 秒自检一次：
#   本地 8090 不通      → sv restart blog_server
#   本地通但公网 530/502 → 重启 cloudflared（隧道假死）
#   本地通且公网正常     → 什么都不做
# 日志超 5MB 滚动，保留最近 5 份

LOG_DIR="/data/data/com.termux/files/home/blog/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/health.log"
PUBLIC_URL="https://jerry-hang.blog/"
LOCAL_URL="http://127.0.0.1:8090/"

rotate() {
  [ -f "$LOG" ] || return
  size=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
  if [ "$size" -gt 5242880 ]; then
    mv "$LOG" "$LOG.$(date +%Y%m%d_%H%M%S)"
    ls -1t "$LOG".* 2>/dev/null | tail -n +6 | xargs -r rm -f
  fi
}

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

log "看门狗启动"

while true; do
  sleep 15
  rotate

  local_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$LOCAL_URL" 2>/dev/null)

  if [ "$local_code" != "200" ] && [ "$local_code" != "302" ]; then
    log "本地 8090 无响应（$local_code），重启 blog_server"
    sv restart blog_server
    sleep 10
    continue
  fi

  pub_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PUBLIC_URL" 2>/dev/null)
  case "$pub_code" in
    200|301|302|403|404) : ;;                 # 边缘正常
    000|502|503|530)                          # 隧道挂了
      log "本地正常但公网异常（$pub_code），重启 cloudflared"
      pkill -f cloudflared 2>/dev/null
      sleep 3
      sv restart cloudflared 2>/dev/null || \
        (nohup cloudflared tunnel --config "$HOME/.cloudflared/config.yml" run myblog >> "$LOG_DIR/tunnel.log" 2>&1 &)
      ;;
    *)  log "公网返回 $pub_code，暂不处理" ;;
  esac
done
EOF
chmod +x $PREFIX/var/service/blog_health/run

sv-enable blog_health
sv up blog_health
sv status blog_health
```

> **为什么公网 403/404 也算"正常"**：
> 那说明**隧道通了**（Cloudflare 边缘成功把请求转给了源站），
> 只是这个具体路径没有内容。真正要修的是 `000`（连不上）、
> `502`（边缘连不到源站）、`530`（Cloudflare 错误 1016，找不到隧道）。
> 把 403/404 混进来会导致**隧道被无意义地反复重启**。

---

## 7. 开机自启（Termux:Boot）

### 7.1 装 Termux:Boot

从 [F-Droid](https://f-droid.org/packages/com.termux.boot/) 装（同样别从 Play 装）。

装完**至少手动打开一次**这个 App，否则它的广播接收器不会注册。

### 7.2 装开机脚本

```bash
mkdir -p ~/.termux/boot
cp ~/blog/deploy/termux-boot-start.sh ~/.termux/boot/start_blog.sh
chmod +x ~/.termux/boot/start_blog.sh
```

仓库里那份内容：

```bash
#!/data/data/com.termux/files/usr/bin/bash
export SVDIR=/data/data/com.termux/files/usr/var/service
export PREFIX=/data/data/com.termux/files/usr
termux-wake-lock
if ! pgrep -f '/usr/bin/runsvdir' >/dev/null 2>&1; then
  service-daemon start          # runit 超级守护进程没起就起来
fi
sleep 8                          # 等文件系统和网络就绪
sv up blog_server
sv up blog_health
termux-notification --title "JerryHang 博客" \
  --content "博客服务已启动 ✅" --priority high 2>/dev/null || true
```

**逐行解释**：

| 行 | 为什么需要 |
|---|---|
| `export SVDIR` / `PREFIX` | 开机脚本的执行环境**不加载** `.bashrc`，这些变量必须自己设 |
| `termux-wake-lock` | 拿 CPU 唤醒锁，否则系统休眠会把服务冻住 |
| `pgrep runsvdir` | 幂等保护，避免重复启动 runsvdir |
| `sleep 8` | 开机瞬间存储和网络还没就绪，太早启动会读不到 `blog.db` |
| `sv up` | 启动服务（`sv-enable` 已经设过自启，这里是双保险） |
| `termux-notification` | 给你一个"开机成功了"的可见反馈，**排查时非常有用** |

### 7.3 必须做的系统设置

**不开这些，手机厂商的省电策略会在几分钟内把 Termux 杀掉。**

以 OPPO / ColorOS 为例（其他品牌选项名类似）：

1. 设置 → 应用 → 应用管理 → **Termux** → 耗电管理 → **允许后台完全行为** / **允许自启动**
2. 设置 → 电池 → **关闭省电模式**（或把 Termux 加进"不受限制"白名单）
3. 设置 → 应用 → Termux → 电池 → **不受限制**
4. **Termux:Boot** 同样设置一遍（它自己要能开机启动）
5. 最近任务列表里**锁定 Termux**（下拉卡片 → 点锁图标），防止一键清理杀掉

> 不同品牌入口不同：小米叫「自启动」+「省电策略：无限制」，
> 华为叫「应用启动管理 → 手动管理」全开，三星叫「未监视的应用」。
> **原则就一句：凡是跟"省电""后台限制""自启动"有关的开关，全部放开。**

---

## 8. 公网访问

手机侧到这里就绪了。**隧道部分两个平台完全一样**，见
[CLOUDFLARE_TUNNEL.md](CLOUDFLARE_TUNNEL.md)。

最短路径（在手机的 Termux 里跑）：

```bash
pkg install -y cloudflared

cloudflared tunnel login                    # 浏览器授权，回调拿证书
cloudflared tunnel create myblog            # 建隧道，记下输出的隧道 ID
cloudflared tunnel route dns myblog 你的域名  # 建 CNAME

# 写配置
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml <<EOF
tunnel: 你的隧道ID
credentials-file: $HOME/.cloudflared/你的隧道ID.json

ingress:
  - hostname: 你的域名
    service: http://127.0.0.1:8090
  - service: http_status:404
EOF

# 前台测试
cloudflared tunnel --config ~/.cloudflared/config.yml run 你的隧道ID
```

通了之后按第 6 节的做法，把 `cloudflared` 也交给 runit 托管，
看门狗就会自动重启它。

> ⚠️ **`service` 一定要写服务实际监听的端口。**
> 写错了的表现是**公网一直 502**，而本地 `curl 127.0.0.1:8090` 完全正常——
> 这个组合最能说明问题就出在隧道的 `ingress` 配置上。

---

## 9. 日常运维命令

```bash
# —— 服务状态 ——
sv status blog_server
sv status blog_health
pgrep -af cloudflared

# —— 重启 ——
sv restart blog_server
sv restart cloudflared

# —— 停止 / 启动 ——
sv down blog_server
sv up blog_server

# —— 取消 / 恢复自启 ——
sv-disable blog_server
sv-enable  blog_server

# —— 日志 ——
tail -f $SVDIR/blog_server/log/current        # runit 日志
tail -f ~/blog/logs/health.log                # 看门狗日志
tail -f ~/blog/logs/tunnel.log                # 隧道日志

# —— 端口检查（手机上没 ss 的话用这个）——
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8090/
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8091/

# —— 公网检查 ——
curl -s -o /dev/null -w "%{http_code}\n" https://你的域名/

# —— 数据库概况 ——
sqlite3 ~/blog/blog.db "select count(*) from posts;"
sqlite3 ~/blog/blog.db "select count(*) from request_logs;"
sqlite3 ~/blog/blog.db "select count(*) from sessions;"

# —— 数据库完整性（怀疑掉电损坏时）——
sqlite3 ~/blog/blog.db "pragma integrity_check;"

# —— 改密码 ——
~/blog/target/release/blog_server --hash '新密码'    # 把输出填进 config.toml
sv restart blog_server
```

---

## 10. 省电与后台存活

### 唤醒锁

```bash
termux-wake-lock      # 拿锁（服务脚本里已有）
termux-wake-unlock    # 释放
```

唤醒锁会让通知栏常驻一条「Termux 正在运行」。**这是正常的，别去点掉它**——
点掉等于释放锁，服务会被系统冻住。

### 编译期特别提示

手机编译时 CPU 会满载，**发热明显**。建议：

- 插上充电器（编译很耗电）
- 别在太阳直晒或被子捂着的地方编
- 用 `--jobs 1`，热量更平缓（同时也避免 OOM）

### 数据库写入与掉电

服务开了 **WAL 模式**（`PRAGMA journal_mode=WAL`），
崩溃/掉电**不会损坏数据库**，这是选它的主要原因。

但 WAL 文件会一直长大。默认 `wal_autocheckpoint` 是 1000 页（约 4MB），
本项目额外做了两件事（`src/db.rs`）：

- 每 24 小时 `prune_request_logs()`：正常日志留 30 天，
  `scan`/`crawler`/`blocked`/`bruteforce` 这类安全记录留 90 天
- 紧接着 `checkpoint_wal()`：`PRAGMA wal_checkpoint(TRUNCATE)`，把 WAL 合并回主库

> **第一次运行会删 0 行**，这是正常的——
> 策略要等数据"老过 30 天"才开始生效。

---

## 11. 故障排查

### 编译被 OOM 杀掉

**症状**：`cargo build` 中途无输出退出，或 `signal: 9, SIGKILL`。

```bash
cargo build --release --jobs 1
```

还不够就临时关掉其他 App，或者加 swap（需要 root）。

### `ar: not found` / `clang: not found`

```bash
pkg install -y binutils clang
```

### `error: linker 'cc' not found`

```bash
pkg install -y clang
ln -sf $PREFIX/bin/clang $PREFIX/bin/cc    # 有些 crate 硬找 cc
```

### 服务起不来，日志说 `password_sha256 is empty`

`config.toml` 格式不对。检查：

```bash
cat ~/blog/config.toml
```

必须是**等号两边无引号**的纯文本：

```
username = admin
password_sha256 = 64位十六进制
```

解析器只认这两个键，其他键**静默忽略**（不报错，容易误以为生效了）。

### `database is locked`

同时有两个进程打开了同一个 `blog.db`。WAL 模式允许多读一写，但**不允许两个写**。

```bash
pgrep -af blog_server    # 应该只有一个
```

多出来的杀掉，然后 `sv restart blog_server`。

### 绑核没生效

```bash
cat /proc/$(pgrep -f blog_server)/status | grep Cpus_allowed_list
```

部分安卓的 cgroup 会钳制亲和性设置，这是**宿主限制，不是 bug**。
代码里的 `sched_setaffinity` 是**尽力而为**：失败只在 stderr 打警告，不会中止启动。

### 公网 530 / 502

| 现象 | 含义 | 处理 |
|---|---|---|
| **530** | Cloudflare 找不到隧道（error 1016） | 隧道进程挂了 → `pgrep -af cloudflared`，重启 |
| **502** | 边缘连不到源站 | 隧道在跑但 `ingress` 的 `service` 端口写错了，或博客没起 |
| **本地正常 + 公网 502** | 几乎一定是 `ingress` 端口写错 | 核对 `config.yml` 里的 `service:` |

```bash
cloudflared tunnel list        # 看隧道的连接数，0 就是没连上
cloudflared tunnel info myblog
```

### 缓存不刷新（改了页面但公网还是旧的）

服务对 HTML 和 `.js`/`.css` 返回 `no-cache, must-revalidate`，
但**图片等静态资源**是 `public, max-age=600, s-maxage=600`，
所以 Cloudflare 边缘会缓存 10 分钟。

**临时办法**：浏览器 `Ctrl+F5` 强制刷新。
**根治**：在 Cloudflare 后台 Purge Cache，或加一条缓存规则。

### 手机重启后服务没起来

按顺序查：

```bash
ls ~/.termux/boot/start_blog.sh          # 1. 脚本在不在
cat ~/.termux/boot/start_blog.sh | head -3  # 2. shebang 路径对不对
```

3. **Termux:Boot App 是否装好并手动打开过至少一次**
4. **Termux 和 Termux:Boot 是否都加了自启动白名单 + 关掉电池优化**
5. 手动跑一遍看报什么错：

```bash
bash ~/.termux/boot/start_blog.sh
```

---

## 附：完整目录结构（手机端）

```
/data/data/com.termux/files/home/
├── blog/                              ← 仓库根目录
│   ├── target/release/
│   │   ├── blog_server                ← 主服务
│   │   └── import_posts               ← Markdown 导入工具
│   ├── frontend/                      ← 静态资源（BLOG_ROOT）
│   │   ├── index.html                 ← 前台模板（手写，不被覆盖）
│   │   ├── app.js
│   │   ├── _posts/*.md                ← 文章 Markdown 源
│   │   └── blog/<slug>/index.html     ← blog_ctl build 生成的静态页
│   ├── blog.db                        ← SQLite（含 WAL/WAL-SHM 旁文件）
│   ├── config.toml                    ← 账号 + 密码哈希（★ 绝不入库）
│   ├── logs/                          ← 运行日志
│   └── deploy/
│       ├── blog_server.run            ← runit 服务脚本
│       ├── blog_health.run            ← 看门狗
│       └── termux-boot-start.sh       ← 开机脚本
└── .termux/boot/start_blog.sh         ← 开机脚本的安装位置

/data/data/com.termux/files/usr/var/service/
├── blog_server/run                    ← runit 托管
└── blog_health/run
```
