// Local-only real LivePlayer HLS test. Browser fixture success is not Tauri/iOS device validation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "test-results", "live-playback", new Date().toISOString().replace(/[:.]/g, "-"));
const timeoutMs = 120000;
let tempMedia, vite, media, browser;
const sockets = new Set();
const report = { started: new Date().toISOString(), browser: "chromium", executable: "/usr/bin/chromium", transport: "browser fixture; not Tauri/WKWebView", cases: [], output };

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const withTimeout = (promise, ms, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms))]);

async function makeFixture() {
  tempMedia = await mkdtemp(join(tmpdir(), "hghubx-live-hls-"));
  execFileSync(process.env.FFMPEG_PATH || "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=520:sample_rate=44100", "-t", "24", "-c:v", "libx264", "-preset", "ultrafast",
    "-g", "48", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "hls", "-hls_time", "2",
    "-hls_list_size", "0", "-hls_flags", "omit_endlist", "-hls_segment_filename", join(tempMedia, "seg%03d.ts"), join(tempMedia, "live.m3u8"),
  ], { timeout: 60000, stdio: "pipe" });
  const manifest = await readFile(join(tempMedia, "live.m3u8"), "utf8");
  assert(manifest.startsWith("#EXTM3U") && !manifest.includes("#EXT-X-ENDLIST"), "fixture must be a live playlist without ENDLIST");
  return { manifest, segmentNames: [...manifest.matchAll(/\n([^#\r\n]+)\r?\n/g)].map(m => m[1].trim()) };
}

async function serveFixture(fixture) {
  let requests = 0;
  const server = createHttpServer(async (req, res) => {
    requests += 1;
    const url = new URL(req.url, "http://fixture.local");
    const common = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
    try {
      if (url.pathname === "/hls") {
        const target = url.searchParams.get("u") || "";
        if (target.includes("retry") && !server.retryPassed) {
          server.retryPassed = true;
          res.writeHead(503, { ...common, "Content-Type": "text/plain" }); res.end("intentional local retry fault"); return;
        }
        const body = fixture.manifest.replace(/(^|\n)(seg\d+\.ts)/g, (_m, p, name) => `${p}/seg?name=${encodeURIComponent(name)}&channel=${encodeURIComponent(target)}`);
        res.writeHead(200, { ...common, "Content-Type": "application/vnd.apple.mpegurl", "Content-Length": Buffer.byteLength(body) }); res.end(body); return;
      }
      if (url.pathname === "/seg") {
        const name = url.searchParams.get("name") || "";
        assert(fixture.segmentNames.includes(name), `unexpected segment ${name}`);
        const body = await readFile(join(tempMedia, name));
        res.writeHead(200, { ...common, "Content-Type": "video/mp2t", "Content-Length": body.length }); res.end(body); return;
      }
      res.writeHead(404, common); res.end("not found");
    } catch { res.writeHead(404, common); res.end("fixture error"); }
  });
  server.retryPassed = false;
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  server.requestCount = () => requests;
  return server;
}

try {
  await mkdir(output, { recursive: true });
  const fixture = await makeFixture();
  vite = await createViteServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, open: false } });
  await vite.listen();
  const ui = `http://127.0.0.1:${vite.httpServer.address().port}`;
  media = await serveFixture(fixture);
  const mediaUrl = `http://127.0.0.1:${media.address().port}`;
  report.ui = ui; report.media = mediaUrl; report.fixture = { live_playlist: true, endlist: false, duration_seconds: 24 };
  browser = await chromium.launch({ headless: true, executablePath: "/usr/bin/chromium", args: ["--autoplay-policy=no-user-gesture-required"] });
  report.browser_version = browser.version();

  const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const external = [];
  await context.route("**/*", route => {
    const raw = route.request().url();
    const url = new URL(raw);
    if ((url.origin === "http://127.0.0.1:17650" || url.origin === "http://hg.localhost") && (url.pathname === "/hls" || url.pathname === "/seg")) return route.continue({ url: `${mediaUrl}${url.pathname}${url.search}` });
    if (url.origin === ui || url.origin === mediaUrl) return route.continue();
    external.push({ url: raw, protocol: url.protocol, host: url.host });
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const caseResult = { name: "real-live-player", status: "running", started: new Date().toISOString() }; report.cases.push(caseResult);
  try {
    await page.goto(`${ui}/tests/live-playback.html?media=${encodeURIComponent(mediaUrl)}`);
    await page.waitForFunction(() => window.livePlaybackFixture?.events?.includes("playing"));
    const first = await page.evaluate(() => window.livePlaybackFixture.snapshot());
    assert(first.currentTime > 0, `currentTime did not advance: ${JSON.stringify(first)}`);
    assert(first.playing, "playing event/state was not observed");
    assert.equal(first.hasVodSlider, false, "live player must not display a VOD progress slider");
    await page.screenshot({ path: join(output, "live-success-local-fixture.png") });
    report.screenshot = join(output, "live-success-local-fixture.png");

    await page.getByRole("button", { name: "下一台" }).click();
    await page.waitForFunction(() => window.livePlaybackFixture.events.includes("channel-switched") && document.querySelectorAll("video").length === 1);
    const switched = await page.evaluate(() => window.livePlaybackFixture.snapshot());
    assert(switched.oldVideoPaused, "old video was not paused on channel switch");
    assert(switched.oldVideoDestroyed, "old video element was not destroyed on channel switch");
    assert(switched.channel === "本地演示 2", "new channel did not mount");

    await page.getByRole("button", { name: "测试重连" }).click();
    await page.waitForFunction(() => window.livePlaybackFixture.events.filter(e => e === "playing").length >= 2 && document.querySelector("video")?.currentTime > 0);
    const retried = await page.evaluate(() => window.livePlaybackFixture.snapshot());
    assert(retried.retryClicked, "retry/reconnect action was not exercised");
    assert(retried.currentTime > 0, "playback did not recover after retry action");
    assert.deepEqual(external, [], `unexpected external requests: ${JSON.stringify(external)}`);
    caseResult.metrics = { initial_current_time: first.currentTime, switched_channel: switched.channel, old_video_destroyed: switched.oldVideoDestroyed, retry_exercised: true, final_current_time: retried.currentTime, fixture_requests: media.requestCount() };
    caseResult.status = "passed";
    console.log(`PASS live playback: ${JSON.stringify(caseResult.metrics)}`);
  } catch (error) {
    caseResult.status = "failed"; caseResult.error = error.message; caseResult.external_requests = external;
    await page.screenshot({ path: join(output, "live-failure.png") }).catch(() => {});
    console.error(`FAIL live playback: ${error.message}`);
  } finally {
    caseResult.finished = new Date().toISOString();
    await context.close();
  }
} catch (error) {
  report.setup_error = error.message; console.error(`SETUP FAIL: ${error.message}`);
} finally {
  await browser?.close();
  for (const socket of sockets) socket.destroy();
  if (media) await new Promise(resolve => media.close(resolve));
  await vite?.close();
  if (tempMedia) await rm(tempMedia, { recursive: true, force: true });
  report.finished = new Date().toISOString();
  report.passed = report.cases.filter(c => c.status === "passed").length;
  report.failed = report.cases.filter(c => c.status !== "passed").length + (report.setup_error ? 1 : 0);
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Live playback checks: ${report.passed} passed, ${report.failed} failed. Artifacts: ${output}`);
  process.exitCode = report.failed ? 1 : 0;
}
