use super::*;
use serde_json::{json, Value};
use std::time::Instant;

const FIXTURE_URL: &str = "https://fixture.invalid/spider.js";

fn fixture(source: &str, method: &str, args: Value) -> Result<Value, String> {
    run(
        FIXTURE_URL.to_string(),
        source.as_bytes().to_vec(),
        Value::Null,
        method.to_string(),
        args.as_array()
            .expect("fixture args must be an array")
            .clone(),
    )
}

fn fixture_with_ext(source: &str, ext: Value, method: &str, args: Value) -> Result<Value, String> {
    run(
        FIXTURE_URL.to_string(),
        source.as_bytes().to_vec(),
        ext,
        method.to_string(),
        args.as_array()
            .expect("fixture args must be an array")
            .clone(),
    )
}

#[test]
fn source_url_accepts_js_and_mjs_but_rejects_json_file_credentials_and_fragments() {
    for raw in [
        "https://fixture.invalid/spider.js",
        "https://fixture.invalid/spider.mjs",
        "https://fixture.invalid/path/spider.JS?rev=1",
        "https://fixture.invalid/path/spider.MJS?rev=1",
    ] {
        assert!(source_url(raw).is_ok(), "expected accepted: {raw}");
    }
    for raw in [
        "https://fixture.invalid/spider.json",
        "file:///tmp/spider.js",
        "https://user@example.com/spider.js",
        "https://user:password@example.com/spider.js",
        "https://fixture.invalid/spider.js#fragment",
    ] {
        assert!(source_url(raw).is_err(), "expected rejected: {raw}");
    }
}

#[test]
fn request_policy_accepts_get_and_rejects_head_post_and_unsupported_options() {
    assert!(validate_request_options(Some("GET"), false, false).is_ok());
    assert!(validate_request_options(Some("get"), false, false).is_ok());
    assert!(validate_request_options(Some("HEAD"), false, false).is_err());
    assert!(validate_request_options(Some("POST"), false, false).is_err());
    assert!(validate_request_options(None, false, false).is_ok());
    assert!(validate_request_options(Some("GET"), true, false).is_err());
    assert!(validate_request_options(Some("GET"), false, true).is_err());
}

#[test]
fn esm_default_this_ext_and_home_vod_positional_arguments_work() {
    let source = r#"
        export default {
            init(ext) { this.seed = ext.seed; this.kind = ext.kind; },
            homeVod(first, second) {
                return { seed: this.seed, kind: this.kind, first, second };
            }
        };
    "#;
    let result = fixture_with_ext(
        source,
        json!({"seed": "from-ext", "kind": "fixture"}),
        "homeVod",
        json!(["one", 42]),
    )
    .unwrap();
    assert_eq!(
        result,
        json!({
            "seed": "from-ext",
            "kind": "fixture",
            "first": "one",
            "second": 42
        })
    );
}

#[test]
fn async_init_rejection_is_error_and_top_level_await_can_fulfill() {
    let rejected = r#"
        export default { async init() { await Promise.reject('init-secret'); }, home() { return 1; } };
    "#;
    assert!(fixture(rejected, "home", json!([])).is_err());

    let fulfilled = r#"
        const seed = await Promise.resolve('ready');
        export default { home() { return seed; } };
    "#;
    assert_eq!(
        fixture(fulfilled, "home", json!([])).unwrap(),
        json!("ready")
    );
}

#[test]
fn pending_promise_cannot_outlive_shared_eight_second_deadline() {
    let started = Instant::now();
    let source = r#"
        export default { home() { return new Promise(() => {}); } };
    "#;
    let result = fixture(source, "home", json!([]));
    assert!(result.is_err());
    assert!(started.elapsed().as_secs() >= 7);
    assert!(started.elapsed().as_secs() < 12);
}

#[test]
fn quickjs_json_result_is_bounded_before_serde_conversion() {
    let source = r#"
        export default { home() { return Array(10000).fill('x'.repeat(1000)); } };
    "#;
    let result = fixture(source, "home", json!([]));
    assert!(
        result.is_err(),
        "oversized shared-reference result must be rejected"
    );
    let message = result.unwrap_err();
    assert!(
        message.contains("结果") || message.contains("大小") || message.contains("限制"),
        "unexpected error: {message}"
    );
}

#[test]
fn quickjs_engine_memory_limit_rejects_large_string() {
    let source = r#"
        export default { home() { return 'x'.repeat(128 * 1024 * 1024); } };
    "#;
    assert!(fixture(source, "home", json!([])).is_err());
}

#[test]
fn bounded_json_rejects_source_and_args_over_two_mib() {
    let oversized = "x".repeat(MAX_INPUT + 1024);
    let source = json!({"url": FIXTURE_URL, "code": oversized});
    let args = json!([oversized]);
    assert!(bounded_json(&source, "source").is_err());
    assert!(bounded_json(&args, "args").is_err());
}

#[test]
fn strict_target_policy_rejects_loopback_private_and_special_targets_without_network() {
    for raw in [
        "http://127.0.0.1/",
        "http://10.0.0.1/",
        "http://172.16.0.1/",
        "http://192.168.1.1/",
        "http://169.254.169.254/",
        "http://[::1]/",
        "http://[fc00::1]/",
        "http://localhost/",
        "http://router.local/",
        "http://tauri.localhost/",
        "http://hg.localhost/",
        "http://ipc.localhost/",
    ] {
        assert!(
            crate::network_policy::parse_target_with_mode(raw, true).is_err(),
            "unsafe target was accepted: {raw}"
        );
    }
}

#[test]
fn eval_and_function_execute_but_cannot_obtain_process_tauri_or_require() {
    let source = r#"
        export default {
            home() {
                eval("globalThis.__eval_was_run = 7");
                Function("globalThis.__function_was_run = 9")();
                return [
                    globalThis.__eval_was_run,
                    globalThis.__function_was_run,
                    typeof process,
                    typeof tauri,
                    typeof require
                ];
            }
        };
    "#;
    assert_eq!(
        fixture(source, "home", json!([])).unwrap(),
        json!([7, 9, "undefined", "undefined", "undefined"])
    );
}

#[test]
fn request_optional_opts_and_rejections_work_inside_vm() {
    let source = r#"export default {home(){
        const errors=[];
        for (const f of [()=>req('file:///x'),()=>req('https://example.invalid/',{method:'POST'}),()=>req('https://example.invalid/',{header:{x:'y'}})]) {
            try { f(); } catch(e) { errors.push(String(e)); }
        }
        return errors;
    }}"#;
    let result = fixture(source, "home", json!([])).unwrap();
    let errors = result.as_array().unwrap();
    assert_eq!(errors.len(), 3);
    assert!(errors[0].as_str().unwrap().contains("仅允许"));
    assert!(errors[1].as_str().unwrap().contains("仅支持 GET"));
    assert!(errors[2].as_str().unwrap().contains("不支持的请求选项"));
}

#[test]
fn retaining_host_function_aliases_does_not_retain_or_crash_context() {
    let source = r#"globalThis.savedRequest = req; export default {home(){this.saved = request; return 1;}}"#;
    for _ in 0..4 {
        assert_eq!(fixture(source, "home", json!([])).unwrap(), json!(1));
    }
}
