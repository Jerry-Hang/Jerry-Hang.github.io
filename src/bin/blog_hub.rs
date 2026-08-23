//! blog_hub —— 手机端博客管理台（Termux 运行）
//!
//! 纯标准库实现，零第三方依赖。
//! 功能：写新文章 / 编辑 / 删除 / 列表 / 一键发布 / 线上状态。
//! 发布走系统 git（SSH 密钥），全程无需登录 GitHub。
//!
//! 交互菜单模式：直接运行 blog_hub
//! 脚本模式：blog_hub --list | --status | --new "标题" | --publish "信息"

use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

const REPO_HINT: &str = "请在博客仓库目录运行（含 _posts 与 .git）";

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        run_menu();
        return;
    }
    match args[0].as_str() {
        "--list" => cmd_list(),
        "--status" => cmd_status(),
        "--new" => {
            let title = args.get(1).cloned().unwrap_or_default();
            if title.is_empty() { eprintln!("用法: blog_hub --new \"文章标题\""); std::process::exit(1); }
            create_post(&title, None, true);
        }
        "--publish" => {
            let msg = args.get(1).cloned().unwrap_or_else(|| "手机快速发布".to_string());
            publish(&msg);
        }
        other => { eprintln!("未知参数: {other}"); std::process::exit(1); }
    }
}

/* ================= 交互菜单 ================= */

fn run_menu() {
    loop {
        clear();
        println!("┌──────────────────────────────────────────┐");
        println!("│   Jerry 的赛博博客 · 手机管理台          │");
        println!("├──────────────────────────────────────────┤");
        println!("│   .NET 控制台 · 零依赖 · SSH 一键发布    │");
        println!("└──────────────────────────────────────────┘");
        println!();
        println!("  [1] 写新文章");
        println!("  [2] 编辑文章");
        println!("  [3] 删除文章");
        println!("  [4] 文章列表");
        println!("  [5] 一键发布（build + commit + push）");
        println!("  [6] 站点状态（线上 / 最近提交）");
        println!("  [0] 退出");
        println!();
        print!("  选择: ");
        io::stdout().flush().ok();
        let mut line = String::new();
        if io::stdin().read_line(&mut line).is_err() { break; }
        match line.trim() {
            "1" => {
                print!("  文章标题: ");
                io::stdout().flush().ok();
                let mut t = String::new();
                if io::stdin().read_line(&mut t).is_err() || t.trim().is_empty() { continue; }
                let title = t.trim().to_string();
                print!("  分类（逗号分隔，默认 随笔）: ");
                io::stdout().flush().ok();
                let mut c = String::new();
                let _ = io::stdin().read_line(&mut c);
                let cats = parse_csv(if c.trim().is_empty() { "随笔" } else { &c });
                print!("  标签（逗号分隔，可空）: ");
                io::stdout().flush().ok();
                let mut g = String::new();
                let _ = io::stdin().read_line(&mut g);
                let tags = parse_csv(&g);
                print!("  是否置顶精选? [y/N]: ");
                io::stdout().flush().ok();
                let mut p = String::new();
                let _ = io::stdin().read_line(&mut p);
                let pinned = p.trim().eq_ignore_ascii_case("y") || p.trim().eq_ignore_ascii_case("yes");
                create_post(&title, Some(PostMeta { cats, tags, pinned }), false);
                pause();
            }
            "2" => { edit_post(); pause(); }
            "3" => { delete_post(); pause(); }
            "4" => cmd_list(),
            "5" => {
                print!("  提交信息（回车用默认）: ");
                io::stdout().flush().ok();
                let mut m = String::new();
                let _ = io::stdin().read_line(&mut m);
                let msg = if m.trim().is_empty() { "手机发布".to_string() } else { m.trim().to_string() };
                publish(&msg);
                pause();
            }
            "6" => cmd_status(),
            "0" => { println!("再见 👋"); break; }
            _ => continue,
        }
    }
}

struct PostMeta { cats: Vec<String>, tags: Vec<String>, pinned: bool }

fn parse_csv(s: &str) -> Vec<String> {
    s.split(',')
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

fn clear() {
    print!("\x1b[2J\x1b[H");
    io::stdout().flush().ok();
}

fn pause() {
    print!("  按回车继续…");
    io::stdout().flush().ok();
    let mut buf = String::new();
    let _ = io::stdin().read_line(&mut buf);
}

fn today() -> (i64, u32, u32) {
    if let Ok(out) = Command::new("date").arg("+%F").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            let s = s.trim();
            if s.len() == 10 {
                if let (Ok(y), Ok(m), Ok(d)) = (
                    s[0..4].parse::<i64>(), s[5..7].parse::<u32>(), s[8..10].parse::<u32>(),
                ) {
                    return (y, m, d);
                }
            }
        }
    }
    (2026, 8, 23)
}

fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut prev_space = false;
    for ch in s.trim().chars() {
        if ch.is_whitespace() {
            if !prev_space && !out.is_empty() { out.push('-'); }
            prev_space = true;
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    out.trim_end_matches('-').to_string()
}

fn repo_dir() -> Result<PathBuf, String> {
    let cur = std::env::current_dir().map_err(|e| e.to_string())?;
    let mut p = cur.as_path();
    loop {
        if p.join("_posts").is_dir() && p.join(".git").is_dir() {
            return Ok(p.to_path_buf());
        }
        match p.parent() {
            Some(parent) => p = parent,
            None => return Err(REPO_HINT.to_string()),
        }
    }
}

fn collect_posts(repo: &Path) -> Vec<PathBuf> {
    let posts_dir = repo.join("_posts");
    let mut files = Vec::new();
    if let Ok(rd) = fs::read_dir(&posts_dir) {
        for e in rd.flatten() {
            let path = e.path();
            if path.extension().map_or(false, |x| x == "md") {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

fn read_title(path: &Path) -> String {
    if let Ok(content) = fs::read_to_string(path) {
        for line in content.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("title:") {
                return rest.trim().trim_matches('"').trim_matches('\'').to_string();
            }
        }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            return stem.replace('-', " ");
        }
    }
    "<未命名>".to_string()
}

fn write_post_file(repo: &Path, filename: &str, content: &str) -> io::Result<PathBuf> {
    let posts_dir = repo.join("_posts");
    fs::create_dir_all(&posts_dir)?;
    let path = posts_dir.join(filename);
    fs::write(&path, content)?;
    Ok(path)
}

fn create_post(title: &str, meta: Option<PostMeta>, auto_cats: bool) {
    let repo = match repo_dir() {
        Ok(r) => r,
        Err(e) => { eprintln!("✘ {e}"); return; }
    };
    let (y, m, d) = today();
    let date_str = format!("{y:04}-{m:02}-{d:02}");
    let slug = slugify(title);
    let base = format!("{date_str}-{slug}");

    let mut path = repo.join("_posts").join(format!("{base}.md"));
    let mut n = 2;
    while path.exists() {
        path = repo.join("_posts").join(format!("{base}-{n}.md"));
        n += 1;
    }

    let (cats, tags, pinned) = match meta {
        Some(m) => (m.cats, m.tags, m.pinned),
        None => (vec!["随笔".to_string()], Vec::new(), false),
    };

    println!();
    println!("  标题: {title}");
    println!("  请输入正文，每行一个回车；");
    println!("  输入单行 . 或 Ctrl-D 结束：");
    println!("  ----------------------------------------");
    let mut body_lines: Vec<String> = Vec::new();
    loop {
        print!("  | ");
        io::stdout().flush().ok();
        let mut line = String::new();
        match io::stdin().read_line(&mut line) {
            Ok(0) => break,
            Err(_) => break,
            Ok(_) => {
                let line = line.trim_end_matches('\n').trim_end_matches('\r').to_string();
                if line == "." { break; }
                body_lines.push(line);
            }
        }
    }

    let body = body_lines.join("\n");
    let cat_str = cats.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ");
    let tag_str = tags.iter().map(|t| format!("\"{t}\"")).collect::<Vec<_>>().join(", ");
    let pin_line = if pinned { "\npinned: true" } else { "" };
    let content = format!(
        "---\nlayout: post\ntitle: \"{title}\"\ndate: {date_str}\ncategories: [{cat_str}]\ntags: [{tag_str}]{pin_line}\n---\n\n# {title}\n\n{body}\n"
    );

    let filename = path.file_name().unwrap().to_string_lossy().to_string();
    match write_post_file(&repo, &filename, &content) {
        Ok(p) => {
            println!();
            println!("✔ 已保存: {}", p.display());
            println!("  字数: {} 字", body.replace([' ', '\t', '\n'], "").chars().count());
        }
        Err(e) => eprintln!("✘ 保存失败: {e}"),
    }
}

fn edit_post() {
    let repo = match repo_dir() {
        Ok(r) => r,
        Err(e) => { eprintln!("✘ {e}"); return; }
    };
    let files = collect_posts(&repo);
    if files.is_empty() {
        println!("  还没有文章。");
        return;
    }
    println!("  选择要编辑的文章:");
    for (i, f) in files.iter().enumerate() {
        println!("    {:>2}. {} —— {}", i + 1, read_title(f), f.file_name().unwrap_or_default().to_string_lossy());
    }
    print!("  编号: ");
    io::stdout().flush().ok();
    let mut line = String::new();
    let _ = io::stdin().read_line(&mut line);
    let Ok(idx) = line.trim().parse::<usize>() else { return };
    if idx == 0 || idx > files.len() {
        println!("  无效编号。");
        return;
    }
    let path = files[idx - 1].clone();
    let editor = ["$EDITOR", "vim", "vi", "nano", "vi"]
        .iter()
        .map(|v| v.to_string())
        .find(|e| e.starts_with('$') || which(e));
    let st = if let Some(ed) = editor {
        let ed_actual = if ed.starts_with('$') {
            env::var("EDITOR").unwrap_or_else(|_| "vi".into())
        } else {
            ed
        };
        Command::new(&ed_actual).arg(&path).status()
    } else {
        Err(io::Error::new(io::ErrorKind::NotFound, "no editor"))
    };
    match st {
        Ok(s) if s.success() => println!("✔ 已保存编辑结果。"),
        _ => {
            println!("  （未找到编辑器，改为覆盖正文模式）");
            let content = fs::read_to_string(&path).unwrap_or_default();
            let new_body = overwrite_body(&content);
            let head_end = content.find("\n---\n").map(|i| i + 5).unwrap_or(0);
            let head = content[..head_end.min(content.len())].to_string();
            let ends_ok = head.ends_with("\n\n");
            let mut new = head;
            if !ends_ok { new.push_str("\n\n"); }
            new.push_str(&new_body);
            new.push('\n');
            let _ = fs::write(&path, new);
            println!("✔ 已写入。");
        }
    }
}

fn overwrite_body(content: &str) -> String {
    println!("  旧正文预览（前 6 行）：");
    let body = content.splitn(2, "\n---\n").nth(1).unwrap_or("");
    for (i, l) in body.lines().take(6).enumerate() {
        println!("    {}: {}", i + 1, l);
    }
    println!("  请输入新正文（单行 . 结束）：");
    let mut out = Vec::new();
    loop {
        print!("  | ");
        io::stdout().flush().ok();
        let mut line = String::new();
        let _ = io::stdin().read_line(&mut line);
        let line = line.trim_end_matches('\n').trim_end_matches('\r').to_string();
        if line == "." { break; }
        out.push(line);
    }
    out.join("\n")
}

fn delete_post() {
    let repo = match repo_dir() {
        Ok(r) => r,
        Err(e) => { eprintln!("✘ {e}"); return; }
    };
    let files = collect_posts(&repo);
    if files.is_empty() {
        println!("  还没有文章。");
        return;
    }
    println!("  选择要删除的文章:");
    for (i, f) in files.iter().enumerate() {
        println!("    {:>2}. {} —— {}", i + 1, read_title(f), f.file_name().unwrap_or_default().to_string_lossy());
    }
    print!("  编号（0 取消）: ");
    io::stdout().flush().ok();
    let mut line = String::new();
    let _ = io::stdin().read_line(&mut line);
    let Ok(idx) = line.trim().parse::<usize>() else { return };
    if idx == 0 || idx > files.len() { return; }
    let path = files[idx - 1].clone();
    print!("  确认删除「{}」? [y/N]: ", read_title(&path));
    io::stdout().flush().ok();
    let mut confirm = String::new();
    let _ = io::stdin().read_line(&mut confirm);
    if confirm.trim().eq_ignore_ascii_case("y") || confirm.trim().eq_ignore_ascii_case("yes") {
        match fs::remove_file(&path) {
            Ok(_) => println!("✔ 已删除。"),
            Err(e) => eprintln!("✘ 删除失败: {e}"),
        }
    } else {
        println!("  已取消。");
    }
}

fn cmd_list() {
    let repo = match repo_dir() {
        Ok(r) => r,
        Err(e) => { eprintln!("✘ {e}"); return; }
    };
    let files = collect_posts(&repo);
    if files.is_empty() {
        println!("  _posts 下暂无文章。");
        return;
    }
    println!("  _posts 文章（{} 篇）:", files.len());
    for (i, f) in files.iter().enumerate() {
        println!("    {:>2}. {}", i + 1, f.file_name().unwrap_or_default().to_string_lossy());
    }
}

fn cmd_status() {
    let repo = match repo_dir() {
        Ok(r) => r,
        Err(e) => { eprintln!("✘ {e}"); return; }
    };
    println!("  仓库: {}", repo.display());
    if let Ok(out) = Command::new("git").args(["log", "-1", "--oneline"]).output() {
        if out.status.success() {
            println!("  最近提交: {}", String::from_utf8_lossy(&out.stdout).trim());
        }
    }
    if let Ok(out) = Command::new("git").args(["status", "--short"]).output() {
        let s = String::from_utf8_lossy(&out.stdout);
        println!("  未提交改动: {}", if s.trim().is_empty() { "无".into() } else { s.lines().count().to_string() + " 项" });
    }
    println!("  线上地址: https://jerry-hang.blog");
    println!("  文章数: {}", collect_posts(&repo).len());
}

fn publish(msg: &str) {
    let repo = match repo_dir() {
        Ok(r) => r,
        Err(e) => { eprintln!("✘ {e}"); return; }
    };
    let ctl = repo.join("target/release/blog_ctl");
    println!("==> 构建 posts.json");
    if ctl.exists() {
        let _ = Command::new(&ctl).arg("build").status();
    } else {
        let _ = Command::new("cargo").args(["run", "--release", "--", "build"]).current_dir(&repo).status();
    }
    println!("==> git add .");
    if !run_git(&repo, &["add", "."]) { return; }
    println!("==> git commit -m {msg}");
    if !run_git(&repo, &["commit", "-m", msg]) {
        println!("  （没有改动可提交，跳过）。");
        return;
    }
    println!("==> git push");
    let st = Command::new("git").arg("push").current_dir(&repo).status();
    match st {
        Ok(s) if s.success() => {
            println!();
            println!("✔ 发布成功！网站将在 1-2 分钟更新:");
            println!("  https://jerry-hang.blog");
        }
        _ => eprintln!("✘ push 失败，请检查 SSH 密钥（ssh -T git@github.com 可测试）。"),
    }
}

fn run_git(repo: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .args(args)
        .current_dir(repo)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn which(name: &str) -> bool {
    Command::new("command")
        .args(["-v", name])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
