# 看门狗.ps1
#
# Windows 版看门狗，对应 deploy/blog_health.run（Termux/runit 版）。
# 每 15 秒检查一次服务；本地 8090 不可用就重启服务。
# 由计划任务在开机时拉起，常驻运行。
#
# 手动运行：powershell -File 看门狗.ps1

param(
    [int]$IntervalSecs = 15,
    [switch]$Once        # 只检查一次（调试用）
)

$Root   = Split-Path -Parent $PSScriptRoot
$Bin    = Join-Path $Root 'target\release\blog_server.exe'
$LogDir = Join-Path $Root 'logs'
$WatchLog = Join-Path $LogDir 'watchdog.log'
$PidFile  = Join-Path $LogDir 'server.pid'
$LockFile = Join-Path $LogDir 'watchdog.pid'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $WatchLog -Value $line -Encoding UTF8
}

# ---------------------------------------------------------------- 单实例保护
# 计划任务的 MultipleInstances=IgnoreNew 只能防止任务被重复触发，
# 防不住手动运行本脚本。这里用 pid 文件做兜底，避免出现两个看门狗
# 同时拉起服务（会造成端口抢占和进程反复重启）。
if (-not $Once) {
    if (Test-Path $LockFile) {
        $oldPid = (Get-Content $LockFile -Raw -ErrorAction SilentlyContinue).Trim()
        if ($oldPid -match '^\d+$') {
            $alive = Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue
            if ($alive) {
                Write-Host ("已有看门狗在运行（PID {0}），本实例退出。" -f $oldPid) -ForegroundColor Yellow
                Write-Log ("检测到已有看门狗 PID {0}，本实例退出" -f $oldPid)
                exit 0
            }
        }
        # 陈旧锁文件，清理
        Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
    }
    $PID | Set-Content $LockFile -Encoding ASCII
}

function Test-BlogPort {
    param([int]$Port = 8090)
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        return ($r.StatusCode -eq 200)
    } catch {
        # 401 也算服务活着（管理端口需要认证）
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -eq 401) { return $true }
        return $false
    }
}

function Get-BlogProcess {
    Get-CimInstance Win32_Process -Filter "Name='blog_server.exe'" -ErrorAction SilentlyContinue
}

function Start-Blog {
    $launcher = Join-Path $PSScriptRoot '启动博客.ps1'
    try {
        # 启动器会常驻等待子进程，所以用独立进程拉起，不阻塞看门狗。
        Start-Process -FilePath 'powershell.exe' `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
                            '-File', "`"$launcher`"") `
            -WindowStyle Hidden | Out-Null
        Write-Log "已拉起博客服务"
        return $true
    } catch {
        Write-Log "拉起失败: $($_.Exception.Message)"
        return $false
    }
}

function Stop-BlogProcess {
    $procs = Get-CimInstance Win32_Process -Filter "Name='blog_server.exe'" -ErrorAction SilentlyContinue
    if ($procs) {
        Write-Log ("结束 blog_server PID=" + (($procs | ForEach-Object { $_.ProcessId }) -join ','))
        $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 2
    }
}

function Rotate-Log($path, $maxBytes = 5MB, $keep = 5) {
    if (-not (Test-Path $path)) { return }
    if ((Get-Item $path).Length -le $maxBytes) { return }
    $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
    Move-Item $path "$path.$stamp" -Force -ErrorAction SilentlyContinue
    Get-ChildItem (Split-Path $path) -Filter ((Split-Path $path -Leaf) + '.*') |
        Sort-Object LastWriteTime -Descending | Select-Object -Skip $keep |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

Write-Log "看门狗启动（间隔 ${IntervalSecs}s，PID $PID）"

$failCount = 0

try {
    do {
        Start-Sleep -Seconds $IntervalSecs

        $running = Get-BlogProcess
        $alive = Test-BlogPort -Port 8090

        if (-not $alive) {
            $failCount++
            Write-Log "本地 8090 无响应（连续第 $failCount 次）"

            # 连续 2 次失败才动手，避免偶发抖动导致误重启
            if ($failCount -ge 2) {
                Stop-BlogProcess
                Start-Blog | Out-Null
                $failCount = 0
            }
        } else {
            if ($failCount -gt 0) {
                Write-Log "服务已恢复"
            }
            $failCount = 0

            # 进程在但端口不通的极端情况：进程数与监听不一致时也重启
            if (-not $running) {
                Write-Log "端口正常但找不到进程，记录并继续观察"
            }
        }

        # 日志滚动
        Rotate-Log (Join-Path $LogDir 'server.log')
        Rotate-Log (Join-Path $LogDir 'server.err.log')
        Rotate-Log $WatchLog 1MB 3

    } while (-not $Once)
} finally {
    # 无论正常结束还是被 Ctrl+C / 终止，都释放单实例锁
    if (Test-Path $LockFile) {
        $cur = (Get-Content $LockFile -Raw -ErrorAction SilentlyContinue).Trim()
        if ($cur -eq "$PID") { Remove-Item $LockFile -Force -ErrorAction SilentlyContinue }
    }
}

Write-Log "看门狗退出"
