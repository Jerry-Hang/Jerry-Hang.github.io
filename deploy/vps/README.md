# VPS 部署（Debian 12）

把博客后端跑在 VPS 上的部署方案。本目录只放部署产物，不改动应用代码。

## 目录内容

| 文件 | 说明 |
|---|---|
| `blog.service` | systemd 单元（含 MemoryHigh=384M / MemoryMax=512M 内存约束） |
| `config.toml.example` | 配置模板，复制为 `/opt/blog/config.toml` 后填真实值 |
| `deploy.sh` | 一键部署脚本（装依赖 → 拉代码 → 编译 → 装服务） |

## 快速开始

```bash
git clone https://github.com/Jerry-Hang/Jerry-Hang.github.io.git /opt/blog
cd /opt/blog
git checkout deploy/vps   # 本分支
sudo bash deploy/vps/deploy.sh
```

首次运行会生成 `config.toml` 后停下，编辑好密码哈希再跑一次即可。

## 端口与防火墙

- `8090/tcp`：对外博客（需要 `ufw allow 8090/tcp`）
- `8091`：本机管理口，**不对外开放**（仅 127.0.0.1）

## 与 sing-box 共存

sing-box 占用 `443`（VLESS-Reality + Hysteria2），博客走 `8090`，互不冲突。

## 注意事项

- 1C1G 机器编译 Rust 建议先确认有 swap（1G 即可）。
- 频繁 SSH 会被 fail2ban 临时封，隔几十秒重试。
- 非交互 SSH 写文件时 heredoc 可能被吞，用 `base64 -d` 传输更稳。
