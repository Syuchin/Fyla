use serde::Serialize;
use std::path::Path;
use walkdir::WalkDir;

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
pub fn scan_paths(paths: Vec<String>, max_depth: usize) -> Vec<ScannedFile> {
    let mut results = Vec::new();
    for path_str in paths {
        let p = Path::new(&path_str);
        if p.is_file() {
            if let Some(f) = try_make_scanned(p) {
                results.push(f);
            }
        } else if p.is_dir() {
            for entry in WalkDir::new(p)
                .max_depth(max_depth)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
            {
                if let Some(f) = try_make_scanned(entry.path()) {
                    results.push(f);
                }
            }
        }
    }
    results
}

fn try_make_scanned(path: &Path) -> Option<ScannedFile> {
    let ext = path.extension()?.to_str()?.to_lowercase();
    if !SUPPORTED_EXT.contains(&ext.as_str()) {
        return None;
    }
    let name = path.file_name()?.to_string_lossy().into_owned();
    // skip hidden files
    if name.starts_with('.') {
        return None;
    }
    let size = path.metadata().ok()?.len();
    Some(ScannedFile {
        path: path.to_string_lossy().into_owned(),
        name,
        ext,
        size,
    })
}
