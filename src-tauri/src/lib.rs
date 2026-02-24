mod autostart;
mod config;
mod llm;
mod ocr;
mod pdf;
mod renamer;
mod scanner;
mod service;
#[cfg(test)]
mod test_ocr;
mod watcher;

use config::{AppConfig, load_config};
use renamer::{FileInfo, RenameResult, RenameTask};
use std::sync::Mutex;
use tauri::Manager;

struct TrayState(Mutex<Option<tauri::tray::TrayIcon>>);

#[tauri::command]
fn get_config() -> AppConfig {
    load_config()
}

#[tauri::command]
fn save_config(config: AppConfig) -> Result<(), String> {
    config::save_config(&config).map_err(|e| e.to_string())
}

#[tauri::command]
fn scan_folder(path: String, extensions: String) -> Result<Vec<FileInfo>, String> {
    renamer::scan_folder(&path, &extensions).map_err(|e| e.to_string())
}

#[tauri::command]
fn extract_file_text(path: String) -> Result<String, String> {
    extract_file_content_inner(&path).map_err(|e| e.to_string())
}

fn extract_file_content_inner(path: &str) -> anyhow::Result<String> {
    let ext = std::path::Path::new(path)
        .extension()
        .map(|e| e.to_ascii_lowercase().to_string_lossy().to_string())
        .unwrap_or_default();

    match ext.as_str() {
        "pdf" => {
            // 先尝试文本提取，文本太少则 fallback 到 OCR（扫描版 PDF）
            let text = pdf::extract_text(path).unwrap_or_default();
            if text.trim().len() < 50 {
                match ocr::ocr_from_pdf(path) {
                    Ok(ocr_text) if !ocr_text.trim().is_empty() => Ok(ocr_text),
                    _ => {
                        if text.trim().is_empty() {
                            anyhow::bail!("无法提取文本，可能是扫描版或加密 PDF")
                        }
                        Ok(text)
                    }
                }
            } else {
                Ok(text)
            }
        }
        "docx" | "pptx" | "xlsx" | "xls" | "txt" | "md" | "markdown" => pdf::extract_text(path),
        "jpg" | "jpeg" | "png" | "heic" | "webp" | "tiff" => {
            let ocr_text = ocr::ocr_from_file(path).unwrap_or_default();
            let p = std::path::Path::new(path);
            let name = p.file_name().unwrap_or_default().to_string_lossy();
            let meta = std::fs::metadata(p)?;
            let size_kb = meta.len() / 1024;
            let modified = meta
                .modified()
                .map(|t| {
                    let dt: chrono::DateTime<chrono::Local> = t.into();
                    dt.format("%Y-%m-%d").to_string()
                })
                .unwrap_or_default();

            // EXIF 元数据
            let exif_info = read_exif_info(p);

            let mut info = format!(
                "文件名: {}\n文件类型: {}\n文件大小: {}KB\n修改日期: {}",
                name, ext, size_kb, modified
            );
            if let Some(ref exif) = exif_info {
                if let Some(ref dt) = exif.datetime {
                    info.push_str(&format!("\n拍摄时间: {}", dt));
                }
                if let Some(ref cam) = exif.camera {
                    info.push_str(&format!("\n相机: {}", cam));
                }
            }
            if !ocr_text.trim().is_empty() {
                info.push_str(&format!("\n\nOCR识别文字:\n{}", ocr_text));
            }
            Ok(info)
        }
        _ => {
            let p = std::path::Path::new(path);
            let name = p.file_name().unwrap_or_default().to_string_lossy();
            let meta = std::fs::metadata(p)?;
            let size_kb = meta.len() / 1024;
            let modified = meta
                .modified()
                .map(|t| {
                    let dt: chrono::DateTime<chrono::Local> = t.into();
                    dt.format("%Y-%m-%d").to_string()
                })
                .unwrap_or_default();
            Ok(format!(
                "文件名: {}\n文件类型: {}\n文件大小: {}KB\n修改日期: {}",
                name, ext, size_kb, modified
            ))
        }
    }
}

#[tauri::command]
async fn generate_filename(
    text: String,
    config: AppConfig,
    file_path: Option<String>,
) -> Result<String, String> {
    let context = file_path.as_deref().map(collect_file_context);

    // 如果 VLM 已启用且文件是图片，优先走 VLM 多模态
    if config.vlm_enabled
        && let Some(ref path) = file_path
    {
        let ext = std::path::Path::new(path)
            .extension()
            .map(|e| e.to_ascii_lowercase().to_string_lossy().to_string())
            .unwrap_or_default();
        if matches!(
            ext.as_str(),
            "jpg" | "jpeg" | "png" | "heic" | "webp" | "tiff"
        ) {
            // VLM failure falls back to LLM below
            if let Ok(name) = try_vlm_filename(path, &ext, &config, context.as_ref()).await {
                return Ok(name);
            }
        }
    }

    llm::generate_filename(&text, &config, context.as_ref())
        .await
        .map_err(|e| e.to_string())
}

async fn try_vlm_filename(
    path: &str,
    ext: &str,
    config: &AppConfig,
    context: Option<&llm::FileContext>,
) -> Result<String, String> {
    let image_data = std::fs::read(path).map_err(|e| format!("读取图片失败: {}", e))?;
    use base64::Engine;
    let image_base64 = base64::engine::general_purpose::STANDARD.encode(&image_data);
    let mime = match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "heic" => "image/heic",
        "webp" => "image/webp",
        "tiff" => "image/tiff",
        _ => "image/jpeg",
    };
    llm::generate_filename_vlm(&image_base64, mime, config, context)
        .await
        .map_err(|e| e.to_string())
}

fn collect_file_context(path: &str) -> llm::FileContext {
    let p = std::path::Path::new(path);
    let original_name = p
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let parent_dir = p
        .parent()
        .and_then(|d| d.file_name())
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let sibling_names = get_sibling_names(p, 20);
    let (file_size, modified_at) = match std::fs::metadata(p) {
        Ok(meta) => {
            let size = format_file_size(meta.len());
            let modified = meta
                .modified()
                .map(|t| {
                    let dt: chrono::DateTime<chrono::Local> = t.into();
                    dt.format("%Y-%m-%d").to_string()
                })
                .unwrap_or_default();
            (size, modified)
        }
        Err(_) => (String::new(), String::new()),
    };
    llm::FileContext {
        original_name,
        parent_dir,
        sibling_names,
        modified_at,
        file_size,
    }
}

fn get_sibling_names(path: &std::path::Path, limit: usize) -> Vec<String> {
    let parent = path.parent().unwrap_or(std::path::Path::new("."));
    let current = path.file_name();
    std::fs::read_dir(parent)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name();
            Some(name.as_os_str()) != current
                && e.path().is_file()
                && !e.file_name().to_string_lossy().starts_with('.')
        })
        .take(limit)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect()
}

fn format_file_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{}B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.0}KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

#[tauri::command]
async fn generate_names_stream(
    paths: Vec<String>,
    config: AppConfig,
    on_event: tauri::ipc::Channel<llm::StreamEvent>,
) -> Result<(), String> {
    for path_str in &paths {
        let file_name = std::path::Path::new(path_str)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        let _ = on_event.send(llm::StreamEvent::Thinking {
            file_name: file_name.clone(),
        });

        // Extract text
        let text = match extract_file_content_inner(path_str) {
            Ok(t) => t,
            Err(e) => {
                let _ = on_event.send(llm::StreamEvent::Error {
                    file_name,
                    message: e.to_string(),
                });
                continue;
            }
        };

        let context = collect_file_context(path_str);
        let prompt = llm::build_prompt_public(&text, &config, Some(&context));

        // Stream LLM call
        let result = match config.provider.as_str() {
            "openai" => llm::call_openai_stream(&prompt, &config, &file_name, &on_event).await,
            _ => llm::call_ollama_stream(&prompt, &config, &file_name, &on_event).await,
        };

        match result {
            Ok(raw) => {
                let ext = std::path::Path::new(&file_name)
                    .extension()
                    .map(|e| format!(".{}", e.to_string_lossy()));
                let cleaned = llm::clean_filename(&raw, ext.as_deref());
                if cleaned.is_empty() {
                    let _ = on_event.send(llm::StreamEvent::Error {
                        file_name,
                        message: "AI 返回了空文件名".to_string(),
                    });
                } else {
                    let _ = on_event.send(llm::StreamEvent::Done {
                        file_name,
                        suggested: cleaned,
                    });
                }
            }
            Err(e) => {
                let _ = on_event.send(llm::StreamEvent::Error {
                    file_name,
                    message: e.to_string(),
                });
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn rename_files(tasks: Vec<RenameTask>) -> Vec<RenameResult> {
    renamer::rename_files(&tasks)
}

#[tauri::command]
fn move_and_rename(
    src_path: String,
    dest_folder: String,
    new_name: String,
    auto_categorize: bool,
) -> Result<String, String> {
    renamer::move_and_rename(&src_path, &dest_folder, &new_name, auto_categorize)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn test_connection(config: AppConfig) -> Result<String, String> {
    llm::test_connection(&config)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_history() -> Result<Vec<config::HistoryEntry>, String> {
    Ok(config::load_history())
}

#[tauri::command]
fn add_history(entry: config::HistoryEntry) -> Result<(), String> {
    config::add_history(entry).map_err(|e| e.to_string())
}

#[tauri::command]
fn undo_rename(id: u64) -> Result<config::HistoryEntry, String> {
    config::undo_rename(id).map_err(|e| e.to_string())
}

#[tauri::command]
fn start_watch(app: tauri::AppHandle, folder: String, extensions: String) -> Result<(), String> {
    watcher::start_watching(&app, &folder, &extensions)
}

#[tauri::command]
fn stop_watch() -> Result<(), String> {
    watcher::stop_watching();
    Ok(())
}

#[tauri::command]
fn set_badge_count(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    let state = app.state::<TrayState>();
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(tray) = guard.as_ref() {
        let title = if count > 0 {
            format!("{}", count)
        } else {
            String::new()
        };
        tray.set_title(Some(&title)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    autostart::set_autostart(enabled)
}

#[tauri::command]
fn is_autostart_enabled() -> bool {
    autostart::is_enabled()
}

struct ExifInfo {
    datetime: Option<String>,
    camera: Option<String>,
}

fn read_exif_info(path: &std::path::Path) -> Option<ExifInfo> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file);
    let exif = exif::Reader::new().read_from_container(&mut reader).ok()?;

    let datetime = exif
        .get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)
        .map(|f| f.display_value().to_string());
    let camera = exif
        .get_field(exif::Tag::Model, exif::In::PRIMARY)
        .map(|f| f.display_value().to_string());

    Some(ExifInfo { datetime, camera })
}

/// Initializes and runs the Tauri application with tray, plugins, and event handlers.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            scan_folder,
            extract_file_text,
            generate_filename,
            generate_names_stream,
            rename_files,
            move_and_rename,
            test_connection,
            get_history,
            add_history,
            undo_rename,
            start_watch,
            stop_watch,
            set_badge_count,
            set_autostart,
            is_autostart_enabled,
            scanner::scan_paths,
        ])
        .setup(|app| {
            app.manage(TrayState(Mutex::new(None)));
            // macOS: 不显示在 Dock，只在状态栏
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // macOS: 应用毛玻璃效果
            #[cfg(target_os = "macos")]
            {
                let window = app.get_webview_window("main").unwrap();
                window_vibrancy::apply_vibrancy(
                    &window,
                    window_vibrancy::NSVisualEffectMaterial::HeaderView,
                    None,
                    None,
                )
                .expect("apply vibrancy");
            }

            // 右键菜单
            let show_i =
                tauri::menu::MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let quit_i = tauri::menu::MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&show_i, &quit_i])?;

            // 托盘图标（优先用专用 tray 图标，fallback 到 app 图标）
            let icon = {
                let tray_path = app
                    .path()
                    .resource_dir()
                    .map(|d| d.join("icons/tray-2.png"))
                    .ok()
                    .and_then(|p| tauri::image::Image::from_path(&p).ok());
                tray_path.unwrap_or_else(|| app.default_window_icon().cloned().unwrap())
            };
            let tray = tauri::tray::TrayIconBuilder::new()
                .icon(icon)
                .icon_as_template(true)
                .tooltip("Fyla")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // 存储 tray 到 state
            {
                let state = app.state::<TrayState>();
                *state.0.lock().unwrap() = Some(tray);
            }

            // 注册 Finder 右键服务（NSServices）
            service::init(app.handle());

            // 启动时如果配置了 watch 文件夹，自动开始监听
            let config = load_config();
            if !config.watch_folder.is_empty() {
                let handle = app.handle().clone();
                let folder = config.watch_folder.clone();
                let exts = config.watch_extensions.clone();
                std::thread::spawn(move || {
                    let _ = watcher::start_watching(&handle, &folder, &exts);
                });
            }

            Ok(())
        })
        // 关闭窗口时隐藏而不是退出
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // 防止所有窗口关闭后进程退出，但允许主动 app.exit() 退出
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event
                && code.is_none()
            {
                api.prevent_exit();
            }
        });
}
