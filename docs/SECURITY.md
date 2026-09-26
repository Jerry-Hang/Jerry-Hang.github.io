# 安全说明与脱敏指南

> 本文档说明本项目的安全模型、**哪些文件绝对不能提交**，
> 以及**万一提交了该怎么彻底清除**（含实战全过程）。

---

## 目录

- [1. 安全模型](#1-安全模型)
- [2. 绝对不能提交的文件](#2-绝对不能提交的文件)
- [3. 提交前的自检](#3-提交前的自检)
- [4. 事故处理：从 Git 历史中彻底清除](#4-事故处理从-git-历史中彻底清除)
- [5. 实战记录](#5-实战记录)
- [6. 凭证轮换](#6-凭证轮换)

---

## 1. 安全模型

整个服务的安全设计围绕**一个物理隔离**展开：

```
┌─────────────────────────────────────────────────────┐
│  公网端口  0.0.0.0:8090                              │
│  · 只允许 GET / HEAD，其他方法一律 404                │
│  · 无任何 API（/api/* 在这里会当作静态文件 404）       │
│  · 路径穿越防护 + 并发门控 + 内存熔断                  │
└─────────────────────────────────────────────────────┘
                        ↕ 完全隔离，无共享路由
┌─────────────────────────────────────────────────────┐
│  管理端口  127.0.0.1:8091                            │
│  · 只绑回环，且 handler 里二次校验 peer 是 loopback    │
│  · 未登录一律 302 → /login                           │
│  · 双信任等级会话（admin 7 天 / priv 24 小时）         │
└─────────────────────────────────────────────────────┘
```

**为什么这样设计**：博客是"读多写零"的场景。访客只需要读，
所以公网口**根本不需要任何写能力**；连带地，公网口不需要认证、
不需要 CSRF 防护、不需要限流到影响体验。管理口从物理上不可达，
攻击面被压到最小。

### 认证分层

| 层级 | 怎么拿到 | 有效期 | 能做什么 |
|---|---|---|---|
| 无 | — | — | 读公网内容 |
| `blog_admin` | `POST /api/login` 表单登录 | **7 天** | 文章增删改查、统计、日志、仪表盘 |
| `blog_priv` | **HTTP Basic** 再次输密码 | **24 小时** | 以上全部 + 执行系统命令 + 读任意文件 |

**为什么特权操作要二次认证**：`/api/admin/exec` 能执行任意 shell 命令，
`/api/admin/file` 能读任意路径的文件（**没有任何目录限制**）。
把它们的门槛抬到"重新输密码"，是因为一旦浏览器会话被 XSS 或
CSRF 攻破，攻击者拿到的是后台读写权限，**而不是 shell**。

> ⚠️ **注意一个实现细节**：`blog_priv` **只能通过 HTTP Basic 获得**。
> 表单登录只发 `blog_admin`。所以浏览器里点「执行命令」会弹出一个
> Basic 认证框——**这是有意的，不是 bug**。

### 密码存储

- `config.toml` 里只存 **SHA-256 哈希**，从不存明文。
- 比较用**常量时间**实现（`ct_eq`），避免计时侧信道。
- SHA-256 本身**不是密码哈希函数**（没有加盐、没有拉伸），
  理论上可以暴力破解。对这个项目的威胁模型（个人博客 + 强密码）够用，
  但**别用弱密码**。
- 生成哈希：`./target/release/blog_server --hash '你的密码'`

### 已知的防护边界

这些是**有意的设计取舍**，不是漏洞，但你该知道：

| 项 | 说明 |
|---|---|
| **无 CSRF Token** | 唯一的防护是 Cookie 的 `SameSite=Strict`。现代浏览器够用；老旧浏览器不行。 |
| **Cookie 无 `Secure` 标志** | 因为管理口是 `http://127.0.0.1`。走隧道时 Cloudflare 会加 HTTPS，但服务本身不知道。 |
| **`/api/admin/file` 不限制目录** | 能读进程有权限读的**任何**文件。这是刻意给的特权功能。 |
| **`/api/search` 和 `/api/status` 不校验方法** | 任何已认证的方法都能调。不影响安全性，但不规范。 |
| **XSS 净化器是白名单 + 子串黑名单** | 属性值里只要含 `data:` / `expression` 就被丢弃。副作用：`title="metadata: x"` 这种合法值也会被误删。 |
| **`client_ip` 完全信任 `CF-Connecting-IP`** | 如果有人绕过 Cloudflare 直连源站，可以伪造 IP 污染日志。前提是源站直接可达——用隧道时不可达。 |

---

## 2. 绝对不能提交的文件

| 文件 | 里面有什么 | 泄露后果 |
|---|---|---|
| **`config.toml`** | `username` + `password_sha256` | 攻击者拿到密码哈希，可离线暴力破解 |
| **`blog.db`** | 文章正文 + `request_logs`（**全部访客 IP**）+ `sessions`（**有效登录 token**） | **最严重**：拿 `sessions` 表里的 token 可以直接重放登录，不需要知道密码 |
| **`blog.db-wal`** / `blog.db-shm` | 上面数据库的未合并部分 | 同上 |
| **`*.bak` / `*.bak-*`** | 数据库备份 —— **同样是完整的 `blog.db` 内容** | 同上。**这是最容易漏的一类** |
| `*.log` | 日志里可能有 IP、路径、错误堆栈 | 信息泄露 |
| `*.pid` | 无敏感信息，但没必要提交 | — |
| `~/.cloudflared/*.json` | 隧道凭据（`TunnelSecret`） | 别人可以冒充你的隧道 |
| `.env` / API Token | 各种云端凭证 | 看权限而定，可能很严重 |

### ⚠️ 为什么 `.bak` 最危险

`blog.db.bak-before-prune` 这种文件名**不匹配 `*.db`**，
所以常见的 `.gitignore` 规则**抓不住它**：

```gitignore
*.db          # ← blog.db.bak-before-prune 不匹配（不是以 .db 结尾）
*.db-wal      # ← 也不匹配
```

必须显式加：

```gitignore
*.db-*
*.db.bak*
*.bak
*.bak-*
```

**本项目就真的踩过这个坑**，见 [第 5 节](#5-实战记录)。

---

## 3. 提交前的自检

### 3.1 查工作区和索引

```bash
# 有没有敏感文件被追踪
git ls-files | grep -Ei '\.(db|bak|log|pid)$|config\.toml|\.env'

# 期望：无输出
```

### 3.2 查全部历史（关键！）

**只查当前版本是不够的**——文件可能被提交过、后来又删了，
但**在历史里仍然可读**。

```bash
# 历史上出现过的所有路径
git log --all --pretty=format: --name-only | sort -u | grep -Ei '\.(db|bak)$'

# 每一个可达对象
git rev-list --objects --all | grep -Ei '\.(db|bak)$'

# 在所有历史版本里搜凭证特征
git log --all -p | grep -Ei 'sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|cfut_[A-Za-z0-9]{20,}|password_sha256\s*=\s*[0-9a-f]{32,}'
```

**这三条都无输出，才可以推送。**

### 3.3 `.gitignore` 基线

```gitignore
# 秘密与运行时数据（绝不提交）
/config.toml
**/config.toml
/blog.db
/blog.db-*
*.db
*.db-*
*.db.bak*
*.db-wal
*.db-shm
*.bak
*.bak-*

# 日志与临时文件
*.log
*.pid

# 云隧道凭据
**/.cloudflared/*.json
```

### 3.4 加一道自动闸门

在 `.git/hooks/pre-commit` 放一份（记得 `chmod +x`）：

```bash
#!/bin/sh
# 阻止敏感文件进入提交
bad=$(git diff --cached --name-only | grep -Ei '\.(db|db-wal|db-shm|bak|bak-.*)$|(^|/)config\.toml$|\.env$')
if [ -n "$bad" ]; then
  echo "✗ 拒绝提交：检测到敏感文件" >&2
  echo "$bad" | sed 's/^/    /' >&2
  echo "" >&2
  echo "  这些文件含访客 IP、会话 token 或密码哈希。" >&2
  echo "  如确需提交，用 git commit --no-verify 覆盖（不推荐）。" >&2
  exit 1
fi
```

> `pre-commit` 钩子**不会被 `git push` 触发**，也不进版本库，
> 每台克隆的机器都要重新装。它是**辅助**，不是保证。

---

## 4. 事故处理：从 Git 历史中彻底清除

### 4.1 先判断严重程度

```
文件提交过但从未 push？
   └─ 简单：改历史 + 强推，没别人看过

文件已经 push 到公开仓库？
   └─ 严重：假定已泄露 → 必须轮换凭证（见第 6 节）
      即使你清除了历史，GitHub 的缓存、fork、别人的克隆都可能有副本
```

### 4.2 有 `git-filter-repo` 的话（首选）

```bash
pip install git-filter-repo

git filter-repo --invert-paths \
  --path blog.db.bak-before-prune \
  --path blog.db.bak-scope \
  --force
```

`filter-repo` 更快更安全，而且**默认就会清理 `refs/original` 和 reflog**。

### 4.3 只有 `git filter-branch` 的话

```bash
git filter-branch --force --index-filter \
  "git rm -r --cached --ignore-unmatch blog.db.bak-before-prune blog.db.bak-scope" \
  --prune-empty -- --all
```

**参数逐个解释**：

| 参数 | 作用 |
|---|---|
| `--index-filter` | 只改**索引**，不检出工作区 —— 比 `--tree-filter` 快几十倍 |
| `git rm --cached` | 从索引删，不动工作区 |
| `--ignore-unmatch` | 该提交里没这个文件时**不要报错**（否则 filter-branch 会跳过整个提交） |
| `--prune-empty` | 删掉因此变成空提交的那些 |
| `-- --all` | 对所有分支和标签生效（`--` 后面是 rev-list 参数） |

### 4.4 清理残留（这一步最容易漏）

`filter-branch` 会：
1. 把旧提交保存在 **`refs/original/*`**（**这就是旧数据仍然可达的原因**）
2. 留下 reflog 引用

**必须手动清掉，否则 `gc` 不会真的删除那些对象**：

```bash
# 删除 refs/original/*（注意是逐个删，没有通配符）
git for-each-ref --format="%(refname)" refs/original/ | xargs -n1 git update-ref -d

# 清 reflog
git reflog expire --expire=now --expire-unreachable=now --all

# 真正删除不可达对象
git gc --prune=now
```

### 4.5 验证（**别只看 diff！**）

```bash
# ① 所有可达对象里还有没有
git rev-list --objects --all | grep -Ei '\.(db|bak)$'
#   期望：无输出

# ② 历史上出现过的所有路径
git log --all --pretty=format: --name-only | sort -u | grep -Ei '\.(db|bak)$'
#   期望：无输出

# ③ 旧提交是不是真的没了
git cat-file -t <旧提交的SHA>
#   期望：fatal: Not a valid object name  ← 这才是真的删掉了

# ④ 对象库体积
du -sh .git
```

> **③ 是最关键的一条。** 如果 `git cat-file -t <旧SHA>` 还能输出 `commit`，
> 说明**旧数据仍然完整存在**，你的清理没有生效。

### 4.6 强推

远端历史被改写，普通推送会被拒绝，必须强推：

```bash
# 推荐：带 lease，防止覆盖别人的新提交
git push --force-with-lease=refs/heads/main:<远端当前SHA> origin main
```

**为什么用 `--force-with-lease` 而不是 `--force`**：
它在推送前检查远端是否仍是你以为的那个 SHA。
如果别人在这期间推了新提交，推送会**失败而不是覆盖**。

### 4.7 告诉协作者

改写历史后，其他人的克隆已经"分叉"了。他们需要：

```bash
git fetch origin
git reset --hard origin/main     # ⚠️ 会丢弃本地未推送的改动
```

---

## 5. 实战记录

> 以下是本项目真实发生过的一次泄露与修复，**过程完整记录，包括我犯的错**。

### 5.1 事故

两个数据库备份被误提交：

| 文件 | 大小 | 出现在 |
|---|---|---|
| `blog.db.bak-before-prune` | 2,457,600 B | **15 个提交** |
| `blog.db.bak-scope` | 2,682,880 B | **4 个提交** |

内容：`request_logs`（访客 IP）、`sessions`（**有效登录 token**）、
文章正文、`posts` 表。

**为什么 `.gitignore` 没拦住**：当时的规则是 `*.db` 和 `*.db-*`，
而 `blog.db.bak-before-prune` 这两个都**不匹配**——
它以 `.bak-before-prune` 结尾，不是 `.db`，也不是 `.db-`。

### 5.2 清除

```bash
git filter-branch --force --index-filter \
  "git rm -r --cached --ignore-unmatch blog.db.bak-before-prune blog.db.bak-scope" \
  --prune-empty -- --all
```

输出确认每个提交都真的删了：

```
Rewrite 2b0dbb00 (2/17)    rm 'blog.db.bak-before-prune'
Rewrite 94e4a4ac (11/17)   rm 'blog.db.bak-before-prune'
                           rm 'blog.db.bak-scope'
...
Ref 'refs/heads/main' was rewritten
```

然后：

```bash
git for-each-ref --format="%(refname)" refs/original/ | xargs -n1 git update-ref -d
git reflog expire --expire=now --expire-unreachable=now --all
git gc --prune=now
```

**结果**：218 个可达对象、76 个历史路径，**零命中**；
`git cat-file -t <旧SHA>` 返回 `fatal: Not a valid object name`；
`.git` 从 ~7.5 MB 降到 **1.7 MB**。

### 5.3 ⚠️ 我犯的错（这部分最重要）

**第一次清理，我以为成功了，其实完全没有。**

我做了一次验证，看到"无残留"就继续往下走了。但那条验证命令写错了：

```powershell
# ✗ 错的（我实际用的）
$names | Where-Object { $_ -match '\.db$' }
```

`\.db$` 是"**以 `.db` 结尾**"——而 `blog.db.bak-before-prune`
以 `-prune` 结尾，**永远匹配不上**。所以它报"干净"，
但两个文件其实**一直好好地在每一个提交里**。

更糟的是我把结果写进日志文件、又用管道过滤，输出被后台任务
刷掉了，我没看到真实内容就下了结论。

**正确做法**（后来重做的验证）：

```powershell
# ✓ 对的：覆盖所有变体，并且查对象库而不只是查 diff
$objs = @(& git rev-list --objects --all)
$leak = @($objs | Where-Object { $_ -match '\.(db|db-wal|db-shm|bak)$' -or $_ -match '\.bak-' })
```

**结论**：**这是推送前的最后一次检查救了我。** 如果当时直接 `git push`，
15 个提交里的访客 IP 和有效会话 token 就会全部公开。

**三条可复用的教训**：

1. **正则要覆盖所有变体。** 想匹配 `.bak-before-prune`，
   就得写 `\.bak` 或 `\.bak-`，别只写 `\.db$`。
2. **查对象库，不要只查 diff 或当前树。**
   `git log --name-only` 的 diff 会漏掉"父提交有的、当前提交也有的"文件。
   `git rev-list --objects --all` 才是完整的。
3. **用一个决定性的判据收尾。**
   `git cat-file -t <旧SHA>` 返回 `fatal: Not a valid object name`
   是**单一、清晰、无法误读**的成功判据。
   用 `.git` 目录体积、或者"看起来没报错"都不够。

### 5.4 另一个坑：验证脚本本身被当成新的威胁

清理完历史后，我又写了几个临时验证脚本（`_scrub2.ps1`、
`_verify_scrub.ps1`、`_leakscan.ps1`）放在仓库根目录。
**它们的文件名含有 `scrub` / `leak` 这些词**，
如果误提交，虽然不含秘密，但会让人以为仓库里有凭证管理逻辑。

**处理**：任务结束后立即删除，并加进 `.gitignore`。

### 5.5 最终状态

```
远端文件数     : 57（清理前 71）
历史中的 .db   : 0
历史中的 .bak  : 0
历史中的凭证   : 0（扫了 464 个对象里的 209 个文本 blob）
对象库体积     : 1.7 MB
管理员密码哈希 : 不在历史中
会话 token     : 不在历史中
```

`.gitignore` 加固后的关键规则：

```gitignore
*.db
*.db-*
*.db.bak*     # ← 就是这条抓住了那两个备份
*.db-wal
*.db-shm
*.bak
*.bak-*
```

---

## 6. 凭证轮换

**记住一句话：一旦秘密被推送过，就假定它已经泄露。**
清除历史能让它不再**公开可见**，但 GitHub 的缓存、fork、
别人 clone 的副本、CI 日志、搜索引擎快照都可能留有副本。

### 各凭证的轮换方法

| 凭证 | 怎么轮换 |
|---|---|
| **管理密码** | 跑 `blog_server --hash '新密码'`，覆盖 `config.toml`，重启服务 |
| **已有会话** | 服务重启后删除 `sessions` 表：`sqlite3 blog.db "delete from sessions;"`（**必须做**——旧 token 在过期前一直有效） |
| **Cloudflare API Token** | <https://dash.cloudflare.com/profile/api-tokens> → **Delete**（**Cloudflare 不允许 Token 自删**，API 会返回 `9109`，必须手动） |
| **隧道凭据** | `cloudflared tunnel delete <名字>` 后重建隧道，并更新 DNS |
| **GitHub PAT** | Settings → Developer settings → Personal access tokens → Revoke |
| **SSH 密钥** | 生成新密钥，替换 `~/.ssh/authorized_keys` |

### 本次事故需要轮换的项目

- [x] `config.toml` —— **从未被提交**，无需轮换
- [ ] **Cloudflare API Token** —— ⚠️ **尚未删除，需要你手动去网页操作**
      （隧道建好后就不再需要它了，见
      [CLOUDFLARE_TUNNEL.md](CLOUDFLARE_TUNNEL.md) 第 8.1 节）
- [ ] 管理密码 —— 建议轮换一次，因为备份在本地磁盘存在过

> **隧道凭据文件（`<隧道ID>.json`）从未进入 Git**，
> 它一直在 `C:\Users\<你>\.cloudflared\` 下，不需要轮换。
