use crate::config::{
    self, AppConfig, PaperChatAttachment, PaperChatCitation, PaperChatMessageEntry,
    PaperChatSessionEntry,
};
use crate::{embedding, llm, pdf};
use anyhow::{Context, Result, anyhow};
use base64::Engine;
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

const FYLA_CHAT_JSON_MARKER: &str = "<<<FYLA_CHAT_JSON>>>";
const PAPER_CHAT_CACHE_VERSION: u32 = 5;
const CHAT_HISTORY_LIMIT: usize = 16;
const FULLTEXT_HISTORY_LIMIT: usize = 8;
const MAX_CONTEXT_CHARS: usize = 1_800;
const MAX_ANCHOR_CHARS: usize = 72;
const MAX_ANCHOR_CANDIDATES: usize = 12;
const TOP_K_PDF: usize = 6;
const TOP_K_REPORT: usize = 4;
const DEFAULT_FULLTEXT_TOKEN_LIMIT: u32 = 60_000;
const OPENAI_SAFE_TOKEN_LIMIT: u32 = 60_000;
const OLLAMA_SAFE_TOKEN_LIMIT: u32 = 16_000;
const STOPPED_REASON: &str = "__FYLA_PAPER_CHAT_STOPPED__";
const MAX_IMAGES_PER_TURN: usize = 3;

fn paper_chat_cancel_registry() -> &'static Mutex<HashMap<String, watch::Sender<bool>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PaperSelectionContext {
    pub source: String,
    pub text: String,
    pub page: Option<u32>,
    pub heading: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PaperChatImageInput {
    pub id: String,
    pub source: String,
    pub path: Option<String>,
    pub name: String,
    pub mime: String,
    pub size_bytes: Option<u64>,
    pub data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperChatPreparedSession {
    pub paper_key: String,
    pub session_id: String,
    pub source_path: String,
    pub saved_path: String,
    pub title: String,
    pub messages: Vec<PaperChatMessageEntry>,
    pub created_at: String,
    pub updated_at: String,
    pub session_summaries: Vec<PaperChatSessionSummary>,
    pub available_attachments: Vec<PaperChatAttachment>,
    pub pdf_available: bool,
    pub report_available: bool,
    pub pdf_page_count: usize,
    pub report_section_count: usize,
    pub pdf_warning: Option<String>,
    pub report_warning: Option<String>,
    pub cache_prepared: bool,
    pub retrieval_strategy: Option<String>,
    pub token_estimate: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PaperChatSessionSummary {
    pub paper_key: String,
    pub session_id: String,
    pub source_path: String,
    pub saved_path: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: usize,
    pub first_user_message: String,
    pub last_assistant_message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum PaperChatStreamEvent {
    #[serde(rename_all = "camelCase")]
    AnswerStarted {
        session_id: String,
        user_message: PaperChatMessageEntry,
        assistant_message: PaperChatMessageEntry,
    },
    #[serde(rename_all = "camelCase")]
    AnswerDelta {
        session_id: String,
        message_id: String,
        delta: String,
    },
    #[serde(rename_all = "camelCase")]
    AnswerDone {
        session_id: String,
        message_id: String,
        content: String,
        citations: Vec<PaperChatCitation>,
        suggested_questions: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    AnswerStopped {
        session_id: String,
        message_id: String,
        content: String,
    },
    #[serde(rename_all = "camelCase")]
    AnswerError {
        session_id: String,
        message_id: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PaperChatCacheEntry {
    pub paper_key: String,
    pub session_id: String,
    pub source_path: String,
    pub saved_path: String,
    pub title: String,
    pub source_modified_ms: Option<u64>,
    pub report_modified_ms: Option<u64>,
    pub cache_version: u32,
    pub retrieval_strategy: String,
    pub embedding_provider_signature: String,
    pub token_estimate: u32,
    pub pdf_pages: Vec<PaperChatPdfPage>,
    pub report_sections: Vec<PaperChatReportSection>,
    pub pdf_warning: Option<String>,
    pub report_warning: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PaperChatPdfPage {
    pub page: u32,
    pub text: String,
    pub embedding: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PaperChatReportSection {
    pub id: String,
    pub heading: String,
    pub text: String,
    pub embedding: Vec<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Clone)]
struct RetrievedChunk {
    source: String,
    label: String,
    text: String,
    page: Option<u32>,
    heading: Option<String>,
    anchor_text: Option<String>,
    score: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetrievalStrategy {
    Fulltext,
    Embedding,
}

#[derive(Debug, Clone)]
enum PromptContextPayload {
    Fulltext(String),
    Retrieved(Vec<RetrievedChunk>),
}

#[derive(Debug, Default)]
struct ChatStreamAccumulator {
    raw: String,
    sent_len: usize,
}

#[derive(Debug, Default)]
struct ParsedChatPayload {
    answer: String,
    suggested_questions: Vec<String>,
}

impl RetrievalStrategy {
    fn as_str(self) -> &'static str {
        match self {
            Self::Fulltext => "fulltext",
            Self::Embedding => "embedding",
        }
    }
}

pub fn prepare_paper_chat_session(
    source_path: String,
    saved_path: String,
    title: String,
    config: AppConfig,
) -> Result<PaperChatPreparedSession> {
    let paper_key = build_paper_key(&source_path, &saved_path, &title);
    let session = if let Some(existing) = config::get_latest_paper_chat_session_by_paper(&paper_key)
    {
        sync_session_metadata(existing, &source_path, &saved_path, &title)?
    } else {
        let created = create_empty_session_entry(&paper_key, &source_path, &saved_path, &title);
        config::upsert_paper_chat_session(created)?
    };
    build_prepared_session(session, &paper_key, &config)
}

pub fn create_paper_chat_session(
    source_path: String,
    saved_path: String,
    title: String,
    config: AppConfig,
) -> Result<PaperChatPreparedSession> {
    let paper_key = build_paper_key(&source_path, &saved_path, &title);
    let session = create_empty_session_entry(&paper_key, &source_path, &saved_path, &title);
    let session = config::upsert_paper_chat_session(session)?;
    build_prepared_session(session, &paper_key, &config)
}

fn build_prepared_session(
    session: PaperChatSessionEntry,
    paper_key: &str,
    config: &AppConfig,
) -> Result<PaperChatPreparedSession> {
    let has_pdf = is_existing_file(&session.source_path);
    let has_report = is_existing_file(&session.saved_path);
    let report_path_empty = session.saved_path.trim().is_empty();
    let source_modified_ms = file_modified_ms(&session.source_path);
    let report_modified_ms = file_modified_ms(&session.saved_path);
    let cached = read_cache(paper_key)?;
    let cache_prepared = cached
        .as_ref()
        .map(|cache| {
            cache_is_likely_current(
                cache,
                paper_key,
                &session.source_path,
                &session.saved_path,
                source_modified_ms,
                report_modified_ms,
                config,
            )
        })
        .unwrap_or(false);

    Ok(PaperChatPreparedSession {
        paper_key: paper_key.to_string(),
        session_id: session.session_id.clone(),
        source_path: session.source_path.clone(),
        saved_path: session.saved_path.clone(),
        title: session.title.clone(),
        messages: session.messages,
        created_at: session.created_at,
        updated_at: session.updated_at,
        session_summaries: build_session_summaries(paper_key),
        available_attachments: build_available_attachments_for_files(has_pdf, has_report),
        pdf_available: has_pdf,
        report_available: has_report,
        pdf_page_count: cached
            .as_ref()
            .map(|cache| cache.pdf_pages.len())
            .unwrap_or(0),
        report_section_count: cached
            .as_ref()
            .map(|cache| cache.report_sections.len())
            .unwrap_or(0),
        pdf_warning: if has_pdf {
            None
        } else {
            Some("当前论文 PDF 不可用，仅可使用解读报告回答。".into())
        },
        report_warning: if has_report || report_path_empty {
            None
        } else {
            Some("当前解读报告文件不存在。".into())
        },
        cache_prepared,
        retrieval_strategy: cached
            .as_ref()
            .map(|cache| cache.retrieval_strategy.clone())
            .filter(|value| !value.trim().is_empty()),
        token_estimate: cached.as_ref().map(|cache| cache.token_estimate),
    })
}

fn build_session_summaries(paper_key: &str) -> Vec<PaperChatSessionSummary> {
    config::list_paper_chat_sessions_by_paper(paper_key)
        .into_iter()
        .map(|session| PaperChatSessionSummary {
            paper_key: session.paper_key.clone(),
            session_id: session.session_id.clone(),
            source_path: session.source_path.clone(),
            saved_path: session.saved_path.clone(),
            title: session.title.clone(),
            created_at: session.created_at.clone(),
            updated_at: session.updated_at.clone(),
            message_count: session.messages.len(),
            first_user_message: session
                .messages
                .iter()
                .find(|message| message.role == "user" && !message.content.trim().is_empty())
                .map(|message| message.content.clone())
                .unwrap_or_default(),
            last_assistant_message: session
                .messages
                .iter()
                .rev()
                .find(|message| message.role == "assistant" && !message.content.trim().is_empty())
                .map(|message| message.content.clone())
                .unwrap_or_default(),
        })
        .collect()
}

fn create_empty_session_entry(
    paper_key: &str,
    source_path: &str,
    saved_path: &str,
    title: &str,
) -> PaperChatSessionEntry {
    let now = iso_now();
    PaperChatSessionEntry {
        paper_key: paper_key.to_string(),
        session_id: make_session_id(paper_key),
        source_path: source_path.to_string(),
        saved_path: saved_path.to_string(),
        title: title.to_string(),
        messages: Vec::new(),
        created_at: now.clone(),
        updated_at: now,
    }
}

fn sync_session_metadata(
    mut session: PaperChatSessionEntry,
    source_path: &str,
    saved_path: &str,
    title: &str,
) -> Result<PaperChatSessionEntry> {
    let mut changed = false;

    if session.paper_key.trim().is_empty() {
        session.paper_key = build_paper_key(source_path, saved_path, title);
        changed = true;
    }
    if session.created_at.trim().is_empty() {
        session.created_at = session.updated_at.clone();
        changed = true;
    }
    if session.source_path != source_path {
        session.source_path = source_path.to_string();
        changed = true;
    }
    if session.saved_path != saved_path {
        session.saved_path = saved_path.to_string();
        changed = true;
    }
    if session.title != title {
        session.title = title.to_string();
        changed = true;
    }

    if changed {
        config::upsert_paper_chat_session(session)
    } else {
        Ok(session)
    }
}

pub fn get_paper_chat_history(session_id: String) -> Result<Vec<PaperChatMessageEntry>> {
    Ok(config::get_paper_chat_session(&session_id)
        .map(|entry| entry.messages)
        .unwrap_or_default())
}

pub fn clear_paper_chat_session(app: AppHandle, session_id: String) -> Result<()> {
    trigger_stream_stop(&session_id);
    let managed_dir = managed_image_session_dir(&session_id);
    if managed_dir.exists() {
        let _ = std::fs::remove_dir_all(&managed_dir);
    }
    let mut session = config::get_paper_chat_session(&session_id)
        .ok_or_else(|| anyhow!("未找到当前论文聊天会话"))?;
    session.messages.clear();
    session.updated_at = iso_now();
    let session = config::upsert_paper_chat_session(session)?;
    let _ = app.emit("sessionUpdated", &session);
    Ok(())
}

pub fn stop_paper_chat_stream(app: AppHandle, session_id: String) -> Result<()> {
    let _ = app;
    trigger_stream_stop(&session_id);
    Ok(())
}

pub async fn stream_paper_chat_reply(
    app: AppHandle,
    session_id: String,
    question: String,
    attachments: Vec<PaperChatAttachment>,
    images: Vec<PaperChatImageInput>,
    selection_context: Option<PaperSelectionContext>,
    config: AppConfig,
    on_event: tauri::ipc::Channel<PaperChatStreamEvent>,
) -> Result<(), String> {
    stream_paper_chat_reply_inner(
        app,
        session_id,
        question,
        attachments,
        images,
        selection_context,
        config,
        on_event,
    )
    .await
    .map_err(|err| err.to_string())
}

pub async fn retry_paper_chat_turn(
    app: AppHandle,
    session_id: String,
    config: AppConfig,
    on_event: tauri::ipc::Channel<PaperChatStreamEvent>,
) -> Result<(), String> {
    let session = config::get_paper_chat_session(&session_id)
        .ok_or_else(|| "未找到当前论文聊天会话".to_string())?;
    if session
        .messages
        .iter()
        .any(|message| message.status == "streaming")
    {
        return Err("当前仍在生成中，请先停止生成".into());
    }

    let last_user = session
        .messages
        .iter()
        .rev()
        .find(|message| message.role == "user" && !message.content.trim().is_empty())
        .cloned()
        .ok_or_else(|| "当前没有可重试的问题".to_string())?;

    stream_paper_chat_reply_inner(
        app,
        session_id,
        last_user.content,
        last_user.attachments,
        Vec::new(),
        None,
        config,
        on_event,
    )
    .await
    .map_err(|err| err.to_string())
}

async fn stream_paper_chat_reply_inner(
    app: AppHandle,
    session_id: String,
    question: String,
    attachments: Vec<PaperChatAttachment>,
    images: Vec<PaperChatImageInput>,
    selection_context: Option<PaperSelectionContext>,
    config: AppConfig,
    on_event: tauri::ipc::Channel<PaperChatStreamEvent>,
) -> Result<()> {
    let mut cancel_rx = register_stream_cancel(&session_id);
    let mut session = config::get_paper_chat_session(&session_id)
        .ok_or_else(|| anyhow!("未找到当前论文聊天会话"))?;

    let history_for_prompt = session.messages.clone();
    let has_image_inputs = !images.is_empty()
        || attachments.iter().any(|attachment| attachment.kind == "image");
    if has_image_inputs && !config.vlm_enabled {
        return Err(anyhow!("请先在设置中开启 VLM，再向论文聊天附带图片。"));
    }
    let requested_attachments = prepare_requested_attachments(&session_id, attachments, images)
        .await
        .context("准备图片附件失败")?;
    let assistant_attachments = requested_attachments
        .iter()
        .filter(|attachment| attachment.kind != "image")
        .cloned()
        .collect::<Vec<_>>();

    let user_message = PaperChatMessageEntry {
        id: make_message_id("user"),
        role: "user".into(),
        content: question.trim().to_string(),
        citations: Vec::new(),
        attachments: requested_attachments.clone(),
        created_at: iso_now(),
        status: "done".into(),
    };
    let assistant_message = PaperChatMessageEntry {
        id: make_message_id("assistant"),
        role: "assistant".into(),
        content: String::new(),
        citations: Vec::new(),
        attachments: assistant_attachments,
        created_at: iso_now(),
        status: "streaming".into(),
    };

    session.messages.push(user_message.clone());
    session.messages.push(assistant_message.clone());
    trim_session_messages(&mut session.messages);
    session.updated_at = iso_now();
    session = config::upsert_paper_chat_session(session)?;
    let _ = app.emit("sessionUpdated", &session);

    let _ = on_event.send(PaperChatStreamEvent::AnswerStarted {
        session_id: session_id.clone(),
        user_message: user_message.clone(),
        assistant_message: assistant_message.clone(),
    });

    let runtime_config = paper_runtime_config(&config);

    let cache = match ensure_cache(
        &session.paper_key,
        &session.source_path,
        &session.saved_path,
        &session.title,
        &config,
    )
    .await
    {
        Ok(cache) => cache,
        Err(err) => {
            let err_message = err.to_string();
            let mut latest = config::get_paper_chat_session(&session_id)
                .ok_or_else(|| anyhow!("未找到当前论文聊天会话"))?;
            if let Some(message) = latest
                .messages
                .iter_mut()
                .find(|message| message.id == assistant_message.id)
            {
                message.content = err_message.clone();
                message.citations.clear();
                message.status = "error".into();
            }
            latest.updated_at = iso_now();
            latest = config::upsert_paper_chat_session(latest)?;
            let _ = app.emit("sessionUpdated", &latest);
            let _ = on_event.send(PaperChatStreamEvent::AnswerError {
                session_id: session_id.clone(),
                message_id: assistant_message.id.clone(),
                message: err_message.clone(),
            });
            clear_stream_cancel(&session_id);
            return Err(err);
        }
    };

    let selected_attachments = normalize_attachments(requested_attachments.clone(), &cache);
    let prompt_context = match retrieval_strategy_from_cache(&cache) {
        RetrievalStrategy::Fulltext => PromptContextPayload::Fulltext(build_fulltext_context(
            &cache,
            &selected_attachments,
            selection_context.as_ref(),
        )),
        RetrievalStrategy::Embedding => {
            let fallback_to_fulltext = |reason: anyhow::Error| -> Result<PromptContextPayload> {
                let reason_text = reason.to_string();
                if let Some(context) = build_safe_fulltext_context(
                    &cache,
                    &selected_attachments,
                    selection_context.as_ref(),
                    &config,
                ) {
                    eprintln!(
                        "[paper-perf] stream_paper_chat_reply.fallback sessionId={} paperKey={} strategy=fulltext reason={}",
                        session_id,
                        session.paper_key,
                        reason_text
                    );
                    Ok(PromptContextPayload::Fulltext(context))
                } else {
                    Err(reason)
                }
            };

            match embedding::resolve_runtime(&config).await {
                Ok(embedding_runtime) => match retrieve_relevant_chunks(
                    &question,
                    &cache,
                    &selected_attachments,
                    selection_context.as_ref(),
                    &embedding_runtime,
                )
                .await
                {
                    Ok(retrieved_chunks) => PromptContextPayload::Retrieved(retrieved_chunks),
                    Err(err) => match fallback_to_fulltext(err) {
                        Ok(context) => context,
                        Err(err) => return Err(err),
                    },
                },
                Err(err) => match fallback_to_fulltext(err.context("准备 embedding 检索失败")) {
                    Ok(context) => context,
                    Err(err) => return Err(err),
                },
            }
        }
    };
    let image_context = build_turn_image_context(
        &requested_attachments,
        &question,
        &session.title,
        &config,
    )
    .await?;
    let messages = build_chat_messages(
        &session.title,
        &question,
        &prompt_context,
        image_context.as_deref(),
        &history_for_prompt,
        &selected_attachments,
    );

    let mut accumulator = ChatStreamAccumulator::default();
    let raw = call_chat_model_stream(&runtime_config, &messages, &mut cancel_rx, |delta| {
        if let Some(answer_delta) = accumulator.push(delta) {
            let _ = on_event.send(PaperChatStreamEvent::AnswerDelta {
                session_id: session_id.clone(),
                message_id: assistant_message.id.clone(),
                delta: answer_delta,
            });
        }
    })
    .await;

    let result = match raw {
        Ok(full_raw) => {
            let parsed = parse_chat_payload(&full_raw);
            let answer = parsed.answer.trim().to_string();
            let citations = Vec::new();
            let mut latest = config::get_paper_chat_session(&session_id)
                .ok_or_else(|| anyhow!("未找到当前论文聊天会话"))?;

            if let Some(message) = latest
                .messages
                .iter_mut()
                .find(|message| message.id == assistant_message.id)
            {
                message.content = answer.clone();
                message.citations.clear();
                message.status = "done".into();
            }
            latest.updated_at = iso_now();
            latest = config::upsert_paper_chat_session(latest)?;
            let _ = app.emit("sessionUpdated", &latest);

            let _ = on_event.send(PaperChatStreamEvent::AnswerDone {
                session_id: session_id.clone(),
                message_id: assistant_message.id.clone(),
                content: answer,
                citations,
                suggested_questions: parsed.suggested_questions,
            });
            Ok(())
        }
        Err(err) => {
            if is_stream_stopped_error(&err) {
                let mut latest = config::get_paper_chat_session(&session_id)
                    .ok_or_else(|| anyhow!("未找到当前论文聊天会话"))?;
                let mut stopped_content = extract_visible_answer(&accumulator.raw)
                    .trim_end()
                    .to_string();
                if let Some(message) = latest
                    .messages
                    .iter_mut()
                    .find(|message| message.id == assistant_message.id)
                {
                    if stopped_content.is_empty() {
                        stopped_content = message.content.clone();
                    }
                    message.content = stopped_content.clone();
                    if message.status == "streaming" {
                        message.status = "stopped".into();
                    }
                }
                latest.updated_at = iso_now();
                latest = config::upsert_paper_chat_session(latest)?;
                let _ = app.emit("sessionUpdated", &latest);
                let _ = on_event.send(PaperChatStreamEvent::AnswerStopped {
                    session_id: session_id.clone(),
                    message_id: assistant_message.id.clone(),
                    content: stopped_content,
                });
                Ok(())
            } else {
                let mut latest = config::get_paper_chat_session(&session_id)
                    .ok_or_else(|| anyhow!("未找到当前论文聊天会话"))?;
                if let Some(message) = latest
                    .messages
                    .iter_mut()
                    .find(|message| message.id == assistant_message.id)
                {
                    message.content = String::new();
                    message.citations.clear();
                    message.status = "error".into();
                }
                latest.updated_at = iso_now();
                latest = config::upsert_paper_chat_session(latest)?;
                let _ = app.emit("sessionUpdated", &latest);

                let _ = on_event.send(PaperChatStreamEvent::AnswerError {
                    session_id: session_id.clone(),
                    message_id: assistant_message.id.clone(),
                    message: err.to_string(),
                });
                Err(err)
            }
        }
    };

    clear_stream_cancel(&session_id);
    result
}

fn build_paper_key(source_path: &str, saved_path: &str, title: &str) -> String {
    let raw = if !saved_path.trim().is_empty() {
        saved_path.trim()
    } else if !source_path.trim().is_empty() {
        source_path.trim()
    } else {
        title.trim()
    };
    format!("paper-chat-{}", stable_hash(raw))
}

fn make_session_id(paper_key: &str) -> String {
    let now = chrono::Utc::now();
    format!(
        "{}-session-{}-{}",
        paper_key,
        now.timestamp_millis(),
        now.timestamp_subsec_nanos()
    )
}

async fn ensure_cache(
    paper_key: &str,
    source_path: &str,
    saved_path: &str,
    title: &str,
    config: &AppConfig,
) -> Result<PaperChatCacheEntry> {
    let started_at = Instant::now();
    let source_modified_ms = file_modified_ms(source_path);
    let report_modified_ms = file_modified_ms(saved_path);

    if let Some(cache) = read_cache(paper_key)? {
        if cache_is_current(
            &cache,
            paper_key,
            source_path,
            saved_path,
            source_modified_ms,
            report_modified_ms,
            config,
        )
        .await?
        {
            eprintln!(
                "[paper-perf] ensure_cache.hit paperKey={} strategy={} elapsedMs={}",
                paper_key,
                cache.retrieval_strategy,
                started_at.elapsed().as_millis()
            );
            return Ok(cache);
        }
    }

    let mut pdf_warning = None;
    let mut pdf_pages = if is_existing_file(source_path) {
        match pdf::extract_pdf_pages_for_chat(source_path) {
            Ok(pages) => pages
                .into_iter()
                .map(|page| PaperChatPdfPage {
                    page: page.page,
                    text: page.text,
                    embedding: Vec::new(),
                })
                .collect::<Vec<_>>(),
            Err(err) => {
                pdf_warning = Some(format!("PDF 页级文本缓存失败：{}", err));
                Vec::new()
            }
        }
    } else {
        pdf_warning = Some("当前论文 PDF 不可用，仅可使用解读报告回答。".into());
        Vec::new()
    };

    let mut report_warning = None;
    let mut report_sections = if is_existing_file(saved_path) {
        match std::fs::read_to_string(saved_path) {
            Ok(markdown) => split_markdown_sections(&markdown),
            Err(err) => {
                report_warning = Some(format!("读取解读报告失败：{}", err));
                Vec::new()
            }
        }
    } else {
        if !saved_path.trim().is_empty() {
            report_warning = Some("当前解读报告文件不存在。".into());
        }
        Vec::new()
    };

    let token_estimate = estimate_token_count(&pdf_pages, &report_sections);
    let requested_strategy = determine_retrieval_strategy(token_estimate, config);
    let mut retrieval_strategy = requested_strategy;
    let mut embedding_provider_signature = String::new();
    let available_attachments =
        build_available_attachments_for_files(!pdf_pages.is_empty(), !report_sections.is_empty());
    let mut fallback_reason = None::<String>;

    if requested_strategy == RetrievalStrategy::Embedding {
        match embedding::resolve_runtime(config).await {
            Ok(embedding_runtime) => {
                embedding_provider_signature = embedding_runtime.signature.clone();

                let embedding_result = async {
                    if !pdf_pages.is_empty() {
                        let inputs = pdf_pages
                            .iter()
                            .map(|page| format!("passage: {}", safe_passage_text(&page.text)))
                            .collect::<Vec<_>>();
                        let embeddings = embedding::embed_texts(&embedding_runtime, &inputs)
                            .await
                            .context("为 PDF 页面生成检索向量失败")?;
                        for (page, embedding) in pdf_pages.iter_mut().zip(embeddings) {
                            page.embedding = embedding;
                        }
                    }

                    if !report_sections.is_empty() {
                        let inputs = report_sections
                            .iter()
                            .map(|section| {
                                format!(
                                    "passage: {}\n{}",
                                    safe_passage_text(&section.heading),
                                    safe_passage_text(&section.text)
                                )
                            })
                            .collect::<Vec<_>>();
                        let embeddings = embedding::embed_texts(&embedding_runtime, &inputs)
                            .await
                            .context("为解读报告生成检索向量失败")?;
                        for (section, embedding) in report_sections.iter_mut().zip(embeddings) {
                            section.embedding = embedding;
                        }
                    }

                    Ok::<(), anyhow::Error>(())
                }
                .await;

                if let Err(err) = embedding_result {
                    if build_safe_fulltext_context_from_parts(
                        &pdf_pages,
                        &report_sections,
                        &available_attachments,
                        None,
                        config,
                    )
                    .is_some()
                    {
                        fallback_reason = Some(err.to_string());
                        retrieval_strategy = RetrievalStrategy::Fulltext;
                        embedding_provider_signature.clear();
                        for page in &mut pdf_pages {
                            page.embedding.clear();
                        }
                        for section in &mut report_sections {
                            section.embedding.clear();
                        }
                    } else {
                        eprintln!(
                            "[paper-perf] ensure_cache.error paperKey={} strategy={} elapsedMs={} error={}",
                            paper_key,
                            requested_strategy.as_str(),
                            started_at.elapsed().as_millis(),
                            err
                        );
                        return Err(err);
                    }
                }
            }
            Err(err) => {
                let err = err.context("准备 embedding 检索失败");
                if build_safe_fulltext_context_from_parts(
                    &pdf_pages,
                    &report_sections,
                    &available_attachments,
                    None,
                    config,
                )
                .is_some()
                {
                    fallback_reason = Some(err.to_string());
                    retrieval_strategy = RetrievalStrategy::Fulltext;
                } else {
                    eprintln!(
                        "[paper-perf] ensure_cache.error paperKey={} strategy={} elapsedMs={} error={}",
                        paper_key,
                        requested_strategy.as_str(),
                        started_at.elapsed().as_millis(),
                        err
                    );
                    return Err(err);
                }
            }
        }
    }

    let cache = PaperChatCacheEntry {
        paper_key: paper_key.to_string(),
        session_id: paper_key.to_string(),
        source_path: source_path.to_string(),
        saved_path: saved_path.to_string(),
        title: title.to_string(),
        source_modified_ms,
        report_modified_ms,
        cache_version: PAPER_CHAT_CACHE_VERSION,
        retrieval_strategy: retrieval_strategy.as_str().to_string(),
        embedding_provider_signature,
        token_estimate,
        pdf_pages,
        report_sections,
        pdf_warning,
        report_warning,
        updated_at: iso_now(),
    };
    write_cache(paper_key, &cache)?;
    if let Some(reason) = fallback_reason.as_deref() {
        eprintln!(
            "[paper-perf] ensure_cache.fallback paperKey={} requestedStrategy={} finalStrategy={} tokenEstimate={} elapsedMs={} reason={}",
            paper_key,
            requested_strategy.as_str(),
            retrieval_strategy.as_str(),
            token_estimate,
            started_at.elapsed().as_millis(),
            reason
        );
    } else {
        eprintln!(
            "[paper-perf] ensure_cache.build paperKey={} strategy={} tokenEstimate={} elapsedMs={}",
            paper_key,
            retrieval_strategy.as_str(),
            token_estimate,
            started_at.elapsed().as_millis()
        );
    }
    Ok(cache)
}

fn cache_is_likely_current(
    cache: &PaperChatCacheEntry,
    paper_key: &str,
    source_path: &str,
    saved_path: &str,
    source_modified_ms: Option<u64>,
    report_modified_ms: Option<u64>,
    config: &AppConfig,
) -> bool {
    if cache_identity(cache) != paper_key
        || cache.source_path != source_path
        || cache.saved_path != saved_path
        || cache.source_modified_ms != source_modified_ms
        || cache.report_modified_ms != report_modified_ms
        || cache.cache_version != PAPER_CHAT_CACHE_VERSION
    {
        return false;
    }

    let expected_strategy = determine_retrieval_strategy(cache_token_estimate(cache), config);
    if cache.retrieval_strategy != expected_strategy.as_str() {
        return false;
    }

    if expected_strategy == RetrievalStrategy::Embedding {
        cache_has_embeddings(cache)
    } else {
        true
    }
}

async fn cache_is_current(
    cache: &PaperChatCacheEntry,
    paper_key: &str,
    source_path: &str,
    saved_path: &str,
    source_modified_ms: Option<u64>,
    report_modified_ms: Option<u64>,
    config: &AppConfig,
) -> Result<bool> {
    if !cache_is_likely_current(
        cache,
        paper_key,
        source_path,
        saved_path,
        source_modified_ms,
        report_modified_ms,
        config,
    ) {
        return Ok(false);
    }

    if retrieval_strategy_from_cache(cache) != RetrievalStrategy::Embedding {
        return Ok(true);
    }

    match embedding::resolve_runtime(config).await {
        Ok(runtime) => Ok(cache.embedding_provider_signature == runtime.signature),
        Err(_) => Ok(!cache.embedding_provider_signature.trim().is_empty()),
    }
}

fn cache_identity(cache: &PaperChatCacheEntry) -> &str {
    if !cache.paper_key.trim().is_empty() {
        cache.paper_key.as_str()
    } else {
        cache.session_id.as_str()
    }
}

fn cache_has_embeddings(cache: &PaperChatCacheEntry) -> bool {
    cache
        .pdf_pages
        .iter()
        .all(|page| !page.embedding.is_empty())
        && cache
            .report_sections
            .iter()
            .all(|section| !section.embedding.is_empty())
}

fn retrieval_strategy_from_cache(cache: &PaperChatCacheEntry) -> RetrievalStrategy {
    match cache.retrieval_strategy.as_str() {
        "fulltext" => RetrievalStrategy::Fulltext,
        _ => RetrievalStrategy::Embedding,
    }
}

fn cache_token_estimate(cache: &PaperChatCacheEntry) -> u32 {
    if cache.token_estimate > 0 {
        cache.token_estimate
    } else {
        estimate_token_count(&cache.pdf_pages, &cache.report_sections)
    }
}

fn estimate_token_count(
    pdf_pages: &[PaperChatPdfPage],
    report_sections: &[PaperChatReportSection],
) -> u32 {
    let pdf_chars = pdf_pages
        .iter()
        .map(|page| page.text.chars().count())
        .sum::<usize>();
    let report_chars = report_sections
        .iter()
        .map(|section| section.heading.chars().count() + section.text.chars().count())
        .sum::<usize>();
    let total_chars = pdf_chars + report_chars;
    if total_chars == 0 {
        return 0;
    }
    total_chars.div_ceil(3) as u32
}

fn determine_retrieval_strategy(token_estimate: u32, config: &AppConfig) -> RetrievalStrategy {
    if token_estimate <= effective_fulltext_token_limit(config) {
        RetrievalStrategy::Fulltext
    } else {
        RetrievalStrategy::Embedding
    }
}

fn effective_fulltext_token_limit(config: &AppConfig) -> u32 {
    let configured = if config.paper_fulltext_token_limit == 0 {
        DEFAULT_FULLTEXT_TOKEN_LIMIT
    } else {
        config.paper_fulltext_token_limit
    }
    .max(4_000);
    configured.min(provider_safe_token_limit(config))
}

fn provider_safe_token_limit(config: &AppConfig) -> u32 {
    let runtime = paper_runtime_config(config);
    if runtime.provider == "ollama" {
        OLLAMA_SAFE_TOKEN_LIMIT
    } else {
        OPENAI_SAFE_TOKEN_LIMIT
    }
}

async fn prepare_requested_attachments(
    session_id: &str,
    attachments: Vec<PaperChatAttachment>,
    images: Vec<PaperChatImageInput>,
) -> Result<Vec<PaperChatAttachment>> {
    let mut source_attachments = Vec::new();
    let mut existing_image_attachments = Vec::new();

    for attachment in attachments {
        if attachment.kind == "image" {
            existing_image_attachments.push(normalize_image_attachment(attachment));
        } else {
            source_attachments.push(attachment);
        }
    }

    let image_attachments = if images.is_empty() {
        existing_image_attachments
    } else {
        images
            .into_iter()
            .take(MAX_IMAGES_PER_TURN)
            .map(|image| persist_image_input_as_attachment(session_id, image))
            .collect::<Result<Vec<_>>>()?
    };

    source_attachments.extend(image_attachments);
    Ok(dedupe_attachments(source_attachments))
}

async fn build_turn_image_context(
    attachments: &[PaperChatAttachment],
    question: &str,
    title: &str,
    config: &AppConfig,
) -> Result<Option<String>> {
    let image_attachments = attachments
        .iter()
        .filter(|attachment| attachment.kind == "image")
        .take(MAX_IMAGES_PER_TURN)
        .cloned()
        .collect::<Vec<_>>();
    if image_attachments.is_empty() {
        return Ok(None);
    }

    let mut sections = Vec::new();
    for (index, attachment) in image_attachments.iter().enumerate() {
        let image_path = attachment
            .path
            .as_deref()
            .ok_or_else(|| anyhow!("图片附件缺少可读取路径"))?;
        let image_name = attachment_display_name(attachment);
        let mime = attachment
            .mime
            .clone()
            .unwrap_or_else(|| infer_image_mime(Some(image_path), attachment.name.as_deref(), None));
        let bytes = std::fs::read(image_path)
            .with_context(|| format!("读取图片失败: {}", image_name))?;
        let image_base64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        let analysis = llm::call_vlm(
            &build_paper_chat_image_prompt(title, question, index, image_attachments.len(), &image_name),
            &image_base64,
            &mime,
            config,
        )
        .await
        .with_context(|| format!("分析图片失败: {}", image_name))?;
        let content = analysis.trim();
        sections.push(format!(
            "[图{} | {}]\n{}",
            index + 1,
            image_name,
            if content.is_empty() { "未返回可用的视觉分析。" } else { content }
        ));
    }

    Ok(Some(format!(
        "[当前问题附带图片的视觉分析]\n{}",
        sections.join("\n\n---\n\n")
    )))
}

fn build_available_attachments(cache: &PaperChatCacheEntry) -> Vec<PaperChatAttachment> {
    build_available_attachments_for_files(
        !cache.pdf_pages.is_empty(),
        !cache.report_sections.is_empty(),
    )
}

fn build_available_attachments_for_files(
    has_pdf: bool,
    has_report: bool,
) -> Vec<PaperChatAttachment> {
    let mut items = Vec::new();
    if has_pdf {
        items.push(PaperChatAttachment {
            kind: "pdf".into(),
            label: "@论文PDF".into(),
            ..PaperChatAttachment::default()
        });
    }
    if has_report {
        items.push(PaperChatAttachment {
            kind: "report".into(),
            label: "@解读报告".into(),
            ..PaperChatAttachment::default()
        });
    }
    items
}

fn normalize_attachments(
    attachments: Vec<PaperChatAttachment>,
    cache: &PaperChatCacheEntry,
) -> Vec<PaperChatAttachment> {
    let mut kinds = attachments
        .into_iter()
        .filter(|item| item.kind == "pdf" || item.kind == "report")
        .collect::<Vec<_>>();
    kinds.retain(|item| {
        (item.kind == "pdf" && !cache.pdf_pages.is_empty())
            || (item.kind == "report" && !cache.report_sections.is_empty())
    });
    if kinds.is_empty() {
        kinds = build_available_attachments(cache);
    }
    dedupe_attachments(kinds)
}

fn dedupe_attachments(attachments: Vec<PaperChatAttachment>) -> Vec<PaperChatAttachment> {
    let mut seen = HashSet::new();
    let mut image_count = 0usize;
    attachments
        .into_iter()
        .filter_map(|item| {
            let normalized = if item.kind == "image" {
                normalize_image_attachment(item)
            } else {
                item
            };
            if normalized.kind == "image" {
                if image_count >= MAX_IMAGES_PER_TURN {
                    return None;
                }
                image_count += 1;
            }
            let key = attachment_dedupe_key(&normalized);
            seen.insert(key).then_some(normalized)
        })
        .collect()
}

fn build_fulltext_context(
    cache: &PaperChatCacheEntry,
    attachments: &[PaperChatAttachment],
    selection: Option<&PaperSelectionContext>,
) -> String {
    build_fulltext_context_from_parts(&cache.pdf_pages, &cache.report_sections, attachments, selection)
}

fn build_safe_fulltext_context(
    cache: &PaperChatCacheEntry,
    attachments: &[PaperChatAttachment],
    selection: Option<&PaperSelectionContext>,
    config: &AppConfig,
) -> Option<String> {
    build_safe_fulltext_context_from_parts(
        &cache.pdf_pages,
        &cache.report_sections,
        attachments,
        selection,
        config,
    )
}

fn build_safe_fulltext_context_from_parts(
    pdf_pages: &[PaperChatPdfPage],
    report_sections: &[PaperChatReportSection],
    attachments: &[PaperChatAttachment],
    selection: Option<&PaperSelectionContext>,
    config: &AppConfig,
) -> Option<String> {
    let context =
        build_fulltext_context_from_parts(pdf_pages, report_sections, attachments, selection);
    if context.trim().is_empty() {
        return None;
    }

    let token_estimate = context.chars().count().div_ceil(3) as u32;
    if token_estimate <= effective_fulltext_token_limit(config) {
        Some(context)
    } else {
        None
    }
}

fn build_fulltext_context_from_parts(
    pdf_pages: &[PaperChatPdfPage],
    report_sections: &[PaperChatReportSection],
    attachments: &[PaperChatAttachment],
    selection: Option<&PaperSelectionContext>,
) -> String {
    let mut sections = Vec::new();
    let allowed = attachments
        .iter()
        .map(|attachment| attachment.kind.as_str())
        .collect::<HashSet<_>>();

    if let Some(selection) = selection.filter(|item| !item.text.trim().is_empty()) {
        let label = match selection.source.as_str() {
            "pdf" => format!(
                "用户当前选中内容 / 论文 PDF 第{}页",
                selection.page.unwrap_or(1)
            ),
            "report" => format!(
                "用户当前选中内容 / 解读报告 {}",
                selection.heading.clone().unwrap_or_else(|| "片段".into())
            ),
            _ => "用户当前选中内容".into(),
        };
        sections.push(format!("[{}]\n{}", label, selection.text.trim()));
    }

    if allowed.contains("pdf") {
        let content = pdf_pages
            .iter()
            .filter(|page| !page.text.trim().is_empty())
            .map(|page| format!("[Page {}]\n{}", page.page, page.text.trim()))
            .collect::<Vec<_>>()
            .join("\n\n");
        if !content.trim().is_empty() {
            sections.push(format!("[论文 PDF 全文]\n{}", content));
        }
    }

    if allowed.contains("report") {
        let content = report_sections
            .iter()
            .filter(|section| !section.text.trim().is_empty())
            .map(|section| format!("[解读报告 / {}]\n{}", section.heading, section.text.trim()))
            .collect::<Vec<_>>()
            .join("\n\n");
        if !content.trim().is_empty() {
            sections.push(format!("[解读报告全文]\n{}", content));
        }
    }

    sections.join("\n\n---\n\n")
}

async fn retrieve_relevant_chunks(
    query: &str,
    cache: &PaperChatCacheEntry,
    attachments: &[PaperChatAttachment],
    selection: Option<&PaperSelectionContext>,
    embedding_runtime: &embedding::ResolvedEmbeddingRuntime,
) -> Result<Vec<RetrievedChunk>> {
    let mut chunks = Vec::new();
    let mut seen = HashSet::new();

    if let Some(selection) = selection.filter(|item| !item.text.trim().is_empty()) {
        let key = match selection.source.as_str() {
            "pdf" => format!("pdf:{}", selection.page.unwrap_or(0)),
            _ => format!(
                "report:{}",
                selection
                    .heading
                    .clone()
                    .unwrap_or_else(|| "selection".into())
            ),
        };
        seen.insert(key);
        chunks.push(RetrievedChunk {
            source: selection.source.clone(),
            label: match selection.source.as_str() {
                "pdf" => format!("论文PDF/第{}页（用户选中）", selection.page.unwrap_or(1)),
                _ => format!(
                    "解读报告/{}（用户选中）",
                    selection.heading.clone().unwrap_or_else(|| "片段".into())
                ),
            },
            text: clamp_chars(selection.text.trim(), MAX_CONTEXT_CHARS),
            page: selection.page,
            heading: selection.heading.clone(),
            anchor_text: fallback_anchor_text(selection.text.trim()),
            score: 1.0,
        });
    }

    if attachments.is_empty() {
        return Ok(chunks);
    }

    let query_embedding = embedding::embed_query(
        embedding_runtime,
        &format!("query: {}", safe_passage_text(query)),
    )
    .await
    .context("生成问题检索向量失败")?;
    let allowed = attachments
        .iter()
        .map(|attachment| attachment.kind.as_str())
        .collect::<HashSet<_>>();

    if allowed.contains("pdf") {
        let mut scored_pages = cache
            .pdf_pages
            .iter()
            .filter(|page| !page.text.trim().is_empty())
            .map(|page| {
                (
                    page,
                    embedding::cosine_similarity(&query_embedding, &page.embedding),
                )
            })
            .collect::<Vec<_>>();
        scored_pages.sort_by(|a, b| b.1.total_cmp(&a.1));

        for (page, score) in scored_pages.into_iter().take(TOP_K_PDF) {
            let key = format!("pdf:{}", page.page);
            if seen.insert(key) {
                let chunk_text = clamp_chars(&page.text, MAX_CONTEXT_CHARS);
                chunks.push(RetrievedChunk {
                    source: "pdf".into(),
                    label: format!("论文PDF/第{}页", page.page),
                    text: chunk_text.clone(),
                    page: Some(page.page),
                    heading: None,
                    anchor_text: select_anchor_text(
                        embedding_runtime,
                        &query_embedding,
                        &chunk_text,
                    )
                    .await,
                    score,
                });
            }
        }
    }

    if allowed.contains("report") {
        let mut scored_sections = cache
            .report_sections
            .iter()
            .filter(|section| !section.text.trim().is_empty())
            .map(|section| {
                (
                    section,
                    embedding::cosine_similarity(&query_embedding, &section.embedding),
                )
            })
            .collect::<Vec<_>>();
        scored_sections.sort_by(|a, b| b.1.total_cmp(&a.1));

        for (section, score) in scored_sections.into_iter().take(TOP_K_REPORT) {
            let key = format!("report:{}", section.heading);
            if seen.insert(key) {
                let chunk_text = clamp_chars(&section.text, MAX_CONTEXT_CHARS);
                chunks.push(RetrievedChunk {
                    source: "report".into(),
                    label: format!("解读报告/{}", section.heading),
                    text: chunk_text.clone(),
                    page: None,
                    heading: Some(section.heading.clone()),
                    anchor_text: select_anchor_text(
                        embedding_runtime,
                        &query_embedding,
                        &chunk_text,
                    )
                    .await,
                    score,
                });
            }
        }
    }

    Ok(chunks)
}

fn build_chat_messages(
    title: &str,
    question: &str,
    prompt_context: &PromptContextPayload,
    image_context: Option<&str>,
    history: &[PaperChatMessageEntry],
    attachments: &[PaperChatAttachment],
) -> Vec<ChatMessage> {
    let mut messages = Vec::new();

    let allowed_sources = attachments
        .iter()
        .filter(|attachment| attachment.kind != "image")
        .map(|attachment| attachment.label.clone())
        .collect::<Vec<_>>();

    let mut system = match prompt_context {
        PromptContextPayload::Fulltext(_) => format!(
            "你是论文阅读助手，正在帮助用户阅读论文「{}」。\n\
仅基于提供给你的论文全文、解读报告和用户选中内容回答，如果证据不足，必须明确回答“当前文档未提供足够证据”。\n\
回答规则：\n\
- 正文使用 Markdown。\n\
- 当引用论文 PDF 内容时，使用 @论文PDF/第X页。\n\
- 一条 PDF 引用只能对应一个页码；如果一句话需要多个页码，必须逐页重复完整标记，例如 @论文PDF/第6页 @论文PDF/第7页。\n\
- 禁止使用省略或合并写法，例如 @论文PDF/第6页、第7页、PDF P.6、第7页、@论文PDF/第6-7页。\n\
- 当引用解读报告内容时，使用 @解读报告/章节名。\n\
- 引用必须 inline 出现在正文中，不要在末尾单独列引用列表。\n\
- 不要编造页码、章节名或外部资料。\n\
- 如果本轮提供了图片视觉分析块，可以把它视为当前问题额外提供的图像观察，但不要编造其中未提到的细节。\n\
- 回答最后单独一行输出 {}\n\
- 再输出单行 JSON：{{\"suggestedQuestions\":[\"问题1\",\"问题2\"]}}",
            title, FYLA_CHAT_JSON_MARKER
        ),
        PromptContextPayload::Retrieved(_) => format!(
            "你是论文阅读助手，正在帮助用户阅读论文「{}」。\n\
仅基于提供给你的参考片段回答，如果证据不足，必须明确回答“当前文档未提供足够证据”。\n\
回答规则：\n\
- 正文使用 Markdown。\n\
- 当引用论文 PDF 内容时，优先在对应句子末尾标注 @论文PDF/第X页『短片段』。\n\
- 一条 PDF 引用只能对应一个页码；如果一句话需要多个页码，必须逐页重复完整标记，例如 @论文PDF/第6页『短片段』 @论文PDF/第7页。\n\
- 禁止使用省略或合并写法，例如 @论文PDF/第6页、第7页、PDF P.6、第7页、@论文PDF/第6-7页。\n\
- 当引用解读报告内容时，优先标注 @解读报告/章节名『短片段』。\n\
- 短片段必须逐字复用参考片段中的 anchor 或连续原文，不能改写、不能加省略号。\n\
- 引用必须 inline 出现在正文中，不要在末尾单独列引用列表。\n\
- 不要编造页码、章节名或外部资料。\n\
- 如果无法确定短片段，可退回旧格式 @论文PDF/第X页 或 @解读报告/章节名。\n\
- 如果本轮提供了图片视觉分析块，可以把它视为当前问题额外提供的图像观察，但不要编造其中未提到的细节。\n\
- 回答最后单独一行输出 {}\n\
- 再输出单行 JSON：{{\"suggestedQuestions\":[\"问题1\",\"问题2\"]}}",
            title, FYLA_CHAT_JSON_MARKER
        ),
    };
    if !allowed_sources.is_empty() {
        system.push_str(&format!(
            "\n本轮可参考来源：{}。",
            allowed_sources.join("、")
        ));
    }
    messages.push(ChatMessage {
        role: "system".into(),
        content: system,
    });

    match prompt_context {
        PromptContextPayload::Fulltext(context) if !context.trim().is_empty() => {
            messages.push(ChatMessage {
                role: "user".into(),
                content: format!("以下是本轮可用的论文全文上下文：\n\n{}", context),
            });
            messages.push(ChatMessage {
                role: "assistant".into(),
                content: "我已阅读上述全文上下文，请继续提问。".into(),
            });
        }
        PromptContextPayload::Retrieved(chunks) if !chunks.is_empty() => {
            let context = chunks
                .iter()
                .map(|chunk| {
                    let mut meta = vec![
                        format!("来源: {}", chunk.label),
                        format!("source={}", chunk.source),
                        format!("score={:.4}", chunk.score),
                    ];
                    if let Some(page) = chunk.page {
                        meta.push(format!("page={}", page));
                    }
                    if let Some(heading) = &chunk.heading {
                        meta.push(format!("heading={}", heading));
                    }
                    if let Some(anchor) = &chunk.anchor_text {
                        meta.push(format!("anchor={}", anchor));
                    }
                    format!("[参考片段]\n{}\n\n{}", meta.join("\n"), chunk.text)
                })
                .collect::<Vec<_>>()
                .join("\n\n---\n\n");
            messages.push(ChatMessage {
                role: "user".into(),
                content: format!("以下是从论文和解读报告中检索到的参考片段：\n\n{}", context),
            });
            messages.push(ChatMessage {
                role: "assistant".into(),
                content: "我已阅读上述参考片段，请继续提问。".into(),
            });
        }
        _ => {}
    }

    if let Some(image_context) = image_context.filter(|value| !value.trim().is_empty()) {
        messages.push(ChatMessage {
            role: "user".into(),
            content: format!("以下是当前问题附带图片的视觉分析结果：\n\n{}", image_context),
        });
        messages.push(ChatMessage {
            role: "assistant".into(),
            content: "我已阅读这些图片观察，请继续提问。".into(),
        });
    }

    let history_limit = if matches!(prompt_context, &PromptContextPayload::Fulltext(_)) {
        FULLTEXT_HISTORY_LIMIT
    } else {
        CHAT_HISTORY_LIMIT
    };
    let recent = history
        .iter()
        .filter(|message| {
            (message.role == "user" || message.role == "assistant")
                && message.status != "streaming"
                && message.status != "error"
                && !message.content.trim().is_empty()
        })
        .rev()
        .take(history_limit)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>();

    for message in recent {
        messages.push(ChatMessage {
            role: message.role,
            content: message.content,
        });
    }

    messages.push(ChatMessage {
        role: "user".into(),
        content: question.trim().to_string(),
    });

    messages
}

async fn call_chat_model_stream<F>(
    config: &AppConfig,
    messages: &[ChatMessage],
    cancel_rx: &mut watch::Receiver<bool>,
    mut on_delta: F,
) -> Result<String>
where
    F: FnMut(&str),
{
    match config.provider.as_str() {
        "openai" => call_openai_chat_stream(config, messages, cancel_rx, &mut on_delta).await,
        _ => call_ollama_chat_stream(config, messages, cancel_rx, &mut on_delta).await,
    }
}

async fn call_openai_chat_stream<F>(
    config: &AppConfig,
    messages: &[ChatMessage],
    cancel_rx: &mut watch::Receiver<bool>,
    on_delta: &mut F,
) -> Result<String>
where
    F: FnMut(&str),
{
    let base = config.openai_base_url.trim_end_matches('/');
    let url = format!("{}/chat/completions", base);
    let body = json!({
        "model": config.openai_model,
        "messages": messages,
        "stream": true
    });
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.openai_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("无法连接 API ({}): {}", base, e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("API 请求失败 {}: {}", status, text));
    }

    let mut raw = String::new();
    let mut buffer = String::new();
    let mut stream = resp.bytes_stream();
    let mut accumulator = ChatStreamAccumulator::default();

    loop {
        let chunk = tokio::select! {
            _ = cancel_rx.changed() => {
                if *cancel_rx.borrow() {
                    return Err(anyhow!(STOPPED_REASON));
                }
                continue;
            }
            next = stream.next() => next,
        };
        let Some(chunk) = chunk else { break };
        let chunk = chunk?;
        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);

        while let Some(event) = take_sse_event(&mut buffer) {
            for line in event.lines() {
                let trimmed = line.trim();
                if !trimmed.starts_with("data:") {
                    continue;
                }
                let payload = trimmed.trim_start_matches("data:").trim();
                if payload == "[DONE]" || payload.is_empty() {
                    continue;
                }
                let value: Value = serde_json::from_str(payload)?;
                let delta = extract_openai_delta_text(&value);
                if !delta.is_empty() {
                    raw.push_str(&delta);
                    if let Some(answer_delta) = accumulator.push(&delta) {
                        on_delta(&answer_delta);
                    }
                }
            }
        }
    }

    Ok(raw)
}

async fn call_ollama_chat_stream<F>(
    config: &AppConfig,
    messages: &[ChatMessage],
    cancel_rx: &mut watch::Receiver<bool>,
    on_delta: &mut F,
) -> Result<String>
where
    F: FnMut(&str),
{
    let url = format!("{}/api/chat", config.ollama_url.trim_end_matches('/'));
    let body = json!({
        "model": config.ollama_model,
        "messages": messages,
        "stream": true,
        "options": { "num_predict": 4096 }
    });
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()?;
    let resp = client.post(&url).json(&body).send().await.map_err(|e| {
        if e.is_connect() {
            anyhow!("无法连接 Ollama（{}），请确认已启动", config.ollama_url)
        } else {
            anyhow!("Ollama 网络错误: {}", e)
        }
    })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Ollama 请求失败 {}: {}", status, text));
    }

    let mut raw = String::new();
    let mut buffer = String::new();
    let mut stream = resp.bytes_stream();
    let mut accumulator = ChatStreamAccumulator::default();

    loop {
        let chunk = tokio::select! {
            _ = cancel_rx.changed() => {
                if *cancel_rx.borrow() {
                    return Err(anyhow!(STOPPED_REASON));
                }
                continue;
            }
            next = stream.next() => next,
        };
        let Some(chunk) = chunk else { break };
        let chunk = chunk?;
        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);

        while let Some(line) = take_line(&mut buffer) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(trimmed)?;
            let delta = value["message"]["content"].as_str().unwrap_or_default();
            if !delta.is_empty() {
                raw.push_str(delta);
                if let Some(answer_delta) = accumulator.push(delta) {
                    on_delta(&answer_delta);
                }
            }
        }
    }

    Ok(raw)
}

impl ChatStreamAccumulator {
    fn push(&mut self, delta: &str) -> Option<String> {
        self.raw.push_str(delta);
        let visible = extract_visible_answer(&self.raw);
        if visible.len() <= self.sent_len {
            return None;
        }
        let next = visible[self.sent_len..].to_string();
        self.sent_len = visible.len();
        (!next.is_empty()).then_some(next)
    }
}

fn parse_chat_payload(raw: &str) -> ParsedChatPayload {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return ParsedChatPayload::default();
    }

    if let Some(idx) = trimmed.find(FYLA_CHAT_JSON_MARKER) {
        let answer = trimmed[..idx].trim().to_string();
        let meta_raw = trimmed[idx + FYLA_CHAT_JSON_MARKER.len()..].trim();
        if let Some(json_str) = extract_json_object(meta_raw) {
            if let Ok(value) = serde_json::from_str::<Value>(json_str) {
                let suggested_questions = value["suggestedQuestions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|item| item.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>();
                return ParsedChatPayload {
                    answer,
                    suggested_questions,
                };
            }
        }
        return ParsedChatPayload {
            answer,
            suggested_questions: Vec::new(),
        };
    }

    ParsedChatPayload {
        answer: trimmed.to_string(),
        suggested_questions: Vec::new(),
    }
}

fn extract_visible_answer(raw: &str) -> String {
    if let Some(idx) = raw.find(FYLA_CHAT_JSON_MARKER) {
        return raw[..idx].to_string();
    }
    let overlap = longest_suffix_prefix_overlap(raw, FYLA_CHAT_JSON_MARKER);
    raw[..raw.len().saturating_sub(overlap)].to_string()
}

fn longest_suffix_prefix_overlap(raw: &str, marker: &str) -> usize {
    let raw_bytes = raw.as_bytes();
    let marker_bytes = marker.as_bytes();
    let max = raw_bytes.len().min(marker_bytes.len().saturating_sub(1));
    for len in (1..=max).rev() {
        if raw_bytes[raw_bytes.len() - len..] == marker_bytes[..len] {
            return len;
        }
    }
    0
}

fn split_markdown_sections(markdown: &str) -> Vec<PaperChatReportSection> {
    let mut sections = Vec::new();
    let mut current_heading = "报告摘要".to_string();
    let mut current_lines = Vec::new();
    let mut slug_counts = HashMap::<String, usize>::new();

    for line in markdown.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            push_section(
                &mut sections,
                &current_heading,
                &current_lines.join("\n"),
                &mut slug_counts,
            );
            current_heading = trimmed.trim_start_matches('#').trim().to_string();
            current_lines.clear();
            continue;
        }
        current_lines.push(line.to_string());
    }

    push_section(
        &mut sections,
        &current_heading,
        &current_lines.join("\n"),
        &mut slug_counts,
    );

    if sections.is_empty() && !markdown.trim().is_empty() {
        push_section(&mut sections, "报告摘要", markdown, &mut slug_counts);
    }

    sections
}

fn register_stream_cancel(session_id: &str) -> watch::Receiver<bool> {
    let (sender, receiver) = watch::channel(false);
    let mut registry = paper_chat_cancel_registry().lock().unwrap();
    registry.insert(session_id.to_string(), sender);
    receiver
}

fn trigger_stream_stop(session_id: &str) {
    if let Some(sender) = paper_chat_cancel_registry()
        .lock()
        .unwrap()
        .get(session_id)
        .cloned()
    {
        let _ = sender.send(true);
    }
}

fn clear_stream_cancel(session_id: &str) {
    paper_chat_cancel_registry()
        .lock()
        .unwrap()
        .remove(session_id);
}

fn is_stream_stopped_error(err: &anyhow::Error) -> bool {
    err.to_string().contains(STOPPED_REASON)
}

fn push_section(
    sections: &mut Vec<PaperChatReportSection>,
    heading: &str,
    text: &str,
    slug_counts: &mut HashMap<String, usize>,
) {
    let clean_text = text.trim();
    if clean_text.is_empty() {
        return;
    }
    let base = slugify_heading(heading);
    let count = slug_counts.entry(base.clone()).or_default();
    *count += 1;
    let id = if *count == 1 {
        base
    } else {
        format!("{}-{}", base, count)
    };
    sections.push(PaperChatReportSection {
        id,
        heading: heading.trim().to_string(),
        text: clean_text.to_string(),
        embedding: Vec::new(),
    });
}

fn safe_passage_text(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        "[empty]".into()
    } else {
        trimmed.to_string()
    }
}

fn clamp_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.trim().to_string();
    }
    text.chars()
        .take(max_chars)
        .collect::<String>()
        .trim()
        .to_string()
}

fn clamp_anchor_text(text: &str) -> String {
    let compact = text
        .replace(['\n', '\r', '\t'], " ")
        .replace(['『', '』'], "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if compact.chars().count() <= MAX_ANCHOR_CHARS {
        return compact.trim().to_string();
    }
    compact
        .chars()
        .take(MAX_ANCHOR_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

fn fallback_anchor_text(text: &str) -> Option<String> {
    let candidate = split_anchor_candidates(text).into_iter().next()?;
    let clamped = clamp_anchor_text(&candidate);
    (!clamped.is_empty()).then_some(clamped)
}

fn split_anchor_candidates(text: &str) -> Vec<String> {
    let mut candidates = Vec::new();

    for paragraph in text
        .split("\n\n")
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        if paragraph.chars().count() <= MAX_ANCHOR_CHARS {
            candidates.push(paragraph.to_string());
            continue;
        }

        let sentences = split_sentences(paragraph);
        if sentences.len() > 1 {
            for sentence in sentences {
                let trimmed = sentence.trim();
                if trimmed.chars().count() >= 12 {
                    candidates.push(trimmed.to_string());
                }
            }
        } else {
            candidates.push(paragraph.to_string());
        }
    }

    if candidates.is_empty() && !text.trim().is_empty() {
        candidates.push(text.trim().to_string());
    }

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .map(|candidate| clamp_anchor_text(&candidate))
        .filter(|candidate| !candidate.is_empty())
        .filter(|candidate| seen.insert(candidate.to_lowercase()))
        .take(MAX_ANCHOR_CANDIDATES)
        .collect()
}

fn split_sentences(text: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut current = String::new();

    for ch in text.chars() {
        current.push(ch);
        if matches!(ch, '.' | '!' | '?' | '。' | '！' | '？' | ';' | '；') {
            let trimmed = current.trim();
            if !trimmed.is_empty() {
                sentences.push(trimmed.to_string());
            }
            current.clear();
        }
    }

    let trimmed = current.trim();
    if !trimmed.is_empty() {
        sentences.push(trimmed.to_string());
    }

    sentences
}

async fn select_anchor_text(
    embedding_runtime: &embedding::ResolvedEmbeddingRuntime,
    query_embedding: &[f32],
    text: &str,
) -> Option<String> {
    let candidates = split_anchor_candidates(text);
    if candidates.is_empty() {
        return None;
    }

    let inputs = candidates
        .iter()
        .map(|candidate| format!("passage: {}", safe_passage_text(candidate)))
        .collect::<Vec<_>>();

    let embeddings = match embedding::embed_texts(embedding_runtime, &inputs).await {
        Ok(embeddings) => embeddings,
        Err(_) => return candidates.into_iter().next(),
    };

    candidates
        .into_iter()
        .zip(embeddings)
        .max_by(|(_, left_embedding), (_, right_embedding)| {
            embedding::cosine_similarity(query_embedding, left_embedding).total_cmp(
                &embedding::cosine_similarity(query_embedding, right_embedding),
            )
        })
        .map(|(candidate, _)| candidate)
}

fn persist_image_input_as_attachment(
    session_id: &str,
    image: PaperChatImageInput,
) -> Result<PaperChatAttachment> {
    let source = image.source.trim().to_lowercase();
    let requested_name = image.name.trim();

    if source == "paste" || source == "pasted" {
        let data_url = image
            .data_url
            .as_deref()
            .ok_or_else(|| anyhow!("缺少粘贴图片数据"))?;
        let (mime, bytes) = decode_image_data_url(data_url, &image.mime)?;
        let name = normalized_image_name(
            if requested_name.is_empty() {
                None
            } else {
                Some(requested_name)
            },
            &mime,
            None,
        );
        let attachment_id = normalized_image_id(Some(&image.id), None, Some(&name));
        let stored_path = write_managed_image(session_id, &attachment_id, &name, &mime, &bytes)?;
        return Ok(normalize_image_attachment(PaperChatAttachment {
            kind: "image".into(),
            label: name.clone(),
            id: Some(attachment_id),
            path: Some(stored_path),
            name: Some(name),
            mime: Some(mime),
            size_bytes: Some(bytes.len() as u64),
            origin: Some("pasted".into()),
        }));
    }

    let path = image
        .path
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("缺少本地图路径"))?;
    if !Path::new(&path).is_file() {
        return Err(anyhow!("图片文件不存在: {}", path));
    }
    let name = normalized_image_name(
        if requested_name.is_empty() {
            None
        } else {
            Some(requested_name)
        },
        &infer_image_mime(Some(&path), Some(requested_name), Some(&image.mime)),
        Some(&path),
    );
    let mime = infer_image_mime(Some(&path), Some(&name), Some(&image.mime));
    let attachment_id = normalized_image_id(Some(&image.id), Some(&path), Some(&name));
    let bytes = std::fs::read(&path)
        .with_context(|| format!("读取图片失败: {}", name))?;
    let stored_path = write_managed_image(session_id, &attachment_id, &name, &mime, &bytes)?;
    let size_bytes = Some(image.size_bytes.unwrap_or(bytes.len() as u64));

    Ok(normalize_image_attachment(PaperChatAttachment {
        kind: "image".into(),
        label: name.clone(),
        id: Some(attachment_id),
        path: Some(stored_path),
        name: Some(name.clone()),
        mime: Some(mime),
        size_bytes,
        origin: Some("picker".into()),
    }))
}

fn decode_image_data_url(data_url: &str, fallback_mime: &str) -> Result<(String, Vec<u8>)> {
    let raw = data_url.trim();
    let payload = raw
        .strip_prefix("data:")
        .ok_or_else(|| anyhow!("粘贴图片数据格式无效"))?;
    let (meta, encoded) = payload
        .split_once(',')
        .ok_or_else(|| anyhow!("粘贴图片数据格式无效"))?;
    if !meta.contains(";base64") {
        return Err(anyhow!("暂不支持非 base64 的图片数据"));
    }
    let mime = meta
        .split(';')
        .next()
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|| infer_image_mime(None, None, Some(fallback_mime)));
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .context("解码粘贴图片失败")?;
    Ok((mime, bytes))
}

fn write_managed_image(
    session_id: &str,
    attachment_id: &str,
    original_name: &str,
    mime: &str,
    bytes: &[u8],
) -> Result<String> {
    let dir = managed_image_attachment_dir(session_id, attachment_id);
    std::fs::create_dir_all(&dir)?;
    let file_name = build_stored_image_file_name(attachment_id, original_name, mime);
    let path = dir.join(file_name);
    std::fs::write(&path, bytes)?;
    Ok(path.to_string_lossy().to_string())
}

fn build_stored_image_file_name(image_id: &str, original_name: &str, mime: &str) -> String {
    let fallback_extension = image_extension_from_mime(mime);
    let path = Path::new(original_name);
    let stem = sanitize_file_name_component(
        path.file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("pasted-image"),
    );
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().trim_start_matches('.').to_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback_extension.to_string());
    format!(
        "{}-{}.{}",
        stable_hash(&format!("{}:{}", image_id, original_name)),
        stem,
        extension
    )
}

fn attachment_display_name(attachment: &PaperChatAttachment) -> String {
    attachment
        .name
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            attachment
                .path
                .as_deref()
                .and_then(|value| Path::new(value).file_name())
                .and_then(|value| value.to_str())
                .map(ToString::to_string)
        })
        .or_else(|| {
            let label = attachment.label.trim();
            (!label.is_empty()).then(|| label.to_string())
        })
        .unwrap_or_else(|| "图片附件".into())
}

fn normalized_image_name(
    requested_name: Option<&str>,
    mime: &str,
    path: Option<&str>,
) -> String {
    let from_name = requested_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let from_path = path
        .and_then(|value| Path::new(value).file_name())
        .and_then(|value| value.to_str())
        .map(ToString::to_string);

    let mut name = from_name.or(from_path).unwrap_or_else(|| {
        format!("image.{}", image_extension_from_mime(mime))
    });

    let has_extension = Path::new(&name).extension().is_some();
    if !has_extension {
        name.push('.');
        name.push_str(image_extension_from_mime(mime));
    }
    name
}

fn normalized_image_id(id: Option<&str>, path: Option<&str>, name: Option<&str>) -> String {
    id.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| path.map(|value| stable_hash(value)))
        .or_else(|| name.map(|value| stable_hash(value)))
        .unwrap_or_else(|| stable_hash("paper-chat-image"))
}

fn normalize_image_attachment(mut attachment: PaperChatAttachment) -> PaperChatAttachment {
    let display_name = attachment_display_name(&attachment);
    if attachment.label.trim().is_empty() {
        attachment.label = display_name.clone();
    }
    if attachment
        .name
        .as_deref()
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        attachment.name = Some(display_name.clone());
    }
    if attachment
        .mime
        .as_deref()
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        attachment.mime = Some(infer_image_mime(
            attachment.path.as_deref(),
            attachment.name.as_deref(),
            None,
        ));
    }
    if attachment
        .id
        .as_deref()
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        attachment.id = Some(normalized_image_id(
            None,
            attachment.path.as_deref(),
            attachment.name.as_deref(),
        ));
    }
    attachment
}

fn attachment_dedupe_key(attachment: &PaperChatAttachment) -> String {
    if attachment.kind == "image" {
        let normalized = normalize_image_attachment(attachment.clone());
        let unique = normalized
            .id
            .or(normalized.path)
            .or(normalized.name)
            .unwrap_or_else(|| normalized.label);
        format!("image:{}", unique)
    } else {
        format!("source:{}", attachment.kind)
    }
}

fn build_paper_chat_image_prompt(
    title: &str,
    question: &str,
    index: usize,
    total: usize,
    image_name: &str,
) -> String {
    format!(
        "你是论文阅读助手的视觉分析器。用户正在阅读论文「{}」。\n\
当前问题：{}\n\
当前图片：第{}张，共{}张，文件名：{}\n\n\
请只根据这张图片本身，输出一份给后续文本模型使用的中文观察摘要。\n\
输出要求：\n\
- 不直接回答用户问题，只做图像观察。\n\
- 先提取图片中可见的文字、标题、坐标轴、表头或界面文案。\n\
- 再概括图表、表格、示意图、截图中的关键结构与趋势。\n\
- 最后补充“与当前问题最相关的观察”。\n\
- 如果某处看不清或无法确认，明确写“无法确认”，不要猜测。\n\
- 尽量简洁、信息密度高，适合直接作为上下文块拼接到论文问答中。",
        title,
        question.trim(),
        index + 1,
        total,
        image_name
    )
}

fn infer_image_mime(path: Option<&str>, name: Option<&str>, mime_hint: Option<&str>) -> String {
    if let Some(mime) = mime_hint.map(str::trim).filter(|value| value.starts_with("image/")) {
        return mime.to_string();
    }

    let extension = path
        .and_then(|value| Path::new(value).extension())
        .and_then(|value| value.to_str())
        .or_else(|| {
            name.and_then(|value| Path::new(value).extension())
                .and_then(|value| value.to_str())
        })
        .map(|value| value.trim().trim_start_matches('.').to_lowercase());

    match extension.as_deref() {
        Some("jpg") | Some("jpeg") => "image/jpeg".into(),
        Some("png") => "image/png".into(),
        Some("webp") => "image/webp".into(),
        Some("gif") => "image/gif".into(),
        Some("bmp") => "image/bmp".into(),
        Some("tif") | Some("tiff") => "image/tiff".into(),
        _ => "image/png".into(),
    }
}

fn image_extension_from_mime(mime: &str) -> &'static str {
    match mime.trim().to_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/tif" | "image/tiff" => "tiff",
        _ => "png",
    }
}

fn sanitize_file_name_component(input: &str) -> String {
    let sanitized = input
        .trim()
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ if ch.is_control() => '_',
            _ => ch,
        })
        .collect::<String>()
        .trim_matches('.')
        .trim()
        .to_string();

    if sanitized.is_empty() {
        "image".into()
    } else {
        sanitized
    }
}

fn make_message_id(prefix: &str) -> String {
    format!(
        "{}-{}-{}",
        prefix,
        stable_hash(&iso_now()),
        stable_hash(prefix)
    )
}

fn trim_session_messages(messages: &mut Vec<PaperChatMessageEntry>) {
    let max_messages = CHAT_HISTORY_LIMIT * 2 + 4;
    if messages.len() > max_messages {
        let remove_count = messages.len() - max_messages;
        messages.drain(0..remove_count);
    }
}

fn stable_hash(input: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn cache_root() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("fyla")
        .join("paper-chat-cache")
}

fn managed_image_root() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("fyla")
        .join("paper-chat-images")
}

fn managed_image_session_dir(session_id: &str) -> PathBuf {
    managed_image_root().join(session_id)
}

fn managed_image_attachment_dir(session_id: &str, attachment_id: &str) -> PathBuf {
    managed_image_session_dir(session_id).join(sanitize_file_name_component(attachment_id))
}

fn cache_path(session_id: &str) -> PathBuf {
    cache_root().join(format!("{}.json", session_id))
}

fn read_cache(session_id: &str) -> Result<Option<PaperChatCacheEntry>> {
    let path = cache_path(session_id);
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&raw).ok())
}

fn write_cache(session_id: &str, cache: &PaperChatCacheEntry) -> Result<()> {
    let path = cache_path(session_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(cache)?)?;
    Ok(())
}

fn file_modified_ms(path: &str) -> Option<u64> {
    if path.trim().is_empty() {
        return None;
    }
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

fn is_existing_file(path: &str) -> bool {
    !path.trim().is_empty() && Path::new(path).is_file()
}

fn slugify_heading(text: &str) -> String {
    let mut output = String::new();
    let mut last_dash = false;
    for ch in text.trim().chars() {
        if ch.is_alphanumeric() {
            for lower in ch.to_lowercase() {
                output.push(lower);
            }
            last_dash = false;
        } else if !last_dash && !output.is_empty() {
            output.push('-');
            last_dash = true;
        }
    }
    let slug = output.trim_matches('-').to_string();
    if slug.is_empty() {
        "section".into()
    } else {
        slug
    }
}

fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn extract_json_object(raw: &str) -> Option<&str> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    (end > start).then_some(&raw[start..=end])
}

fn take_sse_event(buffer: &mut String) -> Option<String> {
    let normalized = buffer.replace("\r\n", "\n");
    if let Some(idx) = normalized.find("\n\n") {
        let event = normalized[..idx].to_string();
        let remaining = normalized[idx + 2..].to_string();
        *buffer = remaining;
        return Some(event);
    }
    *buffer = normalized;
    None
}

fn take_line(buffer: &mut String) -> Option<String> {
    let normalized = buffer.replace("\r\n", "\n");
    if let Some(idx) = normalized.find('\n') {
        let line = normalized[..idx].to_string();
        let remaining = normalized[idx + 1..].to_string();
        *buffer = remaining;
        return Some(line);
    }
    *buffer = normalized;
    None
}

fn extract_openai_delta_text(value: &Value) -> String {
    let content = &value["choices"][0]["delta"]["content"];
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    if let Some(items) = content.as_array() {
        let mut out = String::new();
        for item in items {
            if let Some(text) = item["text"].as_str() {
                out.push_str(text);
            }
        }
        return out;
    }
    String::new()
}

fn paper_runtime_config(config: &AppConfig) -> AppConfig {
    let mut runtime = config.clone();
    runtime.provider = config.paper_provider.clone();
    runtime.ollama_url = config.paper_ollama_url.clone();
    runtime.ollama_model = config.paper_ollama_model.clone();
    runtime.openai_key = config.paper_openai_key.clone();
    runtime.openai_model = config.paper_openai_model.clone();
    runtime.openai_base_url = config.paper_openai_base_url.clone();
    runtime
}
