//! 媒体层：封面解密 + HLS 代理。
//!
//! 站点封面是 AES-128-CBC 密文，m3u8 内部分片/key 又可能被 WebView 的 CORS 拦住，
//! 所以图片与视频统一走本地自定义协议（Windows/Android 为 `http://hg.localhost`，
//! macOS 为 `hg://localhost`，见 [`LOCAL_ORIGIN`]）。

use aes::cipher::{BlockDecrypt, KeyInit};
use aes::Aes128;
use once_cell::sync::Lazy;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::http::{Response, StatusCode};

/// 本平台自定义协议的完整基址。
///
/// Tauri 的自定义协议地址随平台不同：Windows / Android 是 `http://<scheme>.localhost`，
/// macOS / iOS / Linux 是 `<scheme>://localhost`。m3u8 里的分片与 key 地址按它改写。
/// 前端 `src/api.ts` 的 `LOCAL` 必须与此一致，否则封面与视频全部加载失败。
#[cfg(any(target_os = "windows", target_os = "android"))]
pub const LOCAL_ORIGIN: &str = "http://hg.localhost";
/// Linux 走 loopback HTTP：WebKitGTK 的播放器是 GStreamer，它拿不到自定义 scheme。
#[cfg(target_os = "linux")]
pub const LOCAL_ORIGIN: &str = crate::linux_http::ORIGIN;
#[cfg(not(any(target_os = "windows", target_os = "android", target_os = "linux")))]
pub const LOCAL_ORIGIN: &str = "hg://localhost";

const IMG_KEY: &[u8] = b"f5d965df75336270";
const IMG_IV: &[u8] = b"97b60394abc2fbe1";

static IMG_CACHE: Lazy<Mutex<HashMap<String, Arc<Vec<u8>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static PL_CACHE: Lazy<Mutex<HashMap<String, Arc<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
/// AES Key / 分片：拖进度条时同一 key、同一片会被反复拉，缓存住省一次往返。
static KEY_CACHE: Lazy<Mutex<HashMap<String, (String, Arc<Vec<u8>>, String)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static SEG_CACHE: Lazy<Mutex<HashMap<String, (String, Arc<Vec<u8>>, String)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const IMG_CACHE_MAX: usize = 240;
const PL_CACHE_MAX: usize = 60;
const KEY_CACHE_MAX: usize = 120;
const SEG_CACHE_MAX: usize = 36;
const SEG_CACHE_MAX_BYTES: usize = 4 * 1024 * 1024;

fn cache_put<V: Clone>(map: &Mutex<HashMap<String, V>>, key: String, val: V, max: usize) {
    let mut m = map.lock().unwrap();
    if m.len() >= max {
        if let Some(k) = m.keys().next().cloned() {
            m.remove(&k);
        }
    }
    m.insert(key, val);
}

/* ───────────────────────── AES ───────────────────────── */

fn aes_cbc_decrypt(data: &[u8]) -> Option<Vec<u8>> {
    if data.is_empty() || data.len() % 16 != 0 {
        return None;
    }
    let cipher = Aes128::new_from_slice(IMG_KEY).ok()?;
    let mut prev = [0u8; 16];
    prev.copy_from_slice(IMG_IV);
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks(16) {
        let mut ct = [0u8; 16];
        ct.copy_from_slice(chunk);
        let mut block = ct;
        cipher.decrypt_block((&mut block).into());
        for i in 0..16 {
            out.push(block[i] ^ prev[i]);
        }
        prev = ct;
    }
    Some(out)
}

fn strip_padding(mut buf: Vec<u8>) -> Vec<u8> {
    let pad = *buf.last().unwrap_or(&0) as usize;
    if pad > 0 && pad <= 16 && buf.len() >= pad {
        if buf[buf.len() - pad..].iter().all(|b| *b as usize == pad) {
            buf.truncate(buf.len() - pad);
        }
    }
    buf
}

fn image_kind(buf: &[u8]) -> Option<&'static str> {
    if buf.len() < 12 {
        return None;
    }
    if buf[0] == 0xFF && buf[1] == 0xD8 {
        return Some("image/jpeg");
    }
    if buf.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return Some("image/png");
    }
    if buf.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if buf.starts_with(b"RIFF") && &buf[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// 取封面：命中缓存直接返回，否则下载并按需解密。
pub async fn load_image(url: &str) -> Result<(String, Arc<Vec<u8>>), String> {
    load_image_with_referer_and_user_agent(url, None, None).await
}

/// TVBox 来源可能使用图床防盗链；仅使用调用方传入的来源 origin，不带路径或查询令牌。
async fn load_image_with_referer(
    url: &str,
    referer: Option<&str>,
) -> Result<(String, Arc<Vec<u8>>), String> {
    load_image_with_referer_and_user_agent(url, referer, None).await
}

async fn load_image_with_referer_and_user_agent(
    url: &str,
    referer: Option<&str>,
    user_agent: Option<&str>,
) -> Result<(String, Arc<Vec<u8>>), String> {
    let cache_key = media_cache_key(url, referer, user_agent);
    if let Some(hit) = IMG_CACHE.lock().unwrap().get(&cache_key).cloned() {
        let kind = image_kind(&hit).unwrap_or("image/jpeg");
        return Ok((kind.to_string(), hit));
    }
    let (_, bytes) =
        crate::net::fetch_bytes_with_referer_and_user_agent(url, referer, user_agent).await?;
    let plain = if image_kind(&bytes).is_some() {
        bytes
    } else {
        let dec = aes_cbc_decrypt(&bytes).ok_or_else(|| "封面解密失败".to_string())?;
        strip_padding(dec)
    };
    let kind = image_kind(&plain).unwrap_or("image/jpeg").to_string();
    let arc = Arc::new(plain);
    cache_put(&IMG_CACHE, cache_key, arc.clone(), IMG_CACHE_MAX);
    Ok((kind, arc))
}

fn normalized_image_referer(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let origin = url.origin().ascii_serialization();
    (origin != "null").then(|| format!("{}/", origin.trim_end_matches('/')))
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query
        .split('&')
        .find_map(|part| part.strip_prefix(&format!("{key}=")).map(dec))
}

const MAX_MEDIA_USER_AGENT_LEN: usize = 512;

fn valid_user_agent(value: &str) -> Option<String> {
    (value.len() <= MAX_MEDIA_USER_AGENT_LEN
        && !value.is_empty()
        && !value.chars().any(|c| c.is_control()))
    .then(|| value.to_string())
}

fn media_cache_key(url: &str, referer: Option<&str>, user_agent: Option<&str>) -> String {
    format!(
        "{url}\0{}\0{}",
        referer.unwrap_or(""),
        user_agent.unwrap_or("")
    )
}

/* ───────────────────────── HLS ───────────────────────── */

fn enc(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

fn dec(s: &str) -> String {
    percent_decode_str(s).decode_utf8_lossy().to_string()
}

fn absolutize(base: &str, target: &str) -> String {
    if target.starts_with("http://") || target.starts_with("https://") {
        return target.to_string();
    }
    if let Ok(b) = url::Url::parse(base) {
        if let Ok(j) = b.join(target) {
            return j.to_string();
        }
    }
    target.to_string()
}

/// 属性列表中的引号内可含逗号，不能直接 split(',')。
fn hls_attributes(line: &str) -> Option<(&str, Vec<&str>)> {
    let (tag, rest) = line.split_once(':')?;
    let mut attributes = Vec::new();
    let mut quoted = false;
    let mut start = 0;
    for (i, ch) in rest.char_indices() {
        if ch == '"' {
            quoted = !quoted;
        }
        if ch == ',' && !quoted {
            attributes.push(&rest[start..i]);
            start = i + 1;
        }
    }
    attributes.push(&rest[start..]);
    Some((tag, attributes))
}

fn map_uri_attributes(line: &str, mut rewrite: impl FnMut(&str) -> String) -> String {
    let Some((tag, attributes)) = hls_attributes(line) else {
        return line.to_string();
    };
    let mapped: Vec<String> = attributes
        .into_iter()
        .map(|attribute| {
            if let Some((key, value)) = attribute.split_once('=') {
                if key.trim() == "URI" {
                    if let Some(uri) = value
                        .trim()
                        .strip_prefix('"')
                        .and_then(|v| v.strip_suffix('"'))
                    {
                        return format!("{key}=\"{}\"", rewrite(uri));
                    }
                }
            }
            attribute.to_string()
        })
        .collect();
    format!("{tag}:{}", mapped.join(","))
}

fn rewrite_uri_attr(line: &str, prefix: &str) -> String {
    rewrite_uri_attr_with_referer(line, prefix, None)
}

fn format_seg_proxy_url(prefix: &str, uri: &str, referer: Option<&str>) -> String {
    format_seg_proxy_url_with_user_agent(prefix, uri, referer, None)
}

fn format_seg_proxy_url_with_user_agent(
    prefix: &str,
    uri: &str,
    referer: Option<&str>,
    user_agent: Option<&str>,
) -> String {
    let mut out = format!("{prefix}/seg?u={}", enc(uri));
    if let Some(r) = referer.filter(|r| !r.is_empty()) {
        out.push_str(&format!("&r={}", enc(r)));
    }
    if let Some(ua) = user_agent.filter(|ua| !ua.is_empty()) {
        out.push_str(&format!("&ua={}", enc(ua)));
    }
    out
}

fn rewrite_uri_attr_with_referer(line: &str, prefix: &str, referer: Option<&str>) -> String {
    rewrite_uri_attr_with_referer_and_user_agent(line, prefix, referer, None)
}

fn rewrite_uri_attr_with_referer_and_user_agent(
    line: &str,
    prefix: &str,
    referer: Option<&str>,
    user_agent: Option<&str>,
) -> String {
    map_uri_attributes(line, |uri| {
        format_seg_proxy_url_with_user_agent(prefix, uri, referer, user_agent)
    })
}

fn is_live_media_playlist(text: &str) -> bool {
    let trimmed = text.trim_start_matches('\u{feff}');
    trimmed.starts_with("#EXTM3U")
        && trimmed.contains("#EXTINF:")
        && !trimmed.contains("#EXT-X-ENDLIST")
        && !trimmed.contains("#EXT-X-STREAM-INF")
}

/// 取 m3u8 并把 key / 分片地址改写到本地协议。
pub async fn load_playlist_with_referer(
    url: &str,
    prefix: &str,
    referer: Option<&str>,
) -> Result<Arc<String>, String> {
    load_playlist_with_referer_and_user_agent(url, prefix, referer, None).await
}

pub async fn load_playlist_with_referer_and_user_agent(
    url: &str,
    prefix: &str,
    referer: Option<&str>,
    user_agent: Option<&str>,
) -> Result<Arc<String>, String> {
    // 缓存 key 要带 prefix：同一份 m3u8 在不同 scheme 下改写结果不一样
    let cache_key = format!("{prefix}|{}", media_cache_key(url, referer, user_agent));
    if let Some(hit) = PL_CACHE.lock().unwrap().get(&cache_key).cloned() {
        return Ok(hit);
    }
    let (_, bytes, final_url) =
        crate::net::fetch_bytes_with_final_url_and_referer_and_user_agent(url, referer, user_agent)
            .await?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "播放列表不是 UTF-8 文本")?;
    if !text.trim_start_matches('\u{feff}').starts_with("#EXTM3U") {
        return Err("响应不是 HLS 播放列表".into());
    }
    let arc = Arc::new(rewrite_playlist_with_referer(
        &final_url, text, prefix, referer,
    ));
    if !is_live_media_playlist(text) {
        cache_put(&PL_CACHE, cache_key, arc.clone(), PL_CACHE_MAX);
    }
    Ok(arc)
}

fn rewrite_playlist(url: &str, text: &str, prefix: &str) -> String {
    rewrite_playlist_with_referer_and_user_agent(url, text, prefix, None, None)
}

fn rewrite_playlist_with_referer(
    url: &str,
    text: &str,
    prefix: &str,
    referer: Option<&str>,
) -> String {
    rewrite_playlist_with_referer_and_user_agent(url, text, prefix, referer, None)
}

fn rewrite_playlist_with_referer_and_user_agent(
    url: &str,
    text: &str,
    prefix: &str,
    referer: Option<&str>,
    user_agent: Option<&str>,
) -> String {
    let mut out = String::with_capacity(text.len() + 512);
    for raw in text.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim_end();
        if line.is_empty() {
            out.push('\n');
            continue;
        }
        if line.starts_with('#') {
            // 禁用可派生 URL 的内容引导；DATERANGE 保留时间线/SCTE-35 元数据。
            if line.starts_with("#EXT-X-CONTENT-STEERING:") {
                continue;
            }
            if line.starts_with("#EXT-X-DATERANGE:") {
                if let Some((tag, attributes)) = hls_attributes(line) {
                    let safe: Vec<&str> = attributes
                        .into_iter()
                        .filter(|attribute| {
                            let key = attribute
                                .split('=')
                                .next()
                                .unwrap_or("")
                                .trim()
                                .to_ascii_uppercase();
                            !key.contains("URI") && key != "X-ASSET-LIST"
                        })
                        .collect();
                    out.push_str(&format!("{tag}:{}\n", safe.join(",")));
                }
                continue;
            }
            if line.contains("URI=\"") {
                // KEY/MAP/MEDIA/SESSION-KEY/PART/PRELOAD-HINT 等 URI 都必须经过目标检查。
                let absolute = absolutize_uri_in_attr(url, line);
                out.push_str(&rewrite_uri_attr_with_referer_and_user_agent(
                    &absolute, prefix, referer, user_agent,
                ));
            } else {
                out.push_str(line);
            }
        } else {
            let absolute = absolutize(url, line);
            out.push_str(&format_seg_proxy_url_with_user_agent(
                prefix, &absolute, referer, user_agent,
            ));
        }
        out.push('\n');
    }

    out
}

fn absolutize_uri_in_attr(base: &str, line: &str) -> String {
    map_uri_attributes(line, |uri| absolutize(base, uri))
}

/// 分片 / AES Key 带内存缓存：拖动进度条时避免重复拉取同一片造成卡顿。
pub async fn load_segment_with_referer(
    url: &str,
    referer: Option<&str>,
) -> Result<(Option<String>, Arc<Vec<u8>>, String), String> {
    load_segment_with_referer_and_user_agent(url, referer, None).await
}

pub async fn load_segment_with_referer_and_user_agent(
    url: &str,
    referer: Option<&str>,
    user_agent: Option<&str>,
) -> Result<(Option<String>, Arc<Vec<u8>>, String), String> {
    let cache_key = media_cache_key(url, referer, user_agent);
    if let Some((ctype, bytes, final_url)) = KEY_CACHE.lock().unwrap().get(&cache_key).cloned() {
        return Ok((Some(ctype), bytes, final_url));
    }
    if let Some((ctype, bytes, final_url)) = SEG_CACHE.lock().unwrap().get(&cache_key).cloned() {
        return Ok((Some(ctype), bytes, final_url));
    }
    let (ctype, bytes, final_url) =
        crate::net::fetch_bytes_with_final_url_and_referer_and_user_agent(url, referer, user_agent)
            .await?;
    let mime = ctype.clone().unwrap_or_else(|| {
        let p = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
        if p.ends_with(".ts") {
            "video/mp2t".to_string()
        } else if p.ends_with(".m4s") || p.ends_with(".mp4") {
            "video/mp4".to_string()
        } else {
            "application/octet-stream".to_string()
        }
    });
    let live_playlist = std::str::from_utf8(&bytes).is_ok_and(is_live_media_playlist);
    let len = bytes.len();
    let arc = Arc::new(bytes);
    if !live_playlist {
        if len <= 65536 {
            cache_put(
                &KEY_CACHE,
                cache_key,
                (mime.clone(), arc.clone(), final_url.clone()),
                KEY_CACHE_MAX,
            );
        } else if len <= SEG_CACHE_MAX_BYTES {
            cache_put(
                &SEG_CACHE,
                cache_key,
                (mime.clone(), arc.clone(), final_url.clone()),
                SEG_CACHE_MAX,
            );
        }
    }
    Ok((Some(mime), arc, final_url))
}

/// 清空封面 / 播放列表 / Key / 分片内存缓存
pub fn clear_caches() {
    if let Ok(mut g) = IMG_CACHE.lock() {
        g.clear();
    }
    if let Ok(mut g) = PL_CACHE.lock() {
        g.clear();
    }
    if let Ok(mut g) = KEY_CACHE.lock() {
        g.clear();
    }
    if let Ok(mut g) = SEG_CACHE.lock() {
        g.clear();
    }
}

/* ───────────────────────── 协议响应 ───────────────────────── */

fn respond(status: u16, ctype: &str, body: Vec<u8>, cache: &str) -> Response<Vec<u8>> {
    let len = body.len().to_string();
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK))
        .header("Content-Type", ctype)
        // WKWebView 需要 Content-Length / Accept-Ranges 才肯复用已缓冲的分片
        .header("Content-Length", len)
        .header("Accept-Ranges", "bytes")
        .header(
            "Access-Control-Expose-Headers",
            "Content-Length, Content-Type, Accept-Ranges, Content-Range",
        )
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", cache)
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Honor a single byte range requested by native media stacks such as AVFoundation.
/// Resources are fetched and cached as whole objects, then sliced for the local response.
fn apply_byte_range(response: Response<Vec<u8>>, range: Option<&str>) -> Response<Vec<u8>> {
    if response.status() != StatusCode::OK {
        return response;
    }
    let Some(range) = range.map(str::trim).filter(|value| !value.is_empty()) else {
        return response;
    };
    let Some(spec) = range.strip_prefix("bytes=") else {
        return response;
    };
    // Multipart ranges are not needed for HLS playback; ignore them and return the full object.
    if spec.contains(',') {
        return response;
    }
    let Some((first, last)) = spec.split_once('-') else {
        return response;
    };
    let (mut parts, body) = response.into_parts();
    let total = body.len() as u64;
    let parsed = if first.is_empty() {
        last.parse::<u64>().ok().and_then(|suffix| {
            (suffix > 0 && total > 0).then(|| (total.saturating_sub(suffix), total - 1))
        })
    } else {
        first.parse::<u64>().ok().and_then(|start| {
            if total == 0 || start >= total {
                None
            } else {
                let end = if last.is_empty() {
                    total - 1
                } else {
                    last.parse::<u64>().ok()?.min(total - 1)
                };
                (end >= start).then_some((start, end))
            }
        })
    };
    let Some((start, end)) = parsed else {
        parts.status = StatusCode::RANGE_NOT_SATISFIABLE;
        parts
            .headers
            .insert("Content-Range", format!("bytes */{total}").parse().unwrap());
        parts.headers.insert("Content-Length", "0".parse().unwrap());
        return Response::from_parts(parts, Vec::new());
    };
    let body = body[start as usize..=end as usize].to_vec();
    parts.status = StatusCode::PARTIAL_CONTENT;
    parts.headers.insert(
        "Content-Range",
        format!("bytes {start}-{end}/{total}").parse().unwrap(),
    );
    parts
        .headers
        .insert("Content-Length", body.len().to_string().parse().unwrap());
    Response::from_parts(parts, body)
}

/// 主清单的子清单也经 /seg 返回：必须继续改写，不能把内层 URL 原样交给播放器。
fn segment_response(
    target: &str,
    ctype: Option<&str>,
    bytes: Vec<u8>,
    origin: &str,
) -> Response<Vec<u8>> {
    segment_response_at_url(target, ctype, bytes, origin)
}

fn segment_response_at_url(
    final_url: &str,
    ctype: Option<&str>,
    bytes: Vec<u8>,
    origin: &str,
) -> Response<Vec<u8>> {
    segment_response_at_url_with_referer_and_user_agent(final_url, ctype, bytes, origin, None, None)
}

fn segment_response_at_url_with_referer(
    final_url: &str,
    ctype: Option<&str>,
    bytes: Vec<u8>,
    origin: &str,
    referer: Option<&str>,
) -> Response<Vec<u8>> {
    segment_response_at_url_with_referer_and_user_agent(
        final_url, ctype, bytes, origin, referer, None,
    )
}

fn segment_response_at_url_with_referer_and_user_agent(
    final_url: &str,
    ctype: Option<&str>,
    bytes: Vec<u8>,
    origin: &str,
    referer: Option<&str>,
    user_agent: Option<&str>,
) -> Response<Vec<u8>> {
    let playlist = ctype.is_some_and(|t| t.to_ascii_lowercase().contains("mpegurl"))
        || bytes.starts_with(b"#EXTM3U")
        || bytes.starts_with(b"\xef\xbb\xbf#EXTM3U");
    if playlist {
        return match std::str::from_utf8(&bytes) {
            Ok(text) => {
                let cache_policy = if is_live_media_playlist(text) {
                    "no-store"
                } else {
                    // Rewriting nested URIs does not require disabling the upstream cache policy.
                    "public, max-age=3600"
                };
                respond(
                    200,
                    "application/vnd.apple.mpegurl",
                    rewrite_playlist_with_referer_and_user_agent(
                        final_url, text, origin, referer, user_agent,
                    )
                    .into_bytes(),
                    cache_policy,
                )
            }
            Err(_) => respond(
                502,
                "text/plain",
                b"invalid playlist encoding".to_vec(),
                "no-store",
            ),
        };
    }
    respond(
        200,
        ctype.unwrap_or("application/octet-stream"),
        bytes,
        "public, max-age=3600",
    )
}

/// 统一入口：`<LOCAL_ORIGIN>/img?u=` / `hls?u=` / `seg?u=`
///
/// `origin` 是本平台自定义协议的完整基址，见 [`LOCAL_ORIGIN`]；用于改写 m3u8 里的
/// 分片与 key 地址。`range` 是可选的单字节范围请求头。
pub async fn handle(
    path: &str,
    query: &str,
    origin: &str,
    range: Option<&str>,
) -> Response<Vec<u8>> {
    let target = query_value(query, "u").unwrap_or_default();
    let media_referer = query_value(query, "r").and_then(|value| normalized_image_referer(&value));
    let media_user_agent = query_value(query, "ua").and_then(|value| valid_user_agent(&value));

    if target.is_empty() {
        return respond(400, "text/plain", b"missing u".to_vec(), "no-store");
    }

    let started = std::time::Instant::now();
    let route = match path {
        "/img" => "image",
        "/hls" | "/hls/playlist.m3u8" => "playlist",
        "/seg" => "segment_or_key",
        _ => "unknown",
    };
    crate::playback_log::record(
        "proxy.begin",
        serde_json::json!({"route": route, "resource": crate::playback_log::resource_id(&target)}),
    );
    let response = apply_byte_range(
        match path {
            "/img" => match load_image_with_referer_and_user_agent(
                &target,
                media_referer.as_deref(),
                media_user_agent.as_deref(),
            )
            .await
            {
                Ok((kind, bytes)) => {
                    respond(200, &kind, bytes.as_ref().clone(), "public, max-age=86400")
                }
                Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
            },
            "/hls" | "/hls/playlist.m3u8" => {
                match load_playlist_with_referer_and_user_agent(
                    &target,
                    origin,
                    media_referer.as_deref(),
                    media_user_agent.as_deref(),
                )
                .await
                {
                    Ok(text) => respond(
                        200,
                        "application/vnd.apple.mpegurl",
                        text.as_bytes().to_vec(),
                        "no-store",
                    ),
                    Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
                }
            }
            "/seg" => match load_segment_with_referer_and_user_agent(
                &target,
                media_referer.as_deref(),
                media_user_agent.as_deref(),
            )
            .await
            {
                Ok((ctype, bytes, final_url)) => {
                    segment_response_at_url_with_referer_and_user_agent(
                        &final_url,
                        ctype.as_deref(),
                        bytes.as_ref().clone(),
                        origin,
                        media_referer.as_deref(),
                        media_user_agent.as_deref(),
                    )
                }
                Err(e) => respond(502, "text/plain", e.into_bytes(), "no-store"),
            },
            _ => respond(404, "text/plain", b"not found".to_vec(), "no-store"),
        },
        range,
    );
    crate::playback_log::record(
        "proxy.end",
        serde_json::json!({"route": route, "resource": crate::playback_log::resource_id(&target), "status": response.status().as_u16(), "bytes": response.body().len(), "elapsed_ms": started.elapsed().as_millis() as u64}),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dateranges_keep_timing_and_scte_metadata_but_drop_external_resources() {
        let line = "#EXTM3U\n#EXT-X-DATERANGE:ID=\"event\",START-DATE=\"2026-11-07T00:00:00Z\",DURATION=4,SCTE35-OUT=0xFC,X-TEXT=\"a,b\",X-ASSET-URI=\"https://evil.example/ad\",X-ASSET-LIST=\"https://evil.example/list.json\"\n";
        let out = rewrite_playlist("https://cdn.example/master.m3u8", line, LOCAL_ORIGIN);
        assert!(out.contains("DURATION=4,SCTE35-OUT=0xFC,X-TEXT=\"a,b\""));
        assert!(out.contains("START-DATE="));
        assert!(!out.contains("evil.example") && !out.contains("X-ASSET"));
    }

    #[test]
    fn every_uri_attribute_is_rewritten_without_splitting_quoted_commas() {
        let line = "#EXT-X-MEDIA:NAME=\"audio,main\",URI=\"first.m3u8\",URI=\"second.m3u8\"";
        let absolute = absolutize_uri_in_attr("https://cdn.example/master.m3u8", line);
        let rewritten = rewrite_uri_attr(&absolute, LOCAL_ORIGIN);
        assert_eq!(
            rewritten.matches(&format!("{LOCAL_ORIGIN}/seg?u=")).count(),
            2
        );
        assert!(rewritten.contains("NAME=\"audio,main\""));
        assert!(!rewritten.contains("URI=\"https://"));
    }

    #[test]
    fn nested_playlists_and_alternate_uris_stay_behind_proxy() {
        let text = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"audio/list.m3u8\"\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"http://127.0.0.1/key\"\n#EXT-X-PART:DURATION=1,URI=\"part.ts\"\nvariant/list.m3u8\n";
        let response = segment_response(
            "https://cdn.example/master.m3u8",
            Some("application/octet-stream"),
            text.as_bytes().to_vec(),
            LOCAL_ORIGIN,
        );
        let body = std::str::from_utf8(response.body()).unwrap();
        assert_eq!(body.matches(&format!("{LOCAL_ORIGIN}/seg?u=")).count(), 4);
        // Linux 上 LOCAL_ORIGIN 本身就是 `http://127.0.0.1:<port>`，
        // 所以不能断言「不含 127.0.0.1」，要断言上游那条 key 地址已被代理包起来
        assert!(!body.contains("URI=\"http://127.0.0.1/key\""));
        assert!(body.contains("https%3A%2F%2Fcdn%2Eexample%2Faudio%2Flist%2Em3u8"));
        assert_eq!(
            response.headers()["Content-Type"],
            "application/vnd.apple.mpegurl"
        );
        assert_eq!(response.headers()["X-Content-Type-Options"], "nosniff");
        assert!(!response
            .headers()
            .contains_key("Access-Control-Allow-Origin"));
        let optional = rewrite_playlist("https://cdn.example/list.m3u8",
            "#EXTM3U\n#EXT-X-CONTENT-STEERING:SERVER-URI=\"https://other.example/list.json\"\n#EXT-X-DATERANGE:ID=\"ad\",X-ASSET-LIST=\"http://127.0.0.1/assets\"\nsegment.ts\n", LOCAL_ORIGIN);
        assert!(!optional.contains("CONTENT-STEERING") && !optional.contains("X-ASSET-LIST"));
        assert!(optional.contains("#EXT-X-DATERANGE:ID=\"ad\""));
        let bom = segment_response(
            "https://cdn.example/list.m3u8",
            None,
            b"\xef\xbb\xbf#EXTM3U\nsegment.ts\n".to_vec(),
            LOCAL_ORIGIN,
        );
        assert!(bom.body().starts_with(b"#EXTM3U\n"));
    }

    #[test]
    fn redirected_hls_manifest_uses_final_url_for_relative_uris() {
        let original_url = "https://origin.example/watch/master.m3u8";
        let final_url = "https://cdn.example/v2/playlist/master.m3u8?token=abc";
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"keys/key.bin\"\nsegment.ts?sig=one\n";

        let body = rewrite_playlist(final_url, text, LOCAL_ORIGIN);
        assert!(body.contains(&enc("https://cdn.example/v2/playlist/keys/key.bin")));
        assert!(body.contains(&enc("https://cdn.example/v2/playlist/segment.ts?sig=one")));
        assert!(!body.contains(&enc("https://origin.example/watch/segment.ts?sig=one")));

        let stale = rewrite_playlist(original_url, text, LOCAL_ORIGIN);
        assert!(stale.contains(&enc("https://origin.example/watch/segment.ts?sig=one")));
        let nested = segment_response_at_url(
            final_url,
            Some("application/vnd.apple.mpegurl"),
            text.as_bytes().to_vec(),
            LOCAL_ORIGIN,
        );
        assert!(std::str::from_utf8(nested.body())
            .unwrap()
            .contains(&enc("https://cdn.example/v2/playlist/segment.ts?sig=one")));
    }

    #[test]
    fn byte_ranges_return_partial_content_and_correct_headers() {
        let response = respond(200, "video/mp2t", b"0123456789".to_vec(), "no-store");
        let ranged = apply_byte_range(response, Some("bytes=2-5"));
        assert_eq!(ranged.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(ranged.headers()["Content-Range"], "bytes 2-5/10");
        assert_eq!(ranged.headers()["Content-Length"], "4");
        assert_eq!(ranged.headers()["Accept-Ranges"], "bytes");
        assert!(ranged.headers()["Access-Control-Expose-Headers"]
            .to_str()
            .unwrap()
            .contains("Content-Range"));
        assert_eq!(ranged.body(), b"2345");

        let manifest = b"#EXTM3U\n#EXTINF:4,\nsegment.ts\n".to_vec();
        let probe = apply_byte_range(
            respond(200, "application/vnd.apple.mpegurl", manifest, "no-store"),
            Some("bytes=0-7"),
        );
        assert_eq!(probe.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(probe.body(), b"#EXTM3U\n");

        let suffix = apply_byte_range(
            respond(200, "video/mp2t", b"0123456789".to_vec(), "no-store"),
            Some("bytes=-3"),
        );
        assert_eq!(suffix.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(suffix.headers()["Content-Range"], "bytes 7-9/10");
        assert_eq!(suffix.body(), b"789");

        let unsatisfiable = apply_byte_range(
            respond(200, "video/mp2t", b"0123456789".to_vec(), "no-store"),
            Some("bytes=10-"),
        );
        assert_eq!(unsatisfiable.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(unsatisfiable.headers()["Content-Range"], "bytes */10");
        assert!(unsatisfiable.body().is_empty());
    }

    /// 联网测试：默认跳过，手动跑 `cargo test --lib -- --ignored`。
    /// 依赖上游 `/api/videos/117/play` 返回的实时播放地址。
    #[tokio::test]
    #[ignore = "联网测试：依赖上游实时播放地址，手动用 --ignored 运行"]
    async fn live_play_chain() {
        use crate::net::edge;
        let play = edge(
            &crate::net::base(),
            "GET",
            "/api/videos/117/play?ep=3&page_texts=0",
            None,
            None,
        )
        .await
        .expect("play api");
        let url = play["video_url"].as_str().expect("video_url").to_string();
        println!("play url: {}", &url[..url.len().min(90)]);
        let (_, bytes) = crate::net::fetch_bytes(&url).await.expect("fetch playlist");
        let text = String::from_utf8_lossy(&bytes);
        println!(
            "raw playlist len={} head={}",
            text.len(),
            &text[..text.len().min(160)]
        );
        let q = format!("u={}", enc(&url));
        let resp = handle("/hls", &q, LOCAL_ORIGIN, None).await;
        let body = String::from_utf8_lossy(resp.body()).to_string();
        println!("proxied status={} len={}", resp.status(), body.len());
        assert!(body.contains("#EXTM3U"));
        // 取一个分片验证
        let seg_line = body
            .lines()
            .find(|l| !l.starts_with('#') && l.contains("/seg?u="))
            .expect("seg line")
            .to_string();
        println!("seg line: {}", &seg_line[..seg_line.len().min(120)]);
        let seg_q = seg_line.split("?u=").nth(1).unwrap();
        let seg = handle("/seg", &format!("u={seg_q}"), LOCAL_ORIGIN, None).await;
        println!("segment status={} len={}", seg.status(), seg.body().len());
        assert_eq!(seg.status(), 200);
        assert!(seg.body().len() > 1000);
    }

    /// Opt-in real source check. No source URL or query tokens are printed.
    #[tokio::test]
    #[ignore = "联网测试：显式设置 TVBOX_LIVE_HLS_URL 后运行"]
    async fn live_tvbox_hls_chain() {
        let url = std::env::var("TVBOX_LIVE_HLS_URL").expect("set TVBOX_LIVE_HLS_URL");
        let query = format!("u={}", enc(&url));
        let probe = handle(
            "/hls/playlist.m3u8",
            &query,
            LOCAL_ORIGIN,
            Some("bytes=0-7"),
        )
        .await;
        assert_eq!(probe.status(), StatusCode::PARTIAL_CONTENT);
        assert!(probe.headers().contains_key("Content-Range"));
        assert!(probe.body().starts_with(b"#EXTM3U"));
        let mut response = handle("/hls/playlist.m3u8", &query, LOCAL_ORIGIN, None).await;
        for depth in 0..4 {
            assert_eq!(response.status(), StatusCode::OK, "playlist depth {depth}");
            let text = std::str::from_utf8(response.body()).expect("UTF-8 playlist");
            assert!(text.starts_with("#EXTM3U"), "expected an HLS playlist");
            let next = text
                .lines()
                .find(|line| !line.is_empty() && !line.starts_with('#'))
                .expect("playlist must contain a resource");
            let next = url::Url::parse(next).expect("absolute proxied URL");
            assert_eq!(
                next.origin(),
                url::Url::parse(LOCAL_ORIGIN).unwrap().origin()
            );
            let next_query = next.query().expect("proxied query").to_owned();
            let is_master = text.contains("#EXT-X-STREAM-INF");
            response = handle(
                next.path(),
                &next_query,
                LOCAL_ORIGIN,
                if is_master {
                    None
                } else {
                    Some("bytes=0-1023")
                },
            )
            .await;
            if !is_master {
                assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
                assert!(response.headers().contains_key("Content-Range"));
                assert_eq!(response.body().len(), 1024);
                println!(
                    "PASS TVBox HLS: manifest probe, nested playlists, media 206 (1024 bytes)"
                );
                return;
            }
        }
        panic!("too many nested master playlists");
    }

    /// 离线回归：不再依赖带 auth_key 时效的真实上游地址（旧地址已过期，会 403）。
    /// 与真实播放列表同构：带签名的分片地址 + 加密 KEY + 相对路径分片。
    #[test]
    fn playlist_rewrite_works() {
        let base = "https://cdn.example/videos5/abc/abc.m3u8?auth_key=9999999999-0-0-deadbeef&v=3&via=hgdj";
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin?auth_key=9999999999-0-0-deadbeef\"\n#EXTINF:4,\nseg-1.ts?auth_key=9999999999-0-0-deadbeef\n";
        let body = rewrite_playlist(base, text, LOCAL_ORIGIN);

        assert!(body.contains("#EXTM3U"), "not a playlist: {body}");
        assert!(
            body.contains(&format!("{LOCAL_ORIGIN}/seg?u=")),
            "segments not rewritten: {body}"
        );
        // 分片必须绝对化到源站，并保留签名查询串。
        assert!(
            body.contains(
                "https%3A%2F%2Fcdn%2Eexample%2Fvideos5%2Fabc%2Fseg%2D1%2Ets%3Fauth%5Fkey%3D"
            ),
            "segment not absolutized with query: {body}"
        );
        // 加密 KEY 也要走本地代理，否则 hls.js 会直接打源站被 CORS 拦住。
        assert!(
            body.contains("URI=\"") && body.contains("%2Fkey%2Ebin%3Fauth%5Fkey%3D"),
            "key uri not rewritten: {body}"
        );
        assert!(!body.contains("URI=\"key.bin"), "key uri left relative");
    }

    /// 离线回归：用已知明文 + 项目内置 key/IV 构造密文，验证解密、去填充与类型识别。
    /// 真实封面抓取那条仍保留为 `#[ignore]` 联网测试。
    #[test]
    fn cover_decrypt_roundtrip() {
        use aes::cipher::BlockEncrypt;

        let plain = b"\xFF\xD8\xFF\xE0cover-payload-for-test".to_vec();
        let mut buf = plain.clone();
        let pad = 16 - plain.len() % 16;
        buf.extend(std::iter::repeat_n(pad as u8, pad));

        let cipher = Aes128::new_from_slice(IMG_KEY).expect("key");
        let mut prev = [0u8; 16];
        prev.copy_from_slice(IMG_IV);
        let mut encrypted = Vec::with_capacity(buf.len());
        for chunk in buf.chunks(16) {
            let mut block = [0u8; 16];
            block.copy_from_slice(chunk);
            for i in 0..16 {
                block[i] ^= prev[i];
            }
            let mut out_block = block;
            cipher.encrypt_block((&mut out_block).into());
            encrypted.extend_from_slice(&out_block);
            prev = out_block;
        }

        let decrypted = aes_cbc_decrypt(&encrypted).expect("decrypt");
        let stripped = strip_padding(decrypted);
        assert_eq!(stripped, plain);
        assert_eq!(image_kind(&stripped), Some("image/jpeg"));
    }

    #[test]
    fn image_referer_is_reduced_to_a_credential_free_origin() {
        assert_eq!(
            normalized_image_referer("https://tv.example/api.php/vod?token=secret"),
            Some("https://tv.example/".into())
        );
        assert_eq!(
            normalized_image_referer("http://user:pass@tv.example/vod"),
            None
        );
        assert_eq!(normalized_image_referer("javascript:alert(1)"), None);
        assert_eq!(
            query_value(
                "u=https%3A%2F%2Fcdn.example%2Fp.jpg&r=https%3A%2F%2Ftv.example%2F",
                "r"
            ),
            Some("https://tv.example/".into())
        );
    }

    #[test]
    fn live_media_playlist_and_referer_rewrite_preserve_safety_and_freshness() {
        let live_text =
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:5.0,\nseg1.ts\n";
        let vod_text = "#EXTM3U\n#EXTINF:5.0,\nseg1.ts\n#EXT-X-ENDLIST\n";
        let master_text = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nsub/index.m3u8\n";
        assert!(is_live_media_playlist(live_text));
        assert!(!is_live_media_playlist(vod_text));
        assert!(!is_live_media_playlist(master_text));

        let rewritten = rewrite_playlist_with_referer(
            "https://live.example/ch/index.m3u8",
            live_text,
            LOCAL_ORIGIN,
            Some("https://portal.example/"),
        );
        assert!(rewritten.contains(&format!(
            "{LOCAL_ORIGIN}/seg?u={}&r={}",
            enc("https://live.example/ch/seg1.ts"),
            enc("https://portal.example/")
        )));

        let live_resp = segment_response_at_url_with_referer(
            "https://live.example/ch/index.m3u8",
            Some("application/vnd.apple.mpegurl"),
            live_text.as_bytes().to_vec(),
            LOCAL_ORIGIN,
            Some("https://portal.example/"),
        );
        assert_eq!(live_resp.headers()["Cache-Control"], "no-store");
    }

    #[test]
    fn user_agent_propagates_to_nested_resources_and_cache_identity() {
        let ua = Some("Live Player/1.2");
        let rewritten = rewrite_playlist_with_referer_and_user_agent(
            "https://live.example/ch/index.m3u8",
            "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\nseg.ts\n",
            LOCAL_ORIGIN,
            Some("https://portal.example/"),
            ua,
        );
        assert!(rewritten.matches("&ua=Live%20Player%2F1%2E2").count() == 2);
        assert_ne!(
            media_cache_key("https://cdn.example/seg.ts", Some("https://a/"), Some("A")),
            media_cache_key("https://cdn.example/seg.ts", Some("https://a/"), Some("B"))
        );
        assert_eq!(
            rewrite_playlist(
                "https://cdn.example/list.m3u8",
                "#EXTM3U\nseg.ts\n",
                LOCAL_ORIGIN
            )
            .contains("&ua="),
            false
        );
    }

    #[test]
    fn invalid_user_agent_query_values_are_not_forwarded() {
        assert!(valid_user_agent("Mozilla/5.0").is_some());
        assert!(valid_user_agent("bad\nua").is_none());
        assert!(valid_user_agent(&"x".repeat(MAX_MEDIA_USER_AGENT_LEN + 1)).is_none());
        assert!(valid_user_agent("").is_none());
    }

    /// 联网测试：默认跳过。封面地址带时效签名，不能硬编码进仓库，
    /// 需要用当次上游返回的地址显式传入：
    /// `HGHUBX_TEST_COVER_URL='https://…?auth_key=…' cargo test --lib -- --ignored`
    #[tokio::test]
    #[ignore = "联网测试：需要 HGHUBX_TEST_COVER_URL，手动用 --ignored 运行"]
    async fn cover_decrypt_works() {
        let url = crate::env::var("TEST_COVER_URL")
            .expect("需要设置 HGHUBX_TEST_COVER_URL 为当前有效的封面地址");
        match load_image(&url).await {
            Ok((kind, bytes)) => {
                println!("kind={kind} len={}", bytes.len());
                assert!(kind.starts_with("image/"));
            }
            Err(e) => panic!("image failed: {e}"),
        }
    }
}
