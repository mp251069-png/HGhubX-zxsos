// Local-only end-to-end regression: standard TVBox JSON/API -> Feed -> VideoSurface -> MP4 /seg.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(join(root, "test-results", "tvbox-playback", new Date().toISOString().replace(/[:.]/g, "-")));
await mkdir(output, { recursive: true });
const mediaDir = await mkdtemp(join(output, "tvbox-playback-media-"));
const report = { started: new Date().toISOString(), transport: "local browser fixture; Tauri IPC mocked", output, cases: [] };
let media, vite, browser;
let mediaFile;
const requests = [];

function makeMp4() {
  mediaFile = join(mediaDir, "tvbox-playback-sample.mp4");
  execFileSync(process.env.FFMPEG_PATH || "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "8", "-c:v", "libx264",
    "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", mediaFile,
  ], { timeout: 60000, stdio: "pipe" });
}

async function readRange(file, range) {
  const data = await readFile(file);
  if (!range) return { status: 200, body: data, start: 0, end: data.length - 1 };
  const match = /^bytes=(\d+)-(\d*)$/i.exec(range);
  if (!match) return { status: 416, body: Buffer.alloc(0), start: 0, end: data.length - 1 };
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
  if (start >= data.length || start > end) return { status: 416, body: Buffer.alloc(0), start: 0, end: data.length - 1 };
  return { status: 206, body: data.subarray(start, end + 1), start, end };
}

async function serveFixture() {
  media = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({ method: req.method, path: url.pathname, query: url.search, range: req.headers.range ?? null });
    const common = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Range,Accept-Ranges,Content-Length" };
    if (req.method === "OPTIONS") { res.writeHead(204, { ...common, "Access-Control-Allow-Headers": "Range" }); res.end(); return; }
    if (url.pathname === "/api.php/provide/vod/") {
      const detail = url.searchParams.get("ac") === "detail";
      const payload = detail ? { code: 1, list: [{ vod_id: "fixture-vod-1", vod_name: "本地 MP4 回归", vod_play_from: "网页播放器$$$本地直链", vod_play_url: "网页$http://media.fixture.invalid/share/unsupported$$$第1集$http://media.fixture.invalid/tvbox-playback-sample.mp4", vod_content: "只用于本地真实播放回归" }] }
        : { code: 1, page: 1, pagecount: 1, total: 1, list: [{ vod_id: "fixture-vod-1", vod_name: "本地 MP4 回归", vod_play_from: "网页播放器$$$本地直链", vod_play_url: "网页$http://media.fixture.invalid/share/unsupported$$$第1集$http://media.fixture.invalid/tvbox-playback-sample.mp4" }] };
      const body = Buffer.from(JSON.stringify(payload));
      res.writeHead(200, { ...common, "Content-Type": "application/json", "Content-Length": body.length }); res.end(body); return;
    }
    if (url.pathname === "/tvbox-playback-sample.mp4") {
      const result = await readRange(mediaFile, req.headers.range);
      const headers = { ...common, "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": result.body.length };
      if (result.status === 206) headers["Content-Range"] = `bytes ${result.start}-${result.end}/${(await readFile(mediaFile)).length}`;
      res.writeHead(result.status, headers); res.end(result.body); return;
    }
    if (url.pathname === "/seg") {
      const raw = url.searchParams.get("u") || "";
      assert.equal(raw, "http://media.fixture.invalid/tvbox-playback-sample.mp4", "direct proxy must preserve the TVBox MP4 URL");
      const result = await readRange(mediaFile, req.headers.range);
      const headers = { ...common, "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": result.body.length };
      if (result.status === 206) headers["Content-Range"] = `bytes ${result.start}-${result.end}/${(await readFile(mediaFile)).length}`;
      res.writeHead(result.status, headers); res.end(result.body); return;
    }
    res.writeHead(404, common); res.end("not found");
  });
  await new Promise((done, reject) => { media.once("error", reject); media.listen(0, "127.0.0.1", done); });
  return `http://127.0.0.1:${media.address().port}`;
}

try {
  makeMp4();
  const mediaOrigin = await serveFixture();
  vite = await createViteServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, open: false } });
  await vite.listen();
  const uiOrigin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const external = [];
  await context.addInitScript(({ apiOrigin, mp4Origin }) => {
    window.__TAURI_INTERNALS__ = { invoke(command, args = {}) {
      if (command === "app_boot") return Promise.resolve({ user: null, logged_in: false, base: "http://fixture.invalid" });
      if (command === "debug_log" || command === "playback_log" || command === "set_text_interaction") return Promise.resolve();
      if (command === "tvbox_fetch") return fetch(String(args.url)).then(response => response.ok ? response.json() : Promise.reject(`HTTP ${response.status}`));
      if (command === "tvbox_spider") {
        const method = args.method;
        if (method === "home") return Promise.resolve({ class: [{ type_id: "1", type_name: "Fixture" }] });
        if (method === "homeVod") return Promise.resolve({ list: [{ vod_id: "opaque-vod-1", vod_name: "JS Spider MP4" }] });
        if (method === "detail") return Promise.resolve({ list: [{ vod_id: "opaque-vod-1", vod_name: "JS Spider MP4", vod_play_from: "fixture", vod_play_url: "第1集$opaque-episode-1" }] });
        if (method === "play") {
          if (args.args?.[1] !== "opaque-episode-1") return Promise.reject("unexpected opaque episode id");
          return Promise.resolve({ url: `${mp4Origin}/tvbox-playback-sample.mp4` });
        }
        return Promise.resolve({ list: [] });
      }
      return Promise.reject(`Unexpected IPC: ${command}`);
    } };
    window.__tvboxPlaybackOrigins = { apiOrigin, mp4Origin };
  }, { apiOrigin: mediaOrigin, mp4Origin: "http://media.fixture.invalid" });
  await context.route("**/*", route => {
    const raw = route.request().url();
    const url = new URL(raw);
    if (url.origin === uiOrigin) return route.continue();
    if (url.origin === mediaOrigin) return route.continue();
    if (url.origin === "http://127.0.0.1:17650") return route.continue({ url: `${mediaOrigin}${url.pathname}${url.search}` });
    if (url.origin === "http://media.fixture.invalid") return route.continue({ url: `${mediaOrigin}${url.pathname}${url.search}` });
    external.push(raw); return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const standardCaseStart = requests.length;
  const standardExternalStart = external.length;
  await page.goto(`${uiOrigin}/tests/tvbox-playback.html?api=${encodeURIComponent(`${mediaOrigin}/api.php/provide/vod/`)}`);
  await page.waitForFunction(() => window.tvboxPlaybackFixture?.state === "ready");
  await page.waitForSelector("video");
  await page.waitForFunction(() => document.querySelector("video")?.currentTime > 0.5, undefined, { timeout: 20000 });
  const result = await page.locator("video").evaluate(video => ({ src: video.src, paused: video.paused, currentTime: video.currentTime, duration: video.duration, readyState: video.readyState }));
  assert(result.src.includes("/seg?u="), `Expected direct /seg source, got ${result.src}`);
  assert(!result.src.includes("/hls"), `Direct MP4 must not use /hls: ${result.src}`);
  assert.equal(result.paused, false, "VideoSurface must actually be playing");
  assert(result.currentTime > 0.5, `currentTime did not advance: ${result.currentTime}`);
  assert(result.duration > 1, `MP4 duration unavailable: ${result.duration}`);
  const standardRequests = requests.slice(standardCaseStart);
  assert(standardRequests.some(request => request.path === "/seg"), "Range media service must receive /seg");
  assert(standardRequests.some(request => request.path === "/seg" && request.method === "GET"), "Media must be fetched through GET /seg");
  assert(standardRequests.some(request => request.path === "/seg" && request.range?.startsWith("bytes=")), "Actual playback must make a byte-range media request");
  assert(standardRequests.some(request => request.path === "/api.php/provide/vod/" && new URLSearchParams(request.query).get("ac") === "detail"), "Feed must request standard TVBox details");
  assert(!standardRequests.some(request => request.path === "/hls"), "Direct MP4 must never enter the HLS proxy");
  assert.deepEqual(external.slice(standardExternalStart), [], "Standard case must make no external network requests");
  assert.deepEqual(pageErrors, [], "Browser script errors");
  assert.deepEqual(external, [], "No real third-party network requests");
  report.cases.push({ name: "standard-tvbox-detail-to-mp4", status: "passed", result, requests: standardRequests.filter(request => request.path === "/seg" || request.path.includes("/api.php")) });
  await page.screenshot({ path: join(output, "final.png") });
  console.log(`PASS standard-tvbox-detail-to-mp4: ${JSON.stringify(result)}`);
  const jsCaseStart = requests.length;
  const jsExternalStart = external.length;
  await page.goto(`${uiOrigin}/tests/tvbox-playback.html?js=1`);
  await page.waitForFunction(() => window.tvboxPlaybackFixture?.state === "ready");
  await page.waitForSelector("video");
  await page.waitForFunction(() => document.querySelector("video")?.currentTime > 0.5, undefined, { timeout: 20000 });
  const jsResult = await page.locator("video").evaluate(video => ({ src: video.src, paused: video.paused, currentTime: video.currentTime, duration: video.duration }));
  assert(jsResult.src.includes("/seg?u="), `Expected JS direct /seg source, got ${jsResult.src}`);
  assert.equal(jsResult.paused, false, "JS Spider video must actually be playing");
  assert(jsResult.currentTime > 0.5, `JS currentTime did not advance: ${jsResult.currentTime}`);
  assert(jsResult.duration > 1, `JS MP4 duration unavailable: ${jsResult.duration}`);
  const jsRequests = requests.slice(jsCaseStart);
  assert(jsRequests.some(request => request.path === "/seg" && request.method === "GET" && request.range?.startsWith("bytes=")), "JS playback must make a byte-range /seg GET");
  assert(!jsRequests.some(request => request.path === "/hls"), "JS direct MP4 must never enter the HLS proxy");
  assert.deepEqual(external.slice(jsExternalStart), [], "JS case must make no external network requests");
  assert.deepEqual(pageErrors, [], "Browser script errors in JS Spider case");
  report.cases.push({ name: "js-spider-opaque-id-to-mp4", status: "passed", result: jsResult, requests: jsRequests.filter(request => request.path === "/seg") });
  console.log(`PASS js-spider-opaque-id-to-mp4: ${JSON.stringify(jsResult)}`);
  await context.close();
} catch (error) {
  report.cases.push({ name: "tvbox-playback-suite", status: "failed", error: String(error.stack || error), requests });
  console.error(String(error.stack || error));
  process.exitCode = 1;
} finally {
  report.finished = new Date().toISOString();
  report.passed = report.cases.filter(c => c.status === "passed").length;
  report.failed = report.cases.filter(c => c.status !== "passed").length;
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await browser?.close();
  await media?.close();
  await vite?.close();
  await rm(mediaDir, { recursive: true, force: true });
  console.log(`TVBox playback checks: ${report.passed} passed, ${report.failed} failed. Artifacts: ${output}`);
}
