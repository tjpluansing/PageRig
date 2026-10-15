// Saving web pages as PDF in the desktop app, by printing them with the
// Chrome, Edge or Chromium already installed on the computer.

use std::io::{ErrorKind, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
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
    let profile = work.join("profile");
    let mut cmd = Command::new(browser);
    // A profile of its own, so this works while the browser is open. The
    // browser is driven over its DevTools protocol rather than with
    // --print-to-pdf, which hangs in some Chrome releases.
    cmd.arg("--headless")
        .args([
            "--disable-gpu",
            "--hide-scrollbars",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--mute-audio",
            "--disable-dev-shm-usage",
            "--password-store=basic",
            "--use-mock-keychain",
            "--disable-background-networking",
            "--disable-sync",
            "--disable-component-update",
            "--disable-default-apps",
            // A free port, which the browser writes to DevToolsActivePort in the profile.
            "--remote-debugging-port=0",
        ])
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("about:blank");
    if std::env::var_os("PAGERIG_CHROMIUM_NO_SANDBOX").is_some() {
        cmd.arg("--no-sandbox");
    }
    // Run from the work folder, so a helper that outlives us never holds the install folder open.
    cmd.current_dir(work);
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    hide_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Couldn't start the browser: {e}"))?;
    let deadline = Instant::now() + TIMEOUT;
    let result = print(&mut child, &profile, url, deadline);
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn print(
    child: &mut Child,
    profile: &Path,
    url: &str,
    deadline: Instant,
) -> Result<Vec<u8>, String> {
    let (port, path) = loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            return Err("The browser didn't start.".into());
        }
        if Instant::now() > deadline {
            return Err("The browser didn't start in time.".into());
        }
        std::thread::sleep(Duration::from_millis(100));
        let text = std::fs::read_to_string(profile.join("DevToolsActivePort")).unwrap_or_default();
        let mut lines = text.lines();
        if let (Some(port), Some(path)) = (lines.next(), lines.next()) {
            if let Ok(port) = port.trim().parse::<u16>() {
                break (port, path.trim().to_string());
            }
        }
    };
    let mut cdp = Cdp::connect(port, &path, deadline)?;
    let target = cdp.call("Target.createTarget", json!({ "url": "about:blank" }), None)?;
    let target_id = target["targetId"].as_str().unwrap_or_default().to_string();
    let attached = cdp.call(
        "Target.attachToTarget",
        json!({ "targetId": target_id, "flatten": true }),
        None,
    )?;
    let session = attached["sessionId"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    cdp.call("Page.enable", json!({}), Some(&session))?;
    let nav = cdp.call("Page.navigate", json!({ "url": url }), Some(&session))?;
    if nav.get("errorText").is_some() {
        return Err("The browser couldn't load this page.".into());
    }
    cdp.wait_for("Page.loadEventFired", &session)?;
    // A moment for scripts and lazy images after the page has loaded.
    std::thread::sleep(Duration::from_secs(1));
    let printed = cdp.call(
        "Page.printToPDF",
        json!({ "printBackground": true, "preferCSSPageSize": true, "displayHeaderFooter": false }),
        Some(&session),
    )?;
    let pdf = base64_decode(printed["data"].as_str().unwrap_or_default())
        .ok_or("The browser sent back a damaged PDF.")?;
    if !pdf.starts_with(b"%PDF") {
        return Err("The browser couldn't load this page.".into());
    }
    Ok(pdf)
}

/// A small DevTools protocol client: JSON messages over a WebSocket.
struct Cdp {
    stream: TcpStream,
    deadline: Instant,
    next_id: u64,
    events: Vec<(String, String)>,
}

impl Cdp {
    fn connect(port: u16, path: &str, deadline: Instant) -> Result<Self, String> {
        let fail = |e: std::io::Error| format!("Couldn't talk to the browser: {e}");
        let mut stream = TcpStream::connect(("127.0.0.1", port)).map_err(fail)?;
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .map_err(fail)?;
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: cGFnZXJpZy1jYXB0dXJlIQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        .map_err(fail)?;
        let mut cdp = Cdp {
            stream,
            deadline,
            next_id: 1,
            events: vec![],
        };
        let mut head = vec![];
        while !head.ends_with(b"\r\n\r\n") {
            head.push(cdp.read_byte()?);
        }
        if !head.starts_with(b"HTTP/1.1 101") {
            return Err("The browser refused the connection.".into());
        }
        Ok(cdp)
    }

    fn call(
        &mut self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            msg["sessionId"] = json!(session);
        }
        self.send(msg.to_string().as_bytes())?;
        loop {
            let reply = self.receive()?;
            if reply["id"].as_u64() == Some(id) {
                if reply.get("error").is_some() {
                    return Err("The browser couldn't load this page.".into());
                }
                return Ok(reply["result"].clone());
            }
        }
    }

    fn wait_for(&mut self, method: &str, session: &str) -> Result<(), String> {
        loop {
            if let Some(i) = self
                .events
                .iter()
                .position(|(m, s)| m == method && s == session)
            {
                self.events.remove(i);
                return Ok(());
            }
            self.receive()?;
        }
    }

    /// The next message, keeping any events for wait_for.
    fn receive(&mut self) -> Result<Value, String> {
        let mut data = vec![];
        loop {
            let b0 = self.read_byte()?;
            let b1 = self.read_byte()?;
            let mut len = (b1 & 0x7f) as u64;
            if len == 126 {
                len = u16::from_be_bytes([self.read_byte()?, self.read_byte()?]) as u64;
            } else if len == 127 {
                let mut n = [0u8; 8];
                for b in n.iter_mut() {
                    *b = self.read_byte()?;
                }
                len = u64::from_be_bytes(n);
            }
            let mut payload = vec![0u8; len as usize];
            self.read_exact(&mut payload)?;
            match b0 & 0x0f {
                0x8 => return Err("The browser closed unexpectedly.".into()),
                0x9 => self.frame(0xA, &payload)?,
                0xA => {}
                _ => {
                    data.extend_from_slice(&payload);
                    if b0 & 0x80 != 0 {
                        break;
                    }
                }
            }
        }
        let msg: Value = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
        if let Some(method) = msg["method"].as_str() {
            let session = msg["sessionId"].as_str().unwrap_or_default();
            self.events.push((method.to_string(), session.to_string()));
        }
        Ok(msg)
    }

    fn send(&mut self, payload: &[u8]) -> Result<(), String> {
        self.frame(0x1, payload)
    }

    /// One masked frame, as clients must send.
    fn frame(&mut self, opcode: u8, payload: &[u8]) -> Result<(), String> {
        let mask = [0x50u8, 0x61, 0x67, 0x65];
        let mut out = vec![0x80 | opcode];
        match payload.len() {
            n if n < 126 => out.push(0x80 | n as u8),
            n if n <= 0xffff => {
                out.push(0x80 | 126);
                out.extend_from_slice(&(n as u16).to_be_bytes());
            }
            n => {
                out.push(0x80 | 127);
                out.extend_from_slice(&(n as u64).to_be_bytes());
            }
        }
        out.extend_from_slice(&mask);
        out.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        self.stream
            .write_all(&out)
            .map_err(|e| format!("Couldn't talk to the browser: {e}"))
    }

    fn read_byte(&mut self) -> Result<u8, String> {
        let mut b = [0u8; 1];
        self.read_exact(&mut b)?;
        Ok(b[0])
    }

    fn read_exact(&mut self, buf: &mut [u8]) -> Result<(), String> {
        let mut filled = 0;
        while filled < buf.len() {
            if Instant::now() > self.deadline {
                return Err("The page took too long to load.".into());
            }
            match self.stream.read(&mut buf[filled..]) {
                Ok(0) => return Err("The browser closed unexpectedly.".into()),
                Ok(n) => filled += n,
                Err(e)
                    if matches!(
                        e.kind(),
                        ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                    ) => {}
                Err(e) => return Err(format!("Couldn't talk to the browser: {e}")),
            }
        }
        Ok(())
    }
}

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0);
    for c in text
        .bytes()
        .filter(|&c| c != b'=' && !c.is_ascii_whitespace())
    {
        acc = (acc << 6) | value(c)? as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
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
    fn decodes_base64() {
        assert_eq!(base64_decode("JVBERi0=").unwrap(), b"%PDF-");
        assert_eq!(base64_decode("aGk=").unwrap(), b"hi");
        assert!(base64_decode("a$b=").is_none());
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
