# Cloudflare Tunnel 部署教程（手机 / Windows 双平台）

> 目标：把本机 `127.0.0.1:8090` 的博客暴露成 `https://你的域名`，
> **不需要公网 IP、不需要端口映射、不需要自己配 HTTPS 证书**。

---

## 目录

- [1. 隧道原理（先看懂再动手）](#1-隧道原理先看懂再动手)
- [2. 两种建隧道的方式](#2-两种建隧道的方式)
- [3. 方式 A：`cloudflared tunnel login`（手机 / Linux 推荐）](#3-方式-acloudflared-tunnel-login手机--linux-推荐)
- [4. 方式 B：API Token（Windows 推荐）](#4-方式-bapi-tokenwindows-推荐)
- [5. 常驻：别用 `service install`（重要）](#5-常驻别用-service-install重要)
- [6. 验证清单](#6-验证清单)
- [7. 踩坑实录](#7-踩坑实录)
- [8. 安全收尾](#8-安全收尾)

---

## 1. 隧道原理（先看懂再动手）

```
   访客浏览器
       │  https://你的域名
       ▼
┌──────────────────────┐
│  Cloudflare 边缘      │  ← 自动 HTTPS 证书、DDoS 防护、CDN 缓存
└──────────┬───────────┘
           │  隧道（QUIC 长连接，由内向外发起）
           ▼
┌──────────────────────┐
│  cloudflared（本机）  │  ← 主动连出去，所以不需要开放任何入站端口
└──────────┬───────────┘
           │  http://127.0.0.1:8090
           ▼
┌──────────────────────┐
│  blog_server（本机）  │
└──────────────────────┘
```

**关键点**：连接是**从内向外**建立的。`cloudflared` 启动后主动连到 Cloudflare 边缘
并保持长连接；访客的请求顺着这条既有的连接**回传**进来。

所以：

| 你以为需要的 | 实际 |
|---|---|
| 公网 IP | ❌ 不需要 |
| 路由器端口映射 / UPnP | ❌ 不需要 |
| 域名备案 | ❌ 不需要（服务器在境外） |
| 自己申请 Let's Encrypt 证书 | ❌ 不需要，Cloudflare 自动签 |
| 家里 IP 会被公网扫到 | ❌ 不会，扫描器只能看到 Cloudflare 的 IP |

---

## 2. 两种建隧道的方式

| | 方式 A：`tunnel login` | 方式 B：API Token |
|---|---|---|
| 适用 | 手机 Termux、Linux、macOS | Windows（本机 `login` 会失败） |
| 凭据 | `~/.cloudflared/cert.pem` | 手工组装的 `<隧道ID>.json` |
| 交互 | 浏览器点授权 | 复制粘贴 Token |
| 失败原因 | 见 [7.1](#71-cloudflared-tunnel-login-在部分网络下失败) | Token 权限没给全 |

**两者最终产物完全一样**：一个 `<隧道ID>.json` 凭据文件 + 一个 `config.yml`。
选哪种只取决于 `login` 在你的网络下能不能用。

---

## 3. 方式 A：`cloudflared tunnel login`（手机 / Linux 推荐）

### 3.1 装 cloudflared

```bash
# Termux
pkg install -y cloudflared

# Debian / Ubuntu
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cf.deb
sudo dpkg -i cf.deb

# macOS
brew install cloudflared
```

### 3.2 授权

```bash
cloudflared tunnel login
```

它会打印一个 `https://dash.cloudflare.com/argotunnel?aud=...` 链接。
**在同机的浏览器里打开**（手机就复制到手机浏览器），选你的域名，点 Authorize。

成功后会在 `~/.cloudflared/cert.pem` 写入证书。

### 3.3 建隧道

```bash
cloudflared tunnel create myblog
```

输出里的 UUID 就是**隧道 ID**，记下来：

```
Tunnel credentials written to /data/data/com.termux/files/home/.cloudflared/ff619622-f033-4a47-9806-0b5edc79a29d.json
Created tunnel myblog with id ff619622-f033-4a47-9806-0b5edc79a29d
```

### 3.4 把域名指到隧道

```bash
cloudflared tunnel route dns myblog 你的域名
```

它会自动建一条 CNAME：

```
你的域名  →  ff619622-....cfargotunnel.com  （代理开启 = 橙云）
```

> **橙云必须开着。** 灰色云（DNS only）会让流量直连
> `<隧道ID>.cfargotunnel.com`，而那是个只对 Cloudflare 内部可达的地址，**必然失败**。

### 3.5 写配置文件

```bash
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml <<'EOF'
tunnel: ff619622-f033-4a47-9806-0b5edc79a29d
credentials-file: /data/data/com.termux/files/home/.cloudflared/ff619622-f033-4a47-9806-0b5edc79a29d.json

ingress:
  - hostname: 你的域名
    service: http://127.0.0.1:8090
  - service: http_status:404
EOF
```

**三个必须理解的细节**：

1. **`credentials-file` 要用绝对路径。** 用 `~` 在 systemd / runit
   这类不经过 shell 展开的环境里**不会展开**，cloudflared 会报找不到文件。
2. **`credentials-file` 和 `tunnel:` 都要填。** 只填一个也能跑，
   但两个都填最不容易出歧义。
3. **最后那条 `- service: http_status:404` 是必需的兜底规则。**
   `ingress` 是**从上往下**匹配的列表，必须有最后一条不带 `hostname` 的规则兜底。
   少了它 cloudflared 会拒绝启动并报 `No ingress rules were defined`。

> **⚠️ `service:` 的端口必须和服务实际监听的一致。**
> 写错的表现是**公网一直 502，但本地 `curl 127.0.0.1:8090` 完全正常**。
> 这个组合基本可以确诊：问题在 `ingress`，不在服务本身。
>
> 本项目 PC 端用 **8090**，手机端脚本历史上写的是 **8080**。
> 迁移配置时最容易在这里踩坑——照抄手机端的 `8080` 到 PC 上就是 502，
> 因为 PC 的 8080 被 llama.cpp 占着，博客实际在 8090。

### 3.6 前台测试

```bash
cloudflared tunnel --config ~/.cloudflared/config.yml run myblog
```

健康时日志里会出现：

```
Registered tunnel connection connIndex=0 ... location=lax01 protocol=quic
```

另开一个终端验证：

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://你的域名/
```

看到 `200` 就成了。**接着去看第 5 节做常驻**，别让它在终端里跑着。

---

## 4. 方式 B：API Token（Windows 推荐）

### 4.1 为什么 Windows 上要用这个

`cloudflared tunnel login` 在这台机器上**不可用**：

```
ERR Failed to write the certificate.
Your browser will download the certificate instead...
error="Failed to fetch resource"
```

原因：`login` 拿到授权后要**回调本机**取证书，但
`dash.cloudflare.com` 对非浏览器请求返回 **403 managed challenge**
（响应头 `Cf-Mitigated: challenge`，"Just a moment..." 人机验证页）。
浏览器能过，`cloudflared` 过不去，所以证书永远拿不到。

**API Token 方案完全绕开浏览器授权**：用 token 调 API 直接取隧道凭据，
自己组装成 JSON 文件即可，**不需要 `cert.pem`**。

### 4.2 创建 Token

打开 <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** → **Custom token**。

**必须给两条权限**：

| 范围 | 资源 | 权限 |
|---|---|---|
| 账户 | Cloudflare Tunnel | 编辑 |
| 区域 | DNS | 编辑 |

**区域资源**要选中你的域名；**账户资源**要选中你的账户。

> Token 只会完整显示**一次**，复制下来存好。
> 如果脚本报「这个 token 看不到任何账户」，就是 Account Resources 没选。

### 4.3 跑脚本

仓库里已经准备好了 `deploy/配置隧道.ps1`，它处理好了下面所有坑：
Token 验证、Account ID / Zone ID 查询、隧道复用、凭据文件写入（**不带 BOM**）、
DNS 记录创建/更新。

```powershell
$env:CF_API_TOKEN = "你的Token"
cd D:\3D_Work\Blog\deploy
.\配置隧道.ps1
```

默认参数是 `-Subdomain blog -Domain jerry-hang.blog -Origin http://127.0.0.1:8090`，
可以按需覆盖：

```powershell
# 换个域名前缀
.\配置隧道.ps1 -Subdomain www

# 指向别的服务（比如管理后台）
.\配置隧道.ps1 -Subdomain admin -Origin http://127.0.0.1:8091

# 只验证不写文件（先看看会做什么）
.\配置隧道.ps1 -WhatIf
```

脚本做的五件事：

1. `GET /user/tokens/verify` —— 验证 Token 有效
2. `GET /accounts` —— 取 Account ID（**多于一个账户会停下来让你指定**，避免建错地方）
3. `GET /zones?name=<域名>` —— 取 Zone ID
4. `GET/POST /accounts/<id>/cfd_tunnel` —— 隧道已存在则**复用**，不存在则创建
   （`tunnel_secret` 用 32 字节 CSPRNG 随机生成，`config_src: local` 表示配置放本机）
5. 写 `~/.cloudflared/<隧道ID>.json` 和 `~/.cloudflared/config.yml`，
   然后 `PUT`/`POST` DNS 记录

### 4.4 生成的凭据文件长这样

```json
{
  "AccountTag": "你的账户ID",
  "TunnelSecret": "隧道密钥（base64）",
  "TunnelID": "隧道ID"
}
```

> **必须不带 BOM 写入。** PowerShell 5.1 的 `Set-Content -Encoding UTF8`
> **会写 BOM**，而 cloudflared 的 JSON 解析器不认，报：
>
> ```
> ERR The credentials file ... contained invalid JSON.
> ERR Invalid character '茂' looking for beginning of value
> ```
>
> 那个「茂」就是 UTF-8 BOM 的 `EF BB BF` 被当成 GBK 解读的结果。
>
> **正确写法**：
>
> ```powershell
> [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
> ```
>
> `配置隧道.ps1` 已经这么做了。这就是自己写脚本比手工操作可靠的地方。

### 4.5 前台测试

```powershell
& 'C:\Program Files (x86)\cloudflared\cloudflared.exe' tunnel --config "$env:USERPROFILE\.cloudflared\config.yml" run 你的隧道ID
```

---

## 5. 常驻：别用 `service install`（重要）

### 5.1 为什么 `cloudflared service install` 不能用

这是本项目踩过的最大的一个坑。症状：**公网返回 HTTP 530**（Cloudflare error 1016，边缘找不到源站）。

装出来的服务是这样的：

```
服务 ImagePath : "C:\...\cloudflared.exe"        ← 没有任何参数
服务运行账户    : LocalSystem
cloudflared 找配置: C:\Windows\System32\config\systemprofile\.cloudflared\config.yml  ← 不存在
配置实际在      : C:\Users\<你>\.cloudflared\                              ← LocalSystem 不读这里
结果           : 隧道状态 down，公网 530
```

**三个问题叠加**：

1. **服务以 `LocalSystem` 运行**，它的 `~` 是
   `C:\Windows\System32\config\systemprofile\`，**不是你的用户目录**，
   所以读不到你的 `config.yml`。
2. **`--config` 参数不会被写进服务的 ImagePath。**
   试过 `cloudflared --config X service install`，装出来的 ImagePath 依然只有 exe 路径。
3. **把配置复制到 systemprofile 下也没用**，
   而且这个服务停止时会卡死：
   `sc stop` 报 `1061: The service cannot accept control messages at this time`。

### 5.2 正确做法：计划任务 + 用户账户

和博客看门狗同一个套路——**用计划任务，以用户账户运行**，
这样就用自己的 `~/.cloudflared/` 目录了。

仓库提供了 `deploy/启动隧道.ps1`，它显式指定 `--config` 和隧道 ID，
启动后**常驻等待**子进程（这样计划任务的重启策略才能生效）。

**注册计划任务**（管理员 PowerShell）：

```powershell
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "D:\3D_Work\Blog\deploy\启动隧道.ps1"'

$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Delay = 'PT30S'

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew

# ★ 关键：用当前用户账户，不要用 SYSTEM
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName 'Tunnel-Blog' `
  -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Cloudflare 隧道：把域名接到本机博客' -Force
```

**和博客看门狗的两处关键差异**：

| | 博客看门狗 | 隧道 |
|---|---|---|
| 主体账户 | `SYSTEM`（无需登录） | **当前用户**（要读 `~/.cloudflared/`） |
| 触发器 | `-AtStartup` | `-AtLogOn`（用户账户需要登录会话） |

> **代价**：用用户账户意味着**登录后才启动**。
> 如果希望不登录也跑，可以让 Windows 自动登录，
> 或者把 `config.yml` + 凭据文件复制到 `systemprofile` 目录并改用 SYSTEM
> （但请注意上面第 3 点：复制过去实测**没解决问题**）。
>
> 更稳妥的替代：用 [NSSM](https://nssm.cc/) 之类的包装器把
> `cloudflared --config ...` 注册成服务，并显式指定运行账户与参数。

### 5.3 手机 / Linux 端

同样**别用 systemd 的模板单元**，自己写：

```ini
# /etc/systemd/system/cloudflared-blog.service
[Unit]
Description=Cloudflare Tunnel for blog
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=你的用户名
# ★ 绝对路径，不要用 ~
ExecStart=/usr/local/bin/cloudflared --config /home/你的用户名/.cloudflared/config.yml run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-blog
```

Termux 用 runit，见 [部署-Termux安卓.md](部署-Termux安卓.md) 第 6 节。

---

## 6. 验证清单

按顺序走一遍，出问题时能立刻定位到是哪一层：

```bash
# ① 服务本身活着吗
curl -s -o /dev/null -w "local  : %{http_code}\n" http://127.0.0.1:8090/
#   期望 200。不是的话问题在博客服务，跟隧道无关

# ② 隧道进程在吗
pgrep -af cloudflared
#   或 Windows: Get-Process cloudflared

# ③ 隧道连上了吗（手机/Linux）
cloudflared tunnel info 你的隧道名
#   看连接数，0 就是没连上

# ④ 隧道日志里有注册成功吗
grep "Registered tunnel connection" ~/blog/logs/tunnel.log
#   期望看到 location=xxx protocol=quic

# ⑤ DNS 指向对吗（本机）
nslookup 你的域名
#   应该解析到 Cloudflare 的 IP，不是你家宽带 IP

# ⑥ 公网通吗
curl -s -o /dev/null -w "public : %{http_code}\n" https://你的域名/

# ⑦ 是 Cloudflare 缓存的还是真的回源了
curl -sI https://你的域名/ | grep -i "cf-cache-status\|server"
#   cf-cache-status: HIT  = 边缘缓存命中（改页面后看不到更新是正常的）
#   cf-cache-status: MISS/DYNAMIC = 真的回源了
```

**常见返回码对照**：

| 码 | 含义 | 该查哪 |
|---|---|---|
| `200` | 正常 | — |
| `502` | 边缘连不到源站 | `ingress` 的 `service:` 端口写错了，或博客没起 |
| `530` | Cloudflare 找不到隧道（error 1016） | 隧道进程挂了 / 没连上；Windows 上多半是 `service install` 的坑 |
| `1033` | 隧道已建立但**没有匹配的 ingress 规则** | `config.yml` 的 `hostname` 和访问的域名不一致 |
| `000` | 本机 curl 连不上 | 网络/DNS 问题，或域名没解析 |

---

## 7. 踩坑实录

### 7.1 `cloudflared tunnel login` 在部分网络下失败

**症状**：

```
ERR Failed to write the certificate.
error="Failed to fetch resource"
```

**原因**：`dash.cloudflare.com` 对非浏览器请求返回 403 managed challenge。

**处理**：改用 [方式 B（API Token）](#4-方式-bapi-tokenwindows-推荐)。

### 7.2 凭据文件带 BOM，cloudflared 解析失败

**症状**：

```
ERR Invalid character '茂' looking for beginning of value
```

**原因**：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM。

**处理**：用 `[System.IO.File]::WriteAllText($p, $j, (New-Object System.Text.UTF8Encoding($false)))`。

### 7.3 `service install` 装出来的服务连不上

见 [5.1](#51-为什么-cloudflared-service-install-不能用)。改用计划任务。

### 7.4 `ingress` 少写兜底规则

**症状**：cloudflared 拒绝启动：

```
ERR Failed to start tunnel: No ingress rules were defined in provided config
```

**处理**：`ingress` 列表最后必须有一条不带 `hostname` 的规则：

```yaml
  - service: http_status:404
```

### 7.5 照抄别的机器的端口，公网 502

**症状**：本地 `curl 127.0.0.1:8090` 返回 200，公网 502。

**原因**：`config.yml` 里的 `service:` 写了另一台机器的端口。

**处理**：核对 `service:` 和服务实际监听端口。可以用这条确认服务在哪个端口：

```powershell
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 8080,8090,8091 }
```

```bash
# Linux / Termux
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8090/
```

### 7.6 改了页面但公网看不到更新

**原因**：本项目对 HTML 和 `.js`/`.css` 返回 `no-cache, must-revalidate`，
但**图片等静态资源**是 `public, max-age=600, s-maxage=600`，
Cloudflare 边缘会缓存 10 分钟。

**处理**：
- 临时：浏览器 `Ctrl+F5`
- 根治：Cloudflare 后台 → Caching → **Purge Cache**
- 长期：加一条 Cache Rule，对 HTML 用 `Respect Origin` 或 `Bypass`

> 顺带一提：**Purge Cache 需要单独的 API 权限**（`Zone → Cache Purge → Purge`）。
> 只给了 Tunnel + DNS 权限的 Token 调 purge 接口会返回 **401**。

---

## 8. 安全收尾

### 8.1 隧道建好后，Token 就该删了

**隧道运行时靠自己的凭据文件（`<隧道ID>.json`），和 API Token 完全无关。**
Token 的使命在"建隧道 + 建 DNS"完成时就结束了。

去 <https://dash.cloudflare.com/profile/api-tokens> **Delete** 掉它。

> **Cloudflare 不允许 Token 自删**——API 调删除会返回
> `9109 Unauthorized to access requested resource`。
> 所以**必须手动去网页删**，脚本没法代劳。

### 8.2 管理后台绝对不要接到隧道上

管理端口只绑 `127.0.0.1`，这是**有意设计**：

```toml
BLOG_EXT_ADDR   = '0.0.0.0:8090'      # 前台，公网只读
BLOG_LOCAL_ADDR = '127.0.0.1:8091'    # 后台，公网不可达
```

`配置隧道.ps1 -Subdomain admin -Origin http://127.0.0.1:8091` 这条命令
**技术上可行，但强烈不建议**——那等于把管理后台挂到公网。

要在外面管理，正确做法是 **SSH 隧道**（见
[部署-Termux安卓.md](部署-Termux安卓.md) 第 4.1 节），
或者用 [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
给那个子域加一层身份验证。

### 8.3 公开前的检查表

| 检查项 | 怎么查 | 期望 |
|---|---|---|
| 管理后台不对外 | `curl -s -o /dev/null -w "%{http_code}" https://你的域名:8091/` | 连不上（超时） |
| 默认密码已改 | `cat config.toml` | `password_sha256` 不是 `change-me-on-first-login` 的哈希 |
| `config.toml` 没入库 | `git ls-files \| grep config.toml` | 无输出 |
| `blog.db` 没入库 | `git ls-files \| grep '\.db'` | 无输出 |
| 文章内容可以公开 | 逐篇过一遍 `frontend/_posts/` | 你确认过 |
| 知道日志会记录访客 IP | 后台「请求日志」页 | 你接受这个行为 |

> **最后一项不是 bug 而是功能**：`request_logs` 表按规则分类请求
> （`404`→`scan`、UA 含 bot→`crawler`、`401`→`bruteforce`、`503`→`blocked`），
> 后台能看到来源 IP 和路径分析。如果你不想要这个，得改代码关掉。
