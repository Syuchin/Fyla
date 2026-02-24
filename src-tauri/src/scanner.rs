use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::fs as async_fs;

const SUPPORTED_EXT: &[&str] = &[
    "pdf", "docx", "pptx", "xlsx", "xls", "txt", "md", "jpg", "jpeg", "png", "heic", "webp", "tiff",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedFile {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub size: u64,
}

#[tauri::command]
pub async fn scan_paths(paths: Vec<String>, max_depth: usize) -> Vec<ScannedFile> {
    let mut results = Vec::new();
    for path_str in paths {
        let p = PathBuf::from(&path_str);
        match async_fs::metadata(&p).await {
            Ok(meta) if meta.is_file() => {
                if let Some(f) = try_make_scanned_fast(&p) {
                    let size = meta.len();
                    results.push(ScannedFile { size, ..f });
                }
            }
            Ok(meta) if meta.is_dir() => {
                scan_dir_recursive(&p, max_depth, 0, &mut results).await;
            }
            _ => {}
        }
    }
    results
}

/// Recursively scan a directory using async tokio::fs, up to max_depth levels.
/// Filters by extension and skips hidden files BEFORE reading metadata.
async fn scan_dir_recursive(
    dir: &Path,
    max_depth: usize,
    current_depth: usize,
    results: &mut Vec<ScannedFile>,
) {
    let mut read_dir = match async_fs::read_dir(dir).await {
        Ok(rd) => rd,
        Err(_) => return,
    };

    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let file_name = entry.file_name();
        let name_str = file_name.to_string_lossy();

        // Skip hidden files/dirs early
        if name_str.starts_with('.') {
            continue;
        }

        let path = entry.path();
        let ft = match entry.file_type().await {
            Ok(ft) => ft,
            Err(_) => continue,
        };

        if ft.is_file() {
            // Check extension BEFORE metadata
            if let Some(f) = try_make_scanned_fast(&path) {
                // Only read size for matching files
                let size = match entry.metadata().await {
                    Ok(m) => m.len(),
                    Err(_) => 0,
                };
                results.push(ScannedFile { size, ..f });
            }
        } else if ft.is_dir() && current_depth < max_depth {
            Box::pin(scan_dir_recursive(&path, max_depth, current_depth + 1, results)).await;
        }
    }
}

/// Quick check: extension + hidden filter only, no metadata/stat call.
/// Returns a ScannedFile with size=0 (caller fills in the real size).
fn try_make_scanned_fast(path: &Path) -> Option<ScannedFile> {
    let ext = path.extension()?.to_str()?.to_lowercase();
    if !SUPPORTED_EXT.contains(&ext.as_str()) {
        return None;
    }
    let name = path.file_name()?.to_string_lossy().into_owned();
    if name.starts_with('.') {
        return None;
    }
    Some(ScannedFile {
        path: path.to_string_lossy().into_owned(),
        name,
        ext,
        size: 0,
    })
}
