mod capture;
mod office;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    leave_install_folder();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            office::convert_office,
            capture::capture_web
        ])
        .run(tauri::generate_context!())
        .expect("error while running PageRig");
}

/// Start-menu and desktop shortcuts start PageRig inside its install folder, and
/// every process it starts (the WebView2 browser, LibreOffice, headless Chrome)
/// inherits that working folder. Windows won't delete a folder that is some
/// process's working folder, so a helper that outlives the app would block the
/// uninstaller. Work from the temp folder instead.
#[cfg(windows)]
fn leave_install_folder() {
    let _ = std::env::set_current_dir(std::env::temp_dir());
}

#[cfg(not(windows))]
fn leave_install_folder() {}
