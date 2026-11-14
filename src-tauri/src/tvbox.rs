//! Bounded JSON reads for user-configured TVBox API sources.
use serde_json::Value;
use std::time::Duration;

const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// Parse JSON used by TVBox CMS sources without evaluating JavaScript.
///
/// Strict JSON is attempted first. The fallback only removes comments and
/// trailing commas, then delegates the actual parse to serde_json.
fn parse_tvbox_json(input: &[u8]) -> Result<Value, String> {
    let input = input.strip_prefix(b"\xef\xbb\xbf").unwrap_or(input);
    if let Ok(value) = serde_json::from_slice(input) {
        return Ok(value);
    }

    let cleaned = strip_json_comments_and_trailing_commas(input)?;
    serde_json::from_slice(&cleaned).map_err(|_| "响应不是有效的 TVBox JSON".to_string())
}

/// Remove the small, data-only syntax extensions accepted by TVBox configs.
/// Strings are copied byte-for-byte, so URL `//`, `#`, and escaped quotes are
/// never mistaken for comment syntax. No JavaScript tokens are interpreted.
fn strip_json_comments_and_trailing_commas(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut output = Vec::with_capacity(input.len());
    let mut index = 0;
    let mut in_string = false;
    let mut escaped = false;

    while index < input.len() {
        let byte = input[index];
        if in_string {
            output.push(byte);
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }

        match byte {
            b'"' => {
                in_string = true;
                output.push(byte);
                index += 1;
            }
            b'/' if input.get(index + 1) == Some(&b'/') => {
                output.push(b' ');
                index += 2;
                while index < input.len() && input[index] != b'\n' && input[index] != b'\r' {
                    index += 1;
                }
            }
            b'/' if input.get(index + 1) == Some(&b'*') => {
                output.push(b' ');
                index += 2;
                let mut closed = false;
                while index + 1 < input.len() {
                    if input[index] == b'*' && input[index + 1] == b'/' {
                        index += 2;
                        closed = true;
                        break;
                    }
                    if input[index] == b'\n' || input[index] == b'\r' {
                        output.push(input[index]);
                    }
                    index += 1;
                }
                if !closed {
                    return Err("响应包含未闭合注释".to_string());
                }
            }
            b'#' => {
                output.push(b' ');
                index += 1;
                while index < input.len() && input[index] != b'\n' && input[index] != b'\r' {
                    index += 1;
                }
            }
            _ => {
                output.push(byte);
                index += 1;
            }
        }
    }

    let mut without_trailing_commas = Vec::with_capacity(output.len());
    let mut index = 0;
    in_string = false;
    escaped = false;
    while index < output.len() {
        let byte = output[index];
        if in_string {
            without_trailing_commas.push(byte);
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if byte == b'"' {
            in_string = true;
            without_trailing_commas.push(byte);
            index += 1;
            continue;
        }
        if byte == b',' {
            let mut next = index + 1;
            while next < output.len() && output[next].is_ascii_whitespace() {
                next += 1;
            }
            if matches!(output.get(next), Some(b']' | b'}')) {
                index += 1;
                continue;
            }
        }
        without_trailing_commas.push(byte);
        index += 1;
    }
    Ok(without_trailing_commas)
}

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
        if response
            .content_length()
            .is_some_and(|length| length > MAX_JSON_BYTES as u64)
        {
            return Err("TVBox JSON 响应超过 4 MiB 限制".into());
        }
        let mut response = response;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|error| {
            if error.is_timeout() {
                "请求超时".to_string()
            } else {
                "读取 TVBox JSON 失败".to_string()
            }
        })? {
            if body.len().saturating_add(chunk.len()) > MAX_JSON_BYTES {
                return Err("TVBox JSON 响应超过 4 MiB 限制".into());
            }
            body.extend_from_slice(&chunk);
        }
        parse_tvbox_json(&body)
    })
    .await
    .map_err(|_| "TVBox 请求超过 20 秒".to_string())?
}

pub async fn fetch_m3u(url: &str) -> Result<Value, String> {
    tokio::time::timeout(REQUEST_TIMEOUT, async {
        let response = crate::net::get(
            url,
            REQUEST_TIMEOUT,
            Some("application/vnd.apple.mpegurl, audio/x-mpegurl, text/plain, */*"),
            None,
        )
        .await?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status().as_u16()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_JSON_BYTES as u64)
        {
            return Err("直播 M3U 响应超过 4 MiB 限制".into());
        }
        let final_url = response.url().to_string();
        let mut response = response;
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|error| {
            if error.is_timeout() {
                "请求超时".to_string()
            } else {
                "读取直播 M3U 列表失败".to_string()
            }
        })? {
            if body.len().saturating_add(chunk.len()) > MAX_JSON_BYTES {
                return Err("直播 M3U 响应超过 4 MiB 限制".into());
            }
            body.extend_from_slice(&chunk);
        }
        let text =
            std::str::from_utf8(&body).map_err(|_| "直播源响应不是 UTF-8 文本".to_string())?;
        Ok(serde_json::json!({
            "text": text,
            "final_url": final_url,
        }))
    })
    .await
    .map_err(|_| "直播源请求超过 20 秒".to_string())?
}

#[cfg(test)]
mod tests {
    use super::parse_tvbox_json;
    use serde_json::json;
    use std::collections::BTreeMap;

    #[test]
    fn accepts_bom_comments_trailing_commas_and_preserves_strings() {
        let input = b"\xef\xbb\xbf{
            # a full-line comment
            \"url\": \"https://example.test/a//b#c\",
            \"hash\": \"# not a comment\",
            \"quote\": \"escaped \\\" quote\",
            \"items\": [1, 2, /* inline comment */],
        }";
        let value = parse_tvbox_json(input).expect("extended JSON should parse");
        assert_eq!(value["url"], "https://example.test/a//b#c");
        assert_eq!(value["hash"], "# not a comment");
        assert_eq!(value["quote"], "escaped \" quote");
        assert_eq!(value["items"], json!([1, 2]));
    }

    #[test]
    fn strict_json_still_parses() {
        assert_eq!(
            parse_tvbox_json(br#"{"sites":[{"type":1}]}"#).unwrap(),
            json!({"sites":[{"type":1}]})
        );
    }

    #[test]
    fn rejects_javascript_assignment_function_and_expression() {
        for input in [
            br#"const x = {"sites": []};"#.as_slice(),
            br#"function load() { return {"sites": []}; }"#.as_slice(),
            br#"{"sites": [1 + 2]}"#.as_slice(),
        ] {
            assert!(parse_tvbox_json(input).is_err());
        }
    }

    #[test]
    fn rejects_unclosed_comment() {
        assert!(parse_tvbox_json(br#"{"a": 1 /* never closes}"#).is_err());
    }

    #[test]
    #[ignore = "只在需要验证本地真实配置时，通过 TVBOX_CMS_CONFIG_PATH 显式触发"]
    fn parses_local_cms_fixture_and_reports_site_types() {
        let path = std::env::var("TVBOX_CMS_CONFIG_PATH").expect("set TVBOX_CMS_CONFIG_PATH");
        let bytes = std::fs::read(path).expect("read local CMS config");
        let value = parse_tvbox_json(&bytes).expect("local CMS config should parse");
        let sites = value["sites"].as_array().expect("sites array");
        let mut types = BTreeMap::<String, usize>::new();
        for site in sites {
            let kind = site["type"].to_string();
            *types.entry(kind).or_default() += 1;
        }
        println!("sites_total={} type_counts={types:?}", sites.len());
    }
}
