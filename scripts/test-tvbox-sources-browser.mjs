import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import ts from "typescript";
import { chromium } from "playwright-core";

const root = new URL("../", import.meta.url);
const sourcePath = new URL("src/tvboxSources.ts", root);
const sourceText = await readFile(sourcePath, "utf8");
const compiled = ts.transpileModule(sourceText, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    verbatimModuleSyntax: true,
  },
}).outputText
  .replace(/^import\s+\{\s*invoke\s*\}\s+from\s+["']@tauri-apps\/api\/core["'];\s*$/m, "")
  .replace(/^export\s+/gm, "");

const vite = await createServer({
  root: root.pathname,
  configFile: false,
  server: { host: "127.0.0.1", port: 0 },
  appType: "custom",
});
let browser;
try {
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || "/opt/google/chrome/chrome",
  });
  const page = await browser.newPage();
  const calls = [];
  await page.exposeFunction("__invokeBridge", async (command, args) => {
    calls.push({ command, args });
    const request = new URL(args.url);
    if (command !== "tvbox_fetch_text") throw new Error(`unexpected command: ${command}`);
    if (request.searchParams.has("play")) {
      const mode = request.searchParams.get("play");
      if (mode === "parse-token") return JSON.stringify({ parse: 1, url: "https://cdn.fixture/parsed.m3u8" });
      if (mode === "header-token") return JSON.stringify({ url: "https://cdn.fixture/header.m3u8", header: { Referer: "https://private.invalid" } });
      if (mode === "jx-token") return JSON.stringify({ jx: "true", url: "https://cdn.fixture/jx.m3u8" });
      return JSON.stringify({ url: "https://cdn.fixture/remote.m3u8?sig=a%2Fb" });
    }
    return "{}";
  });
  await page.goto("about:blank");
  const call = (name, ...args) => page.evaluate(async ({ code, name, args }) => {
    const factory = new Function("invoke", `${code}\nreturn { parseTvboxConfig, parseTvboxCategories, parseTvboxVideos, parseTvboxDetail, resolveTvboxPlayback };`);
    const api = factory(globalThis.__invokeBridge);
    return await api[name](...args);
  }, { code: compiled, name, args });

  const xmlSource = { key: "xml", name: "XML Fixture", api: "https://xml.fixture.invalid/api.php", type: 0, searchable: 1, filterable: 1, quickSearch: 0 };
  const fallback = { id: "v-1", name: "回退片名", pic: "", note: "", year: "", area: "", typeName: "", director: "", actor: "", description: "" };
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss><class><ty id="1">电影</ty><ty id="2">剧集</ty></class><list><video><id>v-1</id><name>XML 影片</name><pic>https://img.fixture/poster.jpg</pic><note>更新至2集</note><year>2025</year><area>中国</area><type>剧情</type><director>导演甲</director><actor>演员乙</actor><des>详情 &amp; 说明</des><dl><dd flag="线路甲">第1集$https://cdn.fixture/one.m3u8#第2集$https://cdn.fixture/two.mp4</dd><dd flag="线路乙">正片$https://cdn.fixture/movie.mp4</dd></dl></video></list></rss>`;
  assert.deepEqual(await call("parseTvboxCategories", xml, 0), [{ id: "1", name: "电影" }, { id: "2", name: "剧集" }]);
  const videos = await call("parseTvboxVideos", xml, 0);
  assert.equal(videos[0].name, "XML 影片");
  assert.equal(videos[0].description, "详情 & 说明");
  const detail = await call("parseTvboxDetail", xml, xmlSource, fallback);
  assert.deepEqual(detail.flags, ["线路甲", "线路乙"]);
  assert.equal(detail.episodes["线路甲"][1].url, "https://cdn.fixture/two.mp4");
  assert.equal(detail.episodes["线路乙"][0].flag, "线路乙");

  const json = JSON.stringify({ data: { class: [{ type_id: 7, type_name: "剧集" }], list: [{ vod_id: 9, vod_name: "JSON 影片", vod_pic: "p", vod_remarks: "完结" }] } });
  assert.deepEqual(await call("parseTvboxCategories", json, 1), [{ id: "7", name: "剧集" }]);
  assert.equal((await call("parseTvboxVideos", json, 1))[0].id, "9");

  const remote = { key: "remote", name: "Remote Fixture", api: "https://remote.fixture.invalid/api", type: 4, searchable: 1, filterable: 1, quickSearch: 0 };
  const opaque = { name: "Remote 剧集", url: "opaque-token", flag: "线路甲" };
  calls.length = 0;
  assert.equal(await call("resolveTvboxPlayback", opaque, remote), "https://cdn.fixture/remote.m3u8?sig=a%2Fb");
  assert.equal(calls.length, 1);
  const remoteCall = calls[0];
  assert.equal(remoteCall.command, "tvbox_fetch_text");
  const request = new URL(remoteCall.args.url);
  assert.equal(request.searchParams.get("play"), "opaque-token");
  assert.equal(request.searchParams.get("flag"), "线路甲");
  assert.equal(request.searchParams.get("play"), "opaque-token", "opaque play token is passed unchanged");

  for (const [token, pattern] of [["parse-token", /parse\/jx|解析器/], ["jx-token", /parse\/jx|解析器/], ["header-token", /自定义请求头|请求头/]]) {
    await assert.rejects(call("resolveTvboxPlayback", { ...opaque, url: token }, remote), pattern);
  }
  const signed = "https://cdn.fixture.invalid/live/playlist.m3u8?sig=part%2Fsub%2520value";
  assert.equal(await call("resolveTvboxPlayback", { ...opaque, url: signed }, remote), signed, "signed direct media URL is not rewritten");

  console.log("PASS tvboxSources browser: real DOMParser XML categories/videos/detail, JSON fields, Remote opaque play args, parse/jx/header rejection, and signed URL preservation");
} finally {
  if (browser) await browser.close();
  await vite.close();
}
