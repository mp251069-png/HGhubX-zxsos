import assert from "node:assert/strict";
import { createServer } from "vite";

const vite = await createServer({ configFile: "vite.config.ts", server: { middlewareMode: true }, appType: "custom" });
const storage = new Map();
const events = [];
let configFetches = 0;
let nextConfig = null;
const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const liveText = new Map([
  ["https://live.fixture.invalid/one.m3u", "#EXTM3U\n#EXTINF:-1,One\nhttps://cdn.fixture.invalid/one.m3u8"],
  ["https://cfg.fixture.invalid/live/two.m3u", "#EXTM3U\n#EXTINF:-1,Two\nhttps://cdn.fixture.invalid/two.m3u8"],
  ["https://cfg.fixture.invalid/live/only.txt", "CCTV,#genre#\nCCTV1,https://cdn.fixture.invalid/cctv1.m3u8\nCCTV2,https://cdn.fixture.invalid/cctv2.m3u8"],
  ["https://live.fixture.invalid/from-index.m3u", "#EXTM3U\n#EXTINF:-1,Index\nhttps://cdn.fixture.invalid/index.m3u8"],
]);
try {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    dispatchEvent: event => { events.push(event.type); return true; },
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        if (command === "tvbox_fetch") {
          assert.equal(new URL(args.url).pathname, "/config.json");
          configFetches += 1;
          if (nextConfig) {
            const config = nextConfig;
            nextConfig = null;
            return config;
          }
          return { sites: [{ name: "影视 API", api: `https://vod.fixture.invalid/api-${configFetches}` }], lives: [
            { name: "One", url: "https://live.fixture.invalid/one.m3u" },
            { name: "Two", url: "./live/two.m3u", type: "m3u", ua: "ignored" },
            { name: "Duplicate", url: "https://live.fixture.invalid/one.m3u" },
            { name: "Danger", url: "javascript:alert(1)" },
            { name: "Credential", url: "https://user:pass@live.fixture.invalid/private.m3u" },
            { name: "Broken" },
          ] };
        }
        if (command === "live_fetch") {
          const url = new URL(args.url).toString();
          if (url.endsWith("/two.m3u")) throw new Error("fixture live failure");
          return liveText.get(url) ?? "";
        }
        throw new Error(`unexpected command ${command}`);
      },
    },
  } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  } });

  const tvbox = await vite.ssrLoadModule("/src/tvbox.ts");
  const live = await vite.ssrLoadModule("/src/live.ts");
  const parsed = tvbox.parseTVBoxLiveEntries({ data: { lives: [
    { name: "Relative", url: "./x.m3u" }, { url: "rtmp://bad" }, { url: "https://u:p@bad.invalid/x" },
  ] } }, "https://cfg.fixture.invalid/root/config.json");
  assert.deepEqual(parsed.entries, [{ name: "Relative", url: "https://cfg.fixture.invalid/root/x.m3u" }]);
  assert.equal(parsed.skipped, 2);
  assert.equal(parsed.duplicates, 0);

  const result = await tvbox.importTVBoxSources("https://cfg.fixture.invalid/config.json");
  assert.equal(result.sources.length, 1, "VOD source remains imported");
  assert.equal(result.liveImported, 1);
  assert.equal(result.liveFailed, 1, "only a failed playlist fetch counts as a failure");
  assert.equal(result.liveSkipped, 4, "unsafe, malformed and duplicate live entries are counted as skipped");
  assert.equal(result.liveSources[0].name, "One");
  assert.equal(live.loadLiveSources().length, 1);
  assert.equal(storage.get("hghubx_live_active_v1"), result.liveSources[0].id, "first successful live source becomes active");
  assert(events.includes("hghubx:live-source-change"), "Live library change event is emitted");

  const existingActive = live.importLiveSourceFromText("#EXTM3U\n#EXTINF:-1,Existing\nhttps://cdn.fixture.invalid/existing.m3u8", "Existing", "", "https://live.fixture.invalid/existing.m3u");
  const second = await tvbox.importTVBoxSources("https://cfg.fixture.invalid/config.json");
  assert.equal(second.liveImported, 0);
  assert.equal(storage.get("hghubx_live_active_v1"), existingActive.id, "existing active source is not changed by duplicates");

  nextConfig = { lives: [{ name: "Only live", url: "./live/only.txt" }] };
  const liveOnly = await tvbox.importTVBoxSources("https://cfg.fixture.invalid/config.json");
  assert.deepEqual(liveOnly.sources, [], "a live-only TVBox config does not fall back to treating the config URL as a VOD API");
  assert.equal(liveOnly.liveImported, 1);
  assert.equal(liveOnly.liveSources[0].name, "Only live");
  assert.equal(liveOnly.liveSources[0].channels.length, 2, "TVBox plain grouped channel lists are converted to the shared Live model");
  assert.equal(liveOnly.liveSources[0].channels[0].group, "CCTV");

  nextConfig = { urls: [{ name: "Child config", url: "./child.json" }], lives: [
    { name: "Index live", url: "https://live.fixture.invalid/from-index.m3u" },
  ] };
  const indexWithLive = await tvbox.importTVBoxSources("https://cfg.fixture.invalid/config.json");
  assert.equal(indexWithLive.repositories.length, 1);
  assert.equal(indexWithLive.liveImported, 1, "repository early return must not discard root-level lives");

  const source = { id: "tvbox-source-one", name: "源一", url: "https://vod.fixture.invalid/api" };
  const video = { id: "vod-1", localId: 501, title: "剧集 A", cover: "https://img.fixture.invalid/poster.jpg",
    remarks: "更新至 10 集", description: "简介", year: "2026", area: "CN", language: "中文", type: "剧集",
    actor: "演员", director: "导演", score: 8.7, hot: 920, status: "更新至 10 集",
    playGroups: [{ name: "线路", episodes: [{ name: "第 1 集", url: "https://user:pass@media.fixture.invalid/ep1.m3u8" }] }] };
  assert.equal(tvbox.toggleTVBoxFavorite(source, video), true);
  assert.equal(tvbox.isTVBoxFavorite(source.id, video.id), true);
  assert.equal(tvbox.loadTVBoxFavorites().length, 1);
  assert.deepEqual(tvbox.loadTVBoxFavorites()[0].video.playGroups, [], "saved library metadata does not retain potentially sensitive playback URLs");
  assert.equal(tvbox.toggleTVBoxFavorite(source, video), false);
  assert.equal(tvbox.loadTVBoxFavorites().length, 0);
  tvbox.addTVBoxHistory(source, video, 2, 125, 900);
  tvbox.addTVBoxHistory(source, video, 2, 140, 900);
  assert.equal(tvbox.loadTVBoxHistory().length, 1, "history updates one source/video row rather than duplicating it");
  assert.equal(tvbox.loadTVBoxHistory()[0].t, 140);
  tvbox.clearTVBoxHistory();
  assert.equal(tvbox.loadTVBoxHistory().length, 0);
  assert(events.includes("hghubx:tvbox-library-changed"), "TVBox library mutations emit a refresh event");

  console.log("TVBox Live import checks passed: nested lives, relative URL resolution, unsafe filtering, duplicate suppression, failure isolation, persistence/events, and active-source stability.");
} finally {
  if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else delete globalThis.window;
  if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else delete globalThis.localStorage;
  await vite.close();
}
