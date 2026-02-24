use notify::RecommendedWatcher;
use notify::RecursiveMode;
use notify_debouncer_full::{DebounceEventResult, Debouncer, FileIdMap, new_debouncer};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

static DEBOUNCER: Mutex<Option<Debouncer<RecommendedWatcher, FileIdMap>>> = Mutex::new(None);

/// Starts watching a folder for new files matching the given extensions, emitting "new-file" events.
pub fn start_watching(app: &AppHandle, folder: &str, extensions: &str) -> Result<(), String> {
    stop_watching();

    let folder = folder.to_string();
    let app_handle = app.clone();
    let exts: Vec<String> = extensions
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();

    let (tx, rx) = std::sync::mpsc::channel();

    let mut debouncer = new_debouncer(
        Duration::from_secs(1),
        None,
        move |result: DebounceEventResult| {
            if let Ok(events) = result {
                let _ = tx.send(events);
            }
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watch(Path::new(&folder), RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    // 后台线程处理去重后的事件
    std::thread::spawn(move || {
        for events in rx {
            for event in events {
                if matches!(event.kind, notify::EventKind::Create(_)) {
                    for path in &event.paths {
                        if let Some(ext) = path.extension() {
                            let ext_lower = ext.to_ascii_lowercase().to_string_lossy().to_string();
                            if exts.contains(&ext_lower) {
                                let file_path = path.to_string_lossy().to_string();
                                let file_name = path
                                    .file_name()
                                    .unwrap_or_default()
                                    .to_string_lossy()
                                    .to_string();
                                let app = app_handle.clone();

                                // 每个文件独立线程等待写入完成
                                std::thread::spawn(move || {
                                    if !wait_for_stable(&file_path, 30) {
                                        return;
                                    }
                                    let _ = app.emit(
                                        "new-file",
                                        serde_json::json!({
                                            "path": file_path,
                                            "name": file_name,
                                        }),
                                    );
                                });
                            }
                        }
                    }
                }
            }
        }
    });

    let mut guard = DEBOUNCER.lock().map_err(|e| e.to_string())?;
    *guard = Some(debouncer);

    Ok(())
}

/// Stops the active folder watcher, if any.
pub fn stop_watching() {
    if let Ok(mut guard) = DEBOUNCER.lock() {
        *guard = None;
    }
}

/// 轮询文件大小，连续 2 次间隔 1 秒大小不变则认为写入完成
/// max_wait_secs 为最大等待秒数，超时返回 false
fn wait_for_stable(path: &str, max_wait_secs: u32) -> bool {
    let p = Path::new(path);
    let mut last_size: Option<u64> = None;
    let mut stable_count = 0u32;

    for _ in 0..max_wait_secs {
        std::thread::sleep(std::time::Duration::from_secs(1));
        let current_size = std::fs::metadata(p).map(|m| m.len()).ok();
        if current_size == last_size && current_size.is_some() && current_size != Some(0) {
            stable_count += 1;
            if stable_count >= 2 {
                return true;
            }
        } else {
            stable_count = 0;
        }
        last_size = current_size;
    }
    false
}
