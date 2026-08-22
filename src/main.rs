//! blog_ctl —— 轻量级博客文章管理工具
//!
//! 纯标准库实现，不依赖任何第三方 crate（尤其是 git2）。
//! 所有 git 操作都通过 std::process::Command 调用系统 git 命令。

use std::env;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const POSTS_DIR: &str = "_posts";

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
    println!("  blog_ctl push \"提交信息\"   依次执行 git add . / git commit / git push");
}

/// 生成新文章
fn cmd_new(title: &str) {
    // 1. 确保 _posts 目录存在
    fs::create_dir_all(POSTS_DIR).expect("无法创建 _posts 目录");

    // 2. 组装文件名: YYYY-MM-DD-标题.md
    let (y, m, d) = today();
    let date_str = format!("{y:04}-{m:02}-{d:02}");
    let slug = slugify(title);
    let base = format!("{date_str}-{slug}");

    // 3. 同名文件已存在时自动加序号，避免覆盖
    let mut path = Path::new(POSTS_DIR).join(format!("{base}.md"));
    let mut n = 2;
    while path.exists() {
        path = Path::new(POSTS_DIR).join(format!("{base}-{n}.md"));
        n += 1;
    }

    // 4. 写入带 Jekyll front-matter 的文章模板
    let content = format!(
        "---\n\
         layout: post\n\
         title: \"{title}\"\n\
         date: {date_str}\n\
         categories: [blog]\n\
         tags: []\n\
         ---\n\n\
         # {title}\n\n\
         在这里开始写正文……\n"
    );
    fs::write(&path, content).expect("写入文章文件失败");

    println!("✔ 已创建文章: {}", path.display());
    println!("  用编辑器打开它开始写作吧。");
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

/// git add . + git commit + git push
fn cmd_push(message: &str) {
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

    // 首次推送（尚无 upstream）时自动补 -u origin <当前分支>
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

    // push 使用继承的 stdin/stdout/stderr 运行：
    // 第一次推送时 git 才能在终端交互式提示输入 GitHub 用户名和 PAT。
    let arg_refs: Vec<&str> = push_args.iter().map(String::as_str).collect();
    if !run_git_interactive(&arg_refs) {
        eprintln!("✘ git push 失败，请检查远程地址与认证配置（见上方 git 输出）。");
        std::process::exit(1);
    }

    println!("✔ 已成功推送到远程仓库。");
}

/// 调用系统 git 并透传输出，返回是否成功
fn run_git(args: &[&str]) -> bool {
    git_output(args).0
}

/// 调用系统 git，透传输出并同时返回 (是否成功, 完整输出文本)
fn git_output(args: &[&str]) -> (bool, String) {
    let output = Command::new("git").args(args).output();
    match output {
        Ok(out) => {
            let mut text = String::new();
            if !out.stdout.is_empty() {
                let s = String::from_utf8_lossy(&out.stdout);
                print!("{s}");
                text.push_str(&s);
            }
            if !out.stderr.is_empty() {
                let s = String::from_utf8_lossy(&out.stderr);
                eprint!("{s}");
                text.push_str(&s);
            }
            (out.status.success(), text)
        }
        Err(e) => {
            eprintln!("无法执行 git: {e}（请确认已安装 git）");
            (false, String::new())
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

/// 当前分支是否已设置 upstream（跟踪远程分支）
fn has_upstream() -> bool {
    Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 以继承的 stdio 运行 git（用于 push：允许 git 在终端交互式提示输入凭证）
fn run_git_interactive(args: &[&str]) -> bool {
    match Command::new("git").args(args).status() {
        Ok(st) => st.success(),
        Err(e) => {
            eprintln!("无法执行 git: {e}（请确认已安装 git）");
            false
        }
    }
}

/// 取今天日期 (年, 月, 日)。
/// 标准库没有时区支持（SystemTime 是 UTC），所以优先调用系统 `date +%F`
/// 获取本地时区日期；若 date 不可用则回退到 UTC 计算。
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
    // 回退：按 UTC 计算（很少触发，只在 date 命令缺失时）
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
    let doe = (z - era * 146097) as u64; // 儒略日内天数 [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
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
