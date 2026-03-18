use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

static HISTORY_LOCK: Mutex<()> = Mutex::new(());
static PAPER_HISTORY_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub provider: String,
    pub ollama_url: String,
    pub ollama_model: String,
    pub openai_key: String,
    pub openai_model: String,
    pub openai_base_url: String,
    pub custom_rules: String,
    pub naming_style: String,
    pub include_date: bool,
    pub watch_folder: String,
    pub watch_extensions: String,
    pub name_template: String,
    pub auto_categorize: bool,
    // VLM 设置
    pub vlm_enabled: bool,
    pub vlm_same_as_llm: bool,
    pub vlm_base_url: String,
    pub vlm_key: String,
    pub vlm_model: String,
    pub paper_provider: String,
    pub paper_ollama_url: String,
    pub paper_ollama_model: String,
    pub paper_openai_key: String,
    pub paper_openai_model: String,
    pub paper_openai_base_url: String,
    pub paper_archive_root: String,
}

fn default_naming_style() -> String {
    "kebab-case".into()
}
fn default_watch_extensions() -> String {
    "pdf".into()
}
fn default_openai_base_url() -> String {
    "https://api.openai.com/v1".into()
}
fn default_paper_provider() -> String {
    "openai".into()
}
fn default_paper_archive_root() -> String {
    "/Users/chenghaoyang/Local/papers".into()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            provider: "ollama".into(),
            ollama_url: "http://localhost:11434".into(),
            ollama_model: "llama3.2".into(),
            openai_key: String::new(),
            openai_model: "gpt-4o-mini".into(),
            openai_base_url: default_openai_base_url(),
            custom_rules: String::new(),
            naming_style: default_naming_style(),
            include_date: false,
            watch_folder: String::new(),
            watch_extensions: default_watch_extensions(),
            name_template: String::new(),
            auto_categorize: false,
            vlm_enabled: false,
            vlm_same_as_llm: true,
            vlm_base_url: String::new(),
            vlm_key: String::new(),
            vlm_model: String::new(),
            paper_provider: default_paper_provider(),
            paper_ollama_url: "http://localhost:11434".into(),
            paper_ollama_model: "llama3.2".into(),
            paper_openai_key: String::new(),
            paper_openai_model: "gpt-4.1".into(),
            paper_openai_base_url: default_openai_base_url(),
            paper_archive_root: default_paper_archive_root(),
        }
    }
}

fn config_path() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("fyla").join("config.json")
}

/// Loads config from disk, returning defaults if the file doesn't exist.
pub fn load_config() -> AppConfig {
    let path = config_path();
    if let Ok(data) = fs::read_to_string(&path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        AppConfig::default()
    }
}

/// Persists config to disk as JSON, creating parent directories if needed.
pub fn save_config(config: &AppConfig) -> Result<()> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_string_pretty(config)?;
    fs::write(path, data)?;
    Ok(())
}

// --- 历史记录 ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: u64,
    pub original_path: String,
    pub original_name: String,
    pub new_path: String,
    pub new_name: String,
    pub timestamp: String,
}

fn history_path() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("fyla").join("history.json")
}

/// Loads rename history from disk, returning an empty list on failure.
pub fn load_history() -> Vec<HistoryEntry> {
    let path = history_path();
    if let Ok(data) = fs::read_to_string(&path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        Vec::new()
    }
}

/// Writes the full history list to disk as JSON.
pub fn save_history(history: &[HistoryEntry]) -> Result<()> {
    let path = history_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_string_pretty(history)?;
    fs::write(path, data)?;
    Ok(())
}

/// Prepends a history entry and truncates to 200 records.
pub fn add_history(entry: HistoryEntry) -> Result<()> {
    let _lock = HISTORY_LOCK.lock().unwrap();
    let mut history = load_history();
    history.insert(0, entry);
    history.truncate(200);
    save_history(&history)
}

/// Reverts a rename by moving the file back to its original path.
pub fn undo_rename(id: u64) -> Result<HistoryEntry> {
    let _lock = HISTORY_LOCK.lock().unwrap();
    let mut history = load_history();
    let idx = history
        .iter()
        .position(|h| h.id == id)
        .ok_or_else(|| anyhow::anyhow!("未找到该历史记录"))?;
    let entry = history.remove(idx);

    let src = std::path::Path::new(&entry.new_path);
    let dst = std::path::Path::new(&entry.original_path);

    if !src.exists() {
        return Err(anyhow::anyhow!("文件不存在: {}", entry.new_path));
    }
    if dst.exists() {
        return Err(anyhow::anyhow!("原路径已有文件: {}", entry.original_path));
    }

    // 先 rename，跨文件系统则 copy+delete
    if std::fs::rename(src, dst).is_err() {
        std::fs::copy(src, dst)?;
        std::fs::remove_file(src)?;
    }

    save_history(&history)?;
    Ok(entry)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PaperHistoryEntry {
    pub id: String,
    pub source_path: String,
    pub original_name: String,
    pub saved_path: String,
    pub title: String,
    pub year: String,
    pub venue: String,
    pub slug: String,
    pub summary: String,
    pub elapsed_ms: u64,
    pub char_count: usize,
    pub extractor: String,
    pub extraction_warning: Option<String>,
    pub completed_at: String,
}

fn paper_history_path() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("fyla").join("paper-history.json")
}

pub fn load_paper_history() -> Vec<PaperHistoryEntry> {
    let path = paper_history_path();
    if let Ok(data) = fs::read_to_string(&path) {
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        Vec::new()
    }
}

pub fn save_paper_history(history: &[PaperHistoryEntry]) -> Result<()> {
    let path = paper_history_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_string_pretty(history)?;
    fs::write(path, data)?;
    Ok(())
}

pub fn add_paper_history(entry: PaperHistoryEntry) -> Result<Vec<PaperHistoryEntry>> {
    let _lock = PAPER_HISTORY_LOCK.lock().unwrap();
    let mut history = load_paper_history();
    history.retain(|item| item.saved_path != entry.saved_path);
    history.insert(0, entry);
    history.truncate(80);
    save_paper_history(&history)?;
    Ok(history)
}

pub fn remove_paper_history_item(id: &str) -> Result<Vec<PaperHistoryEntry>> {
    let _lock = PAPER_HISTORY_LOCK.lock().unwrap();
    let mut history = load_paper_history();
    history.retain(|item| item.id != id);
    save_paper_history(&history)?;
    Ok(history)
}

pub fn clear_paper_history() -> Result<()> {
    let _lock = PAPER_HISTORY_LOCK.lock().unwrap();
    save_paper_history(&[])
}
