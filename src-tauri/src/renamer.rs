use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;

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
pub fn scan_folder(folder: &str, extensions: &str) -> Result<Vec<FileInfo>> {
    let dir = Path::new(folder);
    let mut files = Vec::new();
    let exts: Vec<String> = extensions
        .split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();

    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_file()
            && let Some(ext) = path.extension()
        {
            let ext_lower = ext.to_ascii_lowercase().to_string_lossy().to_string();
            if exts.is_empty() || exts.contains(&ext_lower) {
                files.push(FileInfo {
                    path: path.to_string_lossy().to_string(),
                    name: path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string(),
                });
            }
        }
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

/// Moves a file to a destination folder with a new name, falling back to copy+delete across filesystems.
pub fn move_and_rename(src_path: &str, dest_folder: &str, new_name: &str) -> Result<String> {
    let src = Path::new(src_path);
    let dest = Path::new(dest_folder);
    let dst = resolve_conflict(dest, new_name);
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
