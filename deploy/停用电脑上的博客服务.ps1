# 停用电脑上的博客服务.ps1
#
# 背景：博客已迁移到 VPS（Cloudflare 直接回源 VPS 的 80 端口，blog.service 常驻），
#       本机的 cloudflared 隧道 + blog_server 已成多余，且开机/登录会自动拉起。
# 本脚本：停止并禁用自启，但【不删除任何文件】。
#
# 用法（需要管理员）：右键 → 使用 PowerShell 运行

$ErrorActionPreference = 'Continue'
function Line { Write-Host ('─' * 62) -ForegroundColor DarkGray }
function Step($m) { Write-Host "  →  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  ✓  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  !  $m" -ForegroundColor Yellow }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Warn '需要管理员权限，正在提权...'
    Start-Process powershell.exe -Verb RunAs -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', "`"$PSCommandPath`"")
    exit 0
}

$logDir = Split-Path -Parent $PSCommandPath
try { Start-Transcript -Path (Join-Path $logDir '停用博客.log') -Force | Out-Null } catch { }

Line
Write-Host '  停用电脑上的博客服务（文件全部保留）' -ForegroundColor White -BackgroundColor DarkBlue
Line

# ---------------------------------------------------------------- 1) 计划任务
Step '第 1 步：停止并禁用计划任务 Tunnel-Blog'
$t = Get-ScheduledTask -TaskName 'Tunnel-Blog' -ErrorAction SilentlyContinue
if ($t) {
    Stop-ScheduledTask -TaskName 'Tunnel-Blog' -ErrorAction SilentlyContinue
    Disable-ScheduledTask -TaskName 'Tunnel-Blog' -ErrorAction SilentlyContinue | Out-Null
    $t2 = Get-ScheduledTask -TaskName 'Tunnel-Blog'
    if ($t2.State -eq 'Disabled') { Ok "已禁用（State=Disabled）—— 开机/登录不会再启动" }
    else { Warn "状态仍是 $($t2.State)" }
} else { Ok '任务不存在，无需处理' }

# ---------------------------------------------------------------- 2) 守护脚本
Step '第 2 步：结束博客守护用的 PowerShell（否则它会拉起进程）'
$killed = 0
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match 'Blog|隧道|博客|cloudflared' } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        $killed++
        Write-Host "      已结束 PID $($_.ProcessId)" -ForegroundColor DarkGray
    }
Ok "结束了 $killed 个守护进程"

Start-Sleep -Seconds 2

# ---------------------------------------------------------------- 3) 博客进程
Step '第 3 步：停止 blog_server 与 cloudflared'
foreach ($n in @('blog_server', 'cloudflared')) {
    $p = Get-Process -Name $n -ErrorAction SilentlyContinue
    if ($p) {
        $p | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        if (Get-Process -Name $n -ErrorAction SilentlyContinue) { Warn "$n 仍在运行" }
        else { Ok "$n 已停止" }
    } else { Ok "$n 本来就没运行" }
}

# ---------------------------------------------------------------- 4) 验证
Line
Write-Host '  验证' -ForegroundColor White -BackgroundColor DarkBlue
Line
$left = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'blog_server|cloudflared' })
"  残留进程     : $($left.Count) 个 $(if ($left.Count -eq 0) { '✅' } else { '⚠️' })"
$port = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 8090 }
"  8090 端口    : $(if ($port) { '仍在监听 ⚠️' } else { '已释放 ✅' })"
$t3 = Get-ScheduledTask -TaskName 'Tunnel-Blog' -ErrorAction SilentlyContinue
"  计划任务状态 : $($t3.State)"
Write-Host ''
Write-Host '  站点仍由 VPS 提供服务，不受影响：' -ForegroundColor Gray
try {
    $r = Invoke-WebRequest 'https://jerry-hang.blog/' -TimeoutSec 25 -UseBasicParsing
    Write-Host "    https://jerry-hang.blog/  ->  HTTP $($r.StatusCode)，$($r.Content.Length) 字节  ✅" -ForegroundColor Green
} catch { Write-Host "    访问失败: $($_.Exception.Message)" -ForegroundColor Yellow }

Line
Write-Host '  完成。D:\Blog 和 D:\3D_Work\Blog 的文件一个都没删。' -ForegroundColor Gray
Write-Host '  想恢复：把任务 Tunnel-Blog 重新启用即可（Enable-ScheduledTask）。' -ForegroundColor Gray
Line
try { Stop-Transcript | Out-Null } catch { }
Write-Host '  这个窗口可以关了。' -ForegroundColor Gray
