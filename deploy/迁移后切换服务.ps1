# 迁移后切换服务.ps1
#
# 把正在运行的博客服务从旧目录 D:\3D_Work\Blog 切换到本仓库所在目录（默认 D:\Blog）。
#
# 运行栈一共三层，切换时必须按顺序拆：
#
#   计划任务 JerryHang-Blog（SYSTEM，开机启动，延迟 30s）
#     └─ 看门狗.ps1          每 15s 探 8090，挂了就用**自己所在目录**的 exe 重新拉起
#          └─ 启动博客.ps1
#               └─ blog_server.exe   0.0.0.0:8090 前台 / 127.0.0.1:8091 管理
#
#   计划任务 Tunnel-Blog（当前用户，开机启动）
#     └─ 启动隧道.ps1 → cloudflared → https://jerry-hang.blog → 127.0.0.1:8090
#
# 为什么必须先杀看门狗、再杀服务：
#   看门狗是「目录绑定」的——它拉起服务用的是 $Root\target\release\blog_server.exe，
#   而 $Root 由脚本自身位置推导。如果只杀 blog_server，旧看门狗在 15 秒内就会把
#   旧目录的服务重新拉起来，和新目录的实例抢 8090，表现为两个进程反复重启。
#
# 隧道不用重启：
#   cloudflared 只认 127.0.0.1:8090 这个端口，不关心端口后面是哪个目录的进程。
#   本脚本只把 Tunnel-Blog 的 -File 参数改到新目录，让下次开机从新目录起。
#
# 用法（需要管理员，脚本会自己提权）：
#   .\迁移后切换服务.ps1              # 切到本仓库目录
#   .\迁移后切换服务.ps1 -DryRun      # 只检查 + 打印动作，不改动任何东西（无需管理员）
#   .\迁移后切换服务.ps1 -Rollback    # 切回旧目录 D:\3D_Work\Blog
#
# 旧目录不会被删除：切换成功且公网验证通过后，请自行决定是否清理。

param(
    [switch]$DryRun,
    [switch]$Rollback
)

$ErrorActionPreference = 'Stop'

$NewRoot    = Split-Path -Parent $PSScriptRoot        # 本仓库根目录
$OldRoot    = 'D:\3D_Work\Blog'
$TargetRoot = if ($Rollback) { $OldRoot } else { $NewRoot }
$SourceRoot = if ($Rollback) { $NewRoot } else { $OldRoot }

$TaskName   = 'JerryHang-Blog'      # 看门狗计划任务（由 安装计划任务.ps1 注册）
$TunnelTask = 'Tunnel-Blog'         # 隧道计划任务
$PublicUrl  = 'https://jerry-hang.blog'

function Line { Write-Host ('=' * 70) -ForegroundColor DarkGray }
function Step($m) { Write-Host ("  ->  $m") -ForegroundColor Cyan }
function Ok($m)   { Write-Host ("  OK  $m") -ForegroundColor Green }
function Warn($m) { Write-Host ("  !!  $m") -ForegroundColor Yellow }
function Die($m)  { Write-Host ("  XX  $m") -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 提权
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin -and -not $DryRun) {
    Warn '需要管理员权限（计划任务以 SYSTEM 运行），正在提权重启...'
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', ('"{0}"' -f $PSCommandPath))
    if ($Rollback) { $argList += '-Rollback' }
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList
    exit 0
}

Line
Write-Host ("  博客服务目录切换：{0}" -f $(if ($Rollback) { '回滚 → 旧目录' } else { '迁移 → 本仓库目录' })) `
    -ForegroundColor White -BackgroundColor DarkBlue
Line
Write-Host ("  当前运行目录 : {0}" -f $SourceRoot)
Write-Host ("  切换目标目录 : {0}" -f $TargetRoot)
Write-Host ("  模式         : {0}" -f $(if ($DryRun) { 'DryRun（只检查，不修改）' } else { '实际执行' }))
Write-Host ''

# ---------------------------------------------------------------- 前置检查
$Bin       = Join-Path $TargetRoot 'target\release\blog_server.exe'
$Db        = Join-Path $TargetRoot 'blog.db'
$Cfg       = Join-Path $TargetRoot 'config.toml'
$Installer = Join-Path $TargetRoot 'deploy\安装计划任务.ps1'
$TunnelPs1 = Join-Path $TargetRoot 'deploy\启动隧道.ps1'

foreach ($p in @($Bin, $Db, $Cfg, $Installer)) {
    if (-not (Test-Path $p)) { Die ("目标目录不完整，缺少：{0}" -f $p) }
}
Ok '目标目录齐全（可执行文件 / 数据库 / 配置 / 任务安装脚本）'

$dbSize = (Get-Item $Db).Length
if ($dbSize -lt 1024) { Warn ("blog.db 只有 {0} 字节，文章可能为空" -f $dbSize) }

# ---------------------------------------------------------------- 停止当前运行栈
Step '停止当前运行栈（顺序：计划任务 → 看门狗/启动器 → 服务本体）'

if ($DryRun) {
    Warn 'DryRun：跳过停止动作'
} else {
    # 1) 先停计划任务，避免它重新拉起看门狗
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task -and $task.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Ok ("已停止计划任务 {0}" -f $TaskName)
        Start-Sleep -Seconds 1
    }

    # 2) 看门狗 + 启动器（按命令行匹配，不区分它在哪个目录）
    $watchers = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and (
                $_.CommandLine -like '*看门狗.ps1*' -or
                $_.CommandLine -like '*启动博客.ps1*' -or
                $_.CommandLine -like '*启动博客.bat*'
            )
        })
    if ($watchers.Count -eq 0) {
        Ok '没有运行中的看门狗 / 启动器'
    } else {
        foreach ($w in $watchers) {
            Step ("结束 看门狗/启动器 PID={0}" -f $w.ProcessId)
            Stop-Process -Id $w.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Seconds 1

    # 3) 服务本体
    $svcs = @(Get-Process -Name 'blog_server' -ErrorAction SilentlyContinue)
    foreach ($s in $svcs) {
        Step ("结束 blog_server PID={0}" -f $s.Id)
        Stop-Process -Id $s.Id -Force -ErrorAction SilentlyContinue
    }
    if ($svcs.Count -eq 0) { Ok '没有运行中的 blog_server' }

    # 4) 等端口释放（不释放就说明还有幸存实例，继续下去必定抢端口）
    $freed = $false
    for ($i = 1; $i -le 24; $i++) {
        Start-Sleep -Milliseconds 500
        $busy = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalPort -in 8090, 8091 })
        if ($busy.Count -eq 0) { $freed = $true; break }
    }
    if ($freed) {
        Ok '8090 / 8091 已释放'
    } else {
        Die '8090 / 8091 仍被占用，请手动排查：Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 8090,8091 }'
    }
}

# ---------------------------------------------------------------- 隧道任务改指新目录
Step ("更新计划任务 {0} 的脚本路径" -f $TunnelTask)

$tunnelTask = Get-ScheduledTask -TaskName $TunnelTask -ErrorAction SilentlyContinue
if (-not $tunnelTask) {
    Warn ("计划任务 {0} 不存在，跳过（隧道如需开机自启，请跑 deploy\配置隧道.ps1）" -f $TunnelTask)
} elseif (-not (Test-Path $TunnelPs1)) {
    Warn ("找不到 {0}，跳过" -f $TunnelPs1)
} elseif ($DryRun) {
    Warn ("DryRun：会把 -File 改为 {0}" -f $TunnelPs1)
} else {
    # 注意：任务可能正在运行（cloudflared 常驻）。改 action 只影响下次启动，
    # 当前这条隧道不受影响，也不会中断正在服务的公网访问。
    try {
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
            -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $TunnelPs1)
        Set-ScheduledTask -TaskName $TunnelTask -Action $action | Out-Null
        Ok ("{0} 已指向 {1}" -f $TunnelTask, $TunnelPs1)
    } catch {
        Warn ("更新失败（隧道本身不受影响）：{0}" -f $_.Exception.Message)
    }
}

# ---------------------------------------------------------------- 注册并启动目标目录服务
Step ("注册计划任务 {0} 并从目标目录启动服务" -f $TaskName)

if ($DryRun) {
    Warn ("DryRun：会执行 {0}" -f $Installer)
} else {
    Push-Location $TargetRoot
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Installer
    } finally {
        Pop-Location
    }
}

# ---------------------------------------------------------------- 验证
Write-Host ''
Step '验证'

$localOk = $false
for ($i = 1; $i -le 30; $i++) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-WebRequest 'http://127.0.0.1:8090/' -TimeoutSec 5 -UseBasicParsing
        if ($r.StatusCode -eq 200) { $localOk = $true; break }
    } catch { }
}
if ($localOk) {
    Ok '本地前台 http://127.0.0.1:8090  →  HTTP 200'
} else {
    Warn ("本地 8090 未就绪，请看 {0}\logs\server.err.log" -f $TargetRoot)
}

try {
    $admin = Invoke-WebRequest 'http://127.0.0.1:8091/login' -TimeoutSec 5 -UseBasicParsing
    Ok ("本地管理 http://127.0.0.1:8091/login  →  HTTP {0}" -f $admin.StatusCode)
} catch {
    Warn '本地 8091 未就绪'
}

# 确认跑的确实是目标目录的可执行文件
$running = @(Get-CimInstance Win32_Process -Filter "Name='blog_server.exe'" -ErrorAction SilentlyContinue)
if ($running.Count -eq 0) {
    Warn '没有检测到 blog_server.exe 进程'
} elseif ($running.Count -gt 1) {
    Warn ("检测到 {0} 个 blog_server.exe 进程，可能有多份实例在抢端口" -f $running.Count)
} else {
    $exe = $running[0].ExecutablePath
    if ($exe) {
        Write-Host ("      blog_server.exe = {0}" -f $exe)
        if ($exe -like ('{0}*' -f $TargetRoot)) {
            Ok '运行中的服务来自目标目录'
        } else {
            Warn ("仍在运行非目标目录的实例：{0}" -f $exe)
        }
    }
}

# 公网（经 Cloudflare 隧道）
try {
    $pub = Invoke-WebRequest $PublicUrl -TimeoutSec 25 -UseBasicParsing
    Ok ("公网 {0}  →  HTTP {1}" -f $PublicUrl, $pub.StatusCode)
} catch {
    Warn ("公网检查失败（隧道可能未运行）：{0}" -f $_.Exception.Message)
}

$cf = @(Get-Process -Name 'cloudflared' -ErrorAction SilentlyContinue)
if ($cf.Count -gt 0) { Ok ("cloudflared 运行中 PID={0}" -f ($cf.Id -join ',')) } else { Warn 'cloudflared 未运行，公网会 502/530' }

# ---------------------------------------------------------------- 收尾
Line
Write-Host '  完成' -ForegroundColor White -BackgroundColor DarkBlue
Line
Write-Host ''
Write-Host ("  服务目录 : {0}" -f $TargetRoot)
Write-Host  '  外网只读 : https://jerry-hang.blog   (本机 0.0.0.0:8090)'
Write-Host  '  本机管理 : http://127.0.0.1:8091'
Write-Host  ''
if (-not $Rollback) {
    Write-Host '  回滚方法（如果新目录有问题）：' -ForegroundColor Gray
    Write-Host '    .\迁移后切换服务.ps1 -Rollback' -ForegroundColor Gray
    Write-Host ("  旧目录 {0} 未被删除，可直接回滚。" -f $OldRoot) -ForegroundColor Gray
    Write-Host ''
}
