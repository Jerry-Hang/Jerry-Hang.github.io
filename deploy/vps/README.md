# VPS 部署（Debian 12）

把博客后端跑在长期开机的 VPS/Linux 上的部署方案。本目录只放部署产物，不改动应用代码。

## 目录内容

| 文件 | 说明 |
|---|---|
| `blog.service` | systemd 单元（内存约束 + 管理端口已关闭） |
| `config.toml.example` | 配置模板，复制为 `/opt/blog/config.toml` 后填真实值 |
| `deploy.sh` | 一键部署脚本（装依赖 → 拉代码 → 编译 → 装服务） |

## 快速开始

```bash
git clone https://github.com/Jerry-Hang/Jerry-Hang.github.io.git /opt/blog
cd /opt/blog
git checkout deploy/vps
sudo bash deploy/vps/deploy.sh
```

首次运行会生成 `config.toml` 后停下，编辑好密码哈希再跑一次即可。

## 端口

- `80/tcp`：对外博客（`ufw allow 80/tcp`）。选 80 是为了配合 Cloudflare 的 **Flexible SSL** 回源。
- **管理口已取消**：`BLOG_LOCAL_ADDR=none` 时服务端不监听任何管理端口。

## Cloudflare 接入（可选，用自定义域名时）

1. **DNS**：加一条 `A` 记录指向本机公网 IP，**代理状态 = 已代理（橙云）**
2. **SSL/TLS 模式**：设为 **Flexible（灵活）** —— 源站只提供 HTTP，CF 回源走 80；
   若源站自己上了证书，可改成 Full (strict)
3. 访客真实 IP 由 `CF-Connecting-IP` 头带进来，博客已优先取它（`client_ip()`）

> 注：源站 IP 对公网仍是隐藏的（只对 Cloudflare 可见）。

## 管理方式（SSH + CLI）

不再暴露管理 HTTP 端口。所有管理动作通过 SSH 登录后执行 `blog_server ctl`：

```bash
export BLOG_DB=/opt/blog/blog.db
BIN=/opt/blog/target/release/blog_server

$BIN ctl list                                  # 列出全部文章
$BIN ctl show <id|slug>                        # 查看单篇
$BIN ctl new --title "标题" --file post.md --cats 随笔 --tags a,b
$BIN ctl edit <id> --file post.md              # 只传要改的字段
$BIN ctl rm <id>
$BIN ctl import /opt/blog/frontend/_posts --force
$BIN ctl logs --page 1 --per 20 --cat scan     # 请求日志
$BIN ctl count
```

## 内存约束

systemd 单元：`MemoryHigh=384M`、`MemoryMax=512M`；
应用内熔断：RSS > 384MiB 并发减半，< 256MiB 恢复。

## 与 sing-box 共存

sing-box 占用 `443`（VLESS-Reality + Hysteria2），博客走 `80`，互不冲突。

## 注意事项

- 1C1G 机器编译 Rust 建议先确认有 swap（1G 即可）。
- 频繁 SSH 会被 fail2ban 临时封，隔几十秒重试。
- 非交互 SSH 写文件时 heredoc 可能被吞，用 `base64 -d` 或 `scp` 传输更稳。
