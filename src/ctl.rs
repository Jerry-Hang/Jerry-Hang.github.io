//! 博客管理 CLI（SSH 登录服务器后本地使用）。
//!
//! 背景：原设计的管理端是一个常驻 HTTP 端口（127.0.0.1:8091）。
//! 改为「取消管理端口、只通过 SSH 控制」后，所有管理动作走本 CLI，
//! 直接操作 blog.db，不再需要任何网络监听。
use crate::db::{Db, Post};
use std::env;
use std::fs;
use std::io::Read;
use std::path::PathBuf;

fn db_path() -> PathBuf {
    PathBuf::from(env::var("BLOG_DB").unwrap_or_else(|_| "blog.db".to_string()))
}

fn usage() {
    eprintln!(
        "博客管理 CLI\n\
         用法:\n  \
         blog_server ctl list\n  \
         blog_server ctl show <id|slug>\n  \
         blog_server ctl new --title T [--file F] [--desc D] [--cats a,b] [--tags x,y]\n  \
         blog_server ctl edit <id> [--title T] [--file F] [--desc D] [--cats a,b] [--tags x,y]\n  \
         blog_server ctl rm <id>\n  \
         blog_server ctl import <dir> [--force]\n  \
         blog_server ctl logs [--page N] [--per N] [--cat C] [--ip I] [--method M]\n  \
         blog_server ctl count\n\
         环境变量: BLOG_DB (默认 ./blog.db)"
    );
}

fn opt(args: &[String], name: &str) -> Option<String> {
    let mut i = 0;
    while i < args.len() {
        if args[i] == name {
            return args.get(i + 1).cloned();
        }
        if let Some(v) = args[i].strip_prefix(&format!("{name}=")) {
            return Some(v.to_string());
        }
        i += 1;
    }
    None
}

fn list_of(v: &str) -> Vec<String> {
    v.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn read_stdin() -> String {
    let mut s = String::new();
    let _ = std::io::stdin().read_to_string(&mut s);
    s
}

fn read_content(args: &[String]) -> Result<String, String> {
    match opt(args, "--file") {
        Some(f) => fs::read_to_string(&f).map_err(|e| format!("读取 {f} 失败: {e}")),
        None => Ok(read_stdin()),
    }
}

fn open_db() -> Db {
    let p = db_path();
    match Db::open(&p) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("打开数据库失败 {}: {e}", p.display());
            std::process::exit(1);
        }
    }
}

fn find_post(db: &Db, key: &str) -> Option<Post> {
    if let Ok(id) = key.parse::<i64>() {
        if let Some(p) = db.get_by_id(id) {
            return Some(p);
        }
    }
    db.get_by_slug(key)
}

pub fn run(args: &[String]) {
    if args.is_empty() {
        usage();
        std::process::exit(2);
    }
    let cmd = args[0].as_str();
    let rest = &args[1..];
    match cmd {
        "list" => {
            let db = open_db();
            let posts = db.list_posts();
            println!("{:<4} {:<28} {:<10} {}", "ID", "SLUG", "DATE", "TITLE");
            for p in &posts {
                println!("{:<4} {:<28} {:<10} {}", p.id, p.slug, p.date, p.title);
            }
            println!("共 {} 篇", posts.len());
        }
        "show" => {
            let key = rest.first().cloned().unwrap_or_default();
            if key.is_empty() {
                usage();
                std::process::exit(2);
            }
            let db = open_db();
            match find_post(&db, &key) {
                Some(p) => {
                    println!("id: {}", p.id);
                    println!("slug: {}", p.slug);
                    println!("title: {}", p.title);
                    println!("date: {}", p.date);
                    println!("updated_at: {}", p.updated_at);
                    println!("categories: [{}]", p.categories.join(", "));
                    println!("tags: [{}]", p.tags.join(", "));
                    println!("desc: {}", p.desc);
                    println!("---");
                    println!("{}", p.content_md);
                }
                None => {
                    eprintln!("未找到文章: {key}");
                    std::process::exit(1);
                }
            }
        }
        "new" => {
            let title = match opt(rest, "--title") {
                Some(t) => t,
                None => {
                    eprintln!("缺少 --title");
                    std::process::exit(2);
                }
            };
            let content = match read_content(rest) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(2);
                }
            };
            if content.trim().is_empty() {
                eprintln!("正文为空");
                std::process::exit(2);
            }
            let desc = opt(rest, "--desc").unwrap_or_default();
            let cats = opt(rest, "--cats").map(|v| list_of(&v)).unwrap_or_default();
            let tags = opt(rest, "--tags").map(|v| list_of(&v)).unwrap_or_default();
            let db = open_db();
            match db.create_post(&title, &content, cats, tags, &desc) {
                Ok(p) => println!("已创建 #{} slug={} title={}", p.id, p.slug, p.title),
                Err(e) => {
                    eprintln!("创建失败: {e}");
                    std::process::exit(1);
                }
            }
        }
        "edit" => {
            let key = rest.first().cloned().unwrap_or_default();
            if key.is_empty() {
                usage();
                std::process::exit(2);
            }
            let db = open_db();
            let cur = match find_post(&db, &key) {
                Some(p) => p,
                None => {
                    eprintln!("未找到文章: {key}");
                    std::process::exit(1);
                }
            };
            let title = opt(rest, "--title").unwrap_or(cur.title.clone());
            let content = if opt(rest, "--file").is_some() {
                match read_content(rest) {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("{e}");
                        std::process::exit(2);
                    }
                }
            } else {
                cur.content_md.clone()
            };
            let desc = opt(rest, "--desc").unwrap_or(cur.desc.clone());
            let cats = opt(rest, "--cats").map(|v| list_of(&v)).unwrap_or(cur.categories.clone());
            let tags = opt(rest, "--tags").map(|v| list_of(&v)).unwrap_or(cur.tags.clone());
            match db.update_post(cur.id, &title, &content, cats, tags, &desc) {
                Ok(p) => println!("已更新 #{} slug={} title={}", p.id, p.slug, p.title),
                Err(e) => {
                    eprintln!("更新失败: {e}");
                    std::process::exit(1);
                }
            }
        }
        "rm" => {
            let key = rest.first().cloned().unwrap_or_default();
            if key.is_empty() {
                usage();
                std::process::exit(2);
            }
            let db = open_db();
            let p = match find_post(&db, &key) {
                Some(p) => p,
                None => {
                    eprintln!("未找到文章: {key}");
                    std::process::exit(1);
                }
            };
            match db.delete_post(p.id) {
                Ok(_) => println!("已删除 #{} slug={}", p.id, p.slug),
                Err(e) => {
                    eprintln!("删除失败: {e}");
                    std::process::exit(1);
                }
            }
        }
        "import" => {
            let dir = rest.first().cloned().unwrap_or_default();
            if dir.is_empty() {
                usage();
                std::process::exit(2);
            }
            let force = rest.iter().any(|a| a == "--force");
            let db = open_db();
            let mut files: Vec<PathBuf> = match fs::read_dir(&dir) {
                Ok(rd) => rd
                    .filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| p.extension().map(|x| x == "md").unwrap_or(false))
                    .collect(),
                Err(e) => {
                    eprintln!("读取目录失败 {dir}: {e}");
                    std::process::exit(1);
                }
            };
            files.sort();
            let (mut ok, mut skip, mut fail) = (0, 0, 0);
            for f in &files {
                let name = f.file_name().unwrap().to_string_lossy().to_string();
                let text = match fs::read_to_string(f) {
                    Ok(t) => t,
                    Err(e) => {
                        println!("  [失败] {name}: {e}");
                        fail += 1;
                        continue;
                    }
                };
                let (fields, body) = parse_frontmatter(&text);
                let title = get(&fields, "title").cloned().unwrap_or_default();
                let slug = get(&fields, "slug").cloned().unwrap_or_default();
                let date = get(&fields, "date").cloned().unwrap_or_default();
                let desc = get(&fields, "desc").cloned().unwrap_or_default();
                let cats = get(&fields, "categories").map(|v| parse_list(v)).unwrap_or_default();
                let tags = get(&fields, "tags").map(|v| parse_list(v)).unwrap_or_default();
                if title.is_empty() || slug.is_empty() || body.trim().is_empty() {
                    println!("  [跳过] {name} (缺 title/slug 或正文为空)");
                    skip += 1;
                    continue;
                }
                match db.import_post(&slug, &title, &body, cats, tags, &desc, &date, force) {
                    Ok(crate::db::ImportOutcome::Created) => {
                        println!("  [新增] {name} slug={slug}");
                        ok += 1;
                    }
                    Ok(crate::db::ImportOutcome::Updated) => {
                        println!("  [覆盖] {name} slug={slug}");
                        ok += 1;
                    }
                    Ok(crate::db::ImportOutcome::Skipped) => {
                        println!("  [跳过] {name} slug 已存在");
                        skip += 1;
                    }
                    Err(e) => {
                        println!("  [失败] {name}: {e}");
                        fail += 1;
                    }
                }
            }
            println!("完成: 成功 {ok} 跳过 {skip} 失败 {fail}; 总数 {}", db.count());
        }
        "logs" => {
            let page: i64 = opt(rest, "--page").and_then(|v| v.parse().ok()).unwrap_or(1);
            let per: i64 = opt(rest, "--per").and_then(|v| v.parse().ok()).unwrap_or(20);
            let cat = opt(rest, "--cat").unwrap_or_default();
            let ip = opt(rest, "--ip").unwrap_or_default();
            let method = opt(rest, "--method").unwrap_or_default();
            let db = open_db();
            let (rows, total) = db.query_logs(page, per, &cat, &ip, &method);
            println!(
                "{:<5} {:<20} {:<16} {:<7} {:<28} {:<6} {}",
                "ID", "TIME", "IP", "METHOD", "PATH", "STATUS", "CATEGORY"
            );
            for r in &rows {
                println!(
                    "{:<5} {:<20} {:<16} {:<7} {:<28} {:<6} {}",
                    r.id, r.timestamp, r.ip, r.method, r.path, r.status_code, r.category
                );
            }
            println!("共 {total} 条，第 {page} 页（每页 {per}）");
        }
        "count" => {
            let db = open_db();
            println!("{}", db.count());
        }
        _ => {
            usage();
            std::process::exit(2);
        }
    }
}

fn parse_frontmatter(text: &str) -> (Vec<(String, String)>, String) {
    let mut fields = Vec::new();
    let normalized = text.replace("\r\n", "\n");
    if !normalized.starts_with("---") {
        return (fields, normalized);
    }
    let rest = &normalized[3..];
    let rest = rest.strip_prefix('\n').unwrap_or(rest);
    let end = match rest.find("\n---") {
        Some(i) => i,
        None => return (fields, normalized),
    };
    let head = &rest[..end];
    let body = rest[end + 4..].trim_start_matches('\n').to_string();
    for line in head.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim().to_string();
            let mut val = v.trim().to_string();
            if (val.starts_with('"') && val.ends_with('"') && val.len() >= 2)
                || (val.starts_with('\'') && val.ends_with('\'') && val.len() >= 2)
            {
                val = val[1..val.len() - 1].to_string();
            }
            fields.push((key, val));
        }
    }
    (fields, body)
}

fn parse_list(v: &str) -> Vec<String> {
    let t = v.trim();
    let inner = t
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(t);
    inner
        .split(',')
        .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn get<'a>(fields: &'a [(String, String)], key: &str) -> Option<&'a String> {
    fields.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}
