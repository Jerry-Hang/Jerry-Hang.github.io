//! Tokio + axum async dual-port dynamic blog server with request-log threat monitoring.

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
const ONE_GIB_KB: u64 = 1024 * 1024;
const HALF_GIB_KB: u64 = 512 * 1024;
const MEM_SAMPLE_SECS: u64 = 1;
const CACHE_CONTROL: &str = "public, max-age=600, s-maxage=600";

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

fn read_vmrss_kb() -> Option<u64> {
    let status = fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
            return Some(kb);
        }
    }
    None
}

fn read_cpu_ticks() -> u64 {
    if let Ok(s) = fs::read_to_string("/proc/self/stat") {
        let p: Vec<&str> = s.split_whitespace().collect();
        if p.len() > 14 {
            let utime: u64 = p[13].parse().unwrap_or(0);
            let stime: u64 = p[14].parse().unwrap_or(0);
            return utime + stime;
        }
    }
    0
}

async fn memory_monitor(gate: Arc<Gate>, base: usize) {
    let mut reduced = false;
    loop {
        if let Some(kb) = read_vmrss_kb() {
            if kb > ONE_GIB_KB {
                reduced = true;
            } else if kb < HALF_GIB_KB {
                reduced = false;
            }
        }
        let limit = if reduced { (base / 2).max(1) } else { base.max(1) };
        gate.effective.store(limit, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(MEM_SAMPLE_SECS)).await;
    }
}

async fn session_cleanup(db: Arc<Db>) {
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        db.delete_expired_sessions();
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
    let loc = TcpListener::bind(local_addr).await?;
    eprintln!("external {ext_addr} (tunnel), local {local_addr} (management)");
    eprintln!("serving {}, gate={max_concurrent}, db={db_path}", cfg.root.display());

    tokio::spawn(memory_monitor(gate.clone(), max_concurrent));
    tokio::spawn(session_cleanup(db.clone()));

    let ext_app = Router::new().fallback(external_handler).with_state(state.clone());
    let loc_app = Router::new().fallback(local_handler).with_state(state.clone());

    let t1 = tokio::spawn(async move {
        let _ = axum::serve(ext, ext_app.into_make_service_with_connect_info::<SocketAddr>()).await;
    });
    let t2 = tokio::spawn(async move {
        let _ = axum::serve(loc, loc_app.into_make_service_with_connect_info::<SocketAddr>()).await;
    });
    let _ = tokio::join!(t1, t2);
    Ok(())
}

fn ua_of(req: &Request) -> String {
    req.headers()
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

fn log_response(state: &AppState, peer: &SocketAddr, method: &str, path: &str, ua: &str, resp: &Response) {
    let status = resp.status().as_u16() as i64;
    let category = classify(ua, status);
    let _ = state.db.log_request(&peer.ip().to_string(), method, path, status, ua, category);
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
    let resp = external_dispatch(&state, req).await;
    log_response(&state, &peer, &method, &path, &ua, &resp);
    resp
}

async fn external_dispatch(state: &Arc<AppState>, req: Request) -> Response {
    let method = req.method().clone();
    if method != Method::GET && method != Method::HEAD {
        return not_found();
    }
    if !state.gate.try_acquire() {
        return service_unavailable();
    }
    let _guard = GateGuard(state.gate.clone());
    let path = req.uri().path().to_string();
    read_handler(state, &path, method == Method::HEAD).await
}

async fn local_handler(State(state): State<Arc<AppState>>, ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request) -> Response {
    let method = req.method().to_string();
    let path = req.uri().path().to_string();
    let ua = ua_of(&req);
    let resp = local_dispatch(&state, &peer, req).await;
    log_response(&state, &peer, &method, &path, &ua, &resp);
    resp
}

async fn local_dispatch(state: &Arc<AppState>, peer: &SocketAddr, req: Request) -> Response {
    if !peer.ip().is_loopback() {
        return forbidden();
    }
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    if path.starts_with("/api/") {
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
        return resp;
    }
    if method == Method::GET || method == Method::HEAD {
        if path == "/" {
            let cookies = match check_auth(state, req.headers(), false) {
                Ok(c) => c,
                Err(_) => return unauthorized(),
            };
            let mut resp = admin_dashboard();
            add_cookies(&mut resp, &cookies);
            return resp;
        }
        return read_handler(state, &path, method == Method::HEAD).await;
    }
    not_found()
}

fn authorized(state: &AppState, headers: &HeaderMap) -> bool {
    let c = state.cfg.read().unwrap();
    is_authorized(headers, &c.username, &c.password_sha256)
}

fn random_token() -> String {
    use std::io::Read;
    if let Ok(mut f) = fs::File::open("/dev/urandom") {
        let mut buf = [0u8; 16];
        if f.read_exact(&mut buf).is_ok() {
            return buf.iter().map(|b| format!("{:02x}", b)).collect();
        }
    }
    format!("{:x}", Instant::now().elapsed().as_nanos())
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

async fn read_handler(state: &Arc<AppState>, path: &str, _head: bool) -> Response {
    match path {
        "/posts.json" => serve_posts_json(state).await,
        _ if path.starts_with("/post/") => serve_post_html(state, &path["/post/".len()..]).await,
        _ => serve_static(&state.root_canon, path).await,
    }
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
        let rss = read_vmrss_kb().unwrap_or(0);
        let t0 = read_cpu_ticks();
        tokio::time::sleep(Duration::from_millis(300)).await;
        let t1 = read_cpu_ticks();
        let cpu = if t1 >= t0 { ((t1 - t0) as f64 / 100.0) / (0.3 * 4.0) * 100.0 } else { 0.0 };
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

fn admin_dashboard() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(Body::from(ADMIN_HTML))
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
                resp.headers_mut()
                    .insert(header::CACHE_CONTROL, HeaderValue::from_static(CACHE_CONTROL));
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

const ADMIN_HTML: &str = r#"<!DOCTYPE html><html lang=zh><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>博客后台 · Acrylic</title><style>
:root{--bg:#05070f;--card:rgba(255,255,255,.09);--card-b:rgba(255,255,255,.16);--hi:rgba(255,255,255,.18);--acc:#38bdf8;--acc2:#a855f7;--ok:#22c55e;--warn:#f59e0b;--bad:#ef4444;--txt:#e7ecf5;--soft:rgba(231,236,245,.64);--font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;font-family:var(--font);color:var(--txt);background:#05070f;background-image:radial-gradient(1200px 800px at 12% 6%,rgba(56,189,248,.30),transparent 55%),radial-gradient(1100px 750px at 88% 14%,rgba(168,85,247,.26),transparent 55%),radial-gradient(950px 950px at 50% 108%,rgba(16,185,129,.18),transparent 55%),linear-gradient(180deg,#070b18,#0d1226);background-attachment:fixed;min-height:100vh;position:relative}
@media (prefers-color-scheme: light){body{background-image:radial-gradient(1200px 800px at 12% 6%,rgba(56,189,248,.18),transparent 55%),radial-gradient(1100px 750px at 88% 14%,rgba(168,85,247,.14),transparent 55%),radial-gradient(950px 950px at 50% 108%,rgba(16,185,129,.10),transparent 55%),linear-gradient(180deg,#eef2fb,#e2e8f6)}}
body::before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.045;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");z-index:0}
hdr{position:sticky;top:0;z-index:20;padding:13px 20px;display:flex;gap:14px;align-items:center;background:rgba(8,12,24,.40);backdrop-filter:blur(18px) saturate(170%);-webkit-backdrop-filter:blur(18px) saturate(170%);border-bottom:1px solid rgba(255,255,255,.08);transition:background .3s}
hdr.scrolled{background:rgba(6,9,18,.66)}
hdr .logo{width:32px;height:32px;border-radius:10px;background:linear-gradient(135deg,var(--acc),var(--acc2));display:flex;align-items:center;justify-content:center;font-weight:800;color:#0b1020}
hdr h1{font-size:17px;margin:0;font-weight:700}
hdr .sub{font-size:11px;color:var(--soft);margin:0}
hdr a{color:var(--acc);text-decoration:none;margin-left:auto;padding:8px 14px;border:1px solid var(--card-b);border-radius:999px;background:rgba(255,255,255,.06);backdrop-filter:blur(8px);transition:background .2s}
hdr a:hover{background:rgba(255,255,255,.14)}
body>*{position:relative;z-index:1}
.hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;padding:18px 18px 0}
.hero .k{background:var(--card);border:1px solid var(--card-b);border-radius:20px;padding:14px 16px;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);box-shadow:0 6px 24px rgba(0,0,0,.3),inset 0 1px 0 var(--hi)}
.hero .k b{font-size:24px;display:block;background:linear-gradient(90deg,var(--acc),var(--acc2));-webkit-background-clip:text;background-clip:text;color:transparent}
.hero .k span{font-size:12px;color:var(--soft)}
.wrap{display:grid;grid-template-columns:repeat(auto-fit,minmax(350px,1fr));gap:16px;padding:18px}
.card{background:linear-gradient(145deg,rgba(255,255,255,.10),rgba(255,255,255,.035));border:1px solid var(--card-b);border-radius:22px;padding:20px;backdrop-filter:blur(20px) saturate(160%);-webkit-backdrop-filter:blur(20px) saturate(160%);box-shadow:0 10px 40px rgba(0,0,0,.35),inset 0 1px 0 var(--hi);position:relative;overflow:hidden;transition:transform .25s,box-shadow .25s}
.card:hover{transform:translateY(-3px);box-shadow:0 16px 50px rgba(0,0,0,.42),inset 0 1px 0 var(--hi)}
.card::before{content:"";position:absolute;top:-50px;right:-40px;width:180px;height:180px;border-radius:50%;background:radial-gradient(circle,rgba(56,189,248,.35),transparent 70%);filter:blur(12px);pointer-events:none}
.card h2{font-size:13px;margin:0 0 14px;color:var(--acc);letter-spacing:.6px;text-transform:uppercase}
input,textarea,select{width:100%;background:rgba(0,0,0,.28);color:var(--txt);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:10px 12px;margin:6px 0;font-size:14px;font-family:inherit;transition:border .2s,box-shadow .2s}
input:focus,textarea:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px rgba(56,189,248,.15)}
textarea{min-height:180px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
button{background:linear-gradient(135deg,var(--acc),var(--acc2));color:#0b1020;border:0;border-radius:14px;padding:9px 18px;font-weight:700;cursor:pointer;margin:6px 5px 0 0;box-shadow:0 6px 20px rgba(56,189,248,.35);transition:transform .15s,box-shadow .2s}
button:hover{transform:translateY(-2px);box-shadow:0 10px 26px rgba(56,189,248,.5)}
button.red{background:linear-gradient(135deg,#f87171,#ef4444);color:#fff}
.kpi{display:flex;gap:10px;flex-wrap:wrap}.kpi div{background:rgba(0,0,0,.30);border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:12px 16px;min-width:112px;backdrop-filter:blur(8px)}
.kpi b{display:block;font-size:22px;letter-spacing:.4px}
.kpi span{font-size:11px;color:var(--soft)}
.bar{height:12px;background:rgba(0,0,0,.32);border-radius:8px;max-width:100%;overflow:hidden;border:1px solid rgba(255,255,255,.06)}.bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--acc),var(--acc2));border-radius:8px}
.barRow{padding:6px 0}.barRow:hover{filter:brightness(1.3)}
canvas{width:100%;height:190px;background:rgba(0,0,0,.24);border-radius:16px;border:1px solid rgba(255,255,255,.08);cursor:crosshair}
table{width:100%;border-collapse:collapse;font-size:12px;margin-top:10px;border-radius:14px;overflow:hidden}
th,td{padding:9px 10px;text-align:left;border-bottom:1px solid rgba(255,255,255,.06);white-space:nowrap;max-width:230px;overflow:hidden;text-overflow:ellipsis}
th{color:var(--soft);font-weight:600;background:rgba(255,255,255,.04)}
tr:hover td{background:rgba(255,255,255,.05)}
.postrow{display:flex;align-items:center;gap:8px;padding:10px 2px;border-bottom:1px solid rgba(255,255,255,.06)}
.postrow span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#msg{color:var(--ok);font-size:13px;padding:8px 18px}
#tooltip{position:fixed;z-index:99;pointer-events:none;background:rgba(10,14,26,.94);border:1px solid rgba(255,255,255,.2);border-radius:12px;padding:7px 11px;font-size:12px;color:#e7ecf5;box-shadow:0 8px 24px rgba(0,0,0,.45);opacity:0;transition:opacity .12s;transform:translate(-50%,-135%)}

@media (max-width:640px){hdr{padding:10px 12px;gap:8px}hdr h1{font-size:15px;white-space:nowrap}hdr .sub{display:none}hdr a{font-size:12px;padding:7px 10px;white-space:nowrap}.hero{grid-template-columns:repeat(2,1fr);padding:14px 12px 0}.wrap{padding:12px;gap:12px}}

.detail{position:fixed;inset:0;z-index:100;display:none;align-items:center;justify-content:center;padding:16px;background:rgba(3,6,14,.55);backdrop-filter:blur(6px)}
.detail.open{display:flex}
.detail-box{width:min(920px,100%);max-height:88vh;overflow:auto;background:linear-gradient(145deg,rgba(255,255,255,.12),rgba(255,255,255,.045));border:1px solid rgba(255,255,255,.18);border-radius:22px;padding:22px;backdrop-filter:blur(24px) saturate(160%);box-shadow:0 20px 60px rgba(0,0,0,.5)}
.detail-box h2{margin:0}
.detail-box .close{background:rgba(255,255,255,.12);color:#fff;border-radius:999px;padding:6px 14px;float:right}
</style></head><body><hdr><div class=logo>J</div><div><h1>JerryHang 博客后台</h1><p class=sub>Acrylic · 本地管理控制台</p></div><a href="http://127.0.0.1:8080/">← 返回前台</a></hdr><div id=msg></div><div id=tooltip></div><div id=detail class=detail><div class=detail-box><header><h2 id=detail-title></h2><button class=close onclick=closeDetail()>关闭 ✕</button></header><div id=detail-body></div></div></div><div class=hero>
<div onclick=openDetail('today') style=cursor:pointer class=k><span>今日请求</span><b id=h_today>-</b></div>
<div onclick=openDetail('peak') style=cursor:pointer class=k><span>峰值时段</span><b id=h_peak>-</b></div>
<div onclick=openDetail('gate') style=cursor:pointer class=k><span>活跃连接</span><b id=h_gate>-</b></div>
<div class=k><span>文章数</span><b id=h_posts>-</b></div>
</div><div class=wrap>
<div class=card><h2>✍️ 文章编辑器</h2><input id=p_title placeholder="标题"><input id=p_cats placeholder="分类,逗号分隔"><input id=p_tags placeholder="标签,逗号分隔"><textarea id=p_body placeholder="支持 Markdown 语法"></textarea><button onclick=savePost()>发布 / 保存</button><input type=hidden id=p_id><div id=posts></div></div>
<div class=card><h2>🛡 实时威胁监控</h2><div class=kpi><div onclick=openDetail('today') style=cursor:pointer ><b id=today>-</b><span>今日</span></div><div onclick=openDetail('peak') style=cursor:pointer ><b id=peak>-</b><span>峰值</span></div><div onclick=openDetail('scan') style=cursor:pointer ><b id=scan>-</b><span>扫描</span></div><div onclick=openDetail('crawler') style=cursor:pointer ><b id=crawler>-</b><span>爬虫</span></div><div onclick=openDetail('blocked') style=cursor:pointer ><b id=blocked>-</b><span>拦截</span></div><div onclick=openDetail('bruteforce') style=cursor:pointer ><b id=brute>-</b><span>爆破</span></div></div><h3 style=margin:16px 0 8px;font-size:12px;color:var(--soft)>分类柱状图</h3><div id=bars></div><h3 style=margin:16px 0 8px;font-size:12px;color:var(--soft)>按小时分布</h3><canvas id=line1></canvas><h3 style=margin:16px 0 8px;font-size:12px;color:var(--soft)>按天分布</h3><canvas id=line2></canvas></div>
<div class=card><h2>📊 系统状态</h2><div class=kpi><div><b id=cpu>-</b><span>CPU</span></div><div><b id=rss>-</b><span>内存</span></div><div><b id=dbsize>-</b><span>DB</span></div><div><b id=up>-</b><span>运行</span></div><div><b id=nposts>-</b><span>文章</span></div><div><b id=sessions>-</b><span>会话</span></div><div><b id=gate>-</b><span>并发</span></div></div><table id=logs><thead><tr><th>时间</th><th>IP</th><th>方法</th><th>路径</th><th>状态</th><th>类别</th></tr></thead><tbody></tbody></table><button onclick=loadLogs()>刷新日志</button></div>
</div><script>
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
async function jget(o){const r=await fetch(o);return r.json()}
const tip=document.getElementById('tooltip');function showTip(t,ev){tip.innerHTML=t;tip.style.opacity='1';tip.style.left=ev.clientX+'px';tip.style.top=ev.clientY+'px'}function hideTip(){tip.style.opacity='0'}
async function loadStats(){const d=await jget('/api/admin/stats');const c={};(d.categories||[]).forEach(x=>c[x.category]=x.count);const el=id=>document.getElementById(id);el('today').textContent=d.today_total;const pk=d.peak_malicious_hour||{};el('peak').textContent=pk.hour?pk.hour+':00('+pk.count+')':'无';el('scan').textContent=c.scan||0;el('crawler').textContent=c.crawler||0;el('blocked').textContent=c.blocked||0;el('brute').textContent=c.bruteforce||0;el('h_today').textContent=d.today_total;el('h_peak').textContent=pk.hour?pk.hour+':00':'—';const items=d.categories||[];const max=Math.max(1,...items.map(x=>x.count));el('bars').innerHTML=items.map(x=>'<div class=barRow data-tip="'+esc(x.category)+': '+x.count+'"><div style=padding:4px>'+esc(x.category)+'<div class=bar><i style=width:'+(x.count/max*100)+'%></i></div>'+x.count+'</div></div>').join('');drawLine('line1',d.hourly,'h','count');drawLine('line2',d.daily,'date','count');document.querySelectorAll('.barRow').forEach(b=>{b.addEventListener('mousemove',e=>showTip(b.dataset.tip,e));b.addEventListener('mouseleave',hideTip);});}
function drawLine(id,arr,label,val){const c=document.getElementById(id);if(!c)return;const ctx=c.getContext('2d');const w=c.width=c.clientWidth,h=c.height=190;ctx.clearRect(0,0,w,h);ctx.strokeStyle='#38bdf8';ctx.fillStyle='#e7ecf5';ctx.font='10px sans-serif';const max=Math.max(1,...(arr||[]).map(x=>x[val]));const n=(arr||[]).length;if(n===0){ctx.fillText('无数据',10,20);c._data=[];return}const denom=Math.max(1,n-1);ctx.beginPath();ctx.moveTo(0,h-10);for(let i=0;i<n;i++){ctx.lineTo(i/denom*(w-20)+10,h-10-(arr[i][val]/max)*(h-40));}ctx.stroke();if(n===1){ctx.fillStyle='#38bdf8';ctx.beginPath();ctx.arc(10,h-10-(arr[0][val]/max)*(h-40),4,0,7);ctx.fill();}c._data=(arr||[]).map(x=>({label:x[label],v:x[val]}));c._pt=(i)=>({x:i/denom*(w-20)+10,y:h-10-(arr[i][val]/max)*(h-40)});c._n=n;c.addEventListener('mousemove',ev=>{if(!c._data)return;const rect=c.getBoundingClientRect();const mx=ev.clientX-rect.left;let best=0,bd=1e9;for(let i=0;i<c._n;i++){const p=c._pt(i);const d=Math.abs(p.x-mx);if(d<bd){bd=d;best=i}}const p=c._pt(best);ctx.clearRect(0,0,w,h);ctx.beginPath();ctx.moveTo(0,h-10);for(let i=0;i<c._n;i++){const q=c._pt(i);ctx.lineTo(q.x,q.y)}ctx.stroke();ctx.fillStyle='#38bdf8';ctx.beginPath();ctx.arc(p.x,p.y,4,0,7);ctx.fill();showTip(c._data[best].label+': '+c._data[best].v,ev)});c.addEventListener('mouseleave',()=>{if(c._data){const ctx2=c.getContext('2d');ctx2.clearRect(0,0,w,h);ctx2.strokeStyle='#38bdf8';ctx2.beginPath();ctx2.moveTo(0,h-10);for(let i=0;i<c._n;i++){const q=c._pt(i);ctx2.lineTo(q.x,q.y)}ctx2.stroke()}hideTip()});}
async function loadSys(){const d=await jget('/api/admin/system');document.getElementById('cpu').textContent=(d.cpu_percent??0)+'%';document.getElementById('rss').textContent=Math.round((d.rss_kb??0)/1024)+'MB';document.getElementById('dbsize').textContent=(d.db_size_bytes??0)+'B';const u=d.uptime_secs||0;document.getElementById('up').textContent=Math.floor(u/3600)+'h '+Math.floor(u%3600/60)+'m';document.getElementById('nposts').textContent=d.posts;document.getElementById('sessions').textContent=d.session_count;document.getElementById('gate').textContent=(d.gate_active??0)+'/'+(d.gate_limit??0);document.getElementById('h_gate').textContent=(d.gate_active??0)+'/'+(d.gate_limit??0);document.getElementById('h_posts').textContent=d.posts;}
async function loadPosts(){const d=await jget('/api/posts');const el=document.getElementById('posts');el.innerHTML=(d||[]).map(p=>'<div class=postrow><span title="'+esc(p.title)+'">'+esc(p.title)+'</span><button onclick=editPost('+p.id+')>编辑</button><button class=red onclick=delPost('+p.id+')>删除</button></div>').join('');window._posts=d;}
async function loadLogs(){const d=await jget('/api/admin/logs?per_page=20');const tb=document.querySelector('#logs tbody');tb.innerHTML=(d.logs||[]).map(l=>'<tr><td>'+esc(l.timestamp)+'</td><td>'+esc(l.ip)+'</td><td>'+esc(l.method)+'</td><td>'+esc(l.path)+'</td><td>'+l.status_code+'</td><td>'+esc(l.category)+'</td></tr>').join('');}
function setForm(id,title,cats,tags,body){document.getElementById('p_id').value=id||'';document.getElementById('p_title').value=title;document.getElementById('p_cats').value=cats;document.getElementById('p_tags').value=tags;document.getElementById('p_body').value=body;}
function editPost(id){const p=(window._posts||[]).find(x=>x.id===id);if(p)setForm(p.id,p.title,(p.categories||[]).join(','),(p.tags||[]).join(','),p.body);}
async function savePost(){const id=document.getElementById('p_id').value;const body={title:document.getElementById('p_title').value,categories:(document.getElementById('p_cats').value||'').split(',').map(s=>s.trim()).filter(Boolean),tags:(document.getElementById('p_tags').value||'').split(',').map(s=>s.trim()).filter(Boolean),content:document.getElementById('p_body').value};const r=await fetch(id?('/api/posts/'+id):'/api/posts',{method:id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();document.getElementById('msg').textContent=d.error?('错误:'+d.error):(id?'已更新':'已发布: '+d.slug);setForm('','','','','');loadPosts();}
async function delPost(id){if(!confirm('确认删除?'))return;await fetch('/api/posts/'+id,{method:'DELETE'});document.getElementById('msg').textContent='已删除';loadPosts();}
function openDetail(key){const meta={today:{t:'今日请求',d:'今天进入本站的全部请求，含正常与恶意来源。',q:''},peak:{t:'峰值时段',d:'按小时统计的请求量分布、请求类型与来源 IP。',q:'',peak:true},gate:{t:'活跃连接',d:'并发门控 active/limit；超过上限返回 503 记为 blocked。',q:'blocked'},scan:{t:'扫描',d:'访问不存在路径（404）被判定为扫描行为。',q:'scan'},crawler:{t:'爬虫',d:'User-Agent 含 bot/crawler/spider/scanner 的请求。',q:'crawler'},blocked:{t:'拦截',d:'超过并发门控上限返回 503 的连接。',q:'blocked'},bruteforce:{t:'爆破',d:'管理/接口认证失败（401）的记录。',q:'bruteforce'}};const m=meta[key];if(!m)return;const body=document.getElementById('detail-body');document.getElementById('detail-title').textContent=m.t;body.innerHTML='<p style=color:#91a0b5>'+m.d+'</p><p style=color:#91a0b5>加载中…</p>';document.getElementById('detail').classList.add('open');document.body.style.overflow='hidden';(async()=>{let logd=null;if(key!=='peak'){logd=key==='today'?await jget('/api/admin/logs?per_page=200'):await jget('/api/admin/logs?per_page=200&category='+m.q);}let logs=logd?(logd.logs||[]):[];let content='';if(key==='gate'){const sys=await jget('/api/admin/system');content+='<div class=kpi><div><b>'+sys.gate_active+'/'+sys.gate_limit+'</b><span>并发</span></div></div>';}const ip={},path={};let maxip='—',maxipn=0,maxpath='—',maxpathn=0;logs.forEach(l=>{ip[l.ip]=(ip[l.ip]||0)+1;path[l.path]=(path[l.path]||0)+1;if(ip[l.ip]>maxipn){maxipn=ip[l.ip];maxip=l.ip}if(path[l.path]>maxpathn){maxpathn=path[l.path];maxpath=l.path}});const ips=Object.entries(ip).sort((a,b)=>b[1]-a[1]);const paths=Object.entries(path).sort((a,b)=>b[1]-a[1]);if(key==='peak'){const st=await jget('/api/admin/stats');const hourly=st.hourly||[];content+='<div class=kpi><div><b>'+st.today_total+'</b><span>今日</span></div><div><b>'+hourly.length+'</b><span>时段</span></div><div><b>'+(st.peak_malicious_hour?st.peak_malicious_hour.hour+':00':'—')+'</b><span>峰值</span></div></div>';content+='<h3 style=color:#38bdf8;margin:14px 0 6px>按小时请求量</h3><canvas id=dline></canvas>';content+='<details><summary style=color:#38bdf8;margin:8px 0;cursor:pointer>时段明细 ▾</summary><table><thead><tr><th>时段</th><th>请求</th></tr></thead><tbody>'+hourly.map(x=>'<tr><td>'+esc(x.h)+'</td><td>'+x.count+'</td></tr>').join('')+'</tbody></table></details>';content+='<details><summary style=color:#38bdf8;margin:8px 0;cursor:pointer>请求类型 ▾</summary><table><thead><tr><th>类型</th><th>次数</th></tr></thead><tbody>'+(st.categories||[]).map(x=>'<tr><td>'+esc(x.category)+'</td><td>'+x.count+'</td></tr>').join('')+'</tbody></table></details>';content+='<h3 style=color:#38bdf8;margin:14px 0 6px>来源 IP（今日）</h3><table><thead><tr><th>IP</th><th>次数</th></tr></thead><tbody>'+ips.map(x=>'<tr><td>'+esc(x[0])+'</td><td>'+x[1]+'</td></tr>').join('')+'</tbody></table>';}else{content+='<div class=kpi><div><b>'+logs.length+'</b><span>记录</span></div><div><b>'+Object.keys(ip).length+'</b><span>来源IP</span></div><div><b>'+esc(maxip)+'</b><span>最多IP</span></div><div><b>'+esc(maxpath)+'</b><span>Top路径</span></div></div>';content+='<h3 style=color:#38bdf8;margin:14px 0 6px>来源 IP 分布</h3><canvas id=dbar></canvas><h3 style=color:#38bdf8;margin:14px 0 6px>来源 IP</h3><table><thead><tr><th>IP</th><th>次数</th></tr></thead><tbody>'+ips.map(x=>'<tr><td>'+esc(x[0])+'</td><td>'+x[1]+'</td></tr>').join('')+'</tbody></table>';content+='<details><summary style=color:#38bdf8;margin:8px 0;cursor:pointer>来源路径 ▾</summary><table><thead><tr><th>路径</th><th>次数</th></tr></thead><tbody>'+paths.map(x=>'<tr><td>'+esc(x[0])+'</td><td>'+x[1]+'</td></tr>').join('')+'</tbody></table></details>';content+='<details><summary style=color:#38bdf8;margin:8px 0;cursor:pointer>最近记录 ▾</summary><table><thead><tr><th>时间</th><th>IP</th><th>方法</th><th>路径</th><th>状态</th></tr></thead><tbody>'+logs.slice(0,30).map(l=>'<tr><td>'+esc(l.timestamp)+'</td><td>'+esc(l.ip)+'</td><td>'+esc(l.method)+'</td><td>'+esc(l.path)+'</td><td>'+l.status_code+'</td></tr>').join('')+'</tbody></table></details>';}body.innerHTML=content;if(key==='peak'){drawDetailLine('dline',hourly.map(x=>({label:x.h,v:x.count})));}else{drawDetailBar('dbar',ips);}})();}
function drawDetailBar(id,data){const c=document.getElementById(id);if(!c)return;const ctx=c.getContext('2d');const w=c.width=c.clientWidth,h=c.height=170;ctx.clearRect(0,0,w,h);const max=Math.max(1,...data.map(d=>d[1]));const n=data.length;if(!n){ctx.fillStyle='#e7ecf5';ctx.fillText('无数据',10,20);return}const rowH=h/n;ctx.font='11px sans-serif';data.forEach((d,i)=>{const y=i*rowH+rowH/2;const barLen=d[1]/max*(w-96);ctx.fillStyle='#38bdf8';ctx.fillRect(78,y-6,Math.max(2,barLen),12);ctx.fillStyle='#e7ecf5';ctx.fillText(d[0].length>16?d[0].slice(0,15)+'…':d[0],8,y+4);ctx.fillText(d[1],80+barLen+4,y+4);});}
function closeDetail(){document.getElementById('detail').classList.remove('open');document.body.style.overflow='';}
function drawDetailLine(id,data){const c=document.getElementById(id);if(!c)return;const ctx=c.getContext('2d');const w=c.width=c.clientWidth,h=c.height=160;ctx.clearRect(0,0,w,h);const max=Math.max(1,...data.map(d=>d.v));const n=data.length;if(!n){ctx.fillStyle='#e7ecf5';ctx.fillText('无数据',10,20);return}const bw=(w-20)/n;data.forEach((d,i)=>{const bh=d.v/max*(h-34);ctx.fillStyle=d.v>=max?'#38bdf8':'#7dd3fc';ctx.fillRect(10+i*bw+2,h-12-bh,bw-4,bh);ctx.fillStyle='#e7ecf5';ctx.font='9px sans-serif';ctx.fillText(d.label,10+i*bw+2,h-3);});}
window.addEventListener('scroll',()=>{document.querySelector('hdr').classList.toggle('scrolled',window.scrollY>10)});
document.addEventListener('DOMContentLoaded',()=>{loadStats();loadSys();loadPosts();loadLogs();setInterval(loadStats,10000);setInterval(loadSys,10000);});
</script></body></html>"#;
