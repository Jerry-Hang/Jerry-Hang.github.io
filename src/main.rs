//! blog_ctl —— 轻量级博客文章管理工具（纯标准库）
//!
//! 命令: new / list / build / push
//! build 生成 posts.json（含英文 slug）、feed.xml、sitemap.xml、robots.txt，
//! 并为每篇文章生成独立静态页 blog/<slug>/index.html（真实路径直链）

use std::env;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const POSTS_DIR: &str = "_posts";
const SITE: &str = "https://jerry-hang.blog";

struct Post {
    title: String,
    date: String,
    categories: Vec<String>,
    tags: Vec<String>,
    desc: String,
    body: String,
    pinned: bool,
    slug: String,
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("new") => {
            let title = args.get(1).map(String::as_str).unwrap_or_default();
            if title.is_empty() { eprintln!("用法: blog_ctl new \"文章标题\""); std::process::exit(1); }
            cmd_new(title);
        }
        Some("list") => cmd_list(),
        Some("build") => cmd_build(),
        Some("push") => {
            let msg = args.get(1).map(String::as_str).unwrap_or_default();
            if msg.is_empty() { eprintln!("用法: blog_ctl push \"提交信息\""); std::process::exit(1); }
            cmd_push(msg);
        }
        Some(other) => { eprintln!("未知命令: {other}\n"); print_usage(); std::process::exit(1); }
        None => print_usage(),
    }
}

fn print_usage() {
    println!("blog_ctl —— 轻量级博客文章管理工具（纯 std，无第三方依赖）");
    println!("  blog_ctl new \"文章标题\"   新文章");
    println!("  blog_ctl list            列出文章");
    println!("  blog_ctl build           生成 posts.json / feed.xml / sitemap.xml / 独立文章页");
    println!("  blog_ctl push \"信息\"      先 build，再 git add/commit/push");
}

fn cmd_new(title: &str) {
    fs::create_dir_all(POSTS_DIR).expect("无法创建 _posts 目录");
    let (y, m, d) = today();
    let date_str = format!("{y:04}-{m:02}-{d:02}");
    let slug = slugify(title);
    let base = format!("{date_str}-{slug}");
    let mut path = Path::new(POSTS_DIR).join(format!("{base}.md"));
    let mut n = 2;
    while path.exists() {
        path = Path::new(POSTS_DIR).join(format!("{base}-{n}.md"));
        n += 1;
    }
    let content = format!(
        "---\nlayout: post\ntitle: \"{title}\"\ndate: {date_str}\ncategories: [随笔]\ntags: []\n---\n\n# {title}\n\n在这里开始写正文……\n"
    );
    fs::write(&path, content).expect("写入文章文件失败");
    println!("✔ 已创建文章: {}", path.display());
}

fn cmd_list() {
    let dir = Path::new(POSTS_DIR);
    if !dir.exists() { println!("还没有 {POSTS_DIR} 目录。"); return; }
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let path = e.path();
            if path.extension().map_or(false, |x| x == "md") { files.push(path); }
        }
    }
    files.sort();
    if files.is_empty() { println!("{POSTS_DIR} 下还没有文章。"); return; }
    println!("{POSTS_DIR} 下的文章:");
    for (i, f) in files.iter().enumerate() {
        println!("  {:>3}. {}", i + 1, f.file_name().unwrap_or_default().to_string_lossy());
    }
    println!("共 {} 篇", files.len());
}

fn cmd_build() {
    let posts = scan_posts();
    if posts.is_empty() { eprintln!("没有找到文章。"); }
    let items: Vec<String> = posts.iter().map(|p| format!(
        "{{\"title\":\"{t}\",\"date\":\"{d}\",\"categories\":[{c}],\"tags\":[{g}],\"desc\":\"{e}\",\"body\":\"{b}\",\"pinned\":{p},\"slug\":\"{sl}\"}}",
        t = json_escape(&p.title), d = json_escape(&p.date),
        c = json_str_array(&p.categories), g = json_str_array(&p.tags),
        e = json_escape(&p.desc), b = json_escape(&p.body),
        p = if p.pinned { "true" } else { "false" }, sl = json_escape(&p.slug),
    )).collect();
    fs::write("posts.json", format!("[{}]", items.join(","))).expect("写 posts.json 失败");
    fs::write("feed.xml", build_feed(&posts)).expect("写 feed.xml 失败");
    fs::write("sitemap.xml", build_sitemap(&posts)).expect("写 sitemap.xml 失败");
    fs::write("robots.txt", "User-agent: *\nAllow: /\nSitemap: https://jerry-hang.blog/sitemap.xml\n").unwrap();
    generate_pages(&posts);
    println!("✔ 已生成 posts.json（{} 篇）+ feed.xml + sitemap.xml + robots.txt", posts.len());
}

fn scan_posts() -> Vec<Post> {
    let dir = Path::new(POSTS_DIR);
    let mut posts = Vec::new();
    if !dir.exists() { return posts; }
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let path = e.path();
            if path.extension().map_or(false, |x| x == "md") { files.push(path); }
        }
    }
    files.sort();
    for f in files {
        if let Some(p) = parse_post(&f) { posts.push(p); }
    }
    posts.sort_by(|a, b| b.date.cmp(&a.date));
    posts
}

fn parse_post(path: &Path) -> Option<Post> {
    let raw = fs::read_to_string(path).ok()?;
    let norm = raw.replace("\r\n", "\n");
    let lines: Vec<&str> = norm.split('\n').collect();
    let mut title = String::new();
    let mut date = String::new();
    let mut categories = Vec::new();
    let mut tags = Vec::new();
    let mut desc = String::new();
    let mut pinned = false;
    let mut slug_meta = String::new();
    let mut body_start = 0usize;
    if lines.first().map(|l| l.trim()) == Some("---") {
        let mut i = 1usize;
        while i < lines.len() {
            let line = lines[i];
            if line.trim() == "---" { body_start = i + 1; break; }
            if let Some((key, val)) = line.split_once(':') {
                let key = key.trim(); let val = val.trim();
                match key {
                    "title" => title = unquote(val),
                    "date" => date = unquote(val),
                    "categories" => categories = parse_list(val),
                    "tags" => tags = parse_list(val),
                    "desc" | "description" => desc = unquote(val),
                    "pinned" => pinned = unquote(val) == "true",
                    "slug" => slug_meta = unquote(val),
                    _ => {}
                }
            }
            i += 1;
        }
    }
    let mut slug = String::new();
    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
        slug = stem.to_string();
        if !slug_meta.is_empty() {
            slug = slug_meta.clone();
        }
        if title.is_empty() && stem.len() > 11 && stem.as_bytes().get(4) == Some(&b'-') && stem.as_bytes().get(7) == Some(&b'-') {
            title = stem[11..].replace('-', " ");
        } else if title.is_empty() {
            title = stem.replace('-', " ");
        }
        if date.is_empty() && stem.len() >= 10 && stem.as_bytes().get(4) == Some(&b'-') && stem.as_bytes().get(7) == Some(&b'-') {
            date = stem[0..10].to_string();
        }
    }
    if date.is_empty() {
        let (y, m, d) = today();
        date = format!("{y:04}-{m:02}-{d:02}");
    }
    let body_lines: Vec<&str> = lines.iter().skip(body_start).skip_while(|l| l.trim().is_empty()).map(|l| *l).collect();
    let body = body_lines.join("\n");
    if desc.is_empty() {
        if let Some(first) = body_lines.iter().find(|l| !l.trim().is_empty()) {
            let mut s = first.trim().to_string();
            while s.trim_start().starts_with('#') {
                s = s.trim_start().trim_start_matches('#').trim_start().to_string();
            }
            let t = s.trim().to_string();
            if !t.is_empty() { desc = if t.len() > 120 { t[..120].to_string() } else { t }; }
        }
    }
    Some(Post { title, date, categories, tags, desc, body, pinned, slug })
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2 {
        let b = s.as_bytes();
        if (b[0] == b'"' && b[s.len() - 1] == b'"') || (b[0] == 39 && b[s.len() - 1] == 39) {
            return s[1..s.len() - 1].to_string();
        }
    }
    s.to_string()
}

fn parse_list(s: &str) -> Vec<String> {
    let s = s.trim();
    let inner = if s.starts_with('[') && s.ends_with(']') { &s[1..s.len() - 1] } else { s };
    inner.split(',').map(|x| unquote(x.trim())).filter(|x| !x.is_empty()).collect()
}

fn json_str_array(list: &[String]) -> String {
    list.iter().map(|s| format!("\"{}\"", json_escape(s))).collect::<Vec<_>>().join(",")
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        if ch == '"' { out.push_str("\\\""); }
        else if ch == '\\' { out.push_str("\\\\"); }
        else if ch == '\n' { out.push_str("\\n"); }
        else if ch == '\r' { out.push_str("\\r"); }
        else if ch == '\t' { out.push_str("\\t"); }
        else if (ch as u32) < 0x20 { out.push_str(&format!("\\u{:04x}", ch as u32)); }
        else { out.push(ch); }
    }
    out
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
    out
}

fn url_encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 生成每篇文章的独立静态页：blog/<slug>/index.html（真实路径直链，SEO 友好）
fn generate_pages(posts: &[Post]) {
    let tpl = match fs::read_to_string("index.html") {
        Ok(t) => t,
        Err(_) => { eprintln!("未找到 index.html 模板，跳过独立页生成"); return; }
    };
    let mut ok_w = 0;
    for p in posts {
        let dir = format!("blog/{}", p.slug);
        if fs::create_dir_all(&dir).is_err() { continue; }
        let inject = format!(
            "<script>window.__ARTICLE__ = \"{}\";</script>\n",
            xml_escape(&p.slug)
        );
        let marker = "<script src=\"/app.js";
        let out = if let Some(i) = tpl.find(marker) {
            format!("{}{}{}", &tpl[..i], inject, &tpl[i..])
        } else {
            tpl.clone()
        };
        if fs::write(format!("{dir}/index.html"), out).is_ok() { ok_w += 1; }
    }
    println!("✔ 已生成 {} 个独立文章页（blog/<slug>/）", ok_w);
}

fn build_feed(posts: &[Post]) -> String {
    let mut items = String::new();
    for (i, p) in posts.iter().enumerate() {
        items.push_str(&format!(
            "  <item><title>{t}</title><link>{link}</link><guid isPermaLink=\"false\">jb-{i}-{d}-{t}</guid><pubDate>{pub}</pubDate><description>{dsc}</description></item>\n",
            t = xml_escape(&p.title),
            link = format!("{SITE}/blog/{}/", url_encode_path(&p.slug)),
            i = i, d = xml_escape(&p.date), pub = rfc822_date(&p.date), dsc = xml_escape(&p.desc),
        ));
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<rss version=\"2.0\"><channel>\n<title>{t}</title><link>{SITE}</link><description>{d}</description><language>zh-cn</language>\n{items}</channel></rss>",
        t = xml_escape("JerryHang 的个人博客"), d = xml_escape("记录与折腾"), items = items,
    )
}

fn build_sitemap(posts: &[Post]) -> String {
    let mut urls = String::new();
    urls.push_str(&format!("  <url><loc>{SITE}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>\n"));
    for p in posts.iter() {
        urls.push_str(&format!(
            "  <url><loc>{link}</loc><lastmod>{dt}T00:00:00Z</lastmod><priority>0.8</priority></url>\n",
            link = format!("{SITE}/blog/{}/", url_encode_path(&p.slug)), dt = p.date,
        ));
    }
    format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n{urls}</urlset>")
}

fn rfc822_date(date_str: &str) -> String {
    let parts: Vec<&str> = date_str.split('-').collect();
    if parts.len() == 3 {
        if let (Ok(y), Ok(m), Ok(dd)) = (parts[0].parse::<i64>(), parts[1].parse::<u32>(), parts[2].parse::<u32>()) {
            if (1..=12).contains(&m) && (1..=31).contains(&dd) {
                let days = days_from_civil(y, m, dd);
                let wd = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"][(((days % 7) + 7) % 7) as usize];
                let mm = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][(m - 1) as usize];
                return format!("{wd}, {dd:02} {mm} {y} 00:00:00 GMT");
            }
        }
    }
    format!("{date_str} 00:00:00 GMT")
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = y - i64::from(m <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (i64::from(m) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn cmd_push(message: &str) {
    cmd_build();
    let ok = |args: &[&str]| Command::new("git").args(args).status().map(|s| s.success()).unwrap_or(false);
    println!("==> git add .");
    if !ok(&["add", "."]) { eprintln!("✘ git add 失败"); std::process::exit(1); }
    println!("==> git commit");
    if !ok(&["commit", "-m", message]) { eprintln!("✘ 提交失败（无改动或错误）"); std::process::exit(1); }
    println!("==> git push");
    let branch = Command::new("git").args(["branch", "--show-current"]).output().ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    let up = Command::new("git").args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).output().map(|o| o.status.success()).unwrap_or(false);
    let st = if let Some(b) = &branch {
        if !up { Command::new("git").args(["push", "-u", "origin", b]).status() } else { Command::new("git").arg("push").status() }
    } else {
        Command::new("git").arg("push").status()
    };
    match st {
        Ok(s) if s.success() => println!("✔ 发布成功: {SITE}"),
        _ => eprintln!("✘ push 失败"),
    }
}

fn today() -> (i64, u32, u32) {
    if let Ok(out) = Command::new("date").arg("+%F").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            let s = s.trim();
            if s.len() == 10 {
                if let (Ok(y), Ok(m), Ok(d)) = (s[0..4].parse::<i64>(), s[5..7].parse::<u32>(), s[8..10].parse::<u32>()) {
                    if (1..=12).contains(&m) && (1..=31).contains(&d) { return (y, m, d); }
                }
            }
        }
    }
    let days = SystemTime::now().duration_since(UNIX_EPOCH).map(|x| x.as_secs() / 86400).unwrap_or(0);
    civil_from_days(days as i64)
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut prev_space = false;
    for ch in s.trim().chars() {
        if ch.is_whitespace() {
            if !prev_space && !out.is_empty() { out.push('-'); }
            prev_space = true;
        } else { out.push(ch); prev_space = false; }
    }
    out.trim_end_matches('-').to_string()
}
