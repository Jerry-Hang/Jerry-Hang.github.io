//! 跨平台抽象层。
//!
//! 原项目只针对 Android/Termux（Linux）编写，用到三处平台专属能力：
//!   * `sched_setaffinity`   CPU 绑核
//!   * `/proc/self/status`   读取 VmRSS 做内存熔断
//!   * `/proc/self/stat`     读取进程 CPU 时间
//!
//! 本模块把它们抽象出来，Unix 走原路径，Windows 走对应的 Win32 API，
//! 使同一个二进制源码可以在 Termux 与 Windows 上编译运行。

// ============================================================================
// Unix / Android (Termux)
// ============================================================================
#[cfg(unix)]
mod imp {
    // parse_cpu_list 定义在本模块之外（供三个平台分支共用），
    // 必须显式引入，否则这里看不到它。
    use super::parse_cpu_list;
    use std::fs;

    /// 把当前进程绑定到指定 CPU 列表。
    /// `spec` 支持 `"0-3"`、`"0,2,4"`、`"0-3,8"` 这类写法。
    pub fn apply_cpu_affinity(spec: &str) {
        let mut set: libc::cpu_set_t = unsafe { std::mem::zeroed() };
        unsafe {
            libc::CPU_ZERO(&mut set);
        }
        for c in parse_cpu_list(spec) {
            unsafe {
                libc::CPU_SET(c, &mut set);
            }
        }
        let r = unsafe { libc::sched_setaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &set) };
        if r != 0 {
            eprintln!(
                "warning: sched_setaffinity({}) failed: {}",
                spec,
                std::io::Error::last_os_error()
            );
        } else {
            eprintln!("cpu affinity set to {spec}");
        }
    }

    /// 读取进程常驻内存，单位 KB。
    pub fn read_vmrss_kb() -> Option<u64> {
        let status = fs::read_to_string("/proc/self/status").ok()?;
        for line in status.lines() {
            if let Some(rest) = line.strip_prefix("VmRSS:") {
                let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
                return Some(kb);
            }
        }
        None
    }

    /// 读取进程累计 CPU 时间，单位：时钟滴答（Linux 通常 100/秒）。
    pub fn read_cpu_ticks() -> u64 {
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
}

// ============================================================================
// Windows
// ============================================================================
#[cfg(windows)]
mod imp {
    use super::parse_cpu_list;
    use windows_sys::Win32::Foundation::{FILETIME, FALSE};
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetProcessTimes, SetProcessAffinityMask,
    };

    /// 把当前进程绑定到指定 CPU 列表。
    /// `spec` 语义与 Unix 版一致（`"0-3"` / `"0,2,4"`）。
    pub fn apply_cpu_affinity(spec: &str) {
        let list = parse_cpu_list(spec);
        if list.is_empty() {
            return;
        }
        let mut mask: usize = 0;
        for &c in &list {
            // Windows 的亲和掩码是 usize 位图，一个处理器组最多 64 位。
            // 超出位宽的核无法用该 API 指定，忽略并提示。
            if c >= usize::BITS as usize {
                eprintln!(
                    "warning: cpu {c} 超出当前处理器组范围（最多 {} 个逻辑核），已忽略",
                    usize::BITS
                );
                continue;
            }
            mask |= 1usize << c;
        }
        if mask == 0 {
            eprintln!("warning: cpu affinity spec {spec} 未产生有效掩码，跳过");
            return;
        }
        let ok = unsafe {
            // 第一个参数必须是当前进程句柄（伪句柄 -1 即可），
            // 不是 ALL_PROCESSOR_GROUPS —— 那是给线程组亲和用的。
            SetProcessAffinityMask(GetCurrentProcess(), mask)
        };
        if ok == FALSE {
            eprintln!(
                "warning: SetProcessAffinityMask({spec}) failed: {}",
                std::io::Error::last_os_error()
            );
        } else {
            eprintln!("cpu affinity set to {spec} (Windows mask 0x{mask:x})");
        }
    }

    /// 读取进程工作集，单位 KB（对应 Linux 的 VmRSS）。
    pub fn read_vmrss_kb() -> Option<u64> {
        unsafe {
            let mut pmc: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
            pmc.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            let ok = GetProcessMemoryInfo(
                GetCurrentProcess(),
                &mut pmc,
                std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            );
            if ok == FALSE {
                return None;
            }
            // WorkingSetSize 单位是字节，换算成 KB 与 Unix 版对齐
            Some((pmc.WorkingSetSize as u64) / 1024)
        }
    }

    /// 读取进程累计 CPU 时间，单位换算为「时钟滴答」以保持与 Unix 版一致
    /// （1 滴答 = 10ms，即 100 滴答/秒）。
    pub fn read_cpu_ticks() -> u64 {
        unsafe {
            let mut creation: FILETIME = std::mem::zeroed();
            let mut exit: FILETIME = std::mem::zeroed();
            let mut kernel: FILETIME = std::mem::zeroed();
            let mut user: FILETIME = std::mem::zeroed();
            let ok = GetProcessTimes(
                GetCurrentProcess(),
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            );
            if ok == FALSE {
                return 0;
            }
            // FILETIME 由两个 u32 组成，拼成 u64 后单位是 100 纳秒。
            // 转成 10ms 滴答：100ns × 100_000 = 10ms
            fn to_u64(ft: &FILETIME) -> u64 {
                ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64)
            }
            (to_u64(&kernel) + to_u64(&user)) / 100_000
        }
    }
}

// ============================================================================
// 其它平台（BSD/macOS 等）：优雅降级，不阻止编译
// ============================================================================
#[cfg(not(any(unix, windows)))]
mod imp {
    pub fn apply_cpu_affinity(_spec: &str) {
        eprintln!("note: 当前平台不支持 CPU 绑核，已跳过");
    }
    pub fn read_vmrss_kb() -> Option<u64> {
        None
    }
    pub fn read_cpu_ticks() -> u64 {
        0
    }
}

pub use imp::{apply_cpu_affinity, read_cpu_ticks, read_vmrss_kb};

/// 解析 `"0-3"`、`"0,2,4"`、`"0-3,8"` 形式的 CPU 列表。
fn parse_cpu_list(spec: &str) -> Vec<usize> {
    let mut list: Vec<usize> = Vec::new();
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some((a, b)) = part.split_once('-') {
            if let (Ok(a), Ok(b)) = (a.trim().parse::<usize>(), b.trim().parse::<usize>()) {
                if a <= b {
                    for i in a..=b {
                        list.push(i);
                    }
                }
            }
        } else if let Ok(a) = part.parse::<usize>() {
            list.push(a);
        }
    }
    list
}

/// 生成 16 字节随机 token 的十六进制串（会话 Cookie 用）。
///
/// 优先用操作系统 CSPRNG；失败时退回「时间 + 地址熵」的兜底方案，
/// 保证在任何平台上都不会 panic。
pub fn random_token() -> String {
    let mut buf = [0u8; 16];
    if getrandom::getrandom(&mut buf).is_ok() {
        return buf.iter().map(|b| format!("{:02x}", b)).collect();
    }
    // 兜底：时间戳 + 栈地址 + 计数器混合
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static CTR: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let probe = &buf as *const _ as u64;
    let c = CTR.fetch_add(1, Ordering::Relaxed);
    let mut seed = nanos ^ probe.rotate_left(17) ^ c.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    for b in buf.iter_mut() {
        // xorshift64
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        *b = (seed & 0xff) as u8;
    }
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ranges() {
        assert_eq!(parse_cpu_list("0-3"), vec![0, 1, 2, 3]);
        assert_eq!(parse_cpu_list("0,2,4"), vec![0, 2, 4]);
        assert_eq!(parse_cpu_list("0-1,3"), vec![0, 1, 3]);
        assert_eq!(parse_cpu_list(""), Vec::<usize>::new());
        assert_eq!(parse_cpu_list("bad"), Vec::<usize>::new());
    }

    #[test]
    fn token_is_32_hex_chars() {
        let t = random_token();
        assert_eq!(t.len(), 32, "token 应为 16 字节的十六进制串");
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(random_token(), random_token(), "两次生成不应相同");
    }
}
