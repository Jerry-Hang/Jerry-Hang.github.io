//! SQLite-backed blog storage + request logs with WAL, Markdown rendering, XSS-safe HTML.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use pulldown_cmark::{html, Options, Parser};
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, Row};

#[derive(Clone)]
pub struct Post {
    pub id: i64,
    pub slug: String,
    pub title: String,
    pub content_md: String,
    pub content_html: String,
    pub categories: Vec<String>,
    pub tags: Vec<String>,
    pub desc: String,
    pub date: String,
    pub updated_at: String,
}

#[derive(Clone)]
pub struct LogRow {
    pub id: i64,
    pub timestamp: String,
    pub ip: String,
    pub method: String,
    pub path: String,
    pub status_code: i64,
    pub user_agent: String,
    pub category: String,
}

pub struct Db {
    pub conn: Mutex<Connection>,
    pub path: PathBuf,
}

pub fn render_markdown(md: &str) -> String {
    let parser = Parser::new_ext(md, Options::empty());
    let mut out = String::new();
    html::push_html(&mut out, parser);
    sanitize_html(&out)
}

const SAFE_TAGS: &[&str] = &[
    "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
    "strong", "em", "b", "i", "a", "code", "pre", "blockquote", "img", "span", "div",
    "table", "thead", "tbody", "tr", "th", "td", "caption", "del", "s", "sub", "sup",
    "kbd", "figure", "figcaption", "dl", "dt", "dd",
];
const SAFE_ATTRS: &[&str] = &[
    "href", "src", "alt", "title", "class", "id", "rel", "target", "width", "height",
    "colspan", "rowspan", "scope", "lang", "type",
];

pub fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

pub fn sanitize_html(html: &str) -> String {
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            if let Some(p) = html[i..].find('>') {
                let tag = &html[i..i + p + 1];
                let name = extract_name(tag);
                if name.is_empty() || !is_tag_name(&name) || !SAFE_TAGS.contains(&name.as_str()) {
                    out.push_str(&escape_tag(tag));
                } else if tag.starts_with("</") {
                    out.push_str(tag);
                } else {
                    out.push_str(&scrub_open(tag, &name));
                }
                i += p + 1;
                continue;
            }
        }
        let start = i;
        while i < bytes.len() && bytes[i] != b'<' {
            i += 1;
        }
        out.push_str(&html[start..i]);
    }
    out
}

fn is_tag_name(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn extract_name(tag: &str) -> String {
    let s = tag.trim_start_matches('<').trim_start_matches('/');
    let mut name = String::new();
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' {
            name.push(ch);
        } else {
            break;
        }
    }
    name.to_ascii_lowercase()
}

fn escape_tag(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn escape_attr(v: &str) -> String {
    v.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn scrub_open(tag: &str, name: &str) -> String {
    let inner = &tag[1..tag.len() - 1];
    let attr_part = inner
        .strip_prefix(name)
        .map(|s| s.trim())
        .unwrap_or("");
    let mut out = format!("<{name}");
    for (k, v) in tokenize_attrs(attr_part) {
        let lk = k.to_ascii_lowercase();
        let lv = v.to_ascii_lowercase();
        if lk.starts_with("on")
            || lv.contains("javascript:")
            || lv.contains("vbscript:")
            || lv.contains("data:")
            || lv.contains("expression")
            || !SAFE_ATTRS.contains(&lk.as_str())
        {
            continue;
        }
        out.push(' ');
        out.push_str(&k);
        if !v.is_empty() {
            out.push_str("=\"");
            out.push_str(&escape_attr(&v));
            out.push('"');
        }
    }
    out.push('>');
    out
}

fn tokenize_attrs(s: &str) -> Vec<(String, String)> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= b.len() {
            break;
        }
        let kstart = i;
        while i < b.len() && b[i] != b'=' && !b[i].is_ascii_whitespace() {
            i += 1;
        }
        let key = s[kstart..i].to_string();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut val = String::new();
        if i < b.len() && b[i] == b'=' {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < b.len() && (b[i] == b'"' || b[i] == b'\'') {
                let q = b[i];
                i += 1;
                let vstart = i;
                while i < b.len() && b[i] != q {
                    i += 1;
                }
                val = s[vstart..i].to_string();
                if i < b.len() {
                    i += 1;
                }
            } else {
                let vstart = i;
                while i < b.len() && !b[i].is_ascii_whitespace() {
                    i += 1;
                }
                val = s[vstart..i].to_string();
            }
        }
        if !key.is_empty() {
            out.push((key, val));
        }
    }
    out
}

fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut prev_space = false;
    for ch in s.trim().chars() {
        if ch.is_whitespace() {
            if !prev_space && !out.is_empty() {
                out.push('-');
            }
            prev_space = true;
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    if out.is_empty() {
        "post".to_string()
    } else {
        out.trim_end_matches('-').to_string()
    }
}

fn unique_slug(conn: &Connection, title: &str, exclude_id: Option<i64>) -> String {
    let base = slugify(title);
    let mut slug = base.clone();
    let mut n = 2;
    loop {
        let count: i64 = match exclude_id {
            Some(id) => conn
                .query_row("SELECT COUNT(*) FROM posts WHERE slug=?1 AND id<>?2", params![slug, id], |r| r.get(0))
                .unwrap_or(1),
            None => conn
                .query_row("SELECT COUNT(*) FROM posts WHERE slug=?1", params![slug], |r| r.get(0))
                .unwrap_or(1),
        };
        if count == 0 {
            return slug;
        }
        slug = format!("{base}-{n}");
        n += 1;
    }
}

fn post_from_row(row: &Row) -> rusqlite::Result<Post> {
    let categories: String = row.get(5)?;
    let tags: String = row.get(6)?;
    Ok(Post {
        id: row.get(0)?,
        slug: row.get(1)?,
        title: row.get(2)?,
        content_md: row.get(3)?,
        content_html: row.get(4)?,
        categories: serde_json::from_str(&categories).unwrap_or_default(),
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        desc: row.get(7)?,
        date: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn log_from_row(row: &Row) -> rusqlite::Result<LogRow> {
    Ok(LogRow {
        id: row.get(0)?,
        timestamp: row.get(1)?,
        ip: row.get(2)?,
        method: row.get(3)?,
        path: row.get(4)?,
        status_code: row.get(5)?,
        user_agent: row.get(6)?,
        category: row.get(7)?,
    })
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;\
             PRAGMA synchronous=NORMAL;\
             CREATE TABLE IF NOT EXISTS posts (\
               id INTEGER PRIMARY KEY AUTOINCREMENT,\
               slug TEXT UNIQUE NOT NULL,\
               title TEXT NOT NULL,\
               content_md TEXT NOT NULL,\
               content_html TEXT NOT NULL,\
               categories TEXT NOT NULL,\
               tags TEXT NOT NULL,\
               desc TEXT NOT NULL,\
               date TEXT NOT NULL,\
               updated_at TEXT NOT NULL\
             );\
             CREATE TABLE IF NOT EXISTS request_logs (\
               id INTEGER PRIMARY KEY AUTOINCREMENT,\
               timestamp TEXT NOT NULL,\
               ip TEXT NOT NULL,\
               method TEXT NOT NULL,\
               path TEXT NOT NULL,\
               status_code INTEGER NOT NULL,\
               user_agent TEXT NOT NULL,\
               category TEXT NOT NULL\
             );\
             CREATE TABLE IF NOT EXISTS sessions (\
               token TEXT PRIMARY KEY,\
               tier TEXT NOT NULL,\
               expires_at INTEGER NOT NULL\
             );",
        )
        .map_err(|e| e.to_string())?;
        Ok(Db {
            conn: Mutex::new(conn),
            path: path.to_path_buf(),
        })
    }

    // ---- posts ----

    pub fn list_posts(&self) -> Vec<Post> {
        let conn = self.conn.lock().unwrap();
        let mut out = Vec::new();
        if let Ok(mut stmt) = conn.prepare("SELECT id,slug,title,content_md,content_html,categories,tags,desc,date,updated_at FROM posts ORDER BY id DESC") {
            if let Ok(rows) = stmt.query_map([], post_from_row) {
                for r in rows.flatten() {
                    out.push(r);
                }
            }
        }
        out
    }

    pub fn get_by_id(&self, id: i64) -> Option<Post> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT id,slug,title,content_md,content_html,categories,tags,desc,date,updated_at FROM posts WHERE id=?1", params![id], post_from_row)
            .ok()
    }

    pub fn get_by_slug(&self, slug: &str) -> Option<Post> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT id,slug,title,content_md,content_html,categories,tags,desc,date,updated_at FROM posts WHERE slug=?1", params![slug], post_from_row)
            .ok()
    }

    pub fn create_post(&self, title: &str, content_md: &str, categories: Vec<String>, tags: Vec<String>, desc: &str) -> Result<Post, String> {
        let content_html = render_markdown(content_md);
        let desc = if desc.trim().is_empty() {
            content_md.trim().lines().find(|l| !l.trim().is_empty()).unwrap_or("").chars().take(80).collect()
        } else {
            desc.to_string()
        };
        let conn = self.conn.lock().unwrap();
        let slug = unique_slug(&conn, title, None);
        let cats = serde_json::to_string(&categories).unwrap_or_else(|_| "[]".to_string());
        let tagstr = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "INSERT INTO posts(slug,title,content_md,content_html,categories,tags,desc,date,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,date('now'),datetime('now'))",
            params![slug, title, content_md, content_html, cats, tagstr, desc],
        )
        .map_err(|e| e.to_string())?;
        let id = conn.last_insert_rowid();
        drop(conn);
        self.get_by_id(id).ok_or_else(|| "post not found".to_string())
    }

    pub fn update_post(&self, id: i64, title: &str, content_md: &str, categories: Vec<String>, tags: Vec<String>, desc: &str) -> Result<Post, String> {
        let content_html = render_markdown(content_md);
        let desc = if desc.trim().is_empty() {
            content_md.trim().lines().find(|l| !l.trim().is_empty()).unwrap_or("").chars().take(80).collect()
        } else {
            desc.to_string()
        };
        let conn = self.conn.lock().unwrap();
        let exists: i64 = conn
            .query_row("SELECT COUNT(*) FROM posts WHERE id=?1", params![id], |r| r.get(0))
            .unwrap_or(0);
        if exists == 0 {
            return Err("post not found".to_string());
        }
        let slug = unique_slug(&conn, title, Some(id));
        let cats = serde_json::to_string(&categories).unwrap_or_else(|_| "[]".to_string());
        let tagstr = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "UPDATE posts SET slug=?1,title=?2,content_md=?3,content_html=?4,categories=?5,tags=?6,desc=?7,updated_at=datetime('now') WHERE id=?8",
            params![slug, title, content_md, content_html, cats, tagstr, desc, id],
        )
        .map_err(|e| e.to_string())?;
        drop(conn);
        self.get_by_id(id).ok_or_else(|| "post not found".to_string())
    }

    pub fn delete_post(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute("DELETE FROM posts WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("post not found".to_string());
        }
        Ok(())
    }

    pub fn search(&self, q: &str) -> Vec<Post> {
        let conn = self.conn.lock().unwrap();
        let like = format!("%{}%", q);
        let mut out = Vec::new();
        if let Ok(mut stmt) = conn.prepare("SELECT id,slug,title,content_md,content_html,categories,tags,desc,date,updated_at FROM posts WHERE title LIKE ?1 OR content_md LIKE ?1 ORDER BY id DESC") {
            if let Ok(rows) = stmt.query_map(params![like], post_from_row) {
                for r in rows.flatten() {
                    out.push(r);
                }
            }
        }
        out
    }

    pub fn count(&self) -> i64 {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM posts", [], |r| r.get(0)).unwrap_or(0)
    }

    pub fn db_size(&self) -> u64 {
        fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0)
    }

    pub fn create_session(&self, token: &str, tier: &str, ttl_secs: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO sessions(token,tier,expires_at) VALUES(?1,?2,strftime('%s','now')+?3)",
            params![token, tier, ttl_secs],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn valid_session(&self, token: &str, tier: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE token=?1 AND tier=?2 AND expires_at>strftime('%s','now')",
                params![token, tier],
                |r| r.get(0),
            )
            .unwrap_or(0);
        n > 0
    }

    pub fn delete_expired_sessions(&self) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM sessions WHERE expires_at<=strftime('%s','now')", []);
    }

    pub fn active_sessions_count(&self) -> i64 {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM sessions WHERE expires_at>strftime('%s','now')", [], |r| r.get(0))
            .unwrap_or(0)
    }




    // ---- request logs ----

    pub fn log_request(&self, ip: &str, method: &str, path: &str, status_code: i64, user_agent: &str, category: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO request_logs(timestamp,ip,method,path,status_code,user_agent,category) VALUES(datetime('now'),?1,?2,?3,?4,?5,?6)",
            params![ip, method, path, status_code, user_agent, category],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn query_logs(&self, page: i64, per_page: i64, category: &str, ip: &str, method: &str) -> (Vec<LogRow>, i64) {
        let conn = self.conn.lock().unwrap();
        let mut where_sql = String::new();
        let mut where_vals: Vec<Value> = Vec::new();
        let mut n = 1;
        if !category.is_empty() {
            where_sql.push_str(&format!(" AND category=?{n}"));
            where_vals.push(Value::Text(category.to_string()));
            n += 1;
        }
        if !ip.is_empty() {
            where_sql.push_str(&format!(" AND ip LIKE ?{n}"));
            where_vals.push(Value::Text(format!("%{ip}%")));
            n += 1;
        }
        if !method.is_empty() {
            where_sql.push_str(&format!(" AND method=?{n}"));
            where_vals.push(Value::Text(method.to_string()));
            n += 1;
        }
        let count_sql = format!("SELECT COUNT(*) FROM request_logs WHERE 1=1{where_sql}");
        let total: i64 = conn.query_row(&count_sql, params_from_iter(where_vals.iter()), |r| r.get(0)).unwrap_or(0);
        let mut data_vals = where_vals;
        data_vals.push(Value::Integer(per_page));
        data_vals.push(Value::Integer((page - 1) * per_page));
        let data_sql = format!(
            "SELECT id,timestamp,ip,method,path,status_code,user_agent,category FROM request_logs WHERE 1=1{where_sql} ORDER BY id DESC LIMIT ?{n} OFFSET ?{}",
            n + 1
        );
        let mut out = Vec::new();
        if let Ok(mut stmt) = conn.prepare(&data_sql) {
            if let Ok(rows) = stmt.query_map(params_from_iter(data_vals.iter()), log_from_row) {
                for r in rows.flatten() {
                    out.push(r);
                }
            }
        }
        (out, total)
    }

    pub fn today_total(&self) -> i64 {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM request_logs WHERE date(timestamp)=date('now')", [], |r| r.get(0)).unwrap_or(0)
    }

    pub fn category_counts(&self) -> Vec<(String, i64)> {
        let conn = self.conn.lock().unwrap();
        let mut out = Vec::new();
        if let Ok(mut stmt) = conn.prepare("SELECT category, COUNT(*) FROM request_logs GROUP BY category ORDER BY COUNT(*) DESC") {
            if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))) {
                for r in rows.flatten() {
                    out.push(r);
                }
            }
        }
        out
    }

    pub fn peak_malicious_hour(&self) -> Option<(String, i64)> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT strftime('%H',timestamp) h, COUNT(*) c FROM request_logs WHERE category IN ('scan','crawler','blocked','bruteforce') GROUP BY h ORDER BY c DESC LIMIT 1",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )
        .ok()
    }

    pub fn hourly_distribution(&self) -> Vec<(String, i64)> {
        let conn = self.conn.lock().unwrap();
        let mut out = Vec::new();
        if let Ok(mut stmt) = conn.prepare("SELECT strftime('%H',timestamp) h, COUNT(*) c FROM request_logs GROUP BY h ORDER BY h") {
            if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))) {
                for r in rows.flatten() {
                    out.push(r);
                }
            }
        }
        out
    }

    pub fn daily_distribution(&self) -> Vec<(String, i64)> {
        let conn = self.conn.lock().unwrap();
        let mut out = Vec::new();
        if let Ok(mut stmt) = conn.prepare("SELECT date(timestamp) d, COUNT(*) c FROM request_logs GROUP BY d ORDER BY d") {
            if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))) {
                for r in rows.flatten() {
                    out.push(r);
                }
            }
        }
        out
    }
}
