use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio::fs as async_fs;

#[derive(Debug, Serialize, Deserialize)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameTask {
    pub path: String,
    pub new_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    pub path: String,
    pub new_name: Option<String>,
    pub error: Option<String>,
}

/// Lists files in a folder, optionally filtered by comma-separated extensions.
/// Uses async tokio I/O to avoid blocking the Tauri IPC thread.
pub async fn scan_folder(folder: &str, extensions: &str) -> Result<Vec<FileInfo>> {
    let dir = Path::new(folder);
    let mut files = Vec::new();
    let exts: Vec<String> = extensions
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();

    let mut read_dir = async_fs::read_dir(dir).await?;
    while let Some(entry) = read_dir.next_entry().await? {
        let file_name = entry.file_name();
        let name_str = file_name.to_string_lossy();

        // Skip hidden files early
        if name_str.starts_with('.') {
            continue;
        }

        // Filter by extension BEFORE doing any metadata/stat call
        let path = entry.path();
        let ext_match = match path.extension() {
            Some(ext) => {
                let ext_lower = ext.to_ascii_lowercase().to_string_lossy().to_string();
                exts.is_empty() || exts.contains(&ext_lower)
            }
            None => exts.is_empty(),
        };
        if !ext_match {
            continue;
        }

        // Only now check if it's a file (this is the stat call)
        let ft = entry.file_type().await?;
        if !ft.is_file() {
            continue;
        }

        files.push(FileInfo {
            path: path.to_string_lossy().to_string(),
            name: name_str.to_string(),
        });
    }

    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

/// 解决文件名冲突：如果目标已存在，自动追加 -1, -2, ... 后缀
fn resolve_conflict(parent: &Path, name: &str) -> std::path::PathBuf {
    let dst = parent.join(name);
    if !dst.exists() {
        return dst;
    }

    let path = Path::new(name);
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    for i in 1..=999 {
        let candidate = parent.join(format!("{}-{}{}", stem, i, ext));
        if !candidate.exists() {
            return candidate;
        }
    }
    // 极端情况 fallback
    parent.join(format!("{}-dup{}", stem, ext))
}

/// Renames files in batch, resolving name conflicts with numeric suffixes.
pub fn rename_files(tasks: &[RenameTask]) -> Vec<RenameResult> {
    tasks
        .iter()
        .map(|task| {
            let result = do_rename(task);
            match result {
                Ok(final_name) => RenameResult {
                    path: task.path.clone(),
                    new_name: Some(final_name),
                    error: None,
                },
                Err(e) => RenameResult {
                    path: task.path.clone(),
                    new_name: None,
                    error: Some(e.to_string()),
                },
            }
        })
        .collect()
}

fn do_rename(task: &RenameTask) -> Result<String> {
    let src = Path::new(&task.path);
    if !src.exists() {
        anyhow::bail!("源文件不存在: {}", task.path);
    }
    let parent = src
        .parent()
        .ok_or_else(|| anyhow::anyhow!("无法获取父目录"))?;
    let dst = resolve_conflict(parent, &task.new_name);
    let final_name = dst
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    std::fs::rename(src, &dst)?;
    Ok(final_name)
}

/// 根据文件扩展名返回分类子目录名
fn category_subfolder(filename: &str) -> &'static str {
    let ext = Path::new(filename)
        .extension()
        .map(|e| e.to_ascii_lowercase().to_string_lossy().to_string())
        .unwrap_or_default();
    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "heic" | "webp" | "tiff" | "gif" | "bmp" | "svg" => "Images",
        "md" | "txt" | "docx" | "doc" | "rtf" | "pptx" | "xlsx" | "xls" => "Documents",
        "pdf" => "PDFs",
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" => "Archives",
        _ => "",
    }
}

/// Moves a file to a destination folder with a new name, falling back to copy+delete across filesystems.
pub fn move_and_rename(
    src_path: &str,
    dest_folder: &str,
    new_name: &str,
    auto_categorize: bool,
) -> Result<String> {
    let src = Path::new(src_path);
    let mut dest = std::path::PathBuf::from(dest_folder);

    if auto_categorize {
        let sub = category_subfolder(new_name);
        if !sub.is_empty() {
            dest = dest.join(sub);
        }
    }

    // 确保目标目录存在
    std::fs::create_dir_all(&dest)?;

    let dst = resolve_conflict(&dest, new_name);
    let final_name = dst
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // 先尝试 rename（同一文件系统下很快）
    // 如果跨文件系统会失败，则 copy + delete
    if std::fs::rename(src, &dst).is_err() {
        std::fs::copy(src, &dst)?;
        std::fs::remove_file(src)?;
    }

    Ok(final_name)
}
