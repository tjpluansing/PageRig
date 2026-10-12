// Office conversion for the desktop app, using the LibreOffice installed on the
// computer. The file arrives as the raw request body, with its name, the
// target format and an optional import filter in headers.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::ipc::{InvokeBody, Request, Response};

const TARGETS: &[&str] = &["pdf", "docx", "pptx"];
const FILTERS: &[&str] = &["writer_pdf_import", "impress_pdf_import"];
const TIMEOUT: Duration = Duration::from_secs(180);

static COUNTER: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub async fn convert_office(request: Request<'_>) -> Result<Response, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the file as raw bytes.".into());
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let name = header("x-name")
        .map(|n| percent_decode(&n))
        .unwrap_or_else(|| "document".into());
    let to = header("x-to").unwrap_or_default();
    if !TARGETS.contains(&to.as_str()) {
        return Err(format!("Can't convert to {to}."));
    }
    let filter = header("x-filter");
    if let Some(f) = &filter {
        if !FILTERS.contains(&f.as_str()) {
            return Err("Unknown import filter.".into());
        }
    }
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || convert(&bytes, &name, &to, filter.as_deref()))
        .await
        .map_err(|e| e.to_string())?
        .map(Response::new)
}

fn convert(bytes: &[u8], name: &str, to: &str, filter: Option<&str>) -> Result<Vec<u8>, String> {
    let soffice = find_soffice().ok_or(
        "Converting Office files needs LibreOffice. Install it from libreoffice.org, then try again.",
    )?;
    let work = std::env::temp_dir().join(format!(
        "pagerig-convert-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = run(&soffice, &work, bytes, name, to, filter);
    let _ = std::fs::remove_dir_all(&work);
    result
}

fn run(
    soffice: &Path,
    work: &Path,
    bytes: &[u8],
    name: &str,
    to: &str,
    filter: Option<&str>,
) -> Result<Vec<u8>, String> {
    let input_dir = work.join("in");
    let output_dir = work.join("out");
    let profile = work.join("profile");
    for dir in [&input_dir, &output_dir, &profile] {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let input = input_dir.join(safe_name(name));
    std::fs::write(&input, bytes).map_err(|e| e.to_string())?;

    let mut cmd = Command::new(soffice);
    // A profile of its own, so this works even while LibreOffice is open.
    cmd.arg(format!("-env:UserInstallation={}", file_url(&profile)))
        .args(["--headless", "--norestore", "--nolockcheck"]);
    if let Some(f) = filter {
        cmd.arg(format!("--infilter={f}"));
    }
    cmd.arg("--convert-to")
        .arg(to)
        .arg("--outdir")
        .arg(&output_dir)
        .arg(&input);
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    hide_window(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Couldn't start LibreOffice: {e}"))?;
    let started = Instant::now();
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if started.elapsed() > TIMEOUT {
            let _ = child.kill();
            return Err("LibreOffice took too long to convert this file.".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    let produced = std::fs::read_dir(&output_dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case(to)));
    match produced {
        Some(path) => std::fs::read(path).map_err(|e| e.to_string()),
        None => Err("LibreOffice couldn't convert this file.".into()),
    }
}

/// Keep only the file name, without anything that could reach outside the work folder.
fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("document");
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || ":*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim_start_matches('.');
    if cleaned.is_empty() {
        "document".into()
    } else {
        cleaned.into()
    }
}

fn file_url(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    let s = s.replace(' ', "%20");
    if s.starts_with('/') {
        format!("file://{s}")
    } else {
        format!("file:///{s}")
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// LibreOffice from PAGERIG_SOFFICE, the PATH, or where its installers put it.
fn find_soffice() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("PAGERIG_SOFFICE").map(PathBuf::from) {
        if p.is_file() {
            return Some(p);
        }
    }
    let exe = if cfg!(windows) {
        "soffice.exe"
    } else {
        "soffice"
    };
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(exe);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let mut known: Vec<PathBuf> = vec![];
    if cfg!(target_os = "macos") {
        known.push("/Applications/LibreOffice.app/Contents/MacOS/soffice".into());
    } else if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(dir) = std::env::var_os(var) {
                known.push(
                    PathBuf::from(dir)
                        .join("LibreOffice")
                        .join("program")
                        .join("soffice.exe"),
                );
            }
        }
    } else {
        known.extend(
            [
                "/usr/bin/soffice",
                "/usr/local/bin/soffice",
                "/opt/libreoffice/program/soffice",
                "/snap/bin/libreoffice",
            ]
            .map(PathBuf::from),
        );
    }
    known.into_iter().find(|p| p.is_file())
}

#[cfg(windows)]
fn hide_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_cmd: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_stay_inside_the_work_folder() {
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("C:\\Users\\a\\report.docx"), "report.docx");
        assert_eq!(safe_name(".hidden"), "hidden");
        assert_eq!(safe_name(""), "document");
    }

    #[test]
    fn converts_with_libreoffice_when_installed() {
        if find_soffice().is_none() {
            return;
        }
        let pdf = convert(b"Hello from PageRig", "note.txt", "pdf", None).unwrap();
        assert!(pdf.starts_with(b"%PDF"));
        let docx = convert(&pdf, "note.pdf", "docx", Some("writer_pdf_import")).unwrap();
        assert!(docx.starts_with(b"PK"));
    }

    #[test]
    fn decodes_names() {
        assert_eq!(percent_decode("Q3%20report%C3%A9.docx"), "Q3 reporté.docx");
        assert_eq!(percent_decode("100%"), "100%");
    }
}
