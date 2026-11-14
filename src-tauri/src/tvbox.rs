//! Bounded JSON reads for user-configured TVBox API sources.
use serde_json::Value;
use std::time::Duration;

const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

pub async fn fetch_json(url: &str) -> Result<Value, String> {
    tokio::time::timeout(REQUEST_TIMEOUT, async {
        let response = crate::net::get(
            url,
            REQUEST_TIMEOUT,
            Some("application/json, text/plain, */*"),
            None,
        )
        .await?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status().as_u16()));
        }
        if response.content_length().is_some_and(|length| length > MAX_JSON_BYTES as u64) {
            return Err("TVBox JSON 响应超过 4 MiB 限制".into());
        }
        let mut response = response;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|error| {
            if error.is_timeout() { "请求超时".to_string() } else { "读取 TVBox JSON 失败".to_string() }
        })? {
            if body.len().saturating_add(chunk.len()) > MAX_JSON_BYTES {
                return Err("TVBox JSON 响应超过 4 MiB 限制".into());
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body).map_err(|_| "响应不是有效的 TVBox JSON".to_string())
    })
    .await
    .map_err(|_| "TVBox 请求超过 20 秒".to_string())?
}
