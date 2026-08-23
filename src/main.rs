//! blog_ctl —— 轻量级博客文章管理工具
//!
//! 纯标准库实现，不依赖任何第三方 crate。
//! 所有 git 操作都通过 std::process::Command 调用系统 git 命令。
//!
//! 命令:
//!   new   在 _posts 下生成带日期的 Markdown 文章
//!   list  列出所有文章
//!   build 扫描 _posts 生成 posts.json（网站前端的数据源）
//!   push  先 build，再依次 git add / commit / push

use std::env;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const POSTS_DIR: &str = "_posts";

struct Post {
    title: String,
    date: String,
    categories: Vec<String>,
    tags: Vec<String>,
    desc: String,
    body: String,
    pinned: bool,
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    match args.first().map(String::as_str) {
        Some("new") => {
            let title = args.get(1).map(String::as_str).unwrap_or_default();
            if title.is_empty() {
                eprintln!("用法: blog_ctl new \"文章标题\"");
                std::process::exit(1);
            }
            cmd_new(title);
        }
        Some("list") => cmd_list(),
        Some("build") => cmd_build(),
        Some("push") => {
            let msg = args.get(1).map(String::as_str).unwrap_or_default();
            if msg.is_empty() {
                eprintln!("用法: blog_ctl push \"提交信息\"");
                std::process::exit(1);
            }
            cmd_push(msg);
        }
        Some(other) => {
            eprintln!("未知命令: {other}\n");
            print_usage();
            std::process::exit(1);
        }
        None => print_usage(),
    }
}

fn print_usage() {
    println!("blog_ctl —— 轻量级博客文章管理工具（纯 std，无第三方依赖）");
    println!();
    println!("用法:");
    println!("  blog_ctl new \"文章标题\"    在 _posts 下生成带当前日期的 Markdown 文章");
    println!("  blog_ctl list             列出 _posts 下的所有 Markdown 文章");
    println!("  blog_ctl build            扫描 _posts，生成前端数据文件 posts.json");
    println!("  blog_ctl push \"提交信息\"   先 build，再依次执行 git add / git commit / git push");
}

/// 生成新文章
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
        "---\nlayout: post\ntitle: \"{title}\"\ndate: {date_str}\ncategories: [blog]\ntags: []\n---\n\n# {title}\n\n在这里开始写正文……\n"
    );
    fs::write(&path, content).expect("写入文章文件失败");

    println!("✔ 已创建文章: {}", path.display());
    println!("  用编辑器打开它开始写作吧。");
}



/// sitemap.xml（简单站点地图）
fn build_sitemap(posts: &[Post]) -> String {
    let mut urls = String::new();
    urls.push_str("  <url><loc>https://jerry-hang.blog/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>\n");
    for p in posts.iter() {
        urls.push_str(&format!(
            "  <url><loc>https://jerry-hang.blog/?article={dt}</loc><lastmod>{dt}T00:00:00Z</lastmod><priority>0.8</priority></url>\n",
            dt = p.date,
        ));
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n{urls}</urlset>"
    )
}

/// RSS 2.0 feed（订阅用）
fn build_feed(posts: &[Post]) -> String {
    let mut items = String::new();
    for (i, p) in posts.iter().enumerate() {
        items.push_str(&format!(
            "  <item><title>{t}</title><link>https://jerry-hang.blog/</link><guid isPermaLink=\"false\">jb-{i}-{d}-{t}</guid><pubDate>{pub}</pubDate><description>{dsc}</description></item>\n",
            t = xml_escape(&p.title),
            i = i,
            d = xml_escape(&p.date),
            pub = rfc822_date(&p.date),
            dsc = xml_escape(&p.desc),
        ));
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<rss version=\"2.0\"><channel>\n<title>{t}</title><link>https://jerry-hang.blog</link><description>{d}</description><language>zh-cn</language>\n{items}</channel></rss>",
        t = xml_escape("JerryHang 的个人博客"),
        d = xml_escape("记录与折腾"),
        items = items,
    )
}

/// XML 转义
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

/// YYYY-MM-DD -> RFC822（GMT）
fn rfc822_date(date_str: &str) -> String {
    let parts: Vec<&str> = date_str.split('-').collect();
    if parts.len() == 3 {
        if let (Ok(y), Ok(m), Ok(d)) = (
            parts[0].parse::<i64>(),
            parts[1].parse::<u32>(),
            parts[2].parse::<u32>(),
        ) {
            if (1..=12).contains(&m) && (1..=31).contains(&d) {
                let days = days_from_civil(y, m, d);
                let weekdays = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
                let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                let wd = weekdays[(((days % 7) + 7) % 7) as usize];
                let mm = months[(m - 1) as usize];
                return format!("{wd}, {d:02} {mm} {y} 00:00:00 GMT");
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

/// 列出所有 Markdown 文章
fn cmd_list() {
    let dir = Path::new(POSTS_DIR);
    if !dir.exists() {
        println!("还没有 {POSTS_DIR} 目录，先用 blog_ctl new 创建第一篇文章吧。");
        return;
    }

    let mut files: Vec<_> = fs::read_dir(dir)
        .expect("读取 _posts 目录失败")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map_or(false, |x| x == "md"))
        .collect();

    files.sort();

    if files.is_empty() {
        println!("{POSTS_DIR} 下还没有 Markdown 文章。");
        return;
    }

    println!("{POSTS_DIR} 下的文章:");
    for (i, f) in files.iter().enumerate() {
        let name = f.file_name().unwrap_or_default().to_string_lossy();
        println!("{:>3}. {}", i + 1, name);
    }
    println!();
    println!("共 {} 篇文章", files.len());
}

/// 扫描 _posts，生成 posts.json（前端数据源）
fn cmd_build() {
    let posts = scan_posts();
    if posts.is_empty() {
        eprintln!("没有找到任何文章（{POSTS_DIR}/*.md），已生成空 posts.json。");
    }

    let items: Vec<String> = posts
        .iter()
        .map(|p| {
            format!(
                "{{\"title\":\"{t}\",\"date\":\"{d}\",\"categories\":[{c}],\"tags\":[{g}],\"desc\":\"{e}\",\"body\":\"{b}\",\"pinned\":{p}}}",
                t = json_escape(&p.title),
                d = json_escape(&p.date),
                c = json_str_array(&p.categories),
                g = json_str_array(&p.tags),
                e = json_escape(&p.desc),
                b = json_escape(&p.body),
                p = if p.pinned { "true" } else { "false" },
            )
        })
        .collect();

    let out = format!("[{}]", items.join(","));
    fs::write("feed.xml", build_feed(&posts)).expect("写入 feed.xml 失败");
    fs::write("sitemap.xml", build_sitemap(&posts)).expect("写入 sitemap.xml 失败");
    fs::write("robots.txt", "User-agent: *\nAllow: /\nSitemap: https://jerry-hang.blog/sitemap.xml\n").expect("写入 robots.txt 失败");
    fs::write("posts.json", out).expect("写入 posts.json 失败");
    println!("✔ 已生成 posts.json（{} 篇文章）", posts.len());
}

/// 读取 _posts 下所有文章（按日期倒序）
fn scan_posts() -> Vec<Post> {
    let dir = Path::new(POSTS_DIR);
    let mut posts = Vec::new();
    if !dir.exists() {
        return posts;
    }
    let mut files: Vec<_> = fs::read_dir(dir)
        .expect("读取 _posts 目录失败")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map_or(false, |x| x == "md"))
        .collect();
    files.sort();

    for f in files {
        if let Some(p) = parse_post(&f) {
            posts.push(p);
        }
    }
    posts.sort_by(|a, b| b.date.cmp(&a.date));
    posts
}

/// 解析单篇文章（front matter + 正文）
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
    let mut body_start = 0usize;

    if lines.first().map(|l| l.trim()) == Some("---") {
        let mut i = 1usize;
        while i < lines.len() {
            let line = lines[i];
            if line.trim() == "---" {
                body_start = i + 1;
                break;
            }
            if let Some((key, val)) = line.split_once(':') {
                let key = key.trim();
                let val = val.trim();
                match key {
                    "title" => title = unquote(val),
                    "date" => date = unquote(val),
                    "categories" => categories = parse_list(val),
                    "tags" => tags = parse_list(val),
                    "desc" | "description" => desc = unquote(val),
                    "pinned" => pinned = unquote(val) == "true",
                    _ => {}
                }
            }
            i += 1;
        }
    }

    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
        let bytes = stem.as_bytes();
        // 标题兜底：文件名形如 YYYY-MM-DD-标题
        if title.is_empty() && stem.len() > 11 && bytes.get(4) == Some(&b'-') && bytes.get(7) == Some(&b'-') {
            let name_part = &stem[11..];
            title = name_part.replace('-', " ");
        } else if title.is_empty() {
            title = stem.replace('-', " ");
        }
        // 日期兜底：文件名前缀
        if date.is_empty() && stem.len() >= 10 && bytes.get(4) == Some(&b'-') && bytes.get(7) == Some(&b'-') {
            date = stem[0..10].to_string();
        }
    }
    if date.is_empty() {
        let (y, m, d) = today();
        date = format!("{y:04}-{m:02}-{d:02}");
    }

    let body_lines: Vec<&str> = lines
        .iter()
        .skip(body_start)
        .skip_while(|l| l.trim().is_empty())
        .map(|l| *l)
        .collect();
    let body = body_lines.join("\n");

    if desc.is_empty() {
        if let Some(first) = body_lines.iter().find(|l| !l.trim().is_empty()) {
            let mut s = first.trim().to_string();
            while s.trim_start().starts_with('#') {
                s = s.trim_start().trim_start_matches('#').trim_start().to_string();
            }
            let s = s.trim().to_string();
            if !s.is_empty() {
                let mut t = s;
                if t.len() > 120 {
                    t = t[..120].to_string();
                }
                desc = t;
            }
        }
    }

    Some(Post { title, date, categories, tags, desc, body, pinned })
}

/// 去掉包裹的引号
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

/// 解析 [a, b] 或 a 形式的列表
fn parse_list(s: &str) -> Vec<String> {
    let s = s.trim();
    let inner;
    if s.starts_with('[') && s.ends_with(']') {
        inner = &s[1..s.len() - 1];
    } else {
        inner = s;
    }
    inner
        .split(',')
        .map(|x| unquote(x.trim()).to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

/// JSON 字符串数组（已转义的字符串 -> 数组字面量）
fn json_str_array(list: &[String]) -> String {
    let items: Vec<String> = list.iter().map(|s| format!("\"{}\"", json_escape(s))).collect();
    items.join(",")
}

/// JSON 字符串转义
fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        if ch == '"' {
            out.push_str("\\\"");
        } else if ch == '\\' {
            out.push_str("\\\\");
        } else if ch == '\n' {
            out.push_str("\\n");
        } else if ch == '\r' {
            out.push_str("\\r");
        } else if ch == '\t' {
            out.push_str("\\t");
        } else if (ch as u32) < 0x20 {
            out.push_str(&format!("\\u{:04x}", ch as u32));
        } else {
            out.push(ch);
        }
    }
    out
}

/// git add . + git commit + git push（push 前先 build）
fn cmd_push(message: &str) {
    println!("==> 先构建 posts.json");
    cmd_build();

    println!("==> git add .");
    if !run_git(&["add", "."]) {
        eprintln!("✘ git add 失败，已中止。");
        std::process::exit(1);
    }

    println!("==> git commit -m \"{message}\"");
    if !run_git(&["commit", "-m", message]) {
        eprintln!("✘ 提交失败（可能是没有改动需要提交），已跳过 push。");
        std::process::exit(1);
    }

    let branch = current_branch();
    let push_args: Vec<String>;
    let desc: String;
    if let Some(b) = &branch {
        if !has_upstream() {
            push_args = vec![
                "push".to_string(),
                "-u".to_string(),
                "origin".to_string(),
                b.clone(),
            ];
            desc = format!("git push -u origin {b}");
        } else {
            push_args = vec!["push".to_string()];
            desc = "git push".to_string();
        }
    } else {
        push_args = vec!["push".to_string()];
        desc = "git push".to_string();
    }
    println!("==> {desc}");

    let arg_refs: Vec<&str> = push_args.iter().map(String::as_str).collect();
    if !run_git_interactive(&arg_refs) {
        eprintln!("✘ git push 失败，请检查远程地址与认证配置（见上方 git 输出）。");
        std::process::exit(1);
    }

    println!("✔ 已成功推送到远程仓库。");
}

/// 调用系统 git 并透传输出，返回是否成功
fn run_git(args: &[&str]) -> bool {
    let output = Command::new("git").args(args).output();
    match output {
        Ok(out) => {
            if !out.stdout.is_empty() {
                print!("{}", String::from_utf8_lossy(&out.stdout));
            }
            if !out.stderr.is_empty() {
                eprint!("{}", String::from_utf8_lossy(&out.stderr));
            }
            out.status.success()
        }
        Err(e) => {
            eprintln!("无法执行 git: {e}（请确认已安装 git）");
            false
        }
    }
}

/// 获取当前分支名
fn current_branch() -> Option<String> {
    let out = Command::new("git")
        .args(["branch", "--show-current"])
        .output()
        .ok()?;
    if out.status.success() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() {
            return Some(s);
        }
    }
    None
}

/// 当前分支是否已设置 upstream
fn has_upstream() -> bool {
    Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 以继承的 stdio 运行 git（用于 push）
fn run_git_interactive(args: &[&str]) -> bool {
    match Command::new("git").args(args).status() {
        Ok(st) => st.success(),
        Err(e) => {
            eprintln!("无法执行 git: {e}（请确认已安装 git）");
            false
        }
    }
}

/// 取今天日期 (年, 月, 日)
fn today() -> (i64, u32, u32) {
    if let Ok(out) = Command::new("date").arg("+%F").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            let s = s.trim();
            if s.len() == 10 {
                if let (Ok(y), Ok(m), Ok(d)) = (
                    s[0..4].parse::<i64>(),
                    s[5..7].parse::<u32>(),
                    s[8..10].parse::<u32>(),
                ) {
                    if (1..=12).contains(&m) && (1..=31).contains(&d) {
                        return (y, m, d);
                    }
                }
            }
        }
    }
    let days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("系统时间早于 1970 年")
        .as_secs()
        / 86400;
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

/// 把标题转成文件名友好的 slug：空白折叠为连字符，保留中文
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
    out.trim_end_matches('-').to_string()
}
