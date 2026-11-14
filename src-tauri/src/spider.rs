//! Sandboxed JavaScript TVBox Spider execution.
//! Untrusted source, ext, arguments and responses are bounded data; they are never instructions.
use rquickjs::function::Args;
use rquickjs::loader::{Loader, Resolver};
use rquickjs::promise::{Promise, PromiseState};
use rquickjs::{Context, Ctx, Function, Module, Object, Runtime, Value as JsValue};
use serde_json::Value;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const MAX_SOURCE: usize = 2 * 1024 * 1024;
const MAX_INPUT: usize = 2 * 1024 * 1024;
const MAX_MODULES: usize = 16;
const MAX_MODULE_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESULT: usize = 2 * 1024 * 1024;
const MAX_REQUESTS: usize = 32;
const MAX_RESPONSE: usize = 4 * 1024 * 1024;
const MEMORY: usize = 32 * 1024 * 1024;
const STACK: usize = 1024 * 1024;
const EXEC: Duration = Duration::from_secs(8);
const NET: Duration = Duration::from_secs(15);

const METHODS: &[&str] = &[
    "init", "home", "homeVod", "category", "detail", "search", "play",
];

#[derive(Clone)]
struct Budget {
    requests: usize,
    modules: usize,
    module_bytes: usize,
    response_bytes: usize,
    start: Instant,
}
impl Budget {
    fn check(&self) -> rquickjs::Result<()> {
        if self.start.elapsed() > EXEC {
            return Err(rquickjs::Error::new_from_js(
                "timeout",
                "execution deadline exceeded",
            ));
        }
        Ok(())
    }
}
fn js_err(kind: &'static str, msg: &'static str) -> rquickjs::Error {
    rquickjs::Error::new_from_js(kind, msg)
}
fn validate_request_options(
    method: Option<&str>,
    has_body: bool,
    has_headers: bool,
) -> Result<(), &'static str> {
    if let Some(m) = method {
        if !m.eq_ignore_ascii_case("GET") {
            return Err("仅支持 GET");
        }
    }
    if has_body {
        return Err("不支持请求 body");
    }
    if has_headers {
        return Err("不支持自定义 headers");
    }
    Ok(())
}
fn bounded_json(v: &Value, label: &'static str) -> Result<(), String> {
    struct Size(usize);
    impl std::io::Write for Size {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len());
            if self.0 > MAX_INPUT {
                return Err(std::io::Error::other("JSON size limit"));
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(Size(0), v).map_err(|_| format!("{label} JSON 超过大小限制"))
}
fn source_url(raw: &str) -> Result<url::Url, String> {
    let u = url::Url::parse(raw).map_err(|_| "source.url 无效".to_string())?;
    if !matches!(u.scheme(), "http" | "https")
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
    {
        return Err("source.url 只允许无认证、无片段的 HTTP(S) 地址".into());
    }
    let p = u.path().to_ascii_lowercase();
    if !p.ends_with(".js") && !p.ends_with(".mjs") {
        return Err("source.url 必须指向 .js/.mjs 文件".into());
    }
    Ok(u)
}

fn fetch(url: &str, max: usize, budget: Option<&Arc<Mutex<Budget>>>) -> Result<Vec<u8>, String> {
    let timeout = if let Some(b) = budget {
        let b = b.lock().map_err(|_| "预算锁失败")?;
        b.check().map_err(|_| "执行超时")?;
        EXEC.checked_sub(b.start.elapsed())
            .ok_or("执行超时")?
            .min(NET)
    } else {
        NET
    };
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    rt.block_on(async {
        let started = Instant::now();
        let response = crate::net::get_strict(
            url,
            timeout,
            Some("text/javascript, application/javascript, */*"),
            None,
        )
        .await?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status()));
        }
        if response.content_length().is_some_and(|n| n > max as u64) {
            return Err("响应超过大小限制".into());
        }
        let content_length = response.content_length();
        let mut stream = response.bytes_stream();
        let mut out = Vec::with_capacity(content_length.unwrap_or(0).min(max as u64) as usize);
        while let Some(chunk) = tokio::time::timeout(
            timeout.saturating_sub(started.elapsed()),
            futures_util::StreamExt::next(&mut stream),
        )
        .await
        .map_err(|_| "响应体超时".to_string())?
        .transpose()
        .map_err(|e| e.to_string())?
        {
            if started.elapsed() >= timeout {
                return Err("响应体超时".into());
            }
            if out.len().saturating_add(chunk.len()) > max {
                return Err("响应超过大小限制".into());
            }
            out.extend_from_slice(&chunk);
        }
        if let Some(b) = budget {
            let b = b.lock().map_err(|_| "预算锁失败")?;
            b.check().map_err(|_| "执行超时".to_string())?;
        }
        Ok(out)
    })
}

struct HttpResolver;
impl Resolver for HttpResolver {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _a: Option<rquickjs::loader::ImportAttributes<'js>>,
    ) -> rquickjs::Result<String> {
        if !name.starts_with('.') {
            return Err(js_err("module", "仅允许相对 HTTP(S) 模块导入"));
        }
        let u = url::Url::parse(base)
            .map_err(|_| js_err("module", "非法模块基址"))?
            .join(name)
            .map_err(|_| js_err("module", "非法相对模块路径"))?;
        if !matches!(u.scheme(), "http" | "https")
            || !u.username().is_empty()
            || u.password().is_some()
            || u.fragment().is_some()
        {
            return Err(js_err("module", "模块地址不安全"));
        }
        Ok(u.to_string())
    }
}
struct HttpLoader {
    budget: Arc<Mutex<Budget>>,
}
impl Loader for HttpLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _a: Option<rquickjs::loader::ImportAttributes<'js>>,
    ) -> rquickjs::Result<Module<'js, rquickjs::module::Declared>> {
        let b = self
            .budget
            .lock()
            .map_err(|_| js_err("module", "预算锁失败"))?;
        b.check()?;
        if b.modules >= MAX_MODULES {
            return Err(js_err("module", "模块数量超过限制"));
        }
        let max = MAX_SOURCE.min(MAX_MODULE_BYTES.saturating_sub(b.module_bytes));
        if max == 0 {
            return Err(js_err("module", "模块总大小超过限制"));
        }
        drop(b);
        let bytes =
            fetch(name, max, Some(&self.budget)).map_err(|_| js_err("module", "模块加载失败"))?;
        let mut b = self
            .budget
            .lock()
            .map_err(|_| js_err("module", "预算锁失败"))?;
        b.modules += 1;
        b.module_bytes = b.module_bytes.saturating_add(bytes.len());
        if b.module_bytes > MAX_MODULE_BYTES {
            return Err(js_err("module", "模块总大小超过限制"));
        }
        drop(b);
        Module::declare(ctx.clone(), name, bytes)
    }
}

fn install_host<'js>(ctx: Ctx<'js>, budget: Arc<Mutex<Budget>>) -> rquickjs::Result<()> {
    let globals = ctx.globals();
    let req_budget = budget.clone();
    let req = Function::new(
        ctx.clone(),
        move |req_ctx: Ctx<'js>,
              url: String,
              opts: rquickjs::function::Opt<Object<'js>>|
              -> rquickjs::Result<Object<'js>> {
            let opts = match opts.0 {
                Some(opts) => opts,
                None => Object::new(req_ctx.clone())?,
            };
            for key in opts.keys::<String>() {
                if !matches!(
                    key.map_err(|_| js_err("request", "请求选项无效"))?.as_str(),
                    "method" | "headers" | "body"
                ) {
                    return Err(js_err("request", "不支持的请求选项"));
                }
            }
            let method: Option<String> = opts
                .get("method")
                .map_err(|_| js_err("request", "请求选项无效"))?;
            validate_request_options(
                method.as_deref(),
                opts.contains_key("body")
                    .map_err(|_| js_err("request", "请求选项无效"))?,
                opts.contains_key("headers")
                    .map_err(|_| js_err("request", "请求选项无效"))?,
            )
            .map_err(|message| js_err("request", message))?;
            let target = url::Url::parse(&url).map_err(|_| js_err("request", "请求 URL 无效"))?;
            if !matches!(target.scheme(), "http" | "https")
                || !target.username().is_empty()
                || target.password().is_some()
                || target.fragment().is_some()
            {
                return Err(js_err("request", "仅允许无认证 HTTP(S) 请求"));
            }
            let mut b = req_budget
                .lock()
                .map_err(|_| js_err("request", "预算锁失败"))?;
            b.check()?;
            if b.requests >= MAX_REQUESTS {
                return Err(js_err("request", "请求次数超过限制"));
            }
            let max = MAX_RESPONSE.saturating_sub(b.response_bytes);
            if max == 0 {
                return Err(js_err("request", "总响应大小超过限制"));
            }
            b.requests += 1;
            drop(b);
            let bytes =
                fetch(&url, max, Some(&req_budget)).map_err(|_| js_err("request", "请求失败"))?;
            let mut b = req_budget
                .lock()
                .map_err(|_| js_err("request", "预算锁失败"))?;
            b.response_bytes = b.response_bytes.saturating_add(bytes.len());
            if b.response_bytes > MAX_RESPONSE {
                return Err(js_err("request", "总响应大小超过限制"));
            }
            let content =
                String::from_utf8(bytes).map_err(|_| js_err("request", "响应不是 UTF-8"))?;
            let out = Object::new(req_ctx.clone())?;
            out.set("content", content)?;
            out.set("code", 200i32)?;
            out.set("headers", Object::new(req_ctx.clone())?)?;
            Ok(out)
        },
    )?;
    globals.set("req", req.clone())?;
    globals.set("request", req)?;
    ctx.eval::<(), _>(r#"globalThis.local = (() => { const m = new Map(); return { set:(r,k,v)=>m.set(String(r)+'\0'+String(k),v), get:(r,k)=>m.get(String(r)+'\0'+String(k)), delete:(r,k)=>m.delete(String(r)+'\0'+String(k)) }; })(); globalThis.console={log(){},warn(){},error(){}};"#)?;
    Ok(())
}
fn js_value<'js>(ctx: Ctx<'js>, v: &Value) -> rquickjs::Result<JsValue<'js>> {
    rquickjs_serde::to_value(ctx, v).map_err(|_| js_err("args", "JSON 转换失败"))
}
fn drive_promise<'js>(
    ctx: &Ctx<'js>,
    promise: &Promise<'js>,
    deadline: Instant,
) -> rquickjs::Result<JsValue<'js>> {
    while promise.state() == PromiseState::Pending {
        if Instant::now() >= deadline {
            return Err(js_err("timeout", "promise timeout"));
        }
        if !ctx.execute_pending_job() {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    match promise.result::<JsValue<'js>>() {
        Some(Ok(v)) => Ok(v),
        Some(Err(_)) => Err(js_err("promise", "Promise rejected")),
        None => Err(js_err("promise", "Promise 无结果")),
    }
}
fn call_method<'js>(
    ctx: &Ctx<'js>,
    f: Function<'js>,
    this: Object<'js>,
    args: &[Value],
) -> rquickjs::Result<JsValue<'js>> {
    let mut a = Args::new(ctx.clone(), args.len());
    a.this(this)?;
    for v in args {
        a.push_arg(js_value(ctx.clone(), v)?)?;
    }
    f.call_arg(a)
}
fn run(
    url: String,
    entry: Vec<u8>,
    ext: Value,
    method: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    let runtime = Runtime::new().map_err(|e| e.to_string())?;
    runtime.set_memory_limit(MEMORY);
    runtime.set_max_stack_size(STACK);
    let deadline = Instant::now() + EXEC;
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let budget = Arc::new(Mutex::new(Budget {
        requests: 0,
        modules: 1,
        module_bytes: entry.len(),
        response_bytes: 0,
        start: Instant::now(),
    }));
    if entry.len() > MAX_SOURCE || entry.len() > MAX_MODULE_BYTES {
        return Err("入口脚本超过大小限制".into());
    }
    runtime.set_loader(
        HttpResolver,
        HttpLoader {
            budget: budget.clone(),
        },
    );
    let ctx = Context::full(&runtime).map_err(|e| e.to_string())?;
    let result = ctx.with(|ctx| -> Result<Value, String> {
        install_host(ctx.clone(), budget.clone()).map_err(|_| "宿主初始化失败")?;
        let module = Module::declare(ctx.clone(), url, entry).map_err(|_| "脚本解析失败")?;
        let (evaluated, promise) = module.eval().map_err(|_| "脚本执行失败")?;
        drive_promise(&ctx, &promise, deadline).map_err(|_| "脚本初始化失败")?;
        let ns = evaluated.namespace().map_err(|_| "模块命名空间失败")?;
        let spider: JsValue = ns.get("default").map_err(|_| "缺少 default 导出")?;
        let obj = spider.as_object().ok_or("default 不是对象")?;
        if let Some(init) = obj
            .get::<_, Option<Function>>("init")
            .map_err(|_| "init 无效")?
            .filter(|_| method != "init")
        {
            let mut init_args = Args::new(ctx.clone(), 1);
            init_args.this(obj.clone()).map_err(|_| "init 失败")?;
            init_args
                .push_arg(js_value(ctx.clone(), &ext).map_err(|_| "ext 无效")?)
                .map_err(|_| "init 失败")?;
            let v: JsValue = init.call_arg(init_args).map_err(|_| "init 失败")?;
            if let Some(p) = v.clone().into_promise() {
                drive_promise(&ctx, &p, deadline).map_err(|_| "Promise rejected")?;
            }
        }
        let f: Function = obj.get(method.as_str()).map_err(|_| "方法不存在")?;
        let value = call_method(&ctx, f, obj.clone(), &args).map_err(|_| "方法执行失败")?;
        let value = if let Some(p) = value.clone().into_promise() {
            drive_promise(&ctx, &p, deadline).map_err(|_| "Promise rejected")?
        } else {
            value
        };
        // Stringify inside the memory-limited VM before allocating any host tree.
        // Shared references cannot amplify a small JS graph into unbounded Rust data.
        let Some(text) = ctx
            .json_stringify(value)
            .map_err(|_| "结果序列化失败或超过隔离内存限制")?
        else {
            return Ok(Value::Null);
        };
        let text = text.to_cstring().map_err(|_| "结果字符串无效")?;
        if text.len() > MAX_RESULT {
            return Err("结果超过大小限制".into());
        }
        budget
            .lock()
            .map_err(|_| "预算锁失败")?
            .check()
            .map_err(|_| "执行超时")?;
        let bytes: &[u8] = text.as_ref();
        serde_json::from_slice(bytes).map_err(|_| "结果 JSON 无效".into())
    });
    result
}

/// Execute one TVBox Spider method. Production source loading always uses the strict gateway.
pub async fn call(source: Value, method: String, args: Value) -> Result<Value, String> {
    bounded_json(&source, "source")?;
    bounded_json(&args, "args")?;
    if !METHODS.contains(&method.as_str()) {
        return Err("不支持的 Spider 方法".into());
    }
    let args = args.as_array().ok_or("args 必须是数组")?.clone();
    let url = source
        .get("url")
        .and_then(Value::as_str)
        .ok_or("source.url 必须是 HTTP(S) 地址")?;
    let parsed = source_url(url)?;
    crate::network_policy::parse_target_with_mode(parsed.as_str(), true)
        .map_err(|_| "源地址不被严格网络策略允许")?;
    let ext = source.get("ext").cloned().unwrap_or(Value::Null);
    bounded_json(&ext, "ext")?;
    tokio::task::spawn_blocking(move || {
        let entry = fetch(parsed.as_str(), MAX_SOURCE, None)
            .map_err(|_| "Spider 入口加载失败（网络或访问限制）")?;
        run(parsed.to_string(), entry, ext, method, args)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;
    use serde_json::json;
    fn fixture(source: &str, method: &str, args: Value) -> Result<Value, String> {
        run(
            "https://fixture.invalid/spider".into(),
            source.as_bytes().to_vec(),
            Value::Null,
            method.into(),
            args.as_array().unwrap().clone(),
        )
    }
    const ESM: &str = r#"export default { init(x){ this.seed=x; }, home(a,b){ return {m:'home', a,b}; }, category(...a){return {m:'category',a};}, detail(...a){return {m:'detail',a};}, search(...a){return {m:'search',a};}, play(...a){return {m:'play',a};} }"#;
    #[test]
    fn positional_args_and_default_export_work() {
        for m in ["home", "category", "detail", "search", "play"] {
            let v = fixture(ESM, m, json!(["x", 2])).unwrap();
            assert_eq!(v["m"], m);
            if m == "home" {
                assert_eq!(v["a"], "x");
            } else {
                assert_eq!(v["a"][0], "x");
            }
        }
    }
    #[test]
    fn async_fulfilled_and_rejected_are_bounded() {
        let s =
            r#"export default {async init(){await Promise.resolve(1)}, async home(){return 3}}"#;
        assert_eq!(fixture(s, "home", json!([])).unwrap(), json!(3));
        let s = r#"export default {home(){return Promise.reject('secret-token')}}"#;
        assert_eq!(
            fixture(s, "home", json!([])).unwrap_err(),
            "Promise rejected"
        );
    }
    #[test]
    fn dangerous_globals_and_imports_are_unavailable() {
        let s = r#"export default {home(){return [typeof require,typeof process,typeof fs,typeof Deno,typeof Bun,typeof tauri,typeof eval,typeof Function]}}"#;
        let v = fixture(s, "home", json!([])).unwrap();
        assert_eq!(
            v,
            json!([
                "undefined",
                "undefined",
                "undefined",
                "undefined",
                "undefined",
                "undefined",
                "function",
                "function"
            ])
        );
        for s in [
            "import 'file:///etc/passwd'; export default {};",
            "import 'node:fs'; export default {};",
            "export default {}; eval('process')",
        ] {
            assert!(fixture(s, "home", json!([])).is_err());
        }
    }
    #[test]
    fn source_and_method_input_limits_are_enforced() {
        assert!(source_url("file:///tmp/x").is_err());
        assert!(source_url("https://x/a.js").is_ok());
        assert!(source_url("https://u:p@x/").is_err());
        assert!(
            call(json!({"url":"https://x/"}), "home".into(), json!({"x":1}))
                .now_or_never()
                .unwrap()
                .is_err()
        );
    }
    #[test]
    fn loops_are_interrupted_and_calls_are_fresh() {
        let s = r#"export default {home(){while(true){} }}"#;
        assert!(fixture(s, "home", json!([])).is_err());
        let s = r#"export default {home(){local.set('r','k',1); return local.get('r','k')}}"#;
        assert_eq!(fixture(s, "home", json!([])).unwrap(), json!(1));
        let s = r#"export default {home(){return local.get('r','k')}}"#;
        assert_eq!(fixture(s, "home", json!([])).unwrap(), Value::Null);
    }
    #[test]
    fn request_method_policy_is_explicit() {
        assert!(source_url("https://127.0.0.1/a.js").is_ok());
        assert!(crate::network_policy::parse_target_with_mode("https://127.0.0.1/", true).is_err());
        assert!(validate_request_options(Some("POST"), false, false).is_err());
        assert!(validate_request_options(Some("GET"), false, true).is_err());
        assert!(validate_request_options(Some("HEAD"), false, false).is_err());
    }
}

#[cfg(test)]
#[path = "spider_extra_tests.rs"]
mod extra_tests;
