use crate::config::AppConfig;
use crate::{llm, pdf, streaming};
use anyhow::{Result, anyhow};
use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tokio::sync::{Semaphore, watch};

const PAPER_CONCURRENCY: usize = 3;
const FYLA_META_MARKER: &str = "<<<FYLA_META>>>";
const FYLA_MARKDOWN_MARKER: &str = "<<<FYLA_MARKDOWN>>>";
const STOPPED_REASON: &str = "__FYLA_PAPER_REVIEW_STOPPED__";
const DEFAULT_REVIEW_PROMPT_TEMPLATE: &str =
    include_str!("../../src/lib/paper-review-prompt-template.txt");

fn paper_review_cancel_registry()
-> &'static Mutex<std::collections::HashMap<String, watch::Sender<bool>>> {
    static REGISTRY: OnceLock<Mutex<std::collections::HashMap<String, watch::Sender<bool>>>> =
        OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum PaperStreamEvent {
    #[serde(rename_all = "camelCase")]
    ItemStarted {
        source_path: String,
        file_name: String,
    },
    #[serde(rename_all = "camelCase")]
    ItemPhaseChanged {
        source_path: String,
        phase: String,
        message: String,
    },
    #[serde(rename_all = "camelCase")]
    ItemPreviewStarted {
        source_path: String,
        file_name: String,
    },
    #[serde(rename_all = "camelCase")]
    ItemPreviewReady {
        source_path: String,
        preview_chars: usize,
        preview_meta: Option<PaperPreviewMeta>,
    },
    #[serde(rename_all = "camelCase")]
    ItemPreviewDelta {
        source_path: String,
        delta: String,
        preview_chars: usize,
    },
    #[serde(rename_all = "camelCase")]
    ItemDone {
        source_path: String,
        file_name: String,
        result: PaperReviewResult,
    },
    #[serde(rename_all = "camelCase")]
    ItemError {
        source_path: String,
        file_name: String,
        phase: String,
        message: String,
        elapsed_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    ItemCancelled {
        source_path: String,
        file_name: String,
        phase: String,
        elapsed_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    BatchFinished {
        total: usize,
        completed: usize,
        failed: usize,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperReviewResult {
    pub source_path: String,
    pub markdown: String,
    pub saved_path: String,
    pub title: String,
    pub year: String,
    pub venue: String,
    pub slug: String,
    pub summary: String,
    pub elapsed_ms: u64,
    pub extractor: String,
    pub extraction_warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperPreviewMeta {
    pub title: String,
    pub year: String,
    pub venue: String,
    pub summary: String,
}

#[derive(Debug, Clone)]
struct PaperModelResponse {
    title: String,
    year: String,
    venue: String,
    slug: String,
    markdown: String,
    summary: String,
}

#[derive(Debug, Deserialize)]
struct PaperMetaBlock {
    #[serde(default)]
    title: String,
    #[serde(default)]
    year: String,
    #[serde(default)]
    venue: String,
    #[serde(default)]
    summary: String,
}

#[derive(Debug)]
struct ParsedPaperReview {
    response: PaperModelResponse,
    parse_warning: Option<String>,
}

#[derive(Debug, Default)]
struct PreviewAccumulator {
    raw: String,
    sent_preview_len: usize,
    ready_sent: bool,
}

#[derive(Debug, Default)]
struct PreviewUpdate {
    ready: bool,
    delta: Option<String>,
    preview_chars: usize,
    preview_meta: Option<PaperPreviewMeta>,
}

pub async fn test_connection(config: &AppConfig) -> Result<String> {
    llm::test_connection(&paper_runtime_config(config)).await
}

pub async fn generate_reviews_stream(
    paths: Vec<String>,
    config: AppConfig,
    project_name: Option<String>,
    on_event: tauri::ipc::Channel<PaperStreamEvent>,
) -> Result<(), String> {
    let runtime_config = paper_runtime_config(&config);
    let project_name = normalize_optional_project(project_name);
    let registered_paths = paths.clone();
    let total = paths.len();
    let semaphore = Arc::new(Semaphore::new(PAPER_CONCURRENCY));

    for path in &registered_paths {
        register_review_cancel(path);
    }

    let mut completed = 0usize;
    let mut failed = 0usize;
    let mut tasks = stream::iter(paths.into_iter().map(|path| {
        let config = runtime_config.clone();
        let on_event = on_event.clone();
        let project_name = project_name.clone();
        let semaphore = semaphore.clone();
        async move { review_single(path, config, project_name, on_event, semaphore).await }
    }))
    .buffer_unordered(total.max(1));

    while let Some(result) = tasks.next().await {
        match result {
            Ok(_) => completed += 1,
            Err(err) => {
                if !is_review_stopped_error(&err) {
                    failed += 1;
                }
            }
        }
    }

    for path in registered_paths {
        clear_review_cancel(&path);
    }

    let _ = on_event.send(PaperStreamEvent::BatchFinished {
        total,
        completed,
        failed,
    });
    Ok(())
}

async fn review_single(
    path: String,
    config: AppConfig,
    project_name: Option<String>,
    on_event: tauri::ipc::Channel<PaperStreamEvent>,
    semaphore: Arc<Semaphore>,
) -> Result<()> {
    let started_at = Instant::now();
    let file_name = Path::new(&path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let mut cancel_rx = subscribe_review_cancel(&path);

    if *cancel_rx.borrow() {
        return send_cancelled(path, file_name, "queued".into(), 0, on_event);
    }

    let _permit = tokio::select! {
        _ = cancel_rx.changed() => {
            if *cancel_rx.borrow() {
                return send_cancelled(path, file_name, "queued".into(), 0, on_event);
            }
            unreachable!()
        }
        permit = semaphore.clone().acquire_owned() => {
            permit.map_err(|err| anyhow!(err.to_string()))?
        }
    };

    if should_cancel(&cancel_rx) {
        return send_cancelled(
            path,
            file_name,
            "queued".into(),
            started_at.elapsed().as_millis() as u64,
            on_event,
        );
    }

    let _ = on_event.send(PaperStreamEvent::ItemStarted {
        source_path: path.clone(),
        file_name: file_name.clone(),
    });
    let _ = on_event.send(PaperStreamEvent::ItemPhaseChanged {
        source_path: path.clone(),
        phase: "extracting".into(),
        message: "正在提取 PDF 文本".into(),
    });

    let extract_path = path.clone();
    let extracted =
        match tokio::task::spawn_blocking(move || pdf::extract_pdf_text_for_paper(&extract_path))
            .await
            .map_err(|err| anyhow!(err.to_string()))
            .and_then(|value| value)
        {
            Ok(value) => value,
            Err(err) => {
                return send_error(
                    path,
                    file_name,
                    "extracting".into(),
                    err.to_string(),
                    started_at.elapsed().as_millis() as u64,
                    on_event,
                );
            }
        };

    if should_cancel(&cancel_rx) {
        return send_cancelled(
            path,
            file_name,
            "extracting".into(),
            started_at.elapsed().as_millis() as u64,
            on_event,
        );
    }

    let _ = on_event.send(PaperStreamEvent::ItemPhaseChanged {
        source_path: path.clone(),
        phase: "generating".into(),
        message: "正在生成论文解读".into(),
    });
    let _ = on_event.send(PaperStreamEvent::ItemPreviewStarted {
        source_path: path.clone(),
        file_name: file_name.clone(),
    });

    let paper_text = trim_references_for_prompt(&extracted.text);
    let prompt = build_review_prompt(
        &file_name,
        &paper_text,
        &config.paper_review_prompt_template,
    );
    let (model_name, host) = match config.provider.as_str() {
        "openai" => (
            config.openai_model.as_str(),
            streaming::host_for_logging(&config.openai_base_url),
        ),
        _ => (
            config.ollama_model.as_str(),
            streaming::host_for_logging(&config.ollama_url),
        ),
    };
    eprintln!(
        "[paper-perf] review_single.input file={} path={} extractor={} extractedChars={} reviewChars={} promptChars={} provider={} model={} host={}",
        file_name,
        path,
        extracted.extractor,
        extracted.text.chars().count(),
        paper_text.chars().count(),
        prompt.chars().count(),
        config.provider,
        model_name,
        host
    );
    let mut preview = PreviewAccumulator::default();
    let response =
        call_review_model_stream(&config, &file_name, &prompt, &mut cancel_rx, |delta| {
            let update = preview.push(delta);
            if update.ready {
                let _ = on_event.send(PaperStreamEvent::ItemPreviewReady {
                    source_path: path.clone(),
                    preview_chars: update.preview_chars,
                    preview_meta: update.preview_meta,
                });
            }
            if let Some(preview_delta) = update.delta {
                let _ = on_event.send(PaperStreamEvent::ItemPreviewDelta {
                    source_path: path.clone(),
                    delta: preview_delta,
                    preview_chars: update.preview_chars,
                });
            }
        })
        .await;

    let response = match response {
        Ok(value) => value,
        Err(err) => {
            if is_review_stopped_error(&err) || should_cancel(&cancel_rx) {
                return send_cancelled(
                    path,
                    file_name,
                    "generating".into(),
                    started_at.elapsed().as_millis() as u64,
                    on_event,
                );
            }
            return send_error(
                path,
                file_name,
                "generating".into(),
                err.to_string(),
                started_at.elapsed().as_millis() as u64,
                on_event,
            );
        }
    };

    let _ = on_event.send(PaperStreamEvent::ItemPhaseChanged {
        source_path: path.clone(),
        phase: "saving".into(),
        message: "正在保存 Markdown".into(),
    });

    if should_cancel(&cancel_rx) {
        return send_cancelled(
            path,
            file_name,
            "saving".into(),
            started_at.elapsed().as_millis() as u64,
            on_event,
        );
    }

    let parsed = response;
    let save_root = effective_archive_root(&config);
    let save_plan = build_save_plan(&save_root, project_name.as_deref(), &parsed.response);
    let markdown = parsed.response.markdown.trim().to_string();
    if markdown.is_empty() {
        return send_error(
            path,
            file_name,
            "saving".into(),
            "模型返回了空的论文解读内容".into(),
            started_at.elapsed().as_millis() as u64,
            on_event,
        );
    }

    let save_path = save_plan.path.clone();
    let save_markdown = markdown.clone();
    match tokio::task::spawn_blocking(move || save_review(&save_path, &save_markdown))
        .await
        .map_err(|err| anyhow!(err.to_string()))
        .and_then(|value| value)
    {
        Ok(_) => {}
        Err(err) => {
            return send_error(
                path,
                file_name,
                "saving".into(),
                err.to_string(),
                started_at.elapsed().as_millis() as u64,
                on_event,
            );
        }
    }

    let result = PaperReviewResult {
        source_path: path.clone(),
        markdown,
        saved_path: save_plan.path.to_string_lossy().to_string(),
        title: save_plan.title,
        year: save_plan.year,
        venue: save_plan.venue,
        slug: save_plan.slug,
        summary: parsed.response.summary.trim().to_string(),
        elapsed_ms: started_at.elapsed().as_millis() as u64,
        extractor: extracted.extractor,
        extraction_warning: merge_warnings(extracted.warning, parsed.parse_warning),
    };

    clear_review_cancel(&path);
    let _ = on_event.send(PaperStreamEvent::ItemDone {
        source_path: path,
        file_name,
        result,
    });
    Ok(())
}

fn send_error(
    path: String,
    file_name: String,
    phase: String,
    message: String,
    elapsed_ms: u64,
    on_event: tauri::ipc::Channel<PaperStreamEvent>,
) -> Result<()> {
    clear_review_cancel(&path);
    let _ = on_event.send(PaperStreamEvent::ItemError {
        source_path: path,
        file_name,
        phase,
        message: message.clone(),
        elapsed_ms,
    });
    Err(anyhow!(message))
}

fn send_cancelled(
    path: String,
    file_name: String,
    phase: String,
    elapsed_ms: u64,
    on_event: tauri::ipc::Channel<PaperStreamEvent>,
) -> Result<()> {
    clear_review_cancel(&path);
    let _ = on_event.send(PaperStreamEvent::ItemCancelled {
        source_path: path,
        file_name,
        phase,
        elapsed_ms,
    });
    Err(anyhow!(STOPPED_REASON))
}

async fn call_review_model_stream<F>(
    config: &AppConfig,
    file_name: &str,
    prompt: &str,
    cancel_rx: &mut watch::Receiver<bool>,
    mut on_delta: F,
) -> Result<ParsedPaperReview>
where
    F: FnMut(&str),
{
    match config.provider.as_str() {
        "openai" => {
            call_openai_review_stream(config, file_name, prompt, cancel_rx, &mut on_delta).await
        }
        _ => call_ollama_review_stream(config, file_name, prompt, cancel_rx, &mut on_delta).await,
    }
}

async fn call_openai_review_stream<F>(
    config: &AppConfig,
    file_name: &str,
    prompt: &str,
    cancel_rx: &mut watch::Receiver<bool>,
    on_delta: &mut F,
) -> Result<ParsedPaperReview>
where
    F: FnMut(&str),
{
    let base = config.openai_base_url.trim_end_matches('/');
    let mut trace = streaming::StreamTrace::new(
        "paper-review",
        "openai",
        &config.openai_model,
        base,
        file_name,
        prompt.chars().count(),
    );
    let url = format!("{}/chat/completions", base);
    let body = json!({
        "model": config.openai_model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": true
    });
    let client = streaming::build_streaming_http_client()?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.openai_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() {
                anyhow!("无法连接 API ({}): {}", base, e)
            } else if streaming::is_timeout_like_error(&e) {
                let message = streaming::stream_idle_timeout_message();
                trace.log_error(&e, message);
                anyhow!(message)
            } else {
                anyhow!("API 网络错误 ({}): {}", base, e)
            }
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("API 请求失败 {}: {}", status, text));
    }

    let mut raw = String::new();
    let mut buffer = String::new();
    let mut stream = resp.bytes_stream();

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
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(err) => {
                let classified = streaming::classify_stream_error(&err);
                let user_message = classified.to_string();
                trace.log_error(&err, &user_message);
                return Err(classified);
            }
        };
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
                    trace.record_delta(&delta);
                    on_delta(&delta);
                    raw.push_str(&delta);
                }
            }
        }
    }

    trace.log_complete();
    parse_streamed_review(&raw, file_name)
}

async fn call_ollama_review_stream<F>(
    config: &AppConfig,
    file_name: &str,
    prompt: &str,
    cancel_rx: &mut watch::Receiver<bool>,
    on_delta: &mut F,
) -> Result<ParsedPaperReview>
where
    F: FnMut(&str),
{
    let url = format!("{}/api/chat", config.ollama_url.trim_end_matches('/'));
    let mut trace = streaming::StreamTrace::new(
        "paper-review",
        "ollama",
        &config.ollama_model,
        &config.ollama_url,
        file_name,
        prompt.chars().count(),
    );
    let body = json!({
        "model": config.ollama_model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": true,
        "options": { "num_predict": 8192 }
    });
    let client = streaming::build_streaming_http_client()?;
    let resp = client.post(&url).json(&body).send().await.map_err(|e| {
        if e.is_connect() {
            anyhow!("无法连接 Ollama（{}），请确认已启动", config.ollama_url)
        } else if streaming::is_timeout_like_error(&e) {
            let message = streaming::stream_idle_timeout_message();
            trace.log_error(&e, message);
            anyhow!(message)
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
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(err) => {
                let classified = streaming::classify_stream_error(&err);
                let user_message = classified.to_string();
                trace.log_error(&err, &user_message);
                return Err(classified);
            }
        };
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
                trace.record_delta(delta);
                on_delta(delta);
                raw.push_str(delta);
            }
        }
    }

    trace.log_complete();
    parse_streamed_review(&raw, file_name)
}

fn extract_json_object(raw: &str) -> Option<&str> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    (end > start).then_some(&raw[start..=end])
}

impl PreviewAccumulator {
    fn push(&mut self, delta: &str) -> PreviewUpdate {
        self.raw.push_str(delta);

        let preview = extract_markdown_block(&self.raw).unwrap_or_default();
        if preview.is_empty() {
            return PreviewUpdate::default();
        }

        let preview_chars = preview.chars().count();
        let ready = !self.ready_sent;
        if ready {
            self.ready_sent = true;
        }

        let next_delta = if preview.len() > self.sent_preview_len {
            let slice = preview
                .get(self.sent_preview_len..)
                .unwrap_or_default()
                .to_string();
            self.sent_preview_len = preview.len();
            Some(slice)
        } else {
            None
        };

        PreviewUpdate {
            ready,
            delta: next_delta.filter(|value| !value.is_empty()),
            preview_chars,
            preview_meta: if ready {
                extract_preview_meta(&self.raw)
            } else {
                None
            },
        }
    }
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

fn extract_preview_meta(raw: &str) -> Option<PaperPreviewMeta> {
    let meta_block = extract_meta_block(raw)?;
    let json_text = extract_json_object(meta_block).unwrap_or(meta_block).trim();
    let parsed: PaperMetaBlock = serde_json::from_str(json_text).ok()?;
    Some(PaperPreviewMeta {
        title: parsed.title.trim().to_string(),
        year: parsed.year.trim().to_string(),
        venue: parsed.venue.trim().to_string(),
        summary: parsed.summary.trim().to_string(),
    })
}

fn extract_meta_block(raw: &str) -> Option<&str> {
    let meta_idx = raw.find(FYLA_META_MARKER)?;
    let after_meta = &raw[meta_idx + FYLA_META_MARKER.len()..];
    let markdown_idx = after_meta.find(FYLA_MARKDOWN_MARKER)?;
    Some(after_meta[..markdown_idx].trim())
}

fn extract_markdown_block(raw: &str) -> Option<&str> {
    let markdown_idx = raw.find(FYLA_MARKDOWN_MARKER)?;
    let after = &raw[markdown_idx + FYLA_MARKDOWN_MARKER.len()..];
    Some(after.trim_start_matches(['\r', '\n']))
}

fn parse_streamed_review(raw: &str, file_name: &str) -> Result<ParsedPaperReview> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("模型返回了空的论文解读内容"));
    }

    let preview_meta = extract_preview_meta(trimmed);
    let markdown = extract_markdown_block(trimmed)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| trimmed.to_string());

    if markdown.trim().is_empty() {
        return Err(anyhow!("模型返回了空的论文解读内容"));
    }

    let fallback_title = infer_title_from_markdown(&markdown)
        .unwrap_or_else(|| file_stem_or_name(file_name).to_string());
    let meta = preview_meta.unwrap_or(PaperPreviewMeta {
        title: fallback_title.clone(),
        year: String::new(),
        venue: String::new(),
        summary: extract_summary_from_markdown(&markdown).unwrap_or_default(),
    });

    let mut parse_warning = None;
    if extract_meta_block(trimmed).is_none() {
        parse_warning = Some("元信息未按流式标记返回，已基于正文回退提取".into());
    } else if extract_preview_meta(trimmed).is_none() {
        parse_warning = Some("元信息解析失败，已基于正文回退提取".into());
    }

    let title = if meta.title.trim().is_empty() {
        fallback_title
    } else {
        meta.title.trim().to_string()
    };
    let year = meta.year.trim().to_string();
    let venue = meta.venue.trim().to_string();
    let summary = if meta.summary.trim().is_empty() {
        extract_summary_from_markdown(&markdown).unwrap_or_default()
    } else {
        meta.summary.trim().to_string()
    };
    let slug = normalize_slug("", &title);

    Ok(ParsedPaperReview {
        response: PaperModelResponse {
            title,
            year,
            venue,
            slug,
            markdown,
            summary,
        },
        parse_warning,
    })
}

fn infer_title_from_markdown(markdown: &str) -> Option<String> {
    for line in markdown.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("- **标题**：") || trimmed.starts_with("- **标题**:") {
            return Some(
                trimmed
                    .split_once('：')
                    .or_else(|| trimmed.split_once(':'))
                    .map(|(_, value)| value.trim().to_string())
                    .unwrap_or_default(),
            )
            .filter(|value| !value.is_empty());
        }
    }
    markdown
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with('#') && !line.trim_matches('#').trim().is_empty())
        .map(|line| line.trim_matches('#').trim().to_string())
}

fn extract_summary_from_markdown(markdown: &str) -> Option<String> {
    let lines: Vec<&str> = markdown.lines().collect();
    for (idx, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.contains("TL;DR") {
            for next in lines.iter().skip(idx + 1) {
                let candidate = next.trim();
                if candidate.is_empty() || candidate.starts_with('#') {
                    continue;
                }
                return Some(candidate.to_string());
            }
        }
    }

    lines
        .iter()
        .map(|line| line.trim())
        .find(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("---"))
        .map(|line| line.to_string())
}

fn file_stem_or_name(file_name: &str) -> &str {
    Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(file_name)
}

fn merge_warnings(base: Option<String>, extra: Option<String>) -> Option<String> {
    match (base, extra) {
        (Some(a), Some(b)) => Some(format!("{}\n\n{}", a.trim(), b.trim())),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

pub fn stop_review(source_path: String) -> Result<()> {
    trigger_review_stop(&source_path);
    Ok(())
}

fn register_review_cancel(path: &str) {
    let (sender, _receiver) = watch::channel(false);
    paper_review_cancel_registry()
        .lock()
        .unwrap()
        .insert(path.to_string(), sender);
}

fn subscribe_review_cancel(path: &str) -> watch::Receiver<bool> {
    if let Some(sender) = paper_review_cancel_registry()
        .lock()
        .unwrap()
        .get(path)
        .cloned()
    {
        sender.subscribe()
    } else {
        let (sender, receiver) = watch::channel(false);
        paper_review_cancel_registry()
            .lock()
            .unwrap()
            .insert(path.to_string(), sender);
        receiver
    }
}

fn trigger_review_stop(path: &str) {
    if let Some(sender) = paper_review_cancel_registry()
        .lock()
        .unwrap()
        .get(path)
        .cloned()
    {
        let _ = sender.send(true);
    }
}

fn clear_review_cancel(path: &str) {
    paper_review_cancel_registry().lock().unwrap().remove(path);
}

fn should_cancel(cancel_rx: &watch::Receiver<bool>) -> bool {
    *cancel_rx.borrow()
}

fn is_review_stopped_error(err: &anyhow::Error) -> bool {
    err.to_string().contains(STOPPED_REASON)
}

fn resolve_review_prompt_template(template: &str) -> &str {
    let trimmed = template.trim();
    if trimmed.is_empty() {
        DEFAULT_REVIEW_PROMPT_TEMPLATE.trim()
    } else {
        trimmed
    }
}

fn build_review_prompt(file_name: &str, text: &str, template: &str) -> String {
    let review_template = resolve_review_prompt_template(template);
    format!(
        "你只能依据我提供的 PDF 提取文本进行分析，禁止联网、禁止引用外部资料、禁止脑补论文未提供的信息。\n\
你必须严格按以下格式输出，不要添加代码块围栏，不要添加额外解释：\n\
1. 先单独输出一行 `{FYLA_META_MARKER}`\n\
2. 下一行输出一个单行 JSON 对象，只包含：title、year、venue、summary\n\
3. 再单独输出一行 `{FYLA_MARKDOWN_MARKER}`\n\
4. 其后直接输出完整 Markdown 论文解读正文\n\
其中：\n\
- title：论文标题，优先使用论文原文标题。\n\
- year：4 位年份；如果 PDF 中无法可靠确认，返回空字符串。\n\
- venue：会议或期刊简称；如果 PDF 中无法可靠确认，返回空字符串。\n\
- summary：1-2 句简短总结。\n\n\
{review_template}\n\n\
文件名：{file_name}\n\n\
以下是从 PDF 中提取的全文文本：\n{text}"
    )
}

fn trim_references_for_prompt(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return String::new();
    }

    let mut cut_idx = None;
    for (idx, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        let lower = trimmed.to_lowercase();
        let looks_like_references = matches!(
            lower.as_str(),
            "references"
                | "# references"
                | "## references"
                | "bibliography"
                | "# bibliography"
                | "## bibliography"
        );
        if looks_like_references && idx > lines.len() / 2 {
            cut_idx = Some(idx);
            break;
        }
    }

    let kept = match cut_idx {
        Some(idx) => &lines[..idx],
        None => &lines[..],
    };

    kept.join("\n").trim().to_string()
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

fn effective_archive_root(config: &AppConfig) -> PathBuf {
    let value = config.paper_archive_root.trim();
    if value.is_empty() {
        PathBuf::from("/Users/chenghaoyang/Local/papers")
    } else {
        PathBuf::from(value)
    }
}

#[derive(Debug)]
struct SavePlan {
    path: PathBuf,
    title: String,
    year: String,
    venue: String,
    slug: String,
}

fn build_save_plan(
    root: &Path,
    project_name: Option<&str>,
    response: &PaperModelResponse,
) -> SavePlan {
    let title = response.title.trim().to_string();
    let year = response.year.trim().to_string();
    let venue = response.venue.trim().to_string();
    let slug = normalize_slug(&response.slug, &title);
    let file_year = normalize_year(&response.year);
    let file_venue = normalize_venue(&response.venue);
    let file_name = format!("{}-{}-{}.md", file_year, file_venue, slug);

    let path = if let Some(project) = project_name {
        root.join("projects")
            .join(sanitize_path_segment(project))
            .join(file_name)
    } else {
        root.join("inbox").join(file_name)
    };

    SavePlan {
        path,
        title,
        year,
        venue,
        slug,
    }
}

fn save_review(path: &Path, markdown: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, markdown)?;
    Ok(())
}

fn normalize_year(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() == 4 && trimmed.chars().all(|ch| ch.is_ascii_digit()) {
        trimmed.to_string()
    } else {
        trimmed
            .chars()
            .filter(|ch| ch.is_ascii_digit())
            .collect::<String>()
            .chars()
            .take(4)
            .collect::<String>()
            .chars()
            .count()
            .eq(&4)
            .then(|| {
                trimmed
                    .chars()
                    .filter(|ch| ch.is_ascii_digit())
                    .take(4)
                    .collect::<String>()
            })
            .unwrap_or_else(|| "0000".into())
    }
}

fn normalize_venue(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "arXiv".into();
    }
    trimmed
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>()
        .chars()
        .take(24)
        .collect()
}

fn normalize_slug(raw: &str, title: &str) -> String {
    let candidate = if raw.trim().is_empty() { title } else { raw };
    let slug = slugify(candidate);
    if slug.is_empty() {
        "paper".into()
    } else {
        slug
    }
}

fn slugify(input: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in input.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            out.push(lower);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

fn sanitize_path_segment(input: &str) -> String {
    let sanitized = input
        .trim()
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            _ => ch,
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "project".into()
    } else {
        sanitized
    }
}

fn normalize_optional_project(value: Option<String>) -> Option<String> {
    value.and_then(|project| {
        let trimmed = project.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_template_uses_default_review_prompt_template() {
        let resolved = resolve_review_prompt_template("   \n");
        assert!(resolved.contains("## Part A"));
        assert!(resolved.contains("## Part B"));
    }

    #[test]
    fn custom_template_keeps_protocol_markers_and_body() {
        let prompt = build_review_prompt(
            "demo.pdf",
            "paper body",
            "请重点关注实验设计，并保持输出结构不变。",
        );

        assert!(prompt.contains(FYLA_META_MARKER));
        assert!(prompt.contains(FYLA_MARKDOWN_MARKER));
        assert!(prompt.contains("请重点关注实验设计"));
        assert!(prompt.contains("文件名：demo.pdf"));
        assert!(prompt.contains("以下是从 PDF 中提取的全文文本：\npaper body"));
    }
}
