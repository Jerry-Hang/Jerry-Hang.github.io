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
// 回落到 MEM_RECOVER_KB 以下解除。硬上限由 systemd MemoryMax=512M 兜底。
const MEM_THROTTLE_KB: u64 = 384 * 1024;
const MEM_RECOVER_KB: u64 = 256 * 1024;
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
///
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

    // IPv6 字面量：[::1]:8091
    if let Some(rest) = h.strip_prefix('[') {
        if let Some((addr, port)) = rest.split_once("]:") {
            return if port == ext_port {
                format!("http://[{addr}]:{ext_port}/")
            } else {
                format!("http://[{addr}]/")
            };
        }
    }

    match h.split_once(':') {
        // 带端口：是管理端端口就换成前台端口，否则说明本来指向别处，保留
        Some((name, port)) => {
            if port == ext_port {
                format!("http://{name}:{port}/")
            } else {
                format!("http://{name}:{ext_port}/")
            }
        }
        // 不带端口（经隧道，浏览器默认 80/443）：直接用域名
        None => format!("http://{h}/"),
    }
}

/// 把占位符换成实际地址。
fn inject_public_url(html: &str, url: &str) -> String {
    html.replace(PUBLIC_URL_PLACEHOLDER, url)
}

/// 往 HTML 属性里插值时的最小转义，避免用户名里的引号破坏属性结构。
fn html_attr_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
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
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            match k.trim() {
                "username" => username = v.trim().to_string(),
                "password_sha256" => password_sha256 = v.trim().to_string(),
                _ => {}
            }
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
    let mut reduced = false;
    loop {
        if let Some(kb) = crate::platform::read_vmrss_kb() {
            if kb > MEM_THROTTLE_KB {
                reduced = true;
            } else if kb < MEM_RECOVER_KB {
                reduced = false;
            }
        }
        let limit = if reduced { (base / 2).max(1) } else { base.max(1) };
        gate.effective.store(limit, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(MEM_SAMPLE_SECS)).await;
    }
}

async fn session_cleanup(db: Arc<Db>) {
    // 会话过期检查：每分钟一次（原行为，保持不变）
    let mut last_prune = Instant::now();
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        db.delete_expired_sessions();

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
    root_canon: PathBuf,
    db: Arc<Db>,
    start: Instant,
}

pub async fn run(cfg: Config, ext_addr: &str, local_addr: &str, max_concurrent: usize, db_path: &str) -> std::io::Result<()> {
    let root_canon = fs::canonicalize(&cfg.root).unwrap_or_else(|_| cfg.root.clone());
    let db = Db::open(Path::new(db_path)).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let db = Arc::new(db);
    let gate = Arc::new(Gate::new(max_concurrent));
    let state = Arc::new(AppState {
        cfg: RwLock::new(cfg.clone()),
        gate: gate.clone(),
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
    tokio::spawn(session_cleanup(db.clone()));

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

/// 取访客真实 IP。
///
/// 为什么需要：公网流量是经 Cloudflare 隧道进来的，cloudflared 在本机
/// 反向连到 127.0.0.1:8090，所以 peer 永远是回环地址。
/// 直接记 peer 的话，2.8 万条日志全是 127.0.0.1，安全监控形同虚设。
///
/// 优先取 Cloudflare 的 CF-Connecting-IP（它由边缘写入，客户端伪造不了），
/// 其次 X-Forwarded-For 的第一段，最后才回落到 peer。
fn client_ip(headers: &HeaderMap, peer: &SocketAddr) -> String {
    for name in ["cf-connecting-ip", "true-client-ip", "x-real-ip"] {
        if let Some(v) = headers.get(name).and_then(|v| v.to_str().ok()) {
            let v = v.trim();
            if !v.is_empty() {
                return v.to_string();
            }
        }
    }
    if let Some(v) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(first) = v.split(',').next() {
            let first = first.trim();
            if !first.is_empty() {
                return first.to_string();
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
    } else if status == 503 {
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
    let resp = external_dispatch(&state, &peer, req).await;
    log_response(&state, &ip, &method, &path, &ua, &resp);
    resp
}

async fn external_dispatch(state: &Arc<AppState>, peer: &SocketAddr, req: Request) -> Response {
    let method = req.method().clone();
    if method != Method::GET && method != Method::HEAD {
        return not_found();
    }
    if !state.gate.try_acquire() {
        return service_unavailable();
    }
    let _guard = GateGuard(state.gate.clone());
    let path = req.uri().path().to_string();
    // 公网口：按 peer + Host 判断是不是本机；不是就把「查看后台」那段删掉
    let local = is_local_access(&peer.ip(), req.headers());
    read_handler(state, &path, method == Method::HEAD, local, req.headers()).await
}

async fn local_handler(State(state): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request) -> Response {
    local_dispatch(&state, &peer, req).await
}

async fn local_dispatch(state: &Arc<AppState>, peer: &SocketAddr, req: Request) -> Response {
    if !peer.ip().is_loopback() {
        return forbidden();
    }
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
            // 已登录就没必要再看登录页
            if session_cookies_ok(state, req.headers()).is_some() {
                return redirect_to_home();
            }
            return login_page(req.headers(), &state.cfg.read().unwrap().username);
        }

        let cookies = match session_cookies_ok(state, req.headers()) {
            Some(c) => c,
            None => return redirect_to_login(),
        };

        let mut resp = if path == "/" {
            admin_dashboard(req.headers())
        } else {
            // 后台域名下不再挂公网静态文件：原来这里直接 read_handler 放行，
            // 等于 /index.html 等路径完全绕过认证（实测无凭据返回 200）。
            // local 仍要带 Host 判断：peer 一定是回环（本函数开头已校验），
            // 但用 Host: 192.168.x.x 打过来模拟的是局域网访问。
            let local = is_local_access(&peer.ip(), req.headers());
            read_handler(state, &path, method == Method::HEAD, local, req.headers()).await
        };
        add_cookies(&mut resp, &cookies);
        return resp;
    }

    // ---- API：未认证返回 401 JSON ----
    let priv_op = path == "/api/admin/exec" || path == "/api/admin/file";
    let cookies = match check_auth(state, req.headers(), priv_op) {
        Ok(c) => c,
        Err(_) => return unauthorized(),
    };
    let mut resp = if path.starts_with("/api/admin/") {
        handle_admin_api(state, &path, req).await
    } else {
        handle_api(state, &method, &path, req).await
    };
    add_cookies(&mut resp, &cookies);
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

fn add_cookies(resp: &mut Response, cookies: &[(String, String, i64)]) {
    for (name, value, maxage) in cookies {
        let v = format!("{name}={value}; Path=/; HttpOnly; Max-Age={maxage}; SameSite=Strict");
        if let Ok(h) = HeaderValue::from_str(&v) {
            resp.headers_mut().append(header::SET_COOKIE, h);
        }
    }
}

async fn read_handler(state: &Arc<AppState>, path: &str, _head: bool, local: bool, headers: &HeaderMap) -> Response {
    match path {
        "/posts.json" => serve_posts_json(state).await,
        _ if path.starts_with("/post/") => serve_post_html(state, &path["/post/".len()..]).await,
        _ => read_static(state, path, local).await,
    }
}

/// 读静态文件。HTML 需要按来源裁剪（删掉「仅本机」片段），其余原样返回。
///
/// local = 是否本机访问（见 is_local_access）。
///         为 false 时把「查看后台」那段删掉 —— 管理端只绑 127.0.0.1，
///         局域网和外网的人点了也打不开，不如不显示。
async fn read_static(state: &Arc<AppState>, path: &str, local: bool) -> Response {
    // 先确认是 HTML 才读进内存做替换；其余文件走原来的静态文件路径
    let is_html = match resolve_target(&state.root_canon, path) {
        Some(ref f) => content_type(f).starts_with("text/html"),
        None => path == "/" || path.ends_with('/'),
    };

    if !is_html {
        return serve_static(&state.root_canon, path).await;
    }

    let Some(file) = resolve_target(&state.root_canon, path) else {
        return not_found();
    };
    let Ok(bytes) = fs::read(&file) else { return not_found() };
    let Ok(text) = String::from_utf8(bytes) else {
        return not_found();
    };

    html_response(if local { text } else { strip_local_only(&text) })
}

async fn serve_posts_json(state: &Arc<AppState>) -> Response {
    let posts = state.db.list_posts();
    let arr: Vec<serde_json::Value> = posts.iter().map(post_json).collect();
    let body = serde_json::to_string(&arr).unwrap_or_else(|_| "[]".to_string());
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::CACHE_CONTROL, CACHE_CONTROL)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(Body::from(body))
        .unwrap()
}

async fn serve_post_html(state: &Arc<AppState>, slug: &str) -> Response {
    match state.db.get_by_slug(slug) {
        Some(p) => {
            let title = html_escape(&p.title);
            let date = html_escape(&p.date);
            let doc = format!(
                "<!DOCTYPE html><html lang=zh><head><meta charset=\"utf-8\"><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>{title}</title><style>\
                :root{{--font:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,PingFang SC,Microsoft YaHei,sans-serif}}\
                body{{margin:0;min-height:100vh;font-family:var(--font);color:#e2e8f0;color:#e2e8f0;background:#05070f;background-image:radial-gradient(1100px 750px at 12% 8%,rgba(56,189,248,.3),transparent 55%),radial-gradient(1000px 700px at 88% 16%,rgba(168,85,247,.26),transparent 55%),radial-gradient(900px 900px at 50% 105%,rgba(16,185,129,.2),transparent 55%),linear-gradient(180deg,#070b18,#0d1226);background-attachment:fixed}}\
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
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .header(header::CACHE_CONTROL, CACHE_CONTROL)
                .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
                .header(header::X_FRAME_OPTIONS, "SAMEORIGIN")
                .body(Body::from(doc))
                .unwrap()
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
                match state.db.create_post(&title, &content, cats, tags, &desc) {
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
                match state.db.update_post(id, &title, &content, cats, tags, &desc) {
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
            }),
        )
    } else if path == "/api/admin/exec" {
        let v = read_json(req).await;
        let cmd = v["cmd"].as_str().unwrap_or("").to_string();
        if cmd.is_empty() {
            return json_response(StatusCode::BAD_REQUEST, json!({"error": "cmd required"}));
        }
        let out = std::process::Command::new("sh").arg("-c").arg(&cmd).output();
        match out {
            Ok(o) => json_response(
                StatusCode::OK,
                json!({
                    "code": o.status.code().unwrap_or(-1),
                    "stdout": String::from_utf8_lossy(&o.stdout).to_string(),
                    "stderr": String::from_utf8_lossy(&o.stderr).to_string(),
                }),
            ),
            Err(e) => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({"error": e.to_string()})),
        }
    } else if path == "/api/admin/file" {
        let p = query_param(req.uri(), "path").unwrap_or_default();
        if p.is_empty() {
            return json_response(StatusCode::BAD_REQUEST, json!({"error": "path required"}));
        }
        match fs::read(&p) {
            Ok(bytes) => json_response(
                StatusCode::OK,
                json!({"path": p, "size": bytes.len(), "content": String::from_utf8_lossy(&bytes).to_string()}),
            ),
            Err(e) => json_response(StatusCode::NOT_FOUND, json!({"error": e.to_string()})),
        }
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
                return percent_decode(v);
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

async fn serve_static(root_canon: &Path, target: &str) -> Response {
    match resolve_target(root_canon, target) {
        Some(file) => match fs::read(&file) {
            Ok(body) => {
                let len = body.len();
                let ctype = content_type(&file);
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
                    .insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
                // HTML 不缓存：页面里内联了 CSS 和 JS（重建后会变），
                // 如果给长缓存，用户会一直拿到旧页面 —— 实际踩过：
                // 改了前端里硬编码的后台端口，浏览器��用缓存里的旧地址。
                // 静态资源（图片/字体）仍走长缓存，JS/CSS 靠 URL 上的版本号刷新。
                let cc = if ctype.starts_with("text/html") {
                    "no-cache, must-revalidate"
                } else if matches_ext(target, &["js", "css"]) {
                    // 这两个也内联/被内联进页面，同样给短缓存
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
        },
        None => not_found(),
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

fn resolve_target(root_canon: &Path, raw_target: &str) -> Option<PathBuf> {    let rel = sanitize_relative_path(raw_target)?;
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
            return fs::canonicalize(&idx).ok();
        }
        return None;
    }
    if canon.is_file() {
        return Some(canon);
    }
    None
}

fn sanitize_relative_path(raw: &str) -> Option<String> {
    let decoded = percent_decode(raw)?;
    if decoded.contains('\0') {
        return None;
    }
    if decoded.contains('\\') {
        return None;
    }
    let no_leading = decoded.trim_start_matches('/');
    for seg in no_leading.split('/') {
        if seg == ".." {
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
            add_cookies(&mut resp, &cookies);
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
            for key in ["blog_admin", "blog_priv"] {
                let v = format!("{key}=; Path=/; HttpOnly; Max-Age=0; SameSite=Strict");
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
                    add_cookies(&mut resp, &cookies);
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