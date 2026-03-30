use anyhow::{Result, anyhow};
use reqwest::{Client, Url};
use std::error::Error as _;
use std::time::{Duration, Instant};

const STREAM_CONNECT_TIMEOUT_SECS: u64 = 15;
const STREAM_READ_TIMEOUT_SECS: u64 = 90;

pub fn build_streaming_http_client() -> Result<Client> {
    Ok(Client::builder()
        .connect_timeout(Duration::from_secs(STREAM_CONNECT_TIMEOUT_SECS))
        .read_timeout(Duration::from_secs(STREAM_READ_TIMEOUT_SECS))
        .build()?)
}

pub fn stream_idle_timeout_message() -> &'static str {
    "模型长时间没有返回新内容，流式输出已超时，请重试"
}

pub fn stream_interrupted_message() -> &'static str {
    "模型流式连接中断，请重试"
}

pub fn is_timeout_like_error(err: &reqwest::Error) -> bool {
    if err.is_timeout() {
        return true;
    }

    let lower = error_source_chain(err).to_lowercase();
    lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("deadline has elapsed")
}

pub fn classify_stream_error(err: &reqwest::Error) -> anyhow::Error {
    if is_timeout_like_error(err) {
        anyhow!(stream_idle_timeout_message())
    } else {
        anyhow!(stream_interrupted_message())
    }
}

pub fn error_source_chain(err: &reqwest::Error) -> String {
    let mut parts = vec![err.to_string()];
    let mut current = err.source();

    while let Some(source) = current {
        parts.push(source.to_string());
        current = source.source();
    }

    parts.join(" | ")
}

pub fn host_for_logging(base_url: &str) -> String {
    Url::parse(base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| base_url.trim().trim_end_matches('/').to_string())
}

pub struct StreamTrace {
    kind: &'static str,
    provider: String,
    model: String,
    host: String,
    item: String,
    started_at: Instant,
    first_chunk_at: Option<Instant>,
    output_chars: usize,
}

impl StreamTrace {
    pub fn new(
        kind: &'static str,
        provider: &str,
        model: &str,
        base_url: &str,
        item: &str,
        input_chars: usize,
    ) -> Self {
        let trace = Self {
            kind,
            provider: provider.to_string(),
            model: model.to_string(),
            host: host_for_logging(base_url),
            item: item.to_string(),
            started_at: Instant::now(),
            first_chunk_at: None,
            output_chars: 0,
        };

        eprintln!(
            "[stream] start kind={} provider={} model={} host={} item={} inputChars={}",
            trace.kind, trace.provider, trace.model, trace.host, trace.item, input_chars
        );

        trace
    }

    pub fn record_delta(&mut self, delta: &str) {
        if delta.is_empty() {
            return;
        }

        if self.first_chunk_at.is_none() {
            let now = Instant::now();
            self.first_chunk_at = Some(now);
            eprintln!(
                "[stream] first_chunk kind={} provider={} model={} host={} item={} firstChunkMs={}",
                self.kind,
                self.provider,
                self.model,
                self.host,
                self.item,
                now.duration_since(self.started_at).as_millis()
            );
        }

        self.output_chars += delta.chars().count();
    }

    pub fn log_complete(&self) {
        eprintln!(
            "[stream] complete kind={} provider={} model={} host={} item={} elapsedMs={} firstChunkMs={} outputChars={}",
            self.kind,
            self.provider,
            self.model,
            self.host,
            self.item,
            self.started_at.elapsed().as_millis(),
            self.first_chunk_at
                .map(|first| first.duration_since(self.started_at).as_millis().to_string())
                .unwrap_or_else(|| "none".into()),
            self.output_chars
        );
    }

    pub fn log_error(&self, err: &reqwest::Error, user_message: &str) {
        eprintln!(
            "[stream] error kind={} provider={} model={} host={} item={} elapsedMs={} firstChunkMs={} outputChars={} userMessage={} source={}",
            self.kind,
            self.provider,
            self.model,
            self.host,
            self.item,
            self.started_at.elapsed().as_millis(),
            self.first_chunk_at
                .map(|first| first.duration_since(self.started_at).as_millis().to_string())
                .unwrap_or_else(|| "none".into()),
            self.output_chars,
            user_message,
            error_source_chain(err)
        );
    }
}
