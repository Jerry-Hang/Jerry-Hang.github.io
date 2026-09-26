# 启动博客.ps1
#
# Windows 版服务启动器，对应 deploy/blog_server.run（Termux/runit 版）。
#
# 设计说明：
#   本脚本用 Start-Process -RedirectStandardOutput 把子进程输出交给 .NET 直接重定向到
#   文件，然后 Wait-Process 常驻等待。这样：
#     · 日志可靠落盘（不依赖父进程读管道）
#     · 由看门狗或计划任务持有本进程，子进程挂掉后看门狗能感知并重启
#
# 环境变量可在同目录的 config.env.ps1 里覆盖。

param(
    [switch]$NoWait      # 启动后立即返回，不等子进程（调试用）
)

$ErrorActionPreference = 'Stop'

$Root   = Split-Path -Parent $PSScriptRoot   # D:\3D_Work\Blog
$Bin    = Join-Path $Root 'target\release\blog_server.exe'
$LogDir = Join-Path $Root 'logs'
# 说明：Rust 侧全部使用 eprintln!，服务端输出（绑核结果、监听地址等）
# 都写在 stderr，所以看「server.err.log」。server.log 保留给未来的 stdout 输出。
# （Start-Process 不允许两个重定向指向同一文件，故必须分开。）
$Log     = Join-Path $LogDir 'server.log'
$ErrLog  = Join-Path $LogDir 'server.err.log'
$PidFile = Join-Path $LogDir 'server.pid'

# ---------------------------------------------------------------- 默认配置
#
# ⚠️ 端口特意避开 8080/8081/8082：
#    本机有 6 个 llama.cpp 启动脚本都占用 8080（llama-server 默认端口），
#    而 llama-ui 使用 8081。博客若沿用原端口会与其冲突，
#    尤其是 8081 —— 那是博客的「管理后台」，撞上 llama-ui 极易混淆。
#    故博客改用 8090（前台）/ 8091（后台）。
#
# BLOG_CPUS 默认绑 0-3（原项目为手机 4 核 A520 设计）。
# 本机是 16 核 32 线程，建议在 config.env.ps1 里放宽到 '0-7'。
$BLOG_WORKERS        = '4'
$BLOG_CPUS           = '0-3'
$BLOG_MAX_CONCURRENT = '2400'
$BLOG_EXT_ADDR       = '0.0.0.0:8090'
$BLOG_LOCAL_ADDR     = '127.0.0.1:8091'
# 前台地址。管理端页面上的「前台 ↗」「返回博客前台」链接用它。
# 不能用相对路径 /，因为管理端在 8091、前台在 8090 是两个端口，
# / 会指回管理端自己，被 302 弹回登录页（实际踩过这个坑）。
# 经隧道/局域网访问时服务端会优先用请求的 Host 头，这个值只作本机回落。
$BLOG_PUBLIC_URL     = 'http://127.0.0.1:8090/'
$BLOG_ROOT           = Join-Path $Root 'frontend'
$BLOG_DB             = Join-Path $Root 'blog.db'
$BLOG_CONFIG         = Join-Path $Root 'config.toml'

$envFile = Join-Path $PSScriptRoot 'config.env.ps1'
if (Test-Path $envFile) { . $envFile }

# ---------------------------------------------------------------- 前置检查
if (-not (Test-Path $Bin)) {
    Write-Error "找不到可执行文件：$Bin`n请先在 $Root 执行：cargo build --release"
    exit 1
}
if (-not (Test-Path $BLOG_CONFIG)) {
    Write-Warning "config.toml 不存在，将以默认密码启动：$BLOG_CONFIG"
}
if (-not (Test-Path $BLOG_DB)) {
    Write-Warning "blog.db 不存在，文章列表将为空：$BLOG_DB"
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# ---------------------------------------------------------------- 日志滚动
# 单文件超 5MB 切一份，最多保留 5 份（与手机端看门狗行为一致）
function Rotate-IfBig($path, $maxBytes = 5MB, $keep = 5) {
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

# ---------------------------------------------------------------- 设置环境变量
# Start-Process 无法直接传环境变量，先写进当前进程，子进程继承。
$env:BLOG_WORKERS        = $BLOG_WORKERS
$env:BLOG_CPUS           = $BLOG_CPUS
$env:BLOG_MAX_CONCURRENT = $BLOG_MAX_CONCURRENT
$env:BLOG_EXT_ADDR       = $BLOG_EXT_ADDR
$env:BLOG_LOCAL_ADDR     = $BLOG_LOCAL_ADDR
$env:BLOG_PUBLIC_URL     = $BLOG_PUBLIC_URL
$env:BLOG_ROOT           = $BLOG_ROOT
$env:BLOG_DB             = $BLOG_DB
$env:BLOG_CONFIG         = $BLOG_CONFIG

"[{0}] ===== 服务启动 CPUS={1} WORKERS={2} =====" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $BLOG_CPUS, $BLOG_WORKERS |
    Out-File -FilePath $Log -Append -Encoding UTF8

# ---------------------------------------------------------------- 启动
$proc = Start-Process -FilePath $Bin -WorkingDirectory $Root `
    -RedirectStandardOutput $Log -RedirectStandardError $ErrLog `
    -NoNewWindow -PassThru

$proc.Id | Set-Content $PidFile -Encoding ASCII

Start-Sleep -Seconds 3
if ($proc.HasExited) {
    Write-Warning "进程启动后立即退出，退出码 $($proc.ExitCode)。请查看 $ErrLog"
    exit 1
}

Write-Host ("博客服务已启动  PID={0}" -f $proc.Id) -ForegroundColor Green
Write-Host ("  外网只读: http://{0}" -f $BLOG_EXT_ADDR)
Write-Host ("  本机管理: http://{0}" -f $BLOG_LOCAL_ADDR)
Write-Host ("  日志    : {0}" -f $Log)

if ($NoWait) { exit 0 }

# 常驻等待：子进程活着本脚本就活着，子进程退出本脚本跟着退出。
# 看门狗通过检查端口和进程来判断服务健康度。
$proc.WaitForExit()
exit $proc.ExitCode
