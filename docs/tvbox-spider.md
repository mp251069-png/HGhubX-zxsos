# TVBox JavaScript Spider 支持范围

标准 JSON/API 源继续按原有流程加载。HTTP(S) `.js` / `.mjs` Spider 通过独立 QuickJS 解释器运行，不在 WebView 中执行，不注入应用或设备接口。

## 已支持

- ESM `export default` 对象，调用前自动 `init(ext)`；`home`、`homeVod`、`category`、`detail`、`search`、`play` 按位置接收参数，并保留 `this`。
- 同步结果、Promise、顶层 await，以及受控的相对 ESM 导入。
- `req(url)`、`req(url, {method: 'GET'})` 和同义的 `request`，只读取有界 UTF-8 文本。
- 每次调用独立的内存 `local` Map；它不是应用存储，调用间不共享。
- `play` 返回不需额外请求头、无需网页解析的直接 HLS/MP4 地址后，复用现有播放器。

## 明确不支持

JAR / `csp_*` Java Spider、Python、Node 模块、原生动态库、文件系统、环境变量、设备和应用存储接口均不开放。依赖 POST/HEAD、自定义请求头、二进制宿主请求、网页嗅探、`parse/jx` 或其他宿主扩展的脚本会被明确拒绝，不会退化成错误的 GET，也不会在 WebView 中兜底执行。

这不是完整 Android TVBox/drpy 宿主环境；不能据此宣称所有 drpy 规则或第三方 Spider 兼容。源站返回 404、地域限制或已失效的视频地址，也不会因为支持 Spider 自动变成可播放资源。

## 资源与网络限制

每次解释器堆上限 32 MiB、栈上限 1 MiB、解释执行总预算 8 秒；入口下载另有 15 秒限时。入口和单模块最多 2 MiB，模块最多 16 个、总计 8 MiB；宿主请求最多 32 次、响应合计最多 4 MiB。JSON 输入和结果各最多 2 MiB。结果先在受限解释器中序列化，检查 UTF-8 大小后才解析为宿主对象。

网络始终走应用的严格网关，检查 URL、DNS 结果和每跳重定向；即使用户关闭应用的全局严格开关，Spider 也不能访问 loopback、普通内网和特殊地址。不会转发应用的登录令牌或 Cookie。

## 回归验证

`cargo test --manifest-path src-tauri/Cargo.toml --lib spider` 使用自造离线脚本，覆盖 ESM/参数/异步、危险全局缺失、内存和结果超限、死循环和悬挂 Promise 中断、调用间隔离及宿主函数别名释放。

`node scripts/test-tvbox-playback.mjs` 分别验证标准 JSON 和模拟 Spider 的“剧集 ID → 解析 → 媒体 Range 请求 → 播放时间前进”。它不能替代真实第三方源测试或 iPhone 真机播放验收。
