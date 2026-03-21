use crate::config::AppConfig;
use anyhow::{Context, Result, anyhow};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;

const REQUEST_TIMEOUT_SECS: u64 = 45;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperEmbeddingStatus {
    pub state: String,
    pub configured_provider: String,
    pub resolved_provider: Option<String>,
    pub model_name: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmbeddingProviderKind {
    Ollama,
    OpenAI,
}

#[derive(Debug, Clone)]
pub struct ResolvedEmbeddingRuntime {
    pub provider: EmbeddingProviderKind,
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub signature: String,
}

#[derive(Debug, Deserialize)]
struct OllamaTagsResponse {
    #[serde(default)]
    models: Vec<OllamaModelTag>,
}

#[derive(Debug, Deserialize)]
struct OllamaModelTag {
    #[serde(default)]
    name: String,
}

#[derive(Debug, Deserialize)]
struct OllamaEmbedResponse {
    #[serde(default)]
    embeddings: Vec<Vec<f32>>,
    #[serde(default)]
    embedding: Vec<f32>,
}

#[derive(Debug, Deserialize)]
struct OpenAIEmbeddingResponse {
    #[serde(default)]
    data: Vec<OpenAIEmbeddingItem>,
}

#[derive(Debug, Deserialize)]
struct OpenAIEmbeddingItem {
    index: usize,
    #[serde(default)]
    embedding: Vec<f32>,
}

pub async fn get_status(config: &AppConfig) -> PaperEmbeddingStatus {
    let configured_provider = normalized_embedding_provider(config);
    match resolve_runtime(config).await {
        Ok(runtime) => {
            let resolved_provider = provider_name(&runtime.provider).to_string();
            let model_name = runtime.model.clone();
            let state = if configured_provider == "auto"
                && runtime.provider == EmbeddingProviderKind::OpenAI
            {
                "fallback".into()
            } else {
                "ready".into()
            };
            let message = if runtime.provider == EmbeddingProviderKind::Ollama {
                "将使用本地 Ollama embedding。".into()
            } else {
                "将使用 OpenAI 兼容 embedding。".into()
            };

            PaperEmbeddingStatus {
                state,
                configured_provider,
                resolved_provider: Some(resolved_provider),
                model_name,
                message,
            }
        }
        Err(err) => PaperEmbeddingStatus {
            state: "error".into(),
            configured_provider,
            resolved_provider: None,
            model_name: String::new(),
            message: err.to_string(),
        },
    }
}

pub async fn test_connection(config: &AppConfig) -> Result<String> {
    let runtime = resolve_runtime(config).await?;
    let probe = vec!["test paper embedding".to_string()];
    let vectors = embed_texts(&runtime, &probe).await?;
    let dims = vectors.first().map(|item| item.len()).unwrap_or(0);
    let provider = runtime.provider.clone();
    let model = runtime.model.clone();
    Ok(match provider {
        EmbeddingProviderKind::Ollama => {
            format!("Embedding 连接成功：Ollama / {}（{} 维）", model, dims)
        }
        EmbeddingProviderKind::OpenAI => {
            format!("Embedding 连接成功：OpenAI 兼容 / {}（{} 维）", model, dims)
        }
    })
}

pub async fn resolve_runtime(config: &AppConfig) -> Result<ResolvedEmbeddingRuntime> {
    match normalized_embedding_provider(config).as_str() {
        "ollama" => resolve_ollama_runtime(config).await,
        "openai" => resolve_openai_runtime(config),
        _ => match resolve_ollama_runtime(config).await {
            Ok(runtime) => Ok(runtime),
            Err(ollama_err) => resolve_openai_runtime(config).map_err(|openai_err| {
                anyhow!(
                    "未检测到可用的本地 Ollama embedding 模型，请先执行 `ollama pull {}`，或在设置页补齐论文 Embedding 的 Base URL / API Key / Model。Ollama: {}；OpenAI: {}",
                    embedding_ollama_model(config),
                    ollama_err,
                    openai_err
                )
            }),
        },
    }
}

pub async fn embed_texts(
    runtime: &ResolvedEmbeddingRuntime,
    texts: &[String],
) -> Result<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }

    match runtime.provider {
        EmbeddingProviderKind::Ollama => embed_with_ollama(runtime, texts).await,
        EmbeddingProviderKind::OpenAI => embed_with_openai(runtime, texts).await,
    }
}

pub async fn embed_query(runtime: &ResolvedEmbeddingRuntime, query: &str) -> Result<Vec<f32>> {
    Ok(embed_texts(runtime, &[query.to_string()])
        .await?
        .into_iter()
        .next()
        .unwrap_or_default())
}

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();

    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }

    dot / (norm_a * norm_b)
}

fn normalized_embedding_provider(config: &AppConfig) -> String {
    match config.paper_embedding_provider.trim() {
        "ollama" => "ollama".into(),
        "openai" => "openai".into(),
        _ => "auto".into(),
    }
}

fn provider_name(provider: &EmbeddingProviderKind) -> &'static str {
    match provider {
        EmbeddingProviderKind::Ollama => "ollama",
        EmbeddingProviderKind::OpenAI => "openai",
    }
}

fn embedding_ollama_url(config: &AppConfig) -> String {
    let url = config.paper_embedding_ollama_url.trim();
    if url.is_empty() {
        "http://localhost:11434".into()
    } else {
        url.into()
    }
}

fn embedding_ollama_model(config: &AppConfig) -> String {
    let model = config.paper_embedding_ollama_model.trim();
    if model.is_empty() {
        "nomic-embed-text".into()
    } else {
        model.into()
    }
}

fn embedding_openai_base_url(config: &AppConfig) -> String {
    config.paper_embedding_openai_base_url.trim().to_string()
}

fn embedding_openai_key(config: &AppConfig) -> String {
    config.paper_embedding_openai_key.trim().to_string()
}

fn embedding_openai_model(config: &AppConfig) -> String {
    let model = config.paper_embedding_openai_model.trim();
    if model.is_empty() {
        "text-embedding-3-small".into()
    } else {
        model.into()
    }
}

async fn resolve_ollama_runtime(config: &AppConfig) -> Result<ResolvedEmbeddingRuntime> {
    let base_url = embedding_ollama_url(config);
    let model = embedding_ollama_model(config);
    let client = http_client()?;
    let available = ollama_model_available(&client, &base_url, &model).await?;
    if !available {
        return Err(anyhow!("Ollama 已连接，但 embedding 模型 {} 未安装", model));
    }

    Ok(ResolvedEmbeddingRuntime {
        provider: EmbeddingProviderKind::Ollama,
        base_url: base_url.trim_end_matches('/').to_string(),
        api_key: None,
        signature: format!("ollama|{}|{}", base_url.trim_end_matches('/'), model),
        model,
    })
}

fn resolve_openai_runtime(config: &AppConfig) -> Result<ResolvedEmbeddingRuntime> {
    let base_url = embedding_openai_base_url(config);
    let api_key = embedding_openai_key(config);
    let model = embedding_openai_model(config);

    if base_url.is_empty() || api_key.is_empty() || model.is_empty() {
        return Err(anyhow!(
            "请补齐论文 Embedding 的 Base URL / API Key / Model"
        ));
    }

    Ok(ResolvedEmbeddingRuntime {
        provider: EmbeddingProviderKind::OpenAI,
        base_url: base_url.trim_end_matches('/').to_string(),
        api_key: Some(api_key),
        signature: format!("openai|{}|{}", base_url.trim_end_matches('/'), model),
        model,
    })
}

async fn ollama_model_available(client: &Client, base_url: &str, model: &str) -> Result<bool> {
    let url = format!("{}/api/tags", base_url.trim_end_matches('/'));
    let resp = client.get(&url).send().await.map_err(|err| {
        if err.is_connect() {
            anyhow!("无法连接 Ollama（{}），请确认已启动", base_url)
        } else {
            anyhow!("Ollama 网络错误: {}", err)
        }
    })?;

    if !resp.status().is_success() {
        return Err(anyhow!("Ollama 请求失败 {}", resp.status()));
    }

    let data: OllamaTagsResponse = resp.json().await.context("解析 Ollama 模型列表失败")?;
    Ok(data.models.iter().any(|item| item.name.starts_with(model)))
}

async fn embed_with_ollama(
    runtime: &ResolvedEmbeddingRuntime,
    texts: &[String],
) -> Result<Vec<Vec<f32>>> {
    let client = http_client()?;
    let url = format!("{}/api/embed", runtime.base_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .json(&json!({
            "model": runtime.model,
            "input": texts,
        }))
        .send()
        .await
        .map_err(|err| {
            if err.is_connect() {
                anyhow!("无法连接 Ollama（{}），请确认已启动", runtime.base_url)
            } else {
                anyhow!("Ollama embedding 请求失败: {}", err)
            }
        })?;

    if resp.status().is_success() {
        let data: OllamaEmbedResponse = resp.json().await.context("解析 Ollama embedding 失败")?;
        if !data.embeddings.is_empty() {
            return Ok(data.embeddings);
        }
        if !data.embedding.is_empty() {
            return Ok(vec![data.embedding]);
        }
    } else if resp.status().as_u16() != 404 {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Ollama embedding 请求失败 {}: {}", status, text));
    }

    let mut outputs = Vec::with_capacity(texts.len());
    for text in texts {
        let fallback_url = format!("{}/api/embeddings", runtime.base_url.trim_end_matches('/'));
        let resp = client
            .post(&fallback_url)
            .json(&json!({
                "model": runtime.model,
                "prompt": text,
            }))
            .send()
            .await
            .map_err(|err| anyhow!("Ollama embedding 请求失败: {}", err))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!("Ollama embedding 请求失败 {}: {}", status, body));
        }
        let data: OllamaEmbedResponse = resp.json().await.context("解析 Ollama embedding 失败")?;
        let embedding = if !data.embedding.is_empty() {
            data.embedding
        } else {
            data.embeddings.into_iter().next().unwrap_or_default()
        };
        outputs.push(embedding);
    }
    Ok(outputs)
}

async fn embed_with_openai(
    runtime: &ResolvedEmbeddingRuntime,
    texts: &[String],
) -> Result<Vec<Vec<f32>>> {
    let client = http_client()?;
    let url = format!("{}/embeddings", runtime.base_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .header(
            "Authorization",
            format!("Bearer {}", runtime.api_key.clone().unwrap_or_default()),
        )
        .json(&json!({
            "model": runtime.model,
            "input": texts,
        }))
        .send()
        .await
        .map_err(|err| anyhow!("无法连接 API ({}): {}", runtime.base_url, err))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Embedding API 请求失败 {}: {}", status, text));
    }

    let mut items = resp
        .json::<OpenAIEmbeddingResponse>()
        .await
        .context("解析 embedding API 响应失败")?
        .data;
    items.sort_by_key(|item| item.index);
    Ok(items.into_iter().map(|item| item.embedding).collect())
}

fn http_client() -> Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .context("初始化 HTTP 客户端失败")
}
