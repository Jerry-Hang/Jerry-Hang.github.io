#!/usr/bin/env bash
# Jerry Blog — VPS (Debian 12) 一键部署脚本
# 用法：sudo bash deploy.sh
set -euo pipefail

APP_DIR=/opt/blog
REPO_URL="https://github.com/Jerry-Hang/Jerry-Hang.github.io.git"
BRANCH="main"
SERVICE=blog

echo ">> 安装依赖"
apt-get update -y
apt-get install -y git curl build-essential

if ! command -v cargo >/dev/null 2>&1; then
  echo ">> 安装 rustup / Rust"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
fi

echo ">> 拉取代码到 $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --all
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only
else
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

echo ">> 准备配置"
if [ ! -f "$APP_DIR/config.toml" ]; then
  cp "$APP_DIR/deploy/vps/config.toml.example" "$APP_DIR/config.toml"
  echo "!! 已生成 config.toml，请编辑 username / password_sha256 后重跑本脚本"
  exit 0
fi

echo ">> 编译"
cd "$APP_DIR"
cargo build --release

echo ">> 导入文章（仅首次）"
if [ ! -f "$APP_DIR/blog.db" ]; then
  "$APP_DIR/target/release/import_posts" "$APP_DIR/blog.db" "$APP_DIR/frontend/_posts" || true
fi

echo ">> 安装 systemd 服务"
install -m 644 "$APP_DIR/deploy/vps/blog.service" /etc/systemd/system/blog.service
systemctl daemon-reload
systemctl enable --now "$SERVICE"
systemctl restart "$SERVICE"

echo ">> 状态"
systemctl --no-pager -l status "$SERVICE" | head -20
