use crate::config::AppConfig;
use crate::{llm, pdf};
use anyhow::{Result, anyhow};
use futures_util::stream::{self, StreamExt};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::Instant;

const PAPER_CONCURRENCY: usize = 3;
const FYLA_META_MARKER: &str = "<<<FYLA_META>>>";
const FYLA_MARKDOWN_MARKER: &str = "<<<FYLA_MARKDOWN>>>";

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
        message: String,
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
    let total = paths.len();

    let mut completed = 0usize;
    let mut failed = 0usize;
    let mut tasks = stream::iter(paths.into_iter().map(|path| {
        let config = runtime_config.clone();
        let on_event = on_event.clone();
        let project_name = project_name.clone();
        async move { review_single(path, config, project_name, on_event).await }
    }))
    .buffer_unordered(PAPER_CONCURRENCY);

    while let Some(result) = tasks.next().await {
        match result {
            Ok(_) => completed += 1,
            Err(_) => failed += 1,
        }
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
) -> Result<()> {
    let started_at = Instant::now();
    let file_name = Path::new(&path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
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
    let extracted = tokio::task::spawn_blocking(move || pdf::extract_pdf_text_for_paper(&extract_path))
        .await
        .map_err(|err| anyhow!(err.to_string()))??;

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
    let prompt = build_review_prompt(&file_name, &paper_text);
    let mut preview = PreviewAccumulator::default();
    let response = call_review_model_stream(&config, &file_name, &prompt, |delta| {
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
    }).await?;

    let _ = on_event.send(PaperStreamEvent::ItemPhaseChanged {
        source_path: path.clone(),
        phase: "saving".into(),
        message: "正在保存 Markdown".into(),
    });

    let parsed = response;
    let save_root = effective_archive_root(&config);
    let save_plan = build_save_plan(&save_root, project_name.as_deref(), &parsed.response);
    let markdown = parsed.response.markdown.trim().to_string();
    if markdown.is_empty() {
        return send_error(
            path,
            file_name,
            "模型返回了空的论文解读内容".into(),
            started_at.elapsed().as_millis() as u64,
            on_event,
        );
    }

    let save_path = save_plan.path.clone();
    let save_markdown = markdown.clone();
    tokio::task::spawn_blocking(move || save_review(&save_path, &save_markdown))
        .await
        .map_err(|err| anyhow!(err.to_string()))??;

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
    message: String,
    elapsed_ms: u64,
    on_event: tauri::ipc::Channel<PaperStreamEvent>,
) -> Result<()> {
    let _ = on_event.send(PaperStreamEvent::ItemError {
        source_path: path,
        file_name,
        message: message.clone(),
        elapsed_ms,
    });
    Err(anyhow!(message))
}

async fn call_review_model_stream<F>(
    config: &AppConfig,
    file_name: &str,
    prompt: &str,
    mut on_delta: F,
) -> Result<ParsedPaperReview>
where
    F: FnMut(&str),
{
    match config.provider.as_str() {
        "openai" => call_openai_review_stream(config, file_name, prompt, &mut on_delta).await,
        _ => call_ollama_review_stream(config, file_name, prompt, &mut on_delta).await,
    }
}

async fn call_openai_review_stream<F>(
    config: &AppConfig,
    file_name: &str,
    prompt: &str,
    on_delta: &mut F,
) -> Result<ParsedPaperReview>
where
    F: FnMut(&str),
{
    let base = config.openai_base_url.trim_end_matches('/');
    let url = format!("{}/chat/completions", base);
    let body = json!({
        "model": config.openai_model,
        "messages": [{"role": "user", "content": prompt}],
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

    while let Some(chunk) = stream.next().await {
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
                    on_delta(&delta);
                    raw.push_str(&delta);
                }
            }
        }
    }

    parse_streamed_review(&raw, file_name)
}

async fn call_ollama_review_stream<F>(
    config: &AppConfig,
    file_name: &str,
    prompt: &str,
    on_delta: &mut F,
) -> Result<ParsedPaperReview>
where
    F: FnMut(&str),
{
    let url = format!("{}/api/chat", config.ollama_url.trim_end_matches('/'));
    let body = json!({
        "model": config.ollama_model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": true,
        "options": { "num_predict": 8192 }
    });
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()?;
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
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

    while let Some(chunk) = stream.next().await {
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
                on_delta(delta);
                raw.push_str(delta);
            }
        }
    }

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

    lines.iter()
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

fn build_review_prompt(file_name: &str, text: &str) -> String {
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
你是一名大模型（LLM）方向的资深研究者与技术审稿人。我会上传一篇论文的 PDF，请你完整阅读后，按照以下结构对论文进行系统化解读。要求：所有结论必须基于论文原文，带具体数字和证据，不要空洞概括。输出使用 Markdown 格式。\n\n\
**引用规范**：提到其他论文时，不要用\"Yi et al. (2023)\"这种人名引用格式，而是用该论文提出的方法名或框架名（如 DPO、RLHF、ReAct）。如果没有明确的方法名，则用论文标题。目的是让读者一眼就能识别出是哪篇工作。\n\n\
请按以下结构输出：\n\n\
---\n\n\
## Part A：速读\n\n\
### 1. 论文信息\n\n\
- **标题**：论文原标题\n\
- **作者/单位**：第一作者及主要单位\n\
- **发表**：会议/期刊，年份\n\
- **链接**：原文链接（如有）\n\
- **代码/数据**：开源地址（如有）\n\n\
### 2. TL;DR（≤3 句话）\n\n\
用三句话概括：解决什么问题？怎么做的？效果如何（带数字）？\n\n\
### 3. Core Insight（≤2 句话）\n\n\
提炼这篇论文最核心的 intellectual contribution。不要复述摘要，而是回答：作者看到了什么别人没看到的东西？发现了什么现象、提出了什么新视角、或建立了什么之前没有的联系？\n\n\
### 4. 关键结果速览\n\n\
列出 3-5 个最重要的实验结论，每条一句话带数字。\n\n\
---\n\n\
## Part B：精读\n\n\
### 5. 问题与动机\n\n\
- **任务场景**：这篇论文处理的是什么任务？属于哪个研究方向？目标受众和应用场景是什么？\n\
- **现有方法的不足**：之前的方法存在什么具体问题？用论文中给出的数据或例子说明，不要泛泛而谈。\n\
- **核心假设/洞察**：作者基于什么观察或假设出发？这个假设有没有前置的实验验证或理论依据？\n\
- **与最相近工作的区别**：列出论文提到的 2-3 篇最相关的工作，逐一说明本文与它们的核心差异。要说清楚差异的维度（问题定义不同、方法路线不同、评估范围不同等），不要笼统说\"本文更好\"。\n\n\
### 6. Research Questions\n\n\
从论文中提炼出作者实际想回答的核心问题。很多论文不会显式列出 RQ，你需要从 introduction 的贡献列表、实验章节的组织结构、以及消融实验的设计中归纳出来。通常 2-4 个。\n\n\
- **RQ1**：\n\
- **RQ2**：\n\
- **RQ3**：\n\n\
### 7. 方法\n\n\
**7.1 整体框架**\n\n\
用 3-5 句话概括方法的完整流程和核心思路。如果是多阶段 pipeline，说清楚每个阶段的输入、输出和核心操作。\n\n\
**7.2 关键设计选择**\n\n\
找出方法中最重要的 2-3 个设计决策。对每个决策，回答：\n\
- 具体做了什么？\n\
- 为什么选择这个方案而不是显而易见的替代方案？\n\
- 这个选择带来了什么 trade-off？\n\n\
**7.3 技术细节**\n\n\
根据论文实际内容展开，只写论文涉及的部分，不要硬凑。可能涉及但不限于：训练策略与损失函数设计、数据构造与质量控制、推理流程中的特殊设计、核心公式（逐符号解释含义和设计动机）等。\n\n\
### 8. 实验设置\n\n\
- **数据集/Benchmark**：用了哪些评估数据集？各自衡量什么能力？数据规模和来源？\n\
- **评估指标**：每个 metric 具体衡量什么？为什么选这些指标？如果使用了 LLM-as-judge，说明 judge 模型和评分标准。\n\
- **Baselines**：对比了哪些方法？这些 baseline 是否足够强和足够新？有没有明显应该比但没比的？\n\
- **其他关键配置**：列出影响结果的重要实验设置（如模型规模、关键超参数等）。\n\n\
### 9. 实验结果与分析\n\n\
**9.1 主要结果**\n\n\
- 在核心 benchmark 上的表现，必须带具体数字。\n\
- 与最强 baseline 的差距是多少？\n\
- 在不同设置下（如不同规模、不同任务）表现是否一致？有没有方法失效的场景？\n\n\
**9.2 按 RQ 组织的深入分析**\n\n\
对上面提炼的每个 RQ，逐一分析：\n\n\
**RQ1**：\n\
- 用了哪些实验或消融来回答这个问题？实验设计是否合理？\n\
- 关键数字是什么？\n\
- 能得出什么结论？支撑是否充分？\n\n\
**RQ2**：\n\
- （同上结构）\n\n\
**RQ3**：\n\
- （同上结构）\n\n\
**9.3 存疑之处**\n\n\
以审稿人视角审视：对比是否公平？有没有 cherry-picking 嫌疑？有没有缺失的关键实验（该做但没做的消融、该比但没比的 baseline）？评估本身是否可靠？\n\n\
### 10. 一句话总结\n\n\
用一句话概括这篇论文的核心贡献和价值定位。\n\n\
补充要求：\n\
- 若 PDF 中没有可靠提供链接、代码、数据、年份或 venue，请写“论文未提供”或保留为空，不要猜测。\n\
- 所有结论都必须锚定在下方 PDF 文本，不得编造实验结果。\n\
- 主体使用中文表达，方法名、模型名、数据集名、指标名保留英文。\n\n\
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
            "references" | "# references" | "## references" | "bibliography" | "# bibliography" | "## bibliography"
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
