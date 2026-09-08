#!/data/data/com.termux/files/usr/bin/bash
# 开机自启：放到 ~/.termux/boot/start_blog.sh（需 Termux:Boot App）
export SVDIR=/data/data/com.termux/files/usr/var/service
export PREFIX=/data/data/com.termux/files/usr
termux-wake-lock
if ! pgrep -f '/usr/bin/runsvdir /data/data/com.termux/files/usr/var/service' >/dev/null 2>&1; then
  service-daemon start
fi
sleep 8
sv up blog_server
sv up blog_health
termux-notification --title "JerryHang 博客" --content "博客服务已启动 ✅" --priority high 2>/dev/null || true
