// Real App TVBox source playback smoke test. Local-only: mocked Tauri IPC + local MP4 fixture.
// Not iPhone hardware acceptance; Chromium emulates iOS UI/lifecycle semantics.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(join(root, "test-results", "tvbox-sources-ui", new Date().toISOString().replace(/[:.]/g, "-")));
await mkdir(output, { recursive: true });
const report = { transport: "Real Vite App in Chromium; Tauri IPC and local source responses mocked", notIPhoneAcceptance: true, cases: [], external: [] };
let media, vite, browser, mediaFile, mediaOrigin;
const requests = [];

function makeMp4(dir) {
  mediaFile = join(dir, "tvbox-ui-fixture.mp4");
  execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "8", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", mediaFile], { timeout: 60000 });
}
async function rangeBody(range) {
  const data = await readFile(mediaFile);
  if (!range) return { status: 200, body: data, start: 0, end: data.length - 1, total: data.length };
  const m = /^bytes=(\d+)-(\d*)$/i.exec(range);
  const start = Number(m?.[1] || 0), end = Math.min(m?.[2] ? Number(m[2]) : data.length - 1, data.length - 1);
  return { status: 206, body: data.subarray(start, end + 1), start, end, total: data.length };
}
async function serveMedia() {
  media = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({ path: url.pathname, query: url.search, range: req.headers.range || null });
    const common = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Range,Accept-Ranges,Content-Length" };
    if (req.method === "OPTIONS") { res.writeHead(204, { ...common, "Access-Control-Allow-Headers": "Range" }); res.end(); return; }
    if (url.pathname === "/seg") {
      const target = url.searchParams.get("u") || "";
      assert(target.includes("tvbox-ui-fixture.mp4"), `unexpected /seg target: ${target}`);
      const part = await rangeBody(req.headers.range);
      const headers = { ...common, "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": part.body.length };
      if (part.status === 206) headers["Content-Range"] = `bytes ${part.start}-${part.end}/${part.total}`;
      res.writeHead(part.status, headers); res.end(part.body); return;
    }
    res.writeHead(404, common); res.end("not found");
  });
  await new Promise((done, reject) => { media.once("error", reject); media.listen(0, "127.0.0.1", done); });
  mediaOrigin = `http://127.0.0.1:${media.address().port}`;
}

const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 Version/17.1 Mobile/15E148 Safari/604.1";
const source = (key, name, api, type) => ({ key, name, api, type, searchable: 1, filterable: 1, quickSearch: 0 });
const fixtures = {
  json: { source: source("json", "JSON Fixture", "http://json.fixture/api", 1), kind: "json" },
  xml: { source: source("xml", "XML Fixture", "http://xml.fixture/api", 0), kind: "xml" },
  remote: { source: source("remote", "Remote Fixture", "http://remote.fixture/api", 4), kind: "remote" },
};
function responseText(kind, url) {
  const u = new URL(url); const opaque = "opaque-play-token";
  if (kind === "remote" && u.searchParams.has("play")) return JSON.stringify({ url: `${mediaOrigin}/tvbox-ui-fixture.mp4` });
  if (kind === "json") {
    if (u.searchParams.get("ac") === "detail") return JSON.stringify({ data: { list: [{ vod_id: "j1", vod_name: "JSON 本地影片", vod_play_from: "本地直链", vod_play_url: `第1集$${mediaOrigin}/tvbox-ui-fixture.mp4` }] } });
    if (u.searchParams.get("ac") === "videolist") return JSON.stringify({ data: { class: [{ type_id: "1", type_name: "电影" }], list: [{ vod_id: "j1", vod_name: "JSON 本地影片", vod_remarks: "完结" }] } });
  }
  if (kind === "xml") {
    const detail = u.searchParams.has("ids");
    return `<?xml version="1.0"?><rss><class><ty id="1">电影</ty></class><list><video><id>x1</id><name>XML 本地影片</name><note>完结</note>${detail ? `<dl><dd flag="XML线路">第1集$${mediaOrigin}/tvbox-ui-fixture.mp4</dd></dl>` : ""}</video></list></rss>`;
  }
  if (kind === "remote") {
    if (u.searchParams.get("ac") === "detail" && u.searchParams.has("ids")) return JSON.stringify({ list: [{ vod_id: "r1", vod_name: "Remote 透明影片", vod_play_from: "Remote线路", vod_play_url: `第1集$${opaque}` }] });
    if (u.searchParams.get("ac") === "detail") return JSON.stringify({ list: [{ vod_id: "r1", vod_name: "Remote 透明影片", vod_remarks: "完结" }] });
    if (u.searchParams.get("filter") === "true") return JSON.stringify({ class: [{ type_id: "1", type_name: "电影" }] });
  }
  return JSON.stringify({});
}

try {
  const mediaDir = await mkdtemp(join(output, "media-"));
  makeMp4(mediaDir); await serveMedia();
  vite = await createViteServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, open: false } });
  await vite.listen();
  const uiOrigin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || "/opt/google/chrome/chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
  for (const fixture of Object.values(fixtures)) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: iphone, isMobile: true, hasTouch: true });
    const external = []; const calls = [];
    await context.addInitScript(({ library, media }) => {
      localStorage.setItem("hghubx.tvbox.library.v1", JSON.stringify(library));
      window.__TVBOX_UI_FIXTURE__ = { media };
      window.__TAURI_INTERNALS__ = { invoke(command, args = {}) {
        if (command === "app_boot") return Promise.resolve({ user: null, logged_in: false, base: "http://fixture.invalid" });
        if (["debug_log", "playback_log", "set_text_interaction"].includes(command)) return Promise.resolve();
        if (command === "tvbox_fetch_text") return Promise.resolve(window.__TVBOX_UI_FIXTURE__.fetch(String(args.url)));
        return Promise.reject(`Unexpected IPC: ${command}`);
      } };
    }, { library: { sources: [fixture.source], parsers: [] }, media: mediaOrigin });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on("pageerror", e => { (report.pageErrors ??= []).push(`${fixture.kind}: ${e.message}`); });
    await context.route("**/*", async route => {
      const raw = route.request().url(); const url = new URL(raw);
      if (url.origin === uiOrigin || url.origin === mediaOrigin) return route.continue();
      if (url.protocol === "hg:" && url.hostname === "localhost") {
        const response = await fetch(`${mediaOrigin}${url.pathname}${url.search}`, { headers: { range: route.request().headers().range || "" } });
        return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
      }
      external.push(raw); return route.abort("blockedbyclient");
    });
    await page.exposeFunction("__fixtureFetch", async url => { calls.push(url); return responseText(fixture.kind, url); });
    await page.addInitScript(() => { window.__TVBOX_UI_FIXTURE__.fetch = window.__fixtureFetch; });
    const result = { name: fixture.kind, status: "running", calls: [] };
    report.cases.push(result);
    try {
      await page.goto(uiOrigin);
      await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "我的", exact: true }).click();
      await page.getByRole("button", { name: "TVBox 源播放", exact: true }).click();
      await page.getByRole("button", { name: new RegExp(fixture.source.name) }).waitFor();
      await page.getByRole("button", { name: new RegExp(fixture.kind === "remote" ? "Remote 透明影片" : fixture.kind === "xml" ? "XML 本地影片" : "JSON 本地影片") }).click();
      await page.getByRole("button", { name: "第1集", exact: true }).click();
      await page.waitForSelector("video");
      await page.waitForFunction(() => { const v = document.querySelector("video"); return v && v.currentTime > 1 && !v.paused; }, undefined, { timeout: 20000 });
      const playing = await page.locator("video").evaluate(v => ({ currentTime: v.currentTime, duration: v.duration, paused: v.paused, readyState: v.readyState, src: v.src }));
      assert(playing.currentTime > 1 && playing.duration > 1 && !playing.paused, `${fixture.kind}: video did not really decode/play: ${JSON.stringify(playing)}`);
      assert(requests.some(r => r.path === "/seg" && r.range), `${fixture.kind}: no byte-range /seg playback request`);
      const pageRoot = page.locator(".a-page-in").last();
      await pageRoot.evaluate(el => el.setAttribute("inert", ""));
      await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
      await page.waitForFunction(() => document.querySelector("video")?.paused === true);
      const paused = await page.locator("video").evaluate(v => ({ paused: v.paused, time: v.currentTime }));
      assert(paused.paused, `${fixture.kind}: inert/hidden layer did not pause video`);
      await pageRoot.evaluate(el => el.removeAttribute("inert"));
      await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
      await page.locator("video").evaluate(v => v.play());
      await page.waitForFunction(t => document.querySelector("video")?.currentTime > t + 0.4 && !document.querySelector("video")?.paused, paused.time);
      result.status = "passed"; result.playing = playing; result.pausedByInertAndHidden = paused; result.resumed = true;
      console.log(`PASS ${fixture.kind}: currentTime=${playing.currentTime.toFixed(2)} lockPause=true resumed=true`);
    } catch (error) { result.status = "failed"; result.error = String(error.stack || error); console.error(`FAIL ${fixture.kind}: ${error.message}`); }
    result.calls = calls; result.external = external;
    assert.deepEqual(external, [], `${fixture.kind}: unexpected external network`);
    await context.close();
  }
  report.external = report.cases.flatMap(c => c.external || []);
} catch (error) { report.setupError = String(error.stack || error); console.error(report.setupError); process.exitCode = 1; }
finally {
  report.finished = new Date().toISOString(); report.passed = report.cases.filter(c => c.status === "passed").length; report.failed = report.cases.filter(c => c.status !== "passed").length + (report.setupError ? 1 : 0);
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await browser?.close(); await media?.close(); await vite?.close();
  console.log(`TVBox source UI checks: ${report.passed} passed, ${report.failed} failed. Artifacts: ${output}`);
  process.exitCode ||= report.failed ? 1 : 0;
}
