# 部署方式（三选一）

本项目提供**三种部署方式**，各自独立成一个分支，互不影响。按你手头的机器挑一个分支下载即可。

| 部署方式 | 分支 | 适合场景 | 分支里的部署产物 |
|---|---|---|---|
| 📱 **手机 / Termux** | [`deploy/android`](../../tree/deploy/android) | 手边只有一台旧安卓机想当服务器 | `deploy/android/`（runit 服务脚本、开机自启） |
| 🪟 **Windows 电脑** | [`deploy/windows`](../../tree/deploy/windows) | 有台常开的 Windows 机器 | `deploy/windows/`（启动/隧道/计划任务/看门狗脚本） |
| 🐧 **VPS / Linux** | [`deploy/vps`](../../tree/deploy/vps) | 有长期开机的云服务器（推荐，最稳） | `deploy/vps/`（systemd 单元、部署脚本、配置模板） |

> 三个分支都从 `main` 分出；`main` 保留全部代码 + 三套部署产物。

## 怎么选

- 只是想玩玩、或手边只有旧手机 → **手机 / Termux**
- 有台常开的 Windows → **Windows**
- 有云服务器（VPS）→ **VPS**（推荐：不开自己机器、带宽稳定、能挂域名）

## 快速开始（以 VPS 为例）

```bash
git clone https://github.com/Jerry-Hang/Jerry-Hang.github.io.git /opt/blog
cd /opt/blog
git checkout deploy/vps
sudo bash deploy/vps/deploy.sh
```

各分支的详细说明看对应目录里的 `README.md` / `Windows部署说明.md`。

## 四者的关系

```
main ──┬── deploy/android   手机/Termux 部署
       ├── deploy/windows   Windows 部署
       └── deploy/vps       VPS/Linux 部署
```

代码改动提交到 `main`，需要时再同步到三个部署分支。
