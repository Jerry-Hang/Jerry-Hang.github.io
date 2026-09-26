//! 一次性导入工具：把 frontend/_posts/*.md 导入 blog.db
//!
//! 为什么需要它：
//!   服务端的 `POST /api/posts` 不支持指定 slug —— slug 由 `slugify(title)` 生成，
//!   而 `slugify` 只把空格换成 '-'，不处理中文。因此从标题「自我介绍」无法得到
//!   原文 frontmatter 里声明的 `about-me`，会导致原来的文章链接全部失效。
//!
//!   本工具复用 `db.rs`，导入时直接写入 frontmatter 声明的 slug，
//!   同时保证 content_html 的渲染与净化结果与服务器运行时完全一致。
//!
//! 用法：
//!   import_posts <blog.db> <posts_dir> [--force]
//!
//!   --force 表示已存在同 slug 的文章时覆盖（默认跳过）。

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[path = "../db.rs"]
mod db;

/// 从 Markdown 文件里解析 frontmatter。
/// 返回 (fields, body)，fields 是 key -> value（去掉引号）。
fn parse_frontmatter(text: &str) -> (Vec<(String, String)>, String) {
    let mut fields = Vec::new();
    let normalized = text.replace("\r\n", "\n");
    if !normalized.starts_with("---") {
        return (fields, normalized);
    }
    let rest = &normalized[3..];
    let rest = rest.strip_prefix('\n').unwrap_or(rest);
    // 找到结束的 ---
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
            // 去引号
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

/// 解析 `[a, b, c]` 形式的数组值。
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

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("用法: import_posts <blog.db> <posts_dir> [--force]");
        std::process::exit(2);
    }
    let db_path = PathBuf::from(&args[0]);
    let posts_dir = PathBuf::from(&args[1]);
    let force = args.iter().any(|a| a == "--force");

    if !posts_dir.is_dir() {
        eprintln!("错误: 目录不存在 {}", posts_dir.display());
        std::process::exit(2);
    }

    // 收集 .md 文件
    let mut files: Vec<PathBuf> = fs::read_dir(&posts_dir)
        .expect("读取目录失败")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "md").unwrap_or(false))
        .collect();
    files.sort();

    if files.is_empty() {
        eprintln!("错误: {} 下没有 .md 文件", posts_dir.display());
        std::process::exit(2);
    }

    println!("数据库 : {}", db_path.display());
    println!("文章目录: {}", posts_dir.display());
    println!("找到 {} 个 Markdown 文件", files.len());
    println!();

    let handle = match db::Db::open(&db_path) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("打开数据库失败: {e}");
            std::process::exit(1);
        }
    };

    let mut ok = 0;
    let mut skipped = 0;
    let mut failed = 0;

    for f in &files {
        let name = f.file_name().unwrap().to_string_lossy().to_string();
        let text = match fs::read_to_string(f) {
            Ok(t) => t,
            Err(e) => {
                println!("  [失败] {name} 读取错误: {e}");
                failed += 1;
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

        if title.is_empty() {
            println!("  [跳过] {name} 缺少 frontmatter title");
            skipped += 1;
            continue;
        }
        if slug.is_empty() {
            println!("  [跳过] {name} 缺少 frontmatter slug（必须显式声明才能保URL）");
            skipped += 1;
            continue;
        }
        if body.trim().is_empty() {
            println!("  [跳过] {name} 正文为空");
            skipped += 1;
            continue;
        }

        match handle.import_post(&slug, &title, &body, cats, tags, &desc, &date, force) {
            Ok(db::ImportOutcome::Created) => {
                println!("  [新增] {name}\n         slug={slug}  title={title}");
                ok += 1;
            }
            Ok(db::ImportOutcome::Updated) => {
                println!("  [覆盖] {name}\n         slug={slug}  title={title}");
                ok += 1;
            }
            Ok(db::ImportOutcome::Skipped) => {
                println!("  [跳过] {name} — slug '{slug}' 已存在（加 --force 可覆盖）");
                skipped += 1;
            }
            Err(e) => {
                println!("  [失败] {name}: {e}");
                failed += 1;
            }
        }
    }

    println!();
    println!("完成：成功 {ok}  跳过 {skipped}  失败 {failed}");
    println!("当前文章总数: {}", handle.count());
}
