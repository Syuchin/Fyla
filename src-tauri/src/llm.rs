use crate::config::AppConfig;
use anyhow::{Result, anyhow};
use reqwest::Client;
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Debug, Clone)]
pub struct FileContext {
    pub original_name: String,
    pub parent_dir: String,
    pub sibling_names: Vec<String>,
    pub modified_at: String,
    pub file_size: String,
}

/// Streaming event sent via Tauri Channel
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum StreamEvent {
    Thinking {
        file_name: String,
    },
    Partial {
        file_name: String,
        partial: String,
    },
    Done {
        file_name: String,
        suggested: String,
    },
    Error {
        file_name: String,
        message: String,
    },
}

/// 根据配置返回唯一的风格描述字符串，供 LLM/VLM prompt 共用
fn style_description(naming_style: &str) -> &'static str {
    match naming_style {
        "camelCase" => {
            "camelCase：首词全小写，后续词首字母大写，无分隔符。示例：invoiceAcmeCorp20240815"
        }
        "PascalCase" => "PascalCase：每个词首字母大写，无分隔符。示例：InvoiceAcmeCorp20240815",
        "snake_case" => "snake_case：全小写，下划线分隔。示例：invoice_acme_corp_20240815",
        "Train-Case" => {
            "Train-Case：每个词首字母大写其余小写，连字符分隔。示例：Invoice-Acme-Corp-20240815"
        }
        "chinese" => {
            "中文命名：使用简体中文，类型与标题之间用连字符分隔。示例：发票-Acme公司合作协议20240815"
        }
        _ => "kebab-case：全小写，连字符分隔。示例：invoice-acme-corp-20240815",
    }
}

fn context_section(context: Option<&FileContext>) -> String {
    if let Some(ctx) = context {
        let siblings = if ctx.sibling_names.is_empty() {
            "（无）".to_string()
        } else {
            ctx.sibling_names.join("、")
        };
        format!(
            "\n## 文件信息\n\
            - 原始文件名: {}\n\
            - 所在目录: {}\n\
            - 修改时间: {}\n\
            - 文件大小: {}\n\
            \n## 同目录已有文件（参考命名风格）\n{}\n",
            ctx.original_name, ctx.parent_dir, ctx.modified_at, ctx.file_size, siblings
        )
    } else {
        String::new()
    }
}

fn template_section(name_template: &str, naming_style: &str) -> String {
    let effective = if name_template.trim().is_empty() {
        "{type}-{title}"
    } else {
        name_template.trim()
    };
    let type_list = if naming_style == "chinese" {
        "发票、收据、合同、报告、论文、简历、信函、手册、表单、证书、演示文稿、电子表格、照片、文档"
    } else {
        "Invoice, Receipt, Contract, Report, Paper, Resume, Letter, \
        Manual, Form, Certificate, Presentation, Spreadsheet, Photo, Document"
    };
    format!(
        "\n## 命名模板\n\
        按「{}」格式输出。变量替换规则：\n\
        - {{type}} 从以下分类中选最匹配的一个：{}\n\
        - {{title}} 替换为文档标题/主题的关键词（2-5 个词）\n\
        - {{date}} 替换为文档日期（YYYYMMDD）\n\
        - {{author}} 替换为作者/发送方\n\
        - {{number}} 替换为文档编号\n\
        - 找不到的字段直接省略，不要留占位符\n",
        effective, type_list
    )
}

fn build_prompt(text: &str, config: &AppConfig, context: Option<&FileContext>) -> String {
    let style_desc = style_description(&config.naming_style);

    let date_hint = if config.include_date {
        "如果文档中包含日期信息，请在文件名末尾附上日期（格式 YYYYMMDD）。"
    } else {
        "不要在文件名中包含日期。"
    };

    let custom = if config.custom_rules.trim().is_empty() {
        String::new()
    } else {
        format!("\n\n## 用户自定义规则\n{}", config.custom_rules)
    };

    let template = template_section(&config.name_template, &config.naming_style);
    let ctx = context_section(context);

    let abbr_rule = if config.naming_style == "chinese" {
        "缩写词保持原样大写（例如 PDF、NASA）"
    } else {
        "缩写词也遵循同样规则（例如 FINCH → Finch, NASA → Nasa, PDF → Pdf）"
    };

    format!(
        "你是一个文件命名助手。根据以下文件内容生成一个文件名（不含扩展名）。\n\n\
        ## 格式规则（严格遵守，这是唯一的格式标准）\n\
        - 命名风格：{style_desc}\n\
        - {date_hint}\n\
        - {abbr_rule}\n\
        - 只输出文件名本身，不要解释、不要加引号、不要加扩展名\n\
        - 不含空格和文件系统非法字符（/ \\ : * ? \" < > |）{custom}{template}\
        {ctx}\n\
        ## 文件内容\n{text}"
    )
}

/// Builds the LLM prompt from file text and config (public wrapper for Tauri commands).
pub fn build_prompt_public(
    text: &str,
    config: &AppConfig,
    context: Option<&FileContext>,
) -> String {
    build_prompt(text, config, context)
}

/// Tests LLM provider connectivity and model availability.
pub async fn test_connection(config: &AppConfig) -> Result<String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;

    match config.provider.as_str() {
        "openai" => {
            let base = config.openai_base_url.trim_end_matches('/');
            let url = format!("{}/models", base);
            let resp = client
                .get(&url)
                .header("Authorization", format!("Bearer {}", config.openai_key))
                .send()
                .await
                .map_err(|e| anyhow!("无法连接 API ({}): {}", base, e))?;
            if resp.status().is_success() {
                Ok(format!("连接成功: {}", base))
            } else if resp.status().as_u16() == 401 {
                Err(anyhow!("API Key 无效，请检查"))
            } else {
                Err(anyhow!("API 返回错误: {}", resp.status()))
            }
        }
        _ => {
            let url = format!("{}/api/tags", config.ollama_url.trim_end_matches('/'));
            let resp = client.get(&url).send().await.map_err(|e| {
                if e.is_connect() {
                    anyhow!("无法连接 Ollama（{}），请确认已启动", config.ollama_url)
                } else {
                    anyhow!("Ollama 连接错误: {}", e)
                }
            })?;
            if resp.status().is_success() {
                let data: Value = resp.json().await?;
                let models: Vec<&str> = data["models"]
                    .as_array()
                    .map(|arr| arr.iter().filter_map(|m| m["name"].as_str()).collect())
                    .unwrap_or_default();
                if models.iter().any(|m| m.starts_with(&config.ollama_model)) {
                    Ok(format!(
                        "Ollama 连接成功，模型 {} 可用",
                        config.ollama_model
                    ))
                } else {
                    Err(anyhow!(
                        "Ollama 已连接，但模型 {} 未找到。可用: {}",
                        config.ollama_model,
                        models.join(", ")
                    ))
                }
            } else {
                Err(anyhow!("Ollama 返回错误: {}", resp.status()))
            }
        }
    }
}

/// Generates a filename from extracted text using the configured LLM, with retries.
pub async fn generate_filename(
    text: &str,
    config: &AppConfig,
    context: Option<&FileContext>,
) -> Result<String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()?;

    let prompt = build_prompt(text, config, context);

    let max_retries = 2;
    let mut last_err = anyhow!("未知错误");

    for attempt in 0..=max_retries {
        match call_llm(&client, &prompt, config).await {
            Ok(result) => {
                let ext = context.and_then(|ctx| {
                    std::path::Path::new(&ctx.original_name)
                        .extension()
                        .map(|e| format!(".{}", e.to_string_lossy()))
                });
                let cleaned = clean_filename(&result, ext.as_deref());

                if cleaned.is_empty() {
                    last_err = anyhow!("AI 返回了空文件名");
                } else {
                    return Ok(cleaned);
                }
            }
            Err(e) => {
                last_err = e;
            }
        }
        if attempt < max_retries {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }

    Err(anyhow!("重试 {} 次后仍失败: {}", max_retries + 1, last_err))
}

async fn call_llm(client: &Client, prompt: &str, config: &AppConfig) -> Result<String> {
    match config.provider.as_str() {
        "openai" => call_openai(client, prompt, config).await,
        _ => call_ollama(client, prompt, config).await,
    }
}

async fn call_ollama(client: &Client, prompt: &str, config: &AppConfig) -> Result<String> {
    let url = format!("{}/api/chat", config.ollama_url.trim_end_matches('/'));
    let body = json!({
        "model": config.ollama_model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": false,
        "options": { "num_predict": 80 }
    });

    let resp = client.post(&url).json(&body).send().await.map_err(|e| {
        if e.is_timeout() {
            anyhow!("Ollama 请求超时（60秒），模型可能过大或服务未响应")
        } else if e.is_connect() {
            anyhow!(
                "无法连接 Ollama（{}），请确认 Ollama 已启动",
                config.ollama_url
            )
        } else {
            anyhow!("Ollama 网络错误: {}", e)
        }
    })?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Ollama 请求失败 {}: {}", status, text));
    }

    let data: Value = resp.json().await?;
    let content = data["message"]["content"]
        .as_str()
        .ok_or_else(|| anyhow!("Ollama 响应格式错误"))?
        .to_string();
    Ok(content)
}

async fn call_openai(client: &Client, prompt: &str, config: &AppConfig) -> Result<String> {
    let base = config.openai_base_url.trim_end_matches('/');
    let url = format!("{}/chat/completions", base);
    let body = json!({
        "model": config.openai_model,
        "messages": [{"role": "user", "content": prompt}],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "filename_result",
                "strict": true,
                "schema": {
                    "type": "object",
                    "properties": {
                        "filename": { "type": "string" }
                    },
                    "required": ["filename"],
                    "additionalProperties": false
                }
            }
        }
    });

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

    let data: Value = resp.json().await?;
    let content = data["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| anyhow!("API 响应格式错误"))?;

    // 尝试从 JSON 响应中提取 filename 字段
    if let Ok(parsed) = serde_json::from_str::<Value>(content)
        && let Some(filename) = parsed["filename"].as_str()
    {
        return Ok(filename.to_string());
    }
    // fallback: 直接返回原始内容
    Ok(content.to_string())
}

/// Generates a filename from an image using a vision-language model, with retries.
pub async fn generate_filename_vlm(
    image_base64: &str,
    mime: &str,
    config: &AppConfig,
    context: Option<&FileContext>,
) -> Result<String> {
    let prompt = build_vlm_prompt(config, context);

    let max_retries = 2;
    let mut last_err = anyhow!("未知错误");

    for attempt in 0..=max_retries {
        match call_vlm(&prompt, image_base64, mime, config).await {
            Ok(result) => {
                let ext = context.and_then(|ctx| {
                    std::path::Path::new(&ctx.original_name)
                        .extension()
                        .map(|e| format!(".{}", e.to_string_lossy()))
                });
                let cleaned = clean_filename(&result, ext.as_deref());

                if cleaned.is_empty() {
                    last_err = anyhow!("VLM 返回了空文件名");
                } else {
                    return Ok(cleaned);
                }
            }
            Err(e) => {
                last_err = e;
            }
        }
        if attempt < max_retries {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }

    Err(anyhow!(
        "VLM 重试 {} 次后仍失败: {}",
        max_retries + 1,
        last_err
    ))
}

fn build_vlm_prompt(config: &AppConfig, context: Option<&FileContext>) -> String {
    let style_desc = style_description(&config.naming_style);

    let date_hint = if config.include_date {
        "如果图片中包含日期信息，请在文件名末尾附上日期（格式 YYYYMMDD）。"
    } else {
        "不要在文件名中包含日期。"
    };

    let custom = if config.custom_rules.trim().is_empty() {
        String::new()
    } else {
        format!("\n\n## 用户自定义规则\n{}", config.custom_rules)
    };

    let template = template_section(&config.name_template, &config.naming_style);
    let ctx = context_section(context);

    let abbr_rule = if config.naming_style == "chinese" {
        "缩写词保持原样大写（例如 PDF、NASA）"
    } else {
        "缩写词也遵循同样规则（例如 FINCH → Finch, NASA → Nasa, PDF → Pdf）"
    };

    format!(
        "你是一个文件命名助手。根据这张图片的内容生成一个文件名（不含扩展名）。\n\n\
        ## 格式规则（严格遵守，这是唯一的格式标准）\n\
        - 命名风格：{style_desc}\n\
        - {date_hint}\n\
        - {abbr_rule}\n\
        - 只输出文件名本身，不要解释、不要加引号、不要加扩展名\n\
        - 不含空格和文件系统非法字符（/ \\ : * ? \" < > |）{custom}{template}\
        {ctx}"
    )
}

/// Sends an image + prompt to a VLM (OpenAI-compatible or Ollama) and returns the response.
pub async fn call_vlm(
    prompt: &str,
    image_base64: &str,
    mime: &str,
    config: &AppConfig,
) -> Result<String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()?;

    let (base_url, api_key, model) = if config.vlm_same_as_llm {
        match config.provider.as_str() {
            "openai" => (
                config.openai_base_url.clone(),
                config.openai_key.clone(),
                config.openai_model.clone(),
            ),
            _ => {
                // Ollama 也支持 vision，走 /api/chat
                return call_vlm_ollama(&client, prompt, image_base64, mime, config).await;
            }
        }
    } else {
        (
            config.vlm_base_url.clone(),
            config.vlm_key.clone(),
            config.vlm_model.clone(),
        )
    };

    let base = base_url.trim_end_matches('/');
    let url = format!("{}/chat/completions", base);
    let data_url = format!("data:{};base64,{}", mime, image_base64);
    let body = json!({
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": prompt },
                { "type": "image_url", "image_url": { "url": data_url, "detail": "low" } }
            ]
        }]
    });

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("VLM 连接失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("VLM 请求失败 {}: {}", status, text));
    }

    let data: Value = resp.json().await?;
    data["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow!("VLM 响应格式错误"))
}

async fn call_vlm_ollama(
    client: &Client,
    prompt: &str,
    image_base64: &str,
    _mime: &str,
    config: &AppConfig,
) -> Result<String> {
    let url = format!("{}/api/chat", config.ollama_url.trim_end_matches('/'));
    let body = json!({
        "model": config.ollama_model,
        "messages": [{
            "role": "user",
            "content": prompt,
            "images": [image_base64]
        }],
        "stream": false
    });

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("Ollama VLM 连接失败: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Ollama VLM 请求失败 {}: {}", status, text));
    }

    let data: Value = resp.json().await?;
    data["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow!("Ollama VLM 响应格式错误"))
}

/// Streams an Ollama chat completion, sending partial tokens via a Tauri channel.
pub async fn call_ollama_stream(
    prompt: &str,
    config: &AppConfig,
    file_name: &str,
    on_event: &tauri::ipc::Channel<StreamEvent>,
) -> Result<String> {
    use futures_util::StreamExt;

    let url = format!("{}/api/chat", config.ollama_url.trim_end_matches('/'));
    let body = json!({
        "model": config.ollama_model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": true,
        "options": { "num_predict": 80 }
    });

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()?;

    let resp = client.post(&url).json(&body).send().await.map_err(|e| {
        if e.is_connect() {
            anyhow!(
                "无法连接 Ollama（{}），请确认 Ollama 已启动",
                config.ollama_url
            )
        } else {
            anyhow!("Ollama 网络错误: {}", e)
        }
    })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Ollama 请求失败 {}: {}", status, text));
    }

    let mut stream = resp.bytes_stream();
    let mut accumulated = String::new();
    let mut buffer = Vec::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| anyhow!("流读取错误: {}", e))?;
        buffer.extend_from_slice(&chunk);

        // Ollama sends NDJSON: one JSON object per line
        while let Some(newline_pos) = buffer.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=newline_pos).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            if let Ok(json) = serde_json::from_str::<Value>(line)
                && let Some(token) = json["message"]["content"].as_str()
            {
                accumulated.push_str(token);
                let _ = on_event.send(StreamEvent::Partial {
                    file_name: file_name.to_string(),
                    partial: accumulated.clone(),
                });
            }
        }
    }

    // process any remaining data in buffer
    if !buffer.is_empty() {
        let line = String::from_utf8_lossy(&buffer);
        let line = line.trim();
        if !line.is_empty()
            && let Ok(json) = serde_json::from_str::<Value>(line)
            && let Some(token) = json["message"]["content"].as_str()
        {
            accumulated.push_str(token);
        }
    }

    Ok(accumulated)
}

/// Streams an OpenAI-compatible SSE chat completion, sending partial tokens via a Tauri channel.
pub async fn call_openai_stream(
    prompt: &str,
    config: &AppConfig,
    file_name: &str,
    on_event: &tauri::ipc::Channel<StreamEvent>,
) -> Result<String> {
    use futures_util::StreamExt;

    let base = config.openai_base_url.trim_end_matches('/');
    let url = format!("{}/chat/completions", base);
    let body = json!({
        "model": config.openai_model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": true
    });

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(60))
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

    let mut stream = resp.bytes_stream();
    let mut accumulated = String::new();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| anyhow!("流读取错误: {}", e))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(newline_pos) = buffer.find('\n') {
            let line: String = buffer.drain(..=newline_pos).collect();
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if line == "data: [DONE]" {
                break;
            }
            if let Some(data) = line.strip_prefix("data: ")
                && let Ok(json) = serde_json::from_str::<Value>(data)
                && let Some(token) = json["choices"][0]["delta"]["content"].as_str()
            {
                accumulated.push_str(token);
                let _ = on_event.send(StreamEvent::Partial {
                    file_name: file_name.to_string(),
                    partial: accumulated.clone(),
                });
            }
        }
    }

    Ok(accumulated)
}

/// Sanitizes raw LLM output into a valid filename, stripping quotes and illegal characters.
pub fn clean_filename(raw: &str, ext: Option<&str>) -> String {
    let mut name = raw
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "-")
        .trim()
        .to_string();

    // Strip trailing extension if AI included it (e.g. "Report.pdf" → "Report")
    if let Some(e) = ext {
        let lower = name.to_lowercase();
        let ext_lower = e.to_lowercase();
        if lower.ends_with(&ext_lower) {
            name.truncate(name.len() - e.len());
            // Also trim any trailing dot/dash left over
            name = name.trim_end_matches(['.', '-']).to_string();
        }
    }

    name
}
