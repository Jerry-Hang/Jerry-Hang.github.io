//! Tokio + axum async dual-port dynamic blog server with request-log threat monitoring.

use std::env;
use std::fs;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use axum::Router;
use serde_json::json;
use tokio::net::TcpListener;

use crate::base64;
use crate::db::{html_escape, Db, Post};
use crate::sha256;

pub const DEFAULT_USERNAME: &str = "admin";
pub const DEFAULT_PASSWORD: &str = "change-me-on-first-login";
// 内存熔断阈值（RSS，单位 KB）：超过 MEM_THROTTLE_KB 触发限流（并发减半），
// 超过 MEM_CRITICAL_KB 降至 10%，超过 MEM_EMERGENCY_KB 紧急熔断（拒收新连接防 OOM），
// 回落到 MEM_RECOVER_KB 以下恢复。系统级硬上限由 systemd MemoryMax=1280M 兜底。
const MEM_THROTTLE_KB: u64 = 1000 * 1024; // 1000 MB (约 78% of 1280MB)
const MEM_CRITICAL_KB: u64 = 1152 * 1024; // 1152 MB (90% of 1280MB)
const MEM_EMERGENCY_KB: u64 = 1200 * 1024; // 1200 MB (93.75% of 1280MB)
const MEM_RECOVER_KB: u64 = 896 * 1024;  // 896 MB (70% of 1280MB)
const MEM_SAMPLE_SECS: u64 = 1;
const CACHE_CONTROL: &str = "public, max-age=600, s-maxage=600";

// ---------------------------------------------------------------------------
// 后台界面资源
// ---------------------------------------------------------------------------
// 用 include_str! 在编译期嵌入二进制，保持「单文件 exe 拷过去就能跑」的部署方式。
// 源码分成独立文件（src/admin/）是为了可维护——之前这些 HTML/CSS/JS 是压成
// 一整行塞在本文件里的，改一处要从上万字符里找，没法看 diff。
//
// 关于 placeholder 设计：
//   admin.html 里用 /*__CSS__*/ 和 //__JS__ 占位，
//   运行时 admin_dashboard() 用 replacen 注入下面两个常量的内容，
//   这样页面只有一个 HTML 请求，也不需要额外路由。
const ADMIN_HTML: &str = include_str!("admin/admin.html");
const ADMIN_CSS: &str = include_str!("admin/admin.css");
const ADMIN_JS: &str = include_str!("admin/admin.js");
const LOGIN_HTML: &str = include_str!("admin/login.html");

const CSS_PLACEHOLDER: &str = "/*__CSS__*/";
const JS_PLACEHOLDER: &str = "//__JS__";
/// 「返回博客前台」链接的占位符，运行时按请求上下文替换。
const PUBLIC_URL_PLACEHOLDER: &str = "__PUBLIC_URL__";
/// 登录页用户名的占位符。本站只有一个账号，登录页不显示用户名输入框，
/// 由服务端把配置里的用户名注入到隐藏字段，避免把它写死在模板里。
const USERNAME_PLACEHOLDER: &str = "__USERNAME__";
/// 前台地址的默认值（本机）。
/// 管理端在 8091，前台在 8090 —— 两个端口，所以不能用相对路径 `/`，
/// 那样会指回管理端自己，被 302 弹回登录页（实际踩过这个坑）。
const DEFAULT_PUBLIC_URL: &str = "http://127.0.0.1:8090/";

/// 决定「返回前台」应该指向哪个地址。
///
/// 优先看请求的 Host 头：
///   · 经 Cloudflare 隧道访问时 Host 是 jerry-hang.blog，直接用它最自然
///   · 局域网用 192.168.x.x:8091 访问时，把管理端口换成前台端口
///   · 本机 127.0.0.1:8091 同样换成前台端口
///
/// 为什么要换端口：管理端在 8091、前台在 8090。
/// Host 里带的是**管理端**的端口，直接拿去拼链接会指回管理端自己，
/// 被 302 弹回登录页 —— 表现成「点了没反应」。这个坑实际踩过两次：
/// 先是写死相对路径 `/`，再是直接拿 Host 拼。
/// 判断请求是否为 HTTPS 流量（包括 Cloudflare 隧道和反向代理下发的头部）
fn is_https_request(headers: &HeaderMap) -> bool {
    if let Some(proto) = headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()) {
        if proto.eq_ignore_ascii_case("https") {
            return true;
        }
    }
    if let Some(cf_visitor) = headers.get("cf-visitor").and_then(|v| v.to_str().ok()) {
        if cf_visitor.contains("\"https\"") {
            return true;
        }
    }
    false
}

/// 往 HTML 属性里插值时的最小转义，避免属性结构被破坏。
fn html_attr_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// BLOG_PUBLIC_URL 用来兜底（没有 Host 头时），默认 http://127.0.0.1:8090/。
fn public_url(headers: &HeaderMap) -> String {
    let ext_port = env::var("BLOG_EXT_ADDR")
        .ok()
        .and_then(|a| a.rsplit(':').next().map(|s| s.to_string()))
        .unwrap_or_else(|| "8090".to_string());

    let configured = env::var("BLOG_PUBLIC_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_PUBLIC_URL.to_string());

    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return configured;
    };
    let h = host.trim().to_ascii_lowercase();
    if h.is_empty() {
        return configured;
    }

    // 校验 Host 头部字符合法性，防止注入攻击
    let is_valid = h.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == ':' || c == '[' || c == ']');
    if !is_valid {
        return configured;
    }

    let scheme = if is_https_request(headers) { "https" } else { "http" };

    // IPv6 字面量：[::1]:8091
    if let Some(rest) = h.strip_prefix('[') {
        if let Some((addr, port)) = rest.split_once("]:") {
            return if port == ext_port {
                format!("{scheme}://[{addr}]:{ext_port}/")
            } else {
                format!("{scheme}://[{addr}]/")
            };
        }
    }

    match h.split_once(':') {
        // 带端口：是管理端端口就换成前台端口，否则说明本来指向别处，保留
        Some((name, port)) => {
            if port == ext_port {
                format!("{scheme}://{name}:{port}/")
            } else {
                format!("{scheme}://{name}:{ext_port}/")
            }
        }
        // 不带端口（经隧道，浏览器默认 80/443）：直接用域名
        None => format!("{scheme}://{h}/"),
    }
}

/// 把占位符换成实际地址，并进行属性结构转义。
fn inject_public_url(html: &str, url: &str) -> String {
    let safe_url = html_attr_escape(url);
    html.replace(PUBLIC_URL_PLACEHOLDER, &safe_url)
}

/// 判断这次请求是不是「本机访问」。
///
/// 两个条件都要满足：
///   1. 连接来自回环地址（peer 是 127.0.0.1）
///   2. Host 头也是回环名字（127.0.0.1 / localhost）
///
/// 为什么不能只看第 1 条：从本机用 `curl -H "Host: 192.168.2.217:8090"` 打过去，
/// peer 仍是 127.0.0.1，但那模拟的是局域网访问，不该显示「查看后台」。
/// 只看 peer 会让这个判断在任何测试里都为真，等于没做。
fn is_local_access(peer_ip: &std::net::IpAddr, headers: &HeaderMap) -> bool {
    if !peer_ip.is_loopback() {
        return false;
    }
    match headers.get(header::HOST).and_then(|v| v.to_str().ok()) {
        Some(h) => {
            let h = h.trim().to_ascii_lowercase();
            let name = if let Some(rest) = h.strip_prefix('[') {
                rest.split("]:").next().unwrap_or(rest).to_string()
            } else {
                h.split(':').next().unwrap_or("").to_string()
            };
            name == "127.0.0.1" || name == "localhost" || name == "::1" || name.starts_with("127.")
        }
        // 没有 Host 头（HTTP/1.0）时按本机处理，避免误删
        None => true,
    }
}

/// 本机专用内容的标记。前后这对注释之间包住「查看后台」按钮的注入脚本：
/// 本机访问保留，局域网/外网访问整段删掉 —— 管理端只绑 127.0.0.1，
/// 外面的人点了也打不开，不如不显示。
const LOCAL_ONLY_START: &str = "<!--ADMIN_LINK_START-->";
const LOCAL_ONLY_END: &str = "<!--ADMIN_LINK_END-->";

/// 把 HTML 里标记为「仅本机」的片段删掉。
fn strip_local_only(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(a) = rest.find(LOCAL_ONLY_START) {
        out.push_str(&rest[..a]);
        match rest[a..].find(LOCAL_ONLY_END) {
            Some(b) => rest = &rest[a + b + LOCAL_ONLY_END.len()..],
            None => {
                // 标记不成对就不动，避免误删后面所有内容
                out.push_str(&rest[a..]);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

#[derive(Clone)]
pub struct Config {
    pub username: String,
    pub password_sha256: String,
    pub root: PathBuf,
}

pub fn load_config(path: &str, root: PathBuf) -> Result<Config, String> {
    if !Path::new(path).exists() {
        let hash = sha256::sha256_hex(DEFAULT_PASSWORD.as_bytes());
        let content = format!(
            "# JerryHang blog static server config\n\
             # Change `password_sha256` to protect your blog.\n\
             # Generate a new hash with:  blog_server --hash <YOUR_PASSWORD>\n\
             username={}\n\
             password_sha256={}\n",
            DEFAULT_USERNAME, hash
        );
        if let Err(e) = fs::write(path, content) {
            return Err(format!("cannot write default config {path}: {e}"));
        }
        eprintln!("default config written: {path}");
    }
    let content = fs::read_to_string(path).map_err(|e| format!("cannot read config {path}: {e}"))?;
    let mut username = DEFAULT_USERNAME.to_string();
    let mut password_sha256 = String::new();
    for (line_no, line) in content.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let key = k.trim();
            let val = v.trim();
            match key {
                "username" => username = val.to_string(),
                "password_sha256" => password_sha256 = val.to_string(),
                other => {
                    eprintln!(
                        "警告: 配置文件 {path}:{} 发现未识别的键 '{other}'（目前仅支持 username 和 password_sha256），该行已被忽略",
                        line_no + 1
                    );
                }
            }
        } else {
            eprintln!(
                "警告: 配置文件 {path}:{} 格式无效（缺少 '=' 键值分隔符）：'{line}'",
                line_no + 1
            );
        }
    }
    if password_sha256.is_empty() {
        return Err("password_sha256 is empty".to_string());
    }
    Ok(Config { username, password_sha256, root })
}

struct Gate {
    active: AtomicUsize,
    effective: AtomicUsize,
}

impl Gate {
    fn new(base: usize) -> Self {
        Gate { active: AtomicUsize::new(0), effective: AtomicUsize::new(base.max(1)) }
    }
    fn try_acquire(&self) -> bool {
        let eff = self.effective.load(Ordering::SeqCst);
        let mut cur = self.active.load(Ordering::SeqCst);
        loop {
            if cur >= eff {
                return false;
            }
            match self.active.compare_exchange_weak(cur, cur + 1, Ordering::SeqCst, Ordering::SeqCst) {
                Ok(_) => return true,
                Err(actual) => cur = actual,
            }
        }
    }
    fn release(&self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
    fn snapshot(&self) -> (usize, usize) {
        (self.active.load(Ordering::SeqCst), self.effective.load(Ordering::SeqCst))
    }
}

struct GateGuard(Arc<Gate>);
impl Drop for GateGuard {
    fn drop(&mut self) {
        self.0.release();
    }
}

// 内存 / CPU 统计改为走 platform 模块（Unix 读 /proc，Windows 走 Win32 API）

async fn memory_monitor(gate: Arc<Gate>, base: usize) {
    let mut throttle_level = 0; // 0: 正常, 1: 50%限流, 2: 10%重度降级, 3: 紧急熔断
    loop {
        if let Some(kb) = crate::platform::read_vmrss_kb() {
            if kb >= MEM_EMERGENCY_KB {
                throttle_level = 3;
            } else if kb >= MEM_CRITICAL_KB {
                throttle_level = 2;
            } else if kb >= MEM_THROTTLE_KB {
                if throttle_level < 1 {
                    throttle_level = 1;
                }
            } else if kb <= MEM_RECOVER_KB {
                throttle_level = 0;
            }
        }
        let limit = match throttle_level {
            3 => 0,                  // 紧急熔断（>= 480MB）：拒收新连接，防止触发内核 512MB OOM
            2 => (base / 10).max(4), // 重度限流（>= 448MB）：并发压至 10%
            1 => (base / 2).max(1),  // 一级限流（>= 384MB）：并发减半
            _ => base.max(1),        // 恢复正常（<= 256MB）：100% 满负荷
        };
        gate.effective.store(limit, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(MEM_SAMPLE_SECS)).await;
    }
}

// ---------------------------------------------------------------------------
// 防爆破与 DDoS 频率限制器（纯内存滑动窗口，防恶意洪水与路径枚举扫描）
// ---------------------------------------------------------------------------
struct IpState {
    window_start: Instant,
    req_count: u32,
    scan_count: u32,
    banned_until: Option<Instant>,
}

struct IpRateLimiter {
    records: RwLock<HashMap<String, IpState>>,
}

impl IpRateLimiter {
    fn new() -> Self {
        Self {
            records: RwLock::new(HashMap::new()),
        }
    }

    /// 检查该 IP 是否被封禁或请求超频。
    /// 正常返回 Ok(())；超频返回 Err((StatusCode, 提示信息))。
    fn check_and_record(&self, ip: &str) -> Result<(), (StatusCode, &'static str)> {
        let now = Instant::now();
        let mut map = self.records.write().unwrap();

        // 内存过载防御：当条目激增时触发内联清理，防止伪造随机 IP 撑爆内存
        if map.len() >= 4000 && !map.contains_key(ip) {
            Self::prune_internal(&mut map, now);
            if map.len() >= 5000 {
                return Err((StatusCode::TOO_MANY_REQUESTS, "System rate limiter saturated"));
            }
        }

        let entry = map.entry(ip.to_string()).or_insert_with(|| IpState {
            window_start: now,
            req_count: 0,
            scan_count: 0,
            banned_until: None,
        });

        // 1. 是否正处于封禁期
        if let Some(until) = entry.banned_until {
            if now < until {
                return Err((StatusCode::TOO_MANY_REQUESTS, "IP temporarily rate-limited"));
            } else {
                entry.banned_until = None;
                entry.window_start = now;
                entry.req_count = 0;
                entry.scan_count = 0;
            }
        }

        // 2. 10 秒滑动窗口
        let elapsed = now.duration_since(entry.window_start);
        if elapsed >= Duration::from_secs(10) {
            entry.window_start = now;
            entry.req_count = 1;
        } else {
            entry.req_count += 1;
            // 10秒内超过120次请求（正常浏览通常一次载入15-20次），判定为洪水/爬虫
            if entry.req_count > 120 {
                entry.banned_until = Some(now + Duration::from_secs(60));
                return Err((StatusCode::TOO_MANY_REQUESTS, "Rate limit exceeded (flood)"));
            }
        }
        Ok(())
    }

    /// 当请求返回 404 时记录一次探测。若频繁 404 判定为恶意路径枚举并封禁。
    fn record_scan_error(&self, ip: &str) {
        let now = Instant::now();
        let mut map = self.records.write().unwrap();
        if map.len() >= 4000 && !map.contains_key(ip) {
            Self::prune_internal(&mut map, now);
        }
        let entry = map.entry(ip.to_string()).or_insert_with(|| IpState {
            window_start: now,
            req_count: 0,
            scan_count: 0,
            banned_until: None,
        });
        if entry.banned_until.is_none() && now.duration_since(entry.window_start) >= Duration::from_secs(30) {
            entry.window_start = now;
            entry.req_count = 0;
            entry.scan_count = 0;
        }
        entry.scan_count += 1;
        if entry.scan_count >= 15 {
            // 连续 15 次 404，临时封禁 5 分钟
            entry.banned_until = Some(now + Duration::from_secs(300));
        }
    }

    fn prune_internal(map: &mut HashMap<String, IpState>, now: Instant) {
        // 保留有效封禁条目与活跃窗口条目
        map.retain(|_, state| {
            if let Some(b) = state.banned_until {
                b > now
            } else {
                now.duration_since(state.window_start) < Duration::from_secs(30)
            }
        });
        // 若仍超过 4000 条，淘汰最旧的非封禁条目，誓死避免清空已封禁的恶意 IP
        if map.len() > 4000 {
            let mut unbanned_keys: Vec<(String, Instant)> = map
                .iter()
                .filter(|(_, state)| state.banned_until.map_or(true, |b| b <= now))
                .map(|(k, state)| (k.clone(), state.window_start))
                .collect();
            unbanned_keys.sort_by_key(|(_, t)| *t);
            let to_remove = map.len().saturating_sub(3500);
            for (k, _) in unbanned_keys.into_iter().take(to_remove) {
                map.remove(&k);
            }
        }
    }

    /// 定期清理过期条目，保持内存轻量并持久锁定恶意 IP
    fn prune(&self) {
        let now = Instant::now();
        let mut map = self.records.write().unwrap();
        Self::prune_internal(&mut map, now);
    }

    /// 手动解除指定 IP 的封禁
    fn unban(&self, ip: &str) -> bool {
        let mut map = self.records.write().unwrap();
        if let Some(entry) = map.get_mut(ip) {
            entry.banned_until = None;
            entry.req_count = 0;
            entry.scan_count = 0;
            true
        } else {
            false
        }
    }

    /// 列出所有当前处于封禁状态的 IP 及剩余秒数
    fn list_banned(&self) -> Vec<(String, u64)> {
        let now = Instant::now();
        let map = self.records.read().unwrap();
        let mut out = Vec::new();
        for (ip, state) in map.iter() {
            if let Some(until) = state.banned_until {
                if until > now {
                    let rem = until.duration_since(now).as_secs();
                    out.push((ip.clone(), rem));
                }
            }
        }
        out
    }

    /// 校验配对尝试频率（防止暴力探测配对密钥）
    fn check_pair_rate(&self, ip: &str) -> Result<(), &'static str> {
        let now = Instant::now();
        let map = self.records.read().unwrap();
        if let Some(state) = map.get(ip) {
            if let Some(until) = state.banned_until {
                if until > now {
                    return Err("IP 处于临时限流/封禁中");
                }
            }
            if state.scan_count >= 15 {
                return Err("尝试次数过多，请稍后再试");
            }
        }
        Ok(())
    }

    /// 记录配对失败，快速累积封禁计数
    fn record_pair_fail(&self, ip: &str) {
        let now = Instant::now();
        let mut map = self.records.write().unwrap();
        let entry = map.entry(ip.to_string()).or_insert_with(|| IpState {
            window_start: now,
            req_count: 0,
            scan_count: 0,
            banned_until: None,
        });
        if entry.banned_until.is_none() && now.duration_since(entry.window_start) >= Duration::from_secs(30) {
            entry.window_start = now;
            entry.req_count = 0;
            entry.scan_count = 0;
        }
        entry.scan_count += 5; // 3 次失败即封禁 5 分钟 (5 -> 10 -> 15)
        if entry.scan_count >= 15 {
            entry.banned_until = Some(now + Duration::from_secs(300));
        }
    }
}

async fn session_cleanup(db: Arc<Db>, rate_limiter: Arc<IpRateLimiter>) {
    // 会话与配对码过期检查：每分钟一次
    let mut last_prune = Instant::now();
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        db.delete_expired_sessions();
        db.delete_expired_pair_codes();
        rate_limiter.prune();

        // 请求日志清理：每天一次。
        // request_logs 原来只增不减，公网跑久了数据库和 WAL 会无限增长。
        // 保留策略见 Db::prune_request_logs 的注释（正常 30 天 / 安全类别 90 天）。
        if last_prune.elapsed() >= Duration::from_secs(24 * 60 * 60) {
            let n = db.prune_request_logs();
            if n > 0 {
                eprintln!("request_logs pruned: {n} rows removed");
            }
            // 清理后把 WAL 合并回主库，让主库文件反映真实数据量
            db.checkpoint_wal();
            last_prune = Instant::now();
        }
    }
}

struct AppState {
    cfg: RwLock<Config>,
    gate: Arc<Gate>,
    rate_limiter: Arc<IpRateLimiter>,
    root_canon: PathBuf,
    db: Arc<Db>,
    start: Instant,
}

pub async fn run(cfg: Config, ext_addr: &str, local_addr: &str, max_concurrent: usize, db_path: &str) -> std::io::Result<()> {
    let root_canon = fs::canonicalize(&cfg.root).unwrap_or_else(|_| cfg.root.clone());
    let db = Db::open(Path::new(db_path)).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let db = Arc::new(db);
    let gate = Arc::new(Gate::new(max_concurrent));
    let rate_limiter = Arc::new(IpRateLimiter::new());
    let state = Arc::new(AppState {
        cfg: RwLock::new(cfg.clone()),
        gate: gate.clone(),
        rate_limiter: rate_limiter.clone(),
        root_canon,
        db: db.clone(),
        start: Instant::now(),
    });

    let ext = TcpListener::bind(ext_addr).await?;
    // 管理端口可选：BLOG_LOCAL_ADDR 为空 / "none" / "off" 时不监听。
    let loc = if local_addr.is_empty()
        || local_addr.eq_ignore_ascii_case("none")
        || local_addr.eq_ignore_ascii_case("off")
    {
        None
    } else {
        Some(TcpListener::bind(local_addr).await?)
    };
    if loc.is_some() {
        eprintln!("external {ext_addr} (tunnel), local {local_addr} (management)");
    } else {
        eprintln!("external {ext_addr} (tunnel), local management DISABLED (use `blog_server ctl`)");
    }
    eprintln!("serving {}, gate={max_concurrent}, db={db_path}", cfg.root.display());

    tokio::spawn(memory_monitor(gate.clone(), max_concurrent));
    tokio::spawn(session_cleanup(db.clone(), rate_limiter.clone()));

    let ext_app = Router::new().fallback(external_handler).with_state(state.clone());
    let t1 = tokio::spawn(async move {
        let _ = axum::serve(ext, ext_app.into_make_service_with_connect_info::<SocketAddr>()).await;
    });
    if let Some(loc) = loc {
        let loc_app = Router::new().fallback(local_handler).with_state(state.clone());
        let t2 = tokio::spawn(async move {
            let _ = axum::serve(loc, loc_app.into_make_service_with_connect_info::<SocketAddr>()).await;
        });
        let _ = tokio::join!(t1, t2);
    } else {
        let _ = t1.await;
    }
    Ok(())
}

fn ua_of(req: &Request) -> String {
    req.headers()
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

fn parse_valid_ip(s: &str) -> Option<String> {
    let s = s.trim();
    if s.is_empty() || s.len() > 64 {
        return None;
    }
    s.parse::<std::net::IpAddr>().ok().map(|ip| ip.to_string())
}

/// 取访客真实 IP。
///
/// 为什么需要：公网流量是经 Cloudflare 隧道进来的，cloudflared 在本机
/// 反向连到 127.0.0.1:8090，所以 peer 永远是回环地址。
///
/// 安全隔离原则：
/// 1. 仅当 peer 为回环地址（表明来自本机 Cloudflare Tunnel 守护进程）时，才信任转发头；
/// 2. 若直接从公网 TCP 连入（非回环 peer），一律以底层 TCP peer.ip 为准，杜绝伪造头欺骗限流器；
/// 3. 所有提取出的 IP 必须严格通过 IpAddr 解析验证，阻断恶意畸形伪造串。
fn client_ip(headers: &HeaderMap, peer: &SocketAddr) -> String {
    if peer.ip().is_loopback() {
        for name in ["cf-connecting-ip", "true-client-ip", "x-real-ip"] {
            if let Some(v) = headers.get(name).and_then(|v| v.to_str().ok()) {
                if let Some(valid) = parse_valid_ip(v) {
                    return valid;
                }
            }
        }
        if let Some(v) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
            if let Some(first) = v.split(',').next() {
                if let Some(valid) = parse_valid_ip(first) {
                    return valid;
                }
            }
        }
    }
    peer.ip().to_string()
}

fn log_response(state: &AppState, ip: &str, method: &str, path: &str, ua: &str, resp: &Response) {
    let status = resp.status().as_u16() as i64;
    let category = classify(ua, status);
    let _ = state.db.log_request(ip, method, path, status, ua, category);
}

fn classify(ua: &str, status: i64) -> &'static str {
    let ua_l = ua.to_lowercase();
    for k in ["bot", "crawler", "spider", "scanner"] {
        if ua_l.contains(k) {
            return "crawler";
        }
    }
    if status == 404 {
        "scan"
    } else if status == 503 || status == 429 {
        "blocked"
    } else if status == 401 {
        "bruteforce"
    } else {
        "normal"
    }
}

async fn external_handler(State(state): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request) -> Response {
    let method = req.method().to_string();
    let path = req.uri().path().to_string();
    let ua = ua_of(&req);
    // 在 req 被消费前取出真实访客 IP（经隧道时 peer 是回环，不能直接用）
    let ip = client_ip(req.headers(), &peer);

    // 防爆破与 DDoS 频率限制
    if let Err((status, msg)) = state.rate_limiter.check_and_record(&ip) {
        let resp = Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .header(header::RETRY_AFTER, "60")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(msg))
            .unwrap();
        log_response(&state, &ip, &method, &path, &ua, &resp);
        return resp;
    }

    let resp = external_dispatch(&state, &peer, &ip, req).await;
    if resp.status() == StatusCode::NOT_FOUND {
        state.rate_limiter.record_scan_error(&ip);
    }
    log_response(&state, &ip, &method, &path, &ua, &resp);
    resp
}

fn is_trusted_device_session(state: &AppState, headers: &HeaderMap) -> bool {
    let cookies = parse_cookies(headers);
    if let Some(tok) = cookies.get("blog_admin") {
        if state.db.valid_session(tok, "admin") {
            return true;
        }
    }
    if let Some(tok) = cookies.get("blog_trusted") {
        if state.db.valid_session(tok, "trusted") {
            if let Some(dev_id) = cookies.get("blog_dev_id") {
                if !state.db.is_trusted_device(dev_id) {
                    return false;
                }
                state.db.touch_device(dev_id);
            }
            return true;
        }
    }
    false
}

fn handle_auth_check(state: &AppState, headers: &HeaderMap) -> Response {
    let cookies = parse_cookies(headers);
    let mut trusted = false;
    let mut name = String::new();
    if let Some(tok) = cookies.get("blog_admin") {
        if state.db.valid_session(tok, "admin") {
            trusted = true;
            name = "管理员".to_string();
        }
    }
    if !trusted {
        if let Some(tok) = cookies.get("blog_trusted") {
            if state.db.valid_session(tok, "trusted") {
                if let Some(dev_id) = cookies.get("blog_dev_id") {
                    if state.db.is_trusted_device(dev_id) {
                        trusted = true;
                        name = "已验证受信任设备".to_string();
                        state.db.touch_device(dev_id);
                    }
                } else {
                    trusted = true;
                    name = "已验证受信任设备".to_string();
                }
            }
        }
    }
    json_response(StatusCode::OK, json!({
        "trusted": trusted,
        "name": name
    }))
}

async fn handle_auth_pair(state: &Arc<AppState>, ip: &str, req: Request) -> Response {
    if let Err(msg) = state.rate_limiter.check_pair_rate(ip) {
        return json_response(StatusCode::TOO_MANY_REQUESTS, json!({"error": msg}));
    }
    let is_https = is_https_request(req.headers());
    let body = read_json(req).await;
    let code = body.get("code").and_then(|v| v.as_str()).unwrap_or("").trim();
    let dev_id_raw = body.get("device_id").and_then(|v| v.as_str()).unwrap_or("").trim();
    let generated_dev_id = random_token();
    let dev_id = if dev_id_raw.is_empty() { &generated_dev_id } else { dev_id_raw };
    let pubkey = body.get("pubkey").and_then(|v| v.as_str()).unwrap_or("").trim();
    let client_name = body.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();

    if code.is_empty() {
        return json_response(StatusCode::BAD_REQUEST, json!({"error": "缺少配对凭证或密钥"}));
    }

    let pwd_sha = state.cfg.read().unwrap().password_sha256.clone();
    let code_sha = crate::sha256::sha256_hex(code.as_bytes());
    let is_admin_pwd = !code.is_empty() && ct_eq(code_sha.as_bytes(), pwd_sha.as_bytes());

    let verify_res = if is_admin_pwd {
        let dev_name = if !client_name.is_empty() { client_name.to_string() } else { "管理员受信任设备".to_string() };
        state.db.add_or_update_trusted_device(dev_id, &dev_name, pubkey)
    } else {
        state.db.verify_and_consume_pair_code(code, dev_id, pubkey)
    };

    match verify_res {
        Ok(db_name) => {
            let final_name = if !client_name.is_empty() { client_name } else { &db_name };
            state.db.touch_device(dev_id);
            let tok = random_token();
            let _ = state.db.create_session(&tok, "trusted", 365 * 24 * 3600);
            let mut resp = json_response(StatusCode::OK, json!({
                "ok": true,
                "name": final_name,
                "device_id": dev_id
            }));
            let sec_flag = if is_https { "; Secure" } else { "" };
            let cookie_str = format!("blog_trusted={tok}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict{sec_flag}");
            if let Ok(h) = HeaderValue::from_str(&cookie_str) {
                resp.headers_mut().append(header::SET_COOKIE, h);
            }
            let dev_cookie = format!("blog_dev_id={dev_id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict{sec_flag}");
            if let Ok(h) = HeaderValue::from_str(&dev_cookie) {
                resp.headers_mut().append(header::SET_COOKIE, h);
            }
            if is_admin_pwd {
                let admin_tok = random_token();
                let _ = state.db.create_session(&admin_tok, "admin", 7 * 24 * 3600);
                let admin_cookie = format!("blog_admin={admin_tok}; Path=/; Max-Age=604800; HttpOnly; SameSite=Strict{sec_flag}");
                if let Ok(h) = HeaderValue::from_str(&admin_cookie) {
                    resp.headers_mut().append(header::SET_COOKIE, h);
                }
            }
            resp
        }
        Err(e) => {
            state.rate_limiter.record_pair_fail(ip);
            json_response(StatusCode::FORBIDDEN, json!({"error": e}))
        }
    }
}

async fn handle_post_likes_api(state: &Arc<AppState>, ip: &str, req: Request) -> Response {
    let path = req.uri().path().to_string();
    let method = req.method().clone();
    let Some(rest) = path.strip_prefix("/api/posts/") else {
        return not_found();
    };
    if let Some(slug_raw) = rest.strip_suffix("/likes") {
        let slug = percent_decode(slug_raw).unwrap_or_else(|| slug_raw.to_string());
        if method == Method::GET || method == Method::HEAD {
            let count = state.db.get_likes(&slug);
            return json_response(StatusCode::OK, json!({"slug": slug, "likes": count}));
        }
    } else if let Some(slug_raw) = rest.strip_suffix("/like") {
        let slug = percent_decode(slug_raw).unwrap_or_else(|| slug_raw.to_string());
        if method == Method::POST {
            match state.db.add_like(&slug, ip) {
                Ok(total) => {
                    return json_response(StatusCode::OK, json!({"slug": slug, "likes": total}));
                }
                Err(e) => {
                    return json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({"error": e}));
                }
            }
        }
    }
    not_found()
}

async fn external_dispatch(state: &Arc<AppState>, peer: &SocketAddr, ip: &str, req: Request) -> Response {
    let path = req.uri().path().to_string();
    let is_trusted = is_trusted_device_session(state, req.headers());

    // 1. 公开互动与配对认证接口
    if path == "/api/auth/check" {
        return handle_auth_check(state, req.headers());
    }
    if path == "/api/auth/pair-device" && req.method() == Method::POST {
        return handle_auth_pair(state, ip, req).await;
    }
    if path.starts_with("/api/posts/") && (path.ends_with("/likes") || path.ends_with("/like")) {
        return handle_post_likes_api(state, ip, req).await;
    }
    if path == "/api/likes/summary" && (req.method() == Method::GET || req.method() == Method::HEAD) {
        return json_response(StatusCode::OK, json!({
            "total": state.db.total_likes(),
            "summary": state.db.all_likes_summary()
        }));
    }

    // 2. 管理路由与跳板防护（/admin, /login, /_admin/*, /api/admin/* 等）：
    // 只有经过公私钥/单次配对绑定的可信设备才允许访问；
    // 未验证访客一律返回 404 Not Found（不泄露任何后台存在信息与跳板入口）。
    let is_admin_route = path == "/admin"
        || path.starts_with("/admin/")
        || path == "/login"
        || path.starts_with("/_admin/")
        || path.starts_with("/api/admin/")
        || (is_trusted && (path == "/api/login" || path == "/api/logout" || (path.starts_with("/api/posts") && req.method() != Method::GET)));

    if is_admin_route {
        if !is_trusted {
            return not_found();
        }
        return local_dispatch_internal(state, req, false).await;
    }

    // 3. 常规公开内容：严格限定 GET 与 HEAD，受并发熔断限制
    let method = req.method().clone();
    if method != Method::GET && method != Method::HEAD {
        return not_found();
    }
    if !state.gate.try_acquire() {
        return service_unavailable();
    }
    let _guard = GateGuard(state.gate.clone());
    let local = is_trusted || is_local_access(&peer.ip(), req.headers());
    read_handler(state, &path, method == Method::HEAD, local, req.headers()).await
}

async fn local_handler(State(state): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request) -> Response {
    local_dispatch(&state, &peer, req).await
}

async fn local_dispatch(state: &Arc<AppState>, peer: &SocketAddr, req: Request) -> Response {
    if !peer.ip().is_loopback() {
        return forbidden();
    }
    local_dispatch_internal(state, req, true).await
}

async fn local_dispatch_internal(state: &Arc<AppState>, req: Request, is_loopback: bool) -> Response {
    let is_https = is_https_request(req.headers());
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let is_get = method == Method::GET || method == Method::HEAD;

    // ---- 登录 / 退出 / 会话期静态资源：这些必须放在认证检查之前 ----
    let mut req = req;
    if path == "/api/login" || path == "/api/logout" || path.starts_with("/_admin/") {
        if let Some(resp) = handle_local_api(state, &path, &mut req).await {
            return resp;
        }
    }

    // ---- HTML 页面：未登录跳登录页（而不是 401 空白页）----
    if is_get && !path.starts_with("/api/") {
        if path == "/login" {
            // 已登录就没必要再看登录页，直接跳转至后台
            if session_cookies_ok(state, req.headers()).is_some() {
                return if is_loopback { redirect_to_home() } else { redirect_to_admin() };
            }
            return login_page(req.headers(), &state.cfg.read().unwrap().username);
        }

        let cookies = match session_cookies_ok(state, req.headers()) {
            Some(c) => c,
            None => return if is_loopback { redirect_to_login() } else { redirect_to_login_from_admin() },
        };

        let mut resp = if path == "/" || path == "/admin" || path == "/admin/" {
            admin_dashboard(req.headers())
        } else {
            read_handler(state, &path, method == Method::HEAD, true, req.headers()).await
        };
        add_cookies(&mut resp, &cookies, is_https);
        return resp;
    }

    // ---- API：未认证返回 401 JSON ----
    let cookies = match check_auth(state, req.headers(), false) {
        Ok(c) => c,
        Err(_) => return unauthorized(),
    };
    let mut resp = if path.starts_with("/api/admin/") {
        handle_admin_api(state, &path, req).await
    } else {
        handle_api(state, &method, &path, req).await
    };
    add_cookies(&mut resp, &cookies, is_https);
    resp
}

/// 已登录用户访问 /login 时送回后台首页。
fn redirect_to_home() -> Response {
    Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, "/")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::empty())
        .expect("build redirect home")
}

fn redirect_to_admin() -> Response {
    Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, "/admin")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::empty())
        .expect("build redirect admin")
}

fn redirect_to_login_from_admin() -> Response {
    Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, "/login?ref=admin")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::empty())
        .expect("build redirect login")
}

fn authorized(state: &AppState, headers: &HeaderMap) -> bool {
    let c = state.cfg.read().unwrap();
    is_authorized(headers, &c.username, &c.password_sha256)
}

fn random_token() -> String {
    crate::platform::random_token()
}

fn parse_cookies(headers: &HeaderMap) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Some(c) = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()) {
        for part in c.split(';') {
            let part = part.trim();
            if let Some((k, v)) = part.split_once('=') {
                map.insert(k.trim().to_string(), v.trim().to_string());
            }
        }
    }
    map
}

/// Return cookies to set on success, or Err if auth fails.
/// `need_priv` forces password/priv-cookie (24h) for privileged ops.
fn check_auth(state: &AppState, headers: &HeaderMap, need_priv: bool) -> Result<Vec<(String, String, i64)>, ()> {
    let cookies = parse_cookies(headers);
    let ok = if need_priv {
        cookies.get("blog_priv").map_or(false, |t| state.db.valid_session(t, "priv"))
    } else {
        cookies.get("blog_admin").map_or(false, |t| state.db.valid_session(t, "admin"))
    };
    if ok {
        return Ok(Vec::new());
    }
    if !authorized(state, headers) {
        return Err(());
    }
    let admin_tok = random_token();
    let _ = state.db.create_session(&admin_tok, "admin", 7 * 24 * 3600);
    let mut out = vec![("blog_admin".to_string(), admin_tok, 7 * 24 * 3600)];
    if need_priv {
        let priv_tok = random_token();
        let _ = state.db.create_session(&priv_tok, "priv", 24 * 3600);
        out.push(("blog_priv".to_string(), priv_tok, 24 * 3600));
    }
    Ok(out)
}

fn add_cookies(resp: &mut Response, cookies: &[(String, String, i64)], secure: bool) {
    let sec_flag = if secure { "; Secure" } else { "" };
    for (name, value, maxage) in cookies {
        let v = format!("{name}={value}; Path=/; HttpOnly; Max-Age={maxage}; SameSite=Strict{sec_flag}");
        if let Ok(h) = HeaderValue::from_str(&v) {
            resp.headers_mut().append(header::SET_COOKIE, h);
        }
    }
}

async fn read_handler(state: &Arc<AppState>, path: &str, head: bool, local: bool, headers: &HeaderMap) -> Response {
    match path {
        "/posts.json" => serve_posts_json(state, headers, head).await,
        _ if path.starts_with("/post/") => serve_post_html(state, &path["/post/".len()..], head).await,
        _ => read_static(state, path, head, local, headers).await,
    }
}

/// 读静态文件。HTML 需要按来源裁剪（删掉「仅本机」片段），其余原样返回。
///
/// local = 是否本机访问（见 is_local_access）。
///         为 false 时把「查看后台」那段删掉 —— 管理端只绑 127.0.0.1，
///         局域网和外网的人点了也打不开，不如不显示。
async fn read_static(state: &Arc<AppState>, path: &str, head: bool, local: bool, headers: &HeaderMap) -> Response {
    // 先确认是 HTML 才读进内存做替换；其余文件走原来的静态文件路径
    let is_html = match resolve_target(&state.root_canon, path) {
        Some(ref f) => content_type(f).starts_with("text/html"),
        None => path == "/" || path.ends_with('/'),
    };

    if !is_html {
        return serve_static(&state.root_canon, path, headers, head).await;
    }

    let Some(file) = resolve_target(&state.root_canon, path) else {
        return not_found();
    };
    let Ok(bytes) = fs::read(&file) else { return not_found() };
    let Ok(text) = String::from_utf8(bytes) else {
        return not_found();
    };

    let final_text = if local { text } else { strip_local_only(&text) };
    let len = final_text.len();
    let resp = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_LENGTH, len.to_string())
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    if head {
        resp.body(Body::empty()).unwrap()
    } else {
        resp.body(Body::from(final_text)).unwrap()
    }
}

async fn serve_posts_json(state: &Arc<AppState>, headers: &HeaderMap, head: bool) -> Response {
    let posts = state.db.list_posts();
    let arr: Vec<serde_json::Value> = posts.iter().map(post_json).collect();
    let body = serde_json::to_string(&arr).unwrap_or_else(|_| "[]".to_string());
    let etag = format!("\"posts-{}\"", &sha256::sha256_hex(body.as_bytes())[..16]);
    if let Some(inm) = headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) {
        if inm.trim() == etag {
            return Response::builder()
                .status(StatusCode::NOT_MODIFIED)
                .header(header::ETAG, etag)
                .header(header::CACHE_CONTROL, CACHE_CONTROL)
                .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
                .body(Body::empty())
                .unwrap();
        }
    }
    let len = body.len();
    let resp = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::CONTENT_LENGTH, len.to_string())
        .header(header::CACHE_CONTROL, CACHE_CONTROL)
        .header(header::ETAG, etag)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    if head {
        resp.body(Body::empty()).unwrap()
    } else {
        resp.body(Body::from(body)).unwrap()
    }
}

async fn serve_post_html(state: &Arc<AppState>, slug: &str, head: bool) -> Response {
    let decoded = percent_decode(slug).unwrap_or_else(|| slug.to_string());
    match state.db.get_by_slug(&decoded) {
        Some(p) => {
            let title = html_escape(&p.title);
            let date = html_escape(&p.date);
            let doc = format!(
                "<!DOCTYPE html><html lang=zh><head><meta charset=\"utf-8\"><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>{title}</title><style>\
                :root{{--font:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,PingFang SC,Microsoft YaHei,sans-serif}}\
                body{{margin:0;min-height:100vh;font-family:var(--font);color:#e2e8f0;background:#05070f;background-image:radial-gradient(1100px 750px at 12% 8%,rgba(56,189,248,.3),transparent 55%),radial-gradient(1000px 700px at 88% 16%,rgba(168,85,247,.26),transparent 55%),radial-gradient(900px 900px at 50% 105%,rgba(16,185,129,.2),transparent 55%),linear-gradient(180deg,#070b18,#0d1226);background-attachment:fixed}}\
                body::before{{content:\"\";position:fixed;inset:0;pointer-events:none;opacity:.05;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")}}\
                .card{{max-width:820px;margin:32px auto;padding:28px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);border-radius:24px;backdrop-filter:blur(16px) saturate(150%);-webkit-backdrop-filter:blur(16px) saturate(150%);box-shadow:0 10px 40px rgba(0,0,0,.35);position:relative;overflow:hidden}}\
                .card::before{{content:\"\";position:absolute;top:-40px;right:-40px;width:160px;height:160px;border-radius:50%;background:radial-gradient(circle,rgba(56,189,248,.35),transparent 70%);filter:blur(10px);pointer-events:none}}\
                h1{{margin:.2em 0 .3em;background:linear-gradient(90deg,#38bdf8,#a855f7);-webkit-background-clip:text;background-clip:text;color:transparent;font-size:1.8rem}}\
                .date{{color:rgba(226,232,240,.66);font-size:.85rem;margin-bottom:1em}}\
                article p{{line-height:1.75;color:#e2e8f0}} article a{{color:#38bdf8}} article code,pre{{background:rgba(0,0,0,.3);border-radius:8px;padding:2px 6px}} article pre{{padding:10px;overflow:auto}}\
                img{{max-width:100%;border-radius:12px}}\
                </style></head><body><div class=card><h1>{title}</h1><p class=date>{date}</p><article>{}</article></div></body></html>",
                p.content_html
            );
            let len = doc.len();
            let resp = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .header(header::CONTENT_LENGTH, len.to_string())
                .header(header::CACHE_CONTROL, CACHE_CONTROL)
                .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
                .header(header::X_FRAME_OPTIONS, "SAMEORIGIN");
            if head {
                resp.body(Body::empty()).unwrap()
            } else {
                resp.body(Body::from(doc)).unwrap()
            }
        }
        None => not_found(),
    }
}

async fn handle_api(state: &Arc<AppState>, method: &Method, path: &str, req: Request) -> Response {
    if path == "/api/posts" {
        match *method {
            Method::GET => {
                let posts = state.db.list_posts();
                let arr: Vec<serde_json::Value> = posts.iter().map(post_json).collect();
                json_response(StatusCode::OK, serde_json::Value::Array(arr))
            }
            Method::POST => {
                let v = read_json(req).await;
                let title = v["title"].as_str().unwrap_or("").to_string();
                let content = v["content"].as_str().unwrap_or("").to_string();
                if title.is_empty() {
                    return json_response(StatusCode::BAD_REQUEST, json!({"error": "title required"}));
                }
                let cats = to_str_vec(&v["categories"]);
                let tags = to_str_vec(&v["tags"]);
                let desc = v["desc"].as_str().unwrap_or("").to_string();
                let slug_opt = v["slug"].as_str();
                match state.db.create_post(&title, &content, cats, tags, &desc, slug_opt) {
                    Ok(p) => json_response(StatusCode::OK, post_json(&p)),
                    Err(e) => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({"error": e})),
                }
            }
            _ => not_found(),
        }
    } else if let Some(rest) = path.strip_prefix("/api/posts/") {
        let id: i64 = rest.parse().unwrap_or(0);
        match *method {
            Method::PUT => {
                let v = read_json(req).await;
                let title = v["title"].as_str().unwrap_or("").to_string();
                let content = v["content"].as_str().unwrap_or("").to_string();
                let cats = to_str_vec(&v["categories"]);
                let tags = to_str_vec(&v["tags"]);
                let desc = v["desc"].as_str().unwrap_or("").to_string();
                let slug_opt = v["slug"].as_str();
                match state.db.update_post(id, &title, &content, cats, tags, &desc, slug_opt) {
                    Ok(p) => json_response(StatusCode::OK, post_json(&p)),
                    Err(e) => json_response(StatusCode::NOT_FOUND, json!({"error": e})),
                }
            }
            Method::DELETE => match state.db.delete_post(id) {
                Ok(()) => json_response(StatusCode::OK, json!({"ok": true})),
                Err(e) => json_response(StatusCode::NOT_FOUND, json!({"error": e})),
            },
            _ => not_found(),
        }
    } else if path == "/api/search" {
        let q = query_param(req.uri(), "q").unwrap_or_default();
        let posts = state.db.search(&q);
        let arr: Vec<serde_json::Value> = posts.iter().map(post_json).collect();
        json_response(StatusCode::OK, json!({"q": q, "results": serde_json::Value::Array(arr)}))
    } else if path == "/api/status" {
        let count = state.db.count();
        let size = state.db.db_size();
        json_response(StatusCode::OK, json!({"posts": count, "db_size_bytes": size}))
    } else {
        not_found()
    }
}

async fn handle_admin_api(state: &Arc<AppState>, path: &str, req: Request) -> Response {
    if path == "/api/admin/logs" {
        let page = query_param(req.uri(), "page").and_then(|v| v.parse::<i64>().ok()).unwrap_or(1).max(1);
        let per_page = query_param(req.uri(), "per_page").and_then(|v| v.parse::<i64>().ok()).unwrap_or(20).clamp(1, 200);
        let category = query_param(req.uri(), "category").unwrap_or_default();
        let ip = query_param(req.uri(), "ip").unwrap_or_default();
        let method = query_param(req.uri(), "method").unwrap_or_default();
        let (logs, total) = state.db.query_logs(page, per_page, &category, &ip, &method);
        let arr: Vec<serde_json::Value> = logs
            .iter()
            .map(|l| json!({"id": l.id, "timestamp": l.timestamp, "ip": l.ip, "method": l.method, "path": l.path, "status_code": l.status_code, "user_agent": l.user_agent, "category": l.category}))
            .collect();
        json_response(StatusCode::OK, json!({"total": total, "page": page, "per_page": per_page, "logs": arr}))
    } else if path == "/api/admin/stats" {
        let today = state.db.today_total();
        let cats = state.db.category_counts();
        let peak = state.db.peak_malicious_hour();
        let hourly = state.db.hourly_distribution();
        let daily = state.db.daily_distribution();
        json_response(
            StatusCode::OK,
            json!({
                "today_total": today,
                "categories": cats.into_iter().map(|(c, n)| json!({"category": c, "count": n})).collect::<Vec<_>>(),
                "peak_malicious_hour": peak.map(|(h, n)| json!({"hour": h, "count": n})),
                "hourly": hourly.into_iter().map(|(h, n)| json!({"h": h, "count": n})).collect::<Vec<_>>(),
                "daily": daily.into_iter().map(|(d, n)| json!({"date": d, "count": n})).collect::<Vec<_>>(),
            }),
        )
    } else if path == "/api/admin/system" {
        let rss = crate::platform::read_vmrss_kb().unwrap_or(0);
        let t0 = crate::platform::read_cpu_ticks();
        tokio::time::sleep(Duration::from_millis(300)).await;
        let t1 = crate::platform::read_cpu_ticks();
        // 原实现按 4 核归一化；这里换成实际逻辑核数，跨平台与跨机型都更准。
        let ncpu = std::thread::available_parallelism()
            .map(|n| n.get() as f64)
            .unwrap_or(4.0);
        let cpu = if t1 >= t0 {
            ((t1 - t0) as f64 / 100.0) / (0.3 * ncpu) * 100.0
        } else {
            0.0
        };
        let db_size = state.db.db_size();
        let uptime = state.start.elapsed().as_secs();
        let (gate_active, gate_limit) = state.gate.snapshot();
        json_response(
            StatusCode::OK,
            json!({
                "cpu_percent": (cpu * 10.0).round() / 10.0,
                "rss_kb": rss,
                "db_size_bytes": db_size,
                "uptime_secs": uptime,
                "posts": state.db.count(),
                "session_count": state.db.active_sessions_count(),
                "gate_active": gate_active,
                "gate_limit": gate_limit,
                "trusted_devices": state.db.trusted_device_count(),
                "total_likes": state.db.total_likes(),
            }),
        )
    } else if path == "/api/admin/devices" {
        let devs = state.db.list_trusted_devices();
        json_response(StatusCode::OK, json!({"devices": devs}))
    } else if path == "/api/admin/pair-code" {
        let v = read_json(req).await;
        let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("受信任设备");
        let ttl = v.get("ttl_secs").and_then(|x| x.as_i64()).unwrap_or(900).clamp(60, 86400);
        match state.db.create_pair_code(name, ttl) {
            Ok(code) => {
                let url = format!("https://jerry-hang.blog/?pair={code}");
                json_response(StatusCode::OK, json!({
                    "ok": true,
                    "code": code,
                    "name": name,
                    "expires_in": ttl,
                    "url": url
                }))
            }
            Err(e) => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({"error": e})),
        }
    } else if path == "/api/admin/revoke-device" {
        let v = read_json(req).await;
        let dev_id = v.get("device_id").and_then(|x| x.as_str()).unwrap_or("");
        if dev_id.is_empty() {
            return json_response(StatusCode::BAD_REQUEST, json!({"error": "缺少 device_id"}));
        }
        match state.db.revoke_trusted_device(dev_id) {
            Ok(()) => json_response(StatusCode::OK, json!({"ok": true})),
            Err(e) => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({"error": e})),
        }
    } else if path == "/api/admin/banned" {
        let banned = state.rate_limiter.list_banned();
        let arr: Vec<serde_json::Value> = banned.into_iter().map(|(ip, rem)| {
            json!({"ip": ip, "remaining_secs": rem})
        }).collect();
        json_response(StatusCode::OK, json!({"banned": arr}))
    } else if path == "/api/admin/unban" {
        let v = read_json(req).await;
        let ip = v.get("ip").and_then(|x| x.as_str()).unwrap_or("");
        let ok = state.rate_limiter.unban(ip);
        json_response(StatusCode::OK, json!({"ok": ok}))
    } else if path == "/api/admin/likes" {
        let total = state.db.total_likes();
        let summary = state.db.all_likes_summary();
        let arr: Vec<serde_json::Value> = summary.into_iter().map(|(slug, count)| {
            json!({"slug": slug, "count": count})
        }).collect();
        json_response(StatusCode::OK, json!({"total_likes": total, "posts": arr}))
    } else {
        not_found()
    }
}

fn post_json(p: &Post) -> serde_json::Value {
    json!({
        "id": p.id,
        "slug": p.slug,
        "title": p.title,
        "date": p.date,
        "categories": p.categories,
        "tags": p.tags,
        "desc": p.desc,
        "body": p.content_md,
        "updated_at": p.updated_at,
    })
}

async fn read_json(req: Request) -> serde_json::Value {
    let bytes = axum::body::to_bytes(req.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap_or_default();
    serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
}

fn to_str_vec(v: &serde_json::Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default()
}

fn query_param(uri: &axum::http::Uri, key: &str) -> Option<String> {
    let query = uri.query()?;
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                let replaced = v.replace('+', " ");
                return percent_decode(&replaced);
            }
        }
    }
    None
}

fn json_response(status: StatusCode, value: serde_json::Value) -> Response {
    let body = value.to_string();
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(body))
        .unwrap()
}

async fn serve_static(root_canon: &Path, target: &str, req_headers: &HeaderMap, head: bool) -> Response {
    let Some(file) = resolve_target(root_canon, target) else {
        return not_found();
    };
    let Ok(meta) = fs::metadata(&file) else {
        return not_found();
    };
    let len = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let ctype = content_type(&file);
    let is_html = ctype.starts_with("text/html");
    let is_code = matches_ext(target, &["js", "css"]);
    let etag = format!("\"{:x}-{:x}\"", len, mtime);

    // 协商缓存（If-None-Match）：未修改则直接返回 304，节省网络带宽与内存分配
    if !is_html {
        if let Some(inm) = req_headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) {
            if inm.trim() == etag {
                return Response::builder()
                    .status(StatusCode::NOT_MODIFIED)
                    .header(header::ETAG, etag)
                    .header(
                        header::CACHE_CONTROL,
                        if is_code { "no-cache, must-revalidate" } else { CACHE_CONTROL },
                    )
                    .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
                    .body(Body::empty())
                    .unwrap();
            }
        }
    }

    if head {
        let mut resp = Response::new(Body::empty());
        *resp.status_mut() = StatusCode::OK;
        resp.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_str(&ctype)
                .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
        );
        resp.headers_mut().insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&len.to_string()).unwrap(),
        );
        resp.headers_mut()
            .insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
        resp.headers_mut()
            .insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));

        let cc = if is_html || is_code {
            "no-cache, must-revalidate"
        } else {
            CACHE_CONTROL
        };
        resp.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static(cc));
        resp.headers_mut()
            .insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("SAMEORIGIN"));
        return resp;
    }

    match fs::read(&file) {
        Ok(body) => {
            let mut resp = Response::new(Body::from(body));
            *resp.status_mut() = StatusCode::OK;
            resp.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_str(&ctype)
                    .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
            );
            resp.headers_mut().insert(
                header::CONTENT_LENGTH,
                HeaderValue::from_str(&len.to_string()).unwrap(),
            );
            resp.headers_mut()
                .insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
            resp.headers_mut()
                .insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));

            let cc = if is_html || is_code {
                "no-cache, must-revalidate"
            } else {
                CACHE_CONTROL
            };
            resp.headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static(cc));
            resp.headers_mut()
                .insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("SAMEORIGIN"));
            resp
        }
        Err(_) => not_found(),
    }
}

fn text_response(status: StatusCode, body: impl Into<String>) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(Body::from(body.into()))
        .expect("build text response")
}

fn unauthorized() -> Response {
    Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .header(header::WWW_AUTHENTICATE, "Basic realm=\"JerryHang Blog\"")
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(Body::from("401 Unauthorized"))
        .expect("build 401")
}

fn not_found() -> Response {
    text_response(StatusCode::NOT_FOUND, "404 Not Found")
}

fn forbidden() -> Response {
    text_response(StatusCode::FORBIDDEN, "403 Forbidden")
}

fn service_unavailable() -> Response {
    text_response(StatusCode::SERVICE_UNAVAILABLE, "503 Service Unavailable")
}

/// HTTP Basic 认证（保留用于脚本 / curl 调用，网页端已改为表单登录）。
fn is_authorized(headers: &HeaderMap, username: &str, password_hash: &str) -> bool {
    let Some(auth) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Some(rest) = auth.strip_prefix("Basic ") else {
        return false;
    };
    let Some(decoded) = base64::decode(rest) else {
        return false;
    };
    let Ok(cred) = String::from_utf8(decoded) else {
        return false;
    };
    let Some((user, pass)) = cred.split_once(':') else {
        return false;
    };
    if user != username {
        return false;
    }
    let hash = sha256::sha256_hex(pass.as_bytes());
    ct_eq(hash.as_bytes(), password_hash.as_bytes())
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut r = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        r |= x ^ y;
    }
    r == 0
}

/// 判断请求路径的扩展名是否在给定列表里（用于决定缓存策略）。
/// 同时看原始 URL 和解析后的文件路径，因为 `/blog/foo/` 这种目录索引
/// 在 URL 上没有扩展名，实际返回的是 index.html。
fn matches_ext(target: &str, exts: &[&str]) -> bool {
    let ext = Path::new(target)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    exts.iter().any(|e| *e == ext)
}

const ALLOWED_STATIC_EXTS: &[&str] = &[
    "html", "htm", "css", "js", "mjs", "json", "xml", "txt", "png", "jpg", "jpeg", "gif", "svg",
    "webp", "ico", "avif", "woff", "woff2", "ttf", "otf", "eot", "pdf", "mp3", "mp4", "webm",
    "wasm",
];

const FORBIDDEN_DIRS: &[&str] = &["src", "target", "deploy", "_posts", ".git"];

fn is_allowed_static_file(path: &Path) -> bool {
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    // 禁止读取隐藏文件（以点开头）与备份临时文件（以波浪线结尾）
    if file_name.starts_with('.') || file_name.ends_with('~') {
        return false;
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    ALLOWED_STATIC_EXTS.contains(&ext.as_str())
}

fn resolve_target(root_canon: &Path, raw_target: &str) -> Option<PathBuf> {
    let rel = sanitize_relative_path(raw_target)?;
    let full = if rel.is_empty() {
        root_canon.to_path_buf()
    } else {
        root_canon.join(&rel)
    };
    let canon = fs::canonicalize(&full).ok()?;
    if !canon.starts_with(root_canon) {
        return None;
    }
    if canon.is_dir() {
        let idx = canon.join("index.html");
        if idx.is_file() {
            let canon_idx = fs::canonicalize(&idx).ok()?;
            if is_allowed_static_file(&canon_idx) {
                return Some(canon_idx);
            }
        }
        return None;
    }
    if canon.is_file() && is_allowed_static_file(&canon) {
        return Some(canon);
    }
    None
}

fn sanitize_relative_path(raw: &str) -> Option<String> {
    let decoded = percent_decode(raw)?;
    if decoded.contains('\0') || decoded.contains('\\') {
        return None;
    }
    let no_leading = decoded.trim_start_matches('/');
    for seg in no_leading.split('/') {
        if seg.is_empty() {
            continue;
        }
        // 严格阻断路径穿越与隐藏目录/源码/构建目录访问
        if seg == ".."
            || seg.starts_with('.')
            || FORBIDDEN_DIRS.contains(&seg)
            || seg.starts_with("_backup")
        {
            return None;
        }
    }
    Some(no_leading.to_string())
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = hexval(bytes[i + 1])?;
            let lo = hexval(bytes[i + 2])?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hexval(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn content_type(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8".to_string(),
        "css" => "text/css; charset=utf-8".to_string(),
        "js" | "mjs" => "application/javascript; charset=utf-8".to_string(),
        "json" => "application/json; charset=utf-8".to_string(),
        "png" => "image/png".to_string(),
        "jpg" | "jpeg" => "image/jpeg".to_string(),
        "gif" => "image/gif".to_string(),
        "svg" => "image/svg+xml".to_string(),
        "webp" => "image/webp".to_string(),
        "ico" => "image/x-icon".to_string(),
        "xml" => "application/xml; charset=utf-8".to_string(),
        "txt" | "md" => "text/plain; charset=utf-8".to_string(),
        "pdf" => "application/pdf".to_string(),
        "woff" => "font/woff".to_string(),
        "woff2" => "font/woff2".to_string(),
        "ttf" => "font/ttf".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}
// ---------------------------------------------------------------------------
// 后台界面
// ---------------------------------------------------------------------------

/// 后台页面：把 admin.css / admin.js 内联进 admin.html 的占位符，
/// 并按请求上下文替换「前台」链接。
///
/// 页面引用了 /_admin/admin.css 和 /_admin/admin.js 两个 URL，但那是给
/// 登录页用的（登录页是独立文件，没法内联）。后台主页为了让 HTML 里
/// 的占位注释生效，直接在这里替换。
fn admin_dashboard(headers: &HeaderMap) -> Response {
    let html = ADMIN_HTML
        .replacen(CSS_PLACEHOLDER, ADMIN_CSS, 1)
        .replacen(JS_PLACEHOLDER, ADMIN_JS, 1);
    html_response(inject_public_url(&html, &public_url(headers)))
}

fn login_page(headers: &HeaderMap, username: &str) -> Response {
    // 三处替换都是必须的：
    //   CSS        —— 登录页不能引用 /_admin/admin.css（那个路径受认证保护，
    //                 未登录请求会被跳回登录页，浏览器把 HTML 当 CSS 用，样式就丢）
    //   public_url —— 管理端在 8091、前台在 8090，不能用相对路径
    //   username   —— 本站只有一个账号，登录页不显示用户名输入框，
    //                 由服务端注入到隐藏字段，避免写死在模板里
    let html = LOGIN_HTML.replacen(CSS_PLACEHOLDER, ADMIN_CSS, 1);
    let html = inject_public_url(&html, &public_url(headers));
    let html = html.replacen(USERNAME_PLACEHOLDER, &html_attr_escape(username), 1);
    html_response(html)
}

fn html_response(body: String) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(Body::from(body))
        .expect("build html response")
}

/// 后台静态资源（admin.css / admin.js）。由登录页引用。
/// 只在本地端口可达，且受认证保护，见 local_dispatch。
fn admin_asset(name: &str) -> Option<Response> {
    let (body, ctype) = match name {
        "admin.css" => (ADMIN_CSS, "text/css; charset=utf-8"),
        "admin.js" => (ADMIN_JS, "application/javascript; charset=utf-8"),
        _ => return None,
    };
    Some(
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, ctype)
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .body(Body::from(body))
            .expect("build asset response"),
    )
}

/// 未登录时对 HTML 页面返回跳转，而不是 401 文本。
///
/// 为什么改：原来用的是 HTTP Basic 认证，靠浏览器弹原生登录框。
/// 现代浏览器在普通窗口里默认不再弹这个框，用户打开 / 只会看到一个
/// 401 空白页，根本没法输密码。改成跳转到登录页。
fn redirect_to_login() -> Response {
    Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, "/login")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::empty())
        .expect("build redirect")
}

/// 校验用户名 + 明文密码。密码在配置里存的是 sha256 十六进制串。
fn verify_credentials(state: &AppState, user: &str, pass: &str) -> bool {
    let c = state.cfg.read().unwrap();
    if user != c.username {
        return false;
    }
    let hash = sha256::sha256_hex(pass.as_bytes());
    ct_eq(hash.as_bytes(), c.password_sha256.as_bytes())
}

/// 建会话并返回要下发的 Set-Cookie 列表。
fn issue_session(state: &AppState, need_priv: bool) -> Vec<(String, String, i64)> {
    let admin_tok = random_token();
    let _ = state.db.create_session(&admin_tok, "admin", 7 * 24 * 3600);
    let mut out = vec![("blog_admin".to_string(), admin_tok, 7 * 24 * 3600)];
    if need_priv {
        let priv_tok = random_token();
        let _ = state.db.create_session(&priv_tok, "priv", 24 * 3600);
        out.push(("blog_priv".to_string(), priv_tok, 24 * 3600));
    }
    out
}

/// 登录 / 退出，以及会话期的静态资源。
/// 这些路由**不能**要求已认证，所以放在认证检查之前。
///
/// 接收 `&mut Request` 而不是按值：调用方 local_dispatch 在后面的分支里
/// 还要继续用同一个 req，按值传会被 move 掉。
async fn handle_local_api(
    state: &Arc<AppState>,
    path: &str,
    req: &mut Request,
) -> Option<Response> {
    match path {
        "/api/login" => {
            // read_json 需要所有权，用一个空请求把原请求换出来
            let taken = std::mem::replace(req, Request::new(Body::empty()));
            let body = read_json(taken).await;
            let user = body.get("username").and_then(|v| v.as_str()).unwrap_or("");
            let pass = body.get("password").and_then(|v| v.as_str()).unwrap_or("");

            if !verify_credentials(state, user, pass) {
                return Some(json_response(
                    StatusCode::UNAUTHORIZED,
                    json!({ "ok": false, "error": "用户名或密码不正确" }),
                ));
            }

            let cookies = issue_session(state, false);
            let mut resp = json_response(StatusCode::OK, json!({ "ok": true }));
            add_cookies(&mut resp, &cookies, is_https_request(req.headers()));
            Some(resp)
        }

        "/api/logout" => {
            let cookies = parse_cookies(req.headers());
            for key in ["blog_admin", "blog_priv"] {
                if let Some(tok) = cookies.get(key) {
                    let _ = state.db.delete_session(tok);
                }
            }
            let mut resp = json_response(StatusCode::OK, json!({ "ok": true }));
            let sec_flag = if is_https_request(req.headers()) { "; Secure" } else { "" };
            for key in ["blog_admin", "blog_priv"] {
                let v = format!("{key}=; Path=/; HttpOnly; Max-Age=0; SameSite=Strict{sec_flag}");
                if let Ok(h) = HeaderValue::from_str(&v) {
                    resp.headers_mut().append(header::SET_COOKIE, h);
                }
            }
            Some(resp)
        }

        _ => {
            // 会话期的后台静态资源
            if let Some(name) = path.strip_prefix("/_admin/") {
                if let Some(cookies) = session_cookies_ok(state, req.headers()) {
                    let mut resp = admin_asset(name).unwrap_or_else(not_found);
                    add_cookies(&mut resp, &cookies, is_https_request(req.headers()));
                    return Some(resp);
                }
                return Some(redirect_to_login());
            }
            None
        }
    }
}

/// 带「顺带续期」的会话校验。
/// 命中会话时返回空 Vec（cookie 已经下发过，不需要再发）。
/// 命中 Basic 时新建会话并返回 cookie。
fn session_cookies_ok(state: &AppState, headers: &HeaderMap) -> Option<Vec<(String, String, i64)>> {
    match check_auth(state, headers, false) {
        Ok(c) => Some(c),
        Err(()) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify() {
        assert_eq!(classify("Mozilla/5.0", 200), "normal");
        assert_eq!(classify("Googlebot/2.1", 200), "crawler");
        assert_eq!(classify("curl/8.0", 404), "scan");
        assert_eq!(classify("curl/8.0", 503), "blocked");
        assert_eq!(classify("curl/8.0", 429), "blocked");
        assert_eq!(classify("curl/8.0", 401), "bruteforce");
    }

    #[test]
    fn test_memory_thresholds() {
        assert!(MEM_RECOVER_KB < MEM_THROTTLE_KB);
        assert!(MEM_THROTTLE_KB < MEM_CRITICAL_KB);
        assert!(MEM_CRITICAL_KB < MEM_EMERGENCY_KB);
        assert_eq!(MEM_RECOVER_KB, 896 * 1024);
        assert_eq!(MEM_THROTTLE_KB, 1000 * 1024);
        assert_eq!(MEM_EMERGENCY_KB, 1200 * 1024);
    }

    #[test]
    fn test_ip_rate_limiter() {
        let limiter = IpRateLimiter::new();
        let ip = "1.2.3.4";
        // 初始正常请求
        assert!(limiter.check_and_record(ip).is_ok());

        // 模拟超过 120 次请求触发洪水限流
        for _ in 0..125 {
            let _ = limiter.check_and_record(ip);
        }
        let res = limiter.check_and_record(ip);
        assert!(res.is_err());
        assert_eq!(res.unwrap_err().0, StatusCode::TOO_MANY_REQUESTS);

        // 模拟扫描探测封禁
        let scanner_ip = "5.6.7.8";
        for _ in 0..16 {
            limiter.record_scan_error(scanner_ip);
        }
        let scan_res = limiter.check_and_record(scanner_ip);
        assert!(scan_res.is_err());
    }

    #[test]
    fn test_sanitize_relative_path() {
        assert_eq!(sanitize_relative_path("index.html"), Some("index.html".to_string()));
        assert_eq!(sanitize_relative_path("/app.js"), Some("app.js".to_string()));
        assert_eq!(sanitize_relative_path("blog/about-me/"), Some("blog/about-me/".to_string()));

        // 路径穿越攻击
        assert_eq!(sanitize_relative_path("/.."), None);
        assert_eq!(sanitize_relative_path("/../etc/passwd"), None);
        assert_eq!(sanitize_relative_path("/blog/../../blog.db"), None);
        assert_eq!(sanitize_relative_path("/..%2f..%2fconfig.toml"), None);

        // 敏感目录与隐藏文件访问
        assert_eq!(sanitize_relative_path("/.git/config"), None);
        assert_eq!(sanitize_relative_path("/.env"), None);
        assert_eq!(sanitize_relative_path("/.gitignore"), None);
        assert_eq!(sanitize_relative_path("/src/main.rs"), None);
        assert_eq!(sanitize_relative_path("/target/release/blog_ctl"), None);
        assert_eq!(sanitize_relative_path("/_posts/sample.md"), None);
        assert_eq!(sanitize_relative_path("/_backup_test/data"), None);

        // 非法字符阻断
        assert_eq!(sanitize_relative_path("/index.html%00"), None);
        assert_eq!(sanitize_relative_path(r"/..\..\Windows\win.ini"), None);
    }

    #[test]
    fn test_is_allowed_static_file() {
        assert!(is_allowed_static_file(Path::new("index.html")));
        assert!(is_allowed_static_file(Path::new("app.js")));
        assert!(is_allowed_static_file(Path::new("style.css")));
        assert!(is_allowed_static_file(Path::new("avatar.jpg")));
        assert!(is_allowed_static_file(Path::new("eric-terminal.png")));
        assert!(is_allowed_static_file(Path::new("posts.json")));
        assert!(is_allowed_static_file(Path::new("feed.xml")));
        assert!(is_allowed_static_file(Path::new("robots.txt")));

        // 敏感扩展名必须拒收
        assert!(!is_allowed_static_file(Path::new("Cargo.toml")));
        assert!(!is_allowed_static_file(Path::new("Cargo.lock")));
        assert!(!is_allowed_static_file(Path::new("blog.db")));
        assert!(!is_allowed_static_file(Path::new("blog.db-wal")));
        assert!(!is_allowed_static_file(Path::new("main.rs")));
        assert!(!is_allowed_static_file(Path::new("script.sh")));
        assert!(!is_allowed_static_file(Path::new("deploy.ps1")));
        assert!(!is_allowed_static_file(Path::new(".gitignore")));
        assert!(!is_allowed_static_file(Path::new(".env")));
        assert!(!is_allowed_static_file(Path::new("index.html~")));
    }

    #[test]
    fn test_client_ip_spoof_defense() {
        use std::net::SocketAddr;
        let loopback: SocketAddr = "127.0.0.1:54321".parse().unwrap();
        let external: SocketAddr = "198.51.100.22:54321".parse().unwrap();

        let mut headers = HeaderMap::new();
        headers.insert("cf-connecting-ip", "203.0.113.195".parse().unwrap());

        // 回环连接（如 Cloudflare Tunnel）：信任边缘头
        assert_eq!(client_ip(&headers, &loopback), "203.0.113.195");

        // 外部直连连接：拒不信任伪造头，强制使用底层 TCP peer.ip
        assert_eq!(client_ip(&headers, &external), "198.51.100.22");

        // 伪造畸形/注入字符串时拒收，回退到 peer.ip
        let mut bad_headers = HeaderMap::new();
        bad_headers.insert("cf-connecting-ip", "malicious_string_not_ip".parse().unwrap());
        assert_eq!(client_ip(&bad_headers, &loopback), "127.0.0.1");
    }

    #[test]
    fn test_ip_rate_limiter_memory_and_ban_retention() {
        let limiter = IpRateLimiter::new();
        let banned_ip = "9.9.9.9";
        for _ in 0..16 {
            limiter.record_scan_error(banned_ip);
        }
        assert!(limiter.check_and_record(banned_ip).is_err());

        // 模拟大量不同 IP 涌入，触发容量清理
        for i in 0..4500 {
            let ip = format!("10.0.{}.{}", i / 256, i % 256);
            let _ = limiter.check_and_record(&ip);
        }

        // 确保被封禁的 IP 仍然被封禁（誓死不被清空），且内存被严格限额
        assert!(limiter.check_and_record(banned_ip).is_err());
        let map = limiter.records.read().unwrap();
        assert!(map.len() <= 4000);
    }

    #[test]
    fn test_ip_rate_limiter_unban_and_pair_protection() {
        let limiter = IpRateLimiter::new();
        let target_ip = "192.0.2.100";

        // 触发配对失败封禁（3 次失败 = 15 次违规）
        limiter.record_pair_fail(target_ip);
        assert!(limiter.check_pair_rate(target_ip).is_ok());
        limiter.record_pair_fail(target_ip);
        assert!(limiter.check_pair_rate(target_ip).is_ok());
        limiter.record_pair_fail(target_ip);
        assert!(limiter.check_pair_rate(target_ip).is_err());

        // 验证已进入封禁列表
        let banned = limiter.list_banned();
        assert!(banned.iter().any(|(ip, _)| ip == target_ip));
        assert!(limiter.check_and_record(target_ip).is_err());

        // 手动解封
        assert!(limiter.unban(target_ip));
        assert!(limiter.check_and_record(target_ip).is_ok());
        assert!(limiter.list_banned().is_empty());
    }
}