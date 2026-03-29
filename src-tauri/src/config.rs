use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

static HISTORY_LOCK: Mutex<()> = Mutex::new(());
static PAPER_HISTORY_LOCK: Mutex<()> = Mutex::new(());
static PAPER_CHAT_SESSION_LOCK: Mutex<()> = Mutex::new(());
const DEFAULT_PAPER_REVIEW_PROMPT_TEMPLATE: &str =
    include_str!("../../src/lib/paper-review-prompt-template.txt");

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
    pub paper_embedding_provider: String,
    pub paper_embedding_ollama_url: String,
    pub paper_embedding_ollama_model: String,
    pub paper_embedding_openai_key: String,
    pub paper_embedding_openai_model: String,
    pub paper_embedding_openai_base_url: String,
    pub paper_fulltext_token_limit: u32,
    pub paper_archive_root: String,
    pub paper_review_prompt_template: String,
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
fn default_paper_embedding_provider() -> String {
    "auto".into()
}
fn default_paper_embedding_ollama_model() -> String {
    "nomic-embed-text".into()
}
fn default_paper_embedding_openai_model() -> String {
    "text-embedding-3-small".into()
}
fn default_paper_fulltext_token_limit() -> u32 {
    60_000
}
fn default_paper_archive_root() -> String {
    "/Users/chenghaoyang/Local/papers".into()
}
pub fn default_paper_review_prompt_template() -> String {
    DEFAULT_PAPER_REVIEW_PROMPT_TEMPLATE.trim().to_string()
}

fn normalize_paper_review_prompt_template_value(value: &str) -> String {
    if value.trim().is_empty() {
        default_paper_review_prompt_template()
    } else {
        value.to_string()
    }
}

impl AppConfig {
    fn normalized(mut self) -> Self {
        self.paper_review_prompt_template =
            normalize_paper_review_prompt_template_value(&self.paper_review_prompt_template);
        self
    }
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
            paper_embedding_provider: default_paper_embedding_provider(),
            paper_embedding_ollama_url: "http://localhost:11434".into(),
            paper_embedding_ollama_model: default_paper_embedding_ollama_model(),
            paper_embedding_openai_key: String::new(),
            paper_embedding_openai_model: default_paper_embedding_openai_model(),
            paper_embedding_openai_base_url: default_openai_base_url(),
            paper_fulltext_token_limit: default_paper_fulltext_token_limit(),
            paper_archive_root: default_paper_archive_root(),
            paper_review_prompt_template: default_paper_review_prompt_template(),
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
        serde_json::from_str::<AppConfig>(&data)
            .unwrap_or_default()
            .normalized()
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
    let data = serde_json::to_string_pretty(&config.clone().normalized())?;
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PaperChatCitation {
    pub id: String,
    pub source: String,
    pub label: String,
    pub excerpt: String,
    pub page: Option<u32>,
    pub heading: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PaperChatAttachment {
    pub kind: String,
    pub label: String,
    pub id: Option<String>,
    pub path: Option<String>,
    pub name: Option<String>,
    pub mime: Option<String>,
    pub size_bytes: Option<u64>,
    pub origin: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PaperChatMessageEntry {
    pub id: String,
    pub role: String,
    pub content: String,
    pub citations: Vec<PaperChatCitation>,
    pub attachments: Vec<PaperChatAttachment>,
    pub created_at: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PaperChatSessionEntry {
    pub paper_key: String,
    pub session_id: String,
    pub source_path: String,
    pub saved_path: String,
    pub title: String,
    pub messages: Vec<PaperChatMessageEntry>,
    pub created_at: String,
    pub updated_at: String,
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

fn paper_chat_sessions_path() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("fyla").join("paper-chat-sessions.json")
}

pub fn load_paper_chat_sessions() -> Vec<PaperChatSessionEntry> {
    let path = paper_chat_sessions_path();
    if let Ok(data) = fs::read_to_string(&path) {
        serde_json::from_str::<Vec<PaperChatSessionEntry>>(&data)
            .unwrap_or_default()
            .into_iter()
            .map(normalize_paper_chat_session_entry)
            .collect()
    } else {
        Vec::new()
    }
}

pub fn save_paper_chat_sessions(sessions: &[PaperChatSessionEntry]) -> Result<()> {
    let path = paper_chat_sessions_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_string_pretty(sessions)?;
    fs::write(path, data)?;
    Ok(())
}

pub fn get_paper_chat_session(session_id: &str) -> Option<PaperChatSessionEntry> {
    load_paper_chat_sessions()
        .into_iter()
        .find(|entry| entry.session_id == session_id)
}

pub fn list_paper_chat_sessions_by_paper(paper_key: &str) -> Vec<PaperChatSessionEntry> {
    let mut sessions = load_paper_chat_sessions()
        .into_iter()
        .filter(|entry| entry.paper_key == paper_key)
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| right.created_at.cmp(&left.created_at))
    });
    sessions
}

pub fn get_latest_paper_chat_session_by_paper(paper_key: &str) -> Option<PaperChatSessionEntry> {
    list_paper_chat_sessions_by_paper(paper_key)
        .into_iter()
        .next()
}

pub fn upsert_paper_chat_session(entry: PaperChatSessionEntry) -> Result<PaperChatSessionEntry> {
    let _lock = PAPER_CHAT_SESSION_LOCK.lock().unwrap();
    let mut sessions = load_paper_chat_sessions();
    let entry = normalize_paper_chat_session_entry(entry);
    sessions.retain(|item| item.session_id != entry.session_id);
    sessions.insert(0, entry.clone());
    sessions.truncate(120);
    save_paper_chat_sessions(&sessions)?;
    Ok(entry)
}

fn normalize_paper_chat_session_entry(mut entry: PaperChatSessionEntry) -> PaperChatSessionEntry {
    if entry.paper_key.trim().is_empty() {
        entry.paper_key = entry.session_id.clone();
    }
    if entry.created_at.trim().is_empty() {
        entry.created_at = if entry.updated_at.trim().is_empty() {
            String::new()
        } else {
            entry.updated_at.clone()
        };
    }
    if entry.updated_at.trim().is_empty() {
        entry.updated_at = entry.created_at.clone();
    }
    entry
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_paper_review_prompt_is_available() {
        let template = default_paper_review_prompt_template();
        assert!(template.contains("## Part A"));
        assert!(template.contains("## Part B"));
    }

    #[test]
    fn blank_paper_review_prompt_falls_back_to_default() {
        let config = AppConfig {
            paper_review_prompt_template: "   \n".into(),
            ..AppConfig::default()
        }
        .normalized();

        assert_eq!(
            config.paper_review_prompt_template,
            default_paper_review_prompt_template()
        );
    }
}
