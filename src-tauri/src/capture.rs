// Saving web pages as PDF in the desktop app, by printing them with the
// Chrome, Edge or Chromium already installed on the computer.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::ipc::Response;

use crate::office::hide_window;

const TIMEOUT: Duration = Duration::from_secs(120);

static COUNTER: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub async fn capture_web(url: String) -> Result<Response, String> {
    let url = check_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || capture(&url))
        .await
        .map_err(|e| e.to_string())?
        .map(Response::new)
}

/// Only http and https addresses, so a page can't be pointed at local files.
fn check_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("Enter a full web address, starting with https://.".into());
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) || url.len() > 4096 {
        return Err("That web address isn't valid.".into());
    }
    Ok(url.to_string())
}

fn capture(url: &str) -> Result<Vec<u8>, String> {
    let browser = find_browser().ok_or(
        "Saving web pages needs Google Chrome, Microsoft Edge or Chromium. Install one, then try again.",
    )?;
    let work = std::env::temp_dir().join(format!(
        "pagerig-capture-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = run(&browser, &work, url);
    let _ = std::fs::remove_dir_all(&work);
    result
}

fn run(browser: &PathBuf, work: &PathBuf, url: &str) -> Result<Vec<u8>, String> {
    std::fs::create_dir_all(work).map_err(|e| e.to_string())?;
    let out = work.join("page.pdf");
    let mut cmd = Command::new(browser);
    // A profile of its own, so this works while the browser is open.
    cmd.arg("--headless")
        .args([
            "--disable-gpu",
            "--hide-scrollbars",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--mute-audio",
            "--no-pdf-header-footer",
            "--run-all-compositor-stages-before-draw",
            "--virtual-time-budget=15000",
        ])
        .arg(format!(
            "--user-data-dir={}",
            work.join("profile").display()
        ))
        .arg(format!("--print-to-pdf={}", out.display()))
        .arg(url);
    if std::env::var_os("PAGERIG_CHROMIUM_NO_SANDBOX").is_some() {
        cmd.arg("--no-sandbox");
    }
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    hide_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Couldn't start the browser: {e}"))?;
    let started = Instant::now();
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if started.elapsed() > TIMEOUT {
            let _ = child.kill();
            return Err("The page took too long to load.".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    match std::fs::read(&out) {
        Ok(pdf) if pdf.starts_with(b"%PDF") => Ok(pdf),
        _ => Err("The browser couldn't load this page.".into()),
    }
}

/// Chrome, Edge, Chromium or Brave, from PAGERIG_CHROMIUM or where installers put them.
fn find_browser() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("PAGERIG_CHROMIUM").map(PathBuf::from) {
        if p.is_file() {
            return Some(p);
        }
    }
    let mut known: Vec<PathBuf> = vec![];
    if cfg!(target_os = "macos") {
        for app in [
            "Google Chrome",
            "Microsoft Edge",
            "Chromium",
            "Brave Browser",
        ] {
            known.push(format!("/Applications/{app}.app/Contents/MacOS/{app}").into());
        }
    } else if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(dir) = std::env::var_os(var) {
                let dir = PathBuf::from(dir);
                known.push(dir.join("Google/Chrome/Application/chrome.exe"));
                known.push(dir.join("Microsoft/Edge/Application/msedge.exe"));
                known.push(dir.join("Chromium/Application/chrome.exe"));
            }
        }
    } else if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for exe in [
                "google-chrome",
                "google-chrome-stable",
                "chromium",
                "chromium-browser",
                "microsoft-edge",
                "brave-browser",
            ] {
                known.push(dir.join(exe));
            }
        }
    }
    known.into_iter().find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_addresses() {
        assert!(check_url("https://example.com/a b").is_err());
        assert!(check_url("file:///etc/passwd").is_err());
        assert!(check_url("javascript:alert(1)").is_err());
        assert_eq!(
            check_url(" https://example.com ").unwrap(),
            "https://example.com"
        );
    }

    #[test]
    fn captures_when_a_browser_is_installed() {
        if find_browser().is_none() {
            return;
        }
        std::env::set_var("PAGERIG_CHROMIUM_NO_SANDBOX", "1");
        let pdf = capture("data:text/html,<h1>Hello</h1>");
        // data: URLs aren't accepted by check_url, but capture itself can print them.
        assert!(pdf.unwrap().starts_with(b"%PDF"));
    }
}
