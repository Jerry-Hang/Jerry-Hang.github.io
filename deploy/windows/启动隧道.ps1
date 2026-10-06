# 启动隧道.ps1
#
# 启动 cloudflared 隧道，把 https://jerry-hang.blog 接到本机博客 8090。
# 由计划任务 Tunnel-Blog 在登录后调用，并常驻等待。
#
# 为什么不用 cloudflared service install：
#   它装出来的 Windows 服务 ImagePath 不带任何参数，而服务以 LocalSystem 运行，
#   会去 C:\Windows\System32\config\systemprofile\.cloudflared\ 找配置——
#   那个目录里没有配置文件，所以隧道永远是 down 状态、公网返回 530。
#   用 --config 显式传路径也没用，参数不会被写进服务的 ImagePath。
#   而且这个服务停止时会卡死（sc stop 报 1061）。
#   → 改用计划任务 + 用户账户，和博客看门狗同一个套路，已验证可靠。
#
# 环境变量可在同目录 config.env.ps1 里覆盖（复用博客那份配置）。

$ErrorActionPreference = 'Continue'

$Root    = Split-Path -Parent $PSScriptRoot          # D:\3D_Work\Blog
$LogDir  = Join-Path $Root 'logs'
$Log     = Join-Path $LogDir 'tunnel.log'
$ErrLog  = Join-Path $LogDir 'tunnel.err.log'
$PidFile = Join-Path $LogDir 'tunnel.pid'

$CF = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'

# ---------------------------------------------------------------- 默认配置
$BLOG_TUNNEL_ID   = 'ff619622-f033-4a47-9806-0b5edc79a29d'
$BLOG_TUNNEL_CFG  = Join-Path $env:USERPROFILE '.cloudflared\config.yml'
$BLOG_LOCAL_PORT  = '8090'

$envFile = Join-Path $PSScriptRoot 'config.env.ps1'
if (Test-Path $envFile) { . $envFile }

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $Log -Value $line -Encoding UTF8
    Write-Host $line
}

# ---------------------------------------------------------------- 前置检查
if (-not (Test-Path $CF)) {
    Log "错误：找不到 cloudflared：$CF"
    exit 1
}
if (-not (Test-Path $BLOG_TUNNEL_CFG)) {
    Log "错误：找不到隧道配置：$BLOG_TUNNEL_CFG"
    exit 1
}

# ---------------------------------------------------------------- 单实例锁
# 和看门狗一样：计划任务的 MultipleInstances=IgnoreNew 管不住手动运行，
# 所以自己用 pid 文件加一道锁，避免跑出两条隧道连接。
if (Test-Path $PidFile) {
    $oldPid = (Get-Content $PidFile -ErrorAction SilentlyContinue).Trim()
    if ($oldPid) {
        $old = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
        if ($old) {
            Log "已有隧道在运行（PID $oldPid），本实例退出"
            exit 0
        }
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- 等博客就绪
# 隧道起来时博客可能还没监听，等一会儿避免一开始就 502。
Log "等待博客服务就绪（127.0.0.1:$BLOG_LOCAL_PORT）..."
$ready = $false
for ($i = 1; $i -le 30; $i++) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', [int]$BLOG_LOCAL_PORT)
        $c.Close()
        $ready = $true
        Log "博客已就绪（第 $i 次检查）"
        break
    } catch {
        Start-Sleep -Seconds 2
    }
}
if (-not $ready) {
    Log "警告：等 60 秒后博客仍未监听，仍然启动隧道（由 Cloudflare 侧返回 502）"
}

# ---------------------------------------------------------------- 日志滚动
function Rotate-IfBig($path, $maxBytes = 5MB, $keep = 3) {
    if (-not (Test-Path $path)) { return }
    if ((Get-Item $path).Length -le $maxBytes) { return }
    $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
    Move-Item $path "$path.$stamp" -Force
    Get-ChildItem (Split-Path $path) -Filter ((Split-Path $path -Leaf) + '.*') |
        Sort-Object LastWriteTime -Descending | Select-Object -Skip $keep |
        Remove-Item -Force -ErrorAction SilentlyContinue
}
Rotate-IfBig $Log
Rotate-IfBig $ErrLog

# ---------------------------------------------------------------- 启动
Log "启动隧道 $BLOG_TUNNEL_ID"

try {
    $proc = Start-Process -FilePath $CF `
        -ArgumentList @('tunnel', '--config', $BLOG_TUNNEL_CFG, 'run', $BLOG_TUNNEL_ID) `
        -WorkingDirectory $Root `
        -RedirectStandardOutput $Log `
        -RedirectStandardError $ErrLog `
        -NoNewWindow -PassThru

    $proc.Id | Set-Content $PidFile -Encoding ASCII

    Start-Sleep -Seconds 5
    if ($proc.HasExited) {
        Log "进程启动后立即退出，退出码 $($proc.ExitCode)。看 $ErrLog"
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
        exit 1
    }
    Log "隧道已启动 PID=$($proc.Id)"

    # 常驻等待：本脚本活着 = 隧道活着，计划任务设定的重启策略才能生效
    $proc.WaitForExit()
    Log "隧道进程退出，退出码 $($proc.ExitCode)"
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    exit $proc.ExitCode
} catch {
    Log "启动失败：$($_.Exception.Message)"
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    exit 1
}
