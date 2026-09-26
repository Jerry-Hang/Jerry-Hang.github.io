# 安装计划任务.ps1
#
# 注册 Windows 计划任务，实现：
#   · 开机自动启动（无需登录）
#   · 看门狗常驻，服务挂了自动拉起
#   · 崩溃后自动重启
#
# 用法（需管理员）：
#   .\安装计划任务.ps1            安装/更新
#   .\安装计划任务.ps1 -Status    查看状态
#   .\安装计划任务.ps1 -Remove    卸载

param(
    [switch]$Remove,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'
function Line { Write-Host ("=" * 66) -ForegroundColor DarkGray }

$Root     = Split-Path -Parent $PSScriptRoot
$Watchdog = Join-Path $PSScriptRoot '看门狗.ps1'
$TaskName = 'JerryHang-Blog'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Line
Write-Host "  博客服务 —— 计划任务安装" -ForegroundColor White -BackgroundColor DarkBlue
Line
Write-Host ""
Write-Host ("  任务名称 : {0}" -f $TaskName)
Write-Host ("  脚本路径 : {0}" -f $Watchdog)
Write-Host ""

# ---------------------------------------------------------------- 状态
if ($Status) {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) {
        Write-Host "  ✅ 任务已安装" -ForegroundColor Green
        # 注意：Format-Table 的结果必须先 Out-String，否则 Write-Host 会把
        # 格式化对象本身（FormatStartData 等）当文本打出来。
        $t | Select-Object TaskName, State | Format-Table -AutoSize | Out-String | Write-Host
        $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($info) {
            Write-Host ("  上次运行 : {0}  结果: {1}" -f $info.LastRunTime, $info.LastTaskResult)
            Write-Host ("  下次运行 : {0}" -f $info.NextRunTime)
        }
        $p = Get-CimInstance Win32_Process -Filter "Name='blog_server.exe'" -ErrorAction SilentlyContinue
        $w = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -like '*看门狗*' }
        Write-Host ""
        Write-Host ("  blog_server 进程: {0}" -f $(if($p){"运行中 (PID $($p.ProcessId -join ','))"}else{"未运行"}))
        Write-Host ("  看门狗进程      : {0}" -f $(if($w){"运行中 (PID $($w.ProcessId -join ','))"}else{"未运行"}))
    } else {
        Write-Host "  ❌ 任务未安装" -ForegroundColor Yellow
    }
    exit 0
}

# ---------------------------------------------------------------- 卸载
if ($Remove) {
    if (-not $isAdmin) { Write-Host "  [!] 需要管理员权限" -ForegroundColor Red; exit 1 }
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "  ✅ 已卸载计划任务" -ForegroundColor Green
    } else {
        Write-Host "  任务本来就不存在" -ForegroundColor Gray
    }
    # 顺手停掉进程
    Get-CimInstance Win32_Process -Filter "Name='blog_server.exe'" -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*看门狗*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Host "  已停止相关进程" -ForegroundColor Gray
    exit 0
}

# ---------------------------------------------------------------- 安装
if (-not $isAdmin) {
    Write-Host "  [!] 需要管理员权限。请右键以管理员身份运行 PowerShell。" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $Watchdog)) {
    Write-Host ("  [!] 找不到看门狗脚本：{0}" -f $Watchdog) -ForegroundColor Red
    exit 1
}

$bin = Join-Path $Root 'target\release\blog_server.exe'
if (-not (Test-Path $bin)) {
    Write-Host ("  [!] 找不到可执行文件：{0}" -f $bin) -ForegroundColor Red
    Write-Host "      请先编译： cargo build --release" -ForegroundColor Yellow
    exit 1
}

# 动作：用 powershell 隐藏窗口运行看门狗
$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $Watchdog) `
    -WorkingDirectory $Root

# 触发器：开机（延迟 30 秒，等网络与磁盘就绪）
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'

# 设置：崩溃重启、不限时长、允许按需启动、不因电池停止
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -MultipleInstances IgnoreNew

# 主体：SYSTEM 账户，最高权限，无需登录
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

# 注册（已存在则覆盖）
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "  任务已存在，正在更新..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName `
    -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'JerryHang 博客服务器：开机自启 + 看门狗自动重启（对应 Termux 的 runit 方案）' | Out-Null

Write-Host "  ✅ 计划任务已注册" -ForegroundColor Green
Write-Host ""

# ---------------------------------------------------------------- 立即启动
Write-Host "  正在立即启动服务..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 8

$p = Get-CimInstance Win32_Process -Filter "Name='blog_server.exe'" -ErrorAction SilentlyContinue
if ($p) {
    Write-Host ("  ✅ blog_server 运行中  PID={0}" -f ($p.ProcessId -join ',')) -ForegroundColor Green
} else {
    Write-Host "  ⚠️ blog_server 未启动，检查日志：" -ForegroundColor Yellow
    Write-Host ("      {0}" -f (Join-Path $Root 'logs\watchdog.log'))
    Write-Host ("      {0}" -f (Join-Path $Root 'logs\server.err.log'))
}

# 端口检查
foreach ($port in @(8090, 8091)) {
    try {
        $code = & curl.exe -s -o NUL -w "%{http_code}" --max-time 5 "http://127.0.0.1:$port/" 2>$null
        Write-Host ("  端口 {0}: HTTP {1}" -f $port, $code)
    } catch {
        Write-Host ("  端口 {0}: 无响应" -f $port) -ForegroundColor Yellow
    }
}

Line
Write-Host "  安装完成" -ForegroundColor White
Line
Write-Host ""
Write-Host "  外网只读 : http://127.0.0.1:8090" -ForegroundColor White
Write-Host "  本机管理 : http://127.0.0.1:8091" -ForegroundColor White
Write-Host ""
Write-Host "  查看状态 : .\安装计划任务.ps1 -Status" -ForegroundColor Gray
Write-Host "  卸载     : .\安装计划任务.ps1 -Remove" -ForegroundColor Gray
Write-Host "  日志     : $Root\logs\" -ForegroundColor Gray
Write-Host ""
