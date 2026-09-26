# 配置 Cloudflare 隧道（用 API Token，不需要浏览器授权）
#
# 用法：
#   $env:CF_API_TOKEN = "你的token"
#   .\配置隧道.ps1
#
# 做四件事：
#   1. 验证 token，取出 Account ID / Zone ID
#   2. 建命名隧道 blog（已存在则复用）
#   3. 建 DNS 记录 blog.jerry-hang.blog -> 隧道
#   4. 写 cloudflared 配置和凭据文件，装成 Windows 服务开机自启
#
# 为什么用 API Token 而不是 cloudflared tunnel login：
#   login 流程要把证书回调到本机，但 dash.cloudflare.com 对非浏览器请求
#   返回 403 managed challenge（Cf-Mitigated: challenge），cloudflared
#   取不到证书，报 "Failed to fetch resource"。API Token 完全绕开这一步。

param(
    [string]$Domain    = 'jerry-hang.blog',
    [string]$Subdomain = 'blog',
    [string]$TunnelName = 'blog',
    [string]$Origin    = 'http://127.0.0.1:8090',
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$CF   = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$Home_ = Join-Path $env:USERPROFILE '.cloudflared'
$Api  = 'https://api.cloudflare.com/client/v4'

$token = $env:CF_API_TOKEN
if (-not $token) { $token = $env:CLOUDFLARE_API_TOKEN }
if (-not $token) {
    Write-Host "错误：没找到 API Token。" -ForegroundColor Red
    Write-Host "请先设置：`$env:CF_API_TOKEN = '你的token'" -ForegroundColor Yellow
    exit 1
}

$headers = @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' }

function Invoke-CF {
    param([string]$Method, [string]$Path, $Body)
    $uri = "$Api$Path"
    $params = @{ Method = $Method; Uri = $uri; Headers = $headers; TimeoutSec = 30 }
    if ($Body) { $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress) }
    try {
        $r = Invoke-RestMethod @params
    } catch {
        $detail = ''
        try {
            $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
            $detail = $sr.ReadToEnd()
        } catch { }
        throw "CF API 失败 $Method $Path`n$($_.Exception.Message)`n$detail"
    }
    if (-not $r.success) {
        throw "CF API 返回 success=false：$($r.errors | ConvertTo-Json -Compress)"
    }
    return $r.result
}

Write-Host "================================================" -ForegroundColor Cyan
Write-Host " 配置 Cloudflare 隧道" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# ---------- 1. 验证 token ----------
Write-Host "[1/5] 验证 token ..." -ForegroundColor Yellow
$verify = Invoke-CF 'GET' '/user/tokens/verify'
Write-Host ("      token 状态: {0}" -f $verify.status) -ForegroundColor Green

# ---------- 2. 取 Account ID ----------
Write-Host "[2/5] 查询账户 ..." -ForegroundColor Yellow
$accounts = Invoke-CF 'GET' '/accounts?per_page=50'
if (-not $accounts -or $accounts.Count -eq 0) { throw "这个 token 看不到任何账户，检查 Account Resources 是否选了账户" }
if ($accounts.Count -gt 1) {
    Write-Host "      有多个账户，需要你指定：" -ForegroundColor Yellow
    $accounts | ForEach-Object { Write-Host ("        {0}   {1}" -f $_.id, $_.name) }
    throw "请在脚本里把 `$AccountId 写死成上面某一个"
}
$AccountId = $accounts[0].id
Write-Host ("      账户: {0}" -f $accounts[0].name) -ForegroundColor Green
Write-Host ("      AccountId: {0}" -f $AccountId)

# ---------- 3. 取 Zone ID ----------
Write-Host "[3/5] 查询域名 $Domain ..." -ForegroundColor Yellow
$zones = Invoke-CF 'GET' "/zones?name=$Domain"
if (-not $zones -or $zones.Count -eq 0) {
    throw "找不到域名 $Domain。检查：1) 域名是否在 Cloudflare 托管 2) token 的 Zone Resources 是否包含它"
}
$ZoneId = $zones[0].id
Write-Host ("      ZoneId: {0}   状态: {1}" -f $ZoneId, $zones[0].status) -ForegroundColor Green
if ($zones[0].status -ne 'active') {
    Write-Host ("      警告：域名状态是 {0}，不是 active，DNS 可能不生效" -f $zones[0].status) -ForegroundColor Yellow
}

# ---------- 4. 建隧道（已存在则复用）----------
Write-Host "[4/5] 创建隧道 '$TunnelName' ..." -ForegroundColor Yellow
$existing = Invoke-CF 'GET' "/accounts/$AccountId/cfd_tunnel?name=$TunnelName&is_deleted=false"
$tunnel = $null
if ($existing -and $existing.Count -gt 0) {
    $tunnel = $existing[0]
    Write-Host ("      已存在同名隧道，复用 ID {0}" -f $tunnel.id) -ForegroundColor Yellow
} else {
    # secret 用随机 32 字节的 base64，cloudflared 会用它建立连接
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $buf = New-Object byte[] 32
    $rng.GetBytes($buf)
    $secret = [Convert]::ToBase64String($buf)

    $tunnel = Invoke-CF 'POST' "/accounts/$AccountId/cfd_tunnel" @{
        name           = $TunnelName
        tunnel_secret  = $secret
        config_src     = 'local'      # 配置放本机，不走云端
    }
    Write-Host ("      创建成功，ID {0}" -f $tunnel.id) -ForegroundColor Green
}
$TunnelId = $tunnel.id

# 取隧道凭据（等价于 login 得到的 cert.pem 的作用）
Write-Host "      获取隧道凭据 ..." -ForegroundColor Yellow
$cred = Invoke-CF 'GET' "/accounts/$AccountId/cfd_tunnel/$TunnelId/token"
Write-Host ("      凭据长度: {0}" -f $cred.Length) -ForegroundColor Green

# ---------- 5. 写配置 + DNS ----------
Write-Host "[5/5] 写配置并创建 DNS ..." -ForegroundColor Yellow

$Fqdn = "$Subdomain.$Domain"

if (-not $WhatIf) {
    New-Item -ItemType Directory -Force -Path $Home_ | Out-Null

    # 凭据文件
    $credObj = @{
        AccountTag   = $AccountId
        TunnelSecret = $cred
        TunnelID     = $TunnelId
    }
    $credPath = Join-Path $Home_ "$TunnelId.json"
    $credObj | ConvertTo-Json | Set-Content $credPath -Encoding UTF8
    Write-Host ("      凭据文件: {0}" -f $credPath) -ForegroundColor Green

    # 隧道配置
    $cfg = @"
# Cloudflare 隧道配置（由 配置隧道.ps1 生成）
tunnel: $TunnelId
credentials-file: $credPath

ingress:
  - hostname: $Fqdn
    service: $Origin
  - service: http_status:404
"@
    $cfgPath = Join-Path $Home_ 'config.yml'
    $cfg | Set-Content $cfgPath -Encoding UTF8
    Write-Host ("      配置文件: {0}" -f $cfgPath) -ForegroundColor Green

    # DNS：CNAME 指向 <隧道ID>.cfargotunnel.com，必须开代理（橙云）
    $target = "$TunnelId.cfargotunnel.com"
    $existingDns = Invoke-CF 'GET' "/zones/$ZoneId/dns_records?name=$Fqdn"
    $dnsBody = @{
        type    = 'CNAME'
        name    = $Subdomain
        content = $target
        proxied = $true
        ttl     = 1
        comment = 'blog tunnel (dsh)'
    }
    if ($existingDns -and $existingDns.Count -gt 0) {
        $rec = Invoke-CF 'PUT' "/zones/$ZoneId/dns_records/$($existingDns[0].id)" $dnsBody
        Write-Host ("      DNS 已更新: {0} -> {1}" -f $Fqdn, $target) -ForegroundColor Green
    } else {
        $rec = Invoke-CF 'POST' "/zones/$ZoneId/dns_records" $dnsBody
        Write-Host ("      DNS 已创建: {0} -> {1}" -f $Fqdn, $target) -ForegroundColor Green
    }

    Write-Host ""
    Write-Host "================================================" -ForegroundColor Cyan
    Write-Host " 配置完成" -ForegroundColor Cyan
    Write-Host "================================================" -ForegroundColor Cyan
    Write-Host ("  隧道 ID  : {0}" -f $TunnelId)
    Write-Host ("  访问地址 : https://{0}" -f $Fqdn)
    Write-Host ""
    Write-Host "  下一步（手动执行一次，装成开机自启服务）：" -ForegroundColor Yellow
    Write-Host ("    & '$CF' service install")
    Write-Host ""
    Write-Host "  或者直接前台跑测试："
    Write-Host ("    & '$CF' tunnel --config `"$cfgPath`" run $TunnelId")
} else {
    Write-Host "  -WhatIf：只验证，不写文件不改 DNS" -ForegroundColor Yellow
    Write-Host ("  将创建: {0} -> {1}.cfargotunnel.com" -f $Fqdn, $TunnelId)
}
