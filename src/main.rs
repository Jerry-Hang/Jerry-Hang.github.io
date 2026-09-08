mod base64;
mod db;
mod server;
mod sha256;

use std::env;
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if let Some(first) = args.first() {
        if first == "--hash" {
            let pw = args.get(1).cloned().unwrap_or_default();
            println!("{}", sha256::sha256_hex(pw.as_bytes()));
            return;
        }
    }

    let home = env::var("HOME").unwrap_or_else(|_| "/data/data/com.termux/files/home".to_string());
    let root = env::var("BLOG_ROOT").unwrap_or_else(|_| format!("{home}/DSH_work/blog_ctl"));
    let config_path =
        env::var("BLOG_CONFIG").unwrap_or_else(|_| format!("{home}/DSH_work/blog_server_rust/config.toml"));
    let db_path = env::var("BLOG_DB").unwrap_or_else(|_| format!("{home}/DSH_work/blog_server_rust/blog.db"));
    let ext_addr = env::var("BLOG_EXT_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
    let local_addr = env::var("BLOG_LOCAL_ADDR").unwrap_or_else(|_| "127.0.0.1:8081".to_string());
    let max_concurrent: usize = env::var("BLOG_MAX_CONCURRENT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2400);
    let workers: usize = env::var("BLOG_WORKERS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4);
    let cpus = env::var("BLOG_CPUS").unwrap_or_else(|_| "0-3".to_string());
    apply_cpu_affinity(&cpus);

    let cfg = match server::load_config(&config_path, PathBuf::from(&root)) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("配置错误: {e}");
            eprintln!("请编辑 {config_path} 设置 username 和 password_sha256。");
            std::process::exit(1);
        }
    };

    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(workers)
        .enable_all()
        .thread_name("blog-async")
        .build()
        .expect("failed to build tokio runtime");

    if let Err(e) = rt.block_on(server::run(cfg, &ext_addr, &local_addr, max_concurrent, &db_path)) {
        eprintln!("服务器启动失败: {e}");
        std::process::exit(1);
    }
}

fn apply_cpu_affinity(spec: &str) {
    let mut set: libc::cpu_set_t = unsafe { std::mem::zeroed() };
    unsafe { libc::CPU_ZERO(&mut set); }
    let mut list: Vec<usize> = Vec::new();
    for part in spec.split(',') {
        if let Some((a, b)) = part.split_once('-') {
            if let (Ok(a), Ok(b)) = (a.parse::<usize>(), b.parse::<usize>()) {
                for i in a..=b {
                    list.push(i);
                }
            }
        } else if let Ok(a) = part.parse::<usize>() {
            list.push(a);
        }
    }
    for &c in &list {
        unsafe { libc::CPU_SET(c, &mut set); }
    }
    let r = unsafe { libc::sched_setaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &set) };
    if r != 0 {
        eprintln!("warning: sched_setaffinity({}) failed: {}", spec, std::io::Error::last_os_error());
    } else {
        eprintln!("cpu affinity set to {spec}");
    }
}
