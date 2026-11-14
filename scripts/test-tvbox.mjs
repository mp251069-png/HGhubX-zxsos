import assert from "node:assert/strict";
import { createServer } from "vite";

const vite = await createServer({
  configFile: "vite.config.ts",
  server: { middlewareMode: true },
  appType: "custom",
});
try {
  const tvbox = await vite.ssrLoadModule("/src/tvbox.ts");
  const api = await vite.ssrLoadModule("/src/api.ts");
  const source = { id: "fixture-source", name: "Fixture", url: "https://tv.fixture.invalid/api.php/provide/vod/?token=x" };
  const response = {
    code: 1,
    data: {
      page: "2",
      pagecount: "5",
      total: "42",
      class: [{ type_id: "1", type_name: "电影" }, { type_id: "2", type_name: "剧集" }],
      list: [{
        vod_id: "vod-7",
        vod_name: "测试影片",
        vod_pic: "/images/poster.jpg",
        vod_remarks: "更新至 2 集",
        vod_year: "2025",
        vod_area: "中国",
        vod_lang: "中文",
        vod_score: "8.1",
        vod_content: "用于离线测试的详情",
        vod_actor: "演员甲",
        vod_director: "导演乙",
        vod_play_from: "线路A$$$线路B",
        vod_play_url: "第1集$https://media.fixture.invalid/ep1.m3u8#第2集$https://media.fixture.invalid/ep2.m3u8$$$番外$extra.mp4",
      }],
    },
  };
  const page = tvbox.parseTVBoxPage(response, source);
  assert.equal(page.page, 2);
  assert.equal(page.pages, 5);
  assert.equal(page.total, 42);
  assert.deepEqual(page.categories, [{ id: "1", name: "电影" }, { id: "2", name: "剧集" }]);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, "vod-7");
  assert.equal(page.items[0].title, "测试影片");
  assert.equal(page.items[0].cover, "https://tv.fixture.invalid/images/poster.jpg");
  assert.equal(page.items[0].playGroups.length, 2);
  assert.equal(page.items[0].playGroups[0].episodes[1].name, "第2集");
  assert.equal(page.items[0].playGroups[0].episodes[1].url, "https://media.fixture.invalid/ep2.m3u8");
  assert.equal(page.items[0].playGroups[1].episodes[0].url, "https://tv.fixture.invalid/api.php/provide/vod/extra.mp4",
    "Relative media paths resolve against the full API endpoint path");
  assert.equal(tvbox.tvboxMediaUrl(page.items[0], 2), "https://media.fixture.invalid/ep2.m3u8");
  assert.equal(tvbox.tvboxMediaUrl(page.items[0], 1, 1), "https://tv.fixture.invalid/api.php/provide/vod/extra.mp4");
  assert.equal(tvbox.tvboxDetailModel(page.items[0], source).episodes.length, 2);
  const card = tvbox.tvboxVideoCard(page.items[0], source);
  assert.equal(card.id, page.items[0].localId);
  assert(card.cover.includes("/img?u="), "Poster must use the app's local image proxy for CSP compatibility");
  const cardCover = new URL(card.cover);
  assert.equal(cardCover.pathname, "/img");
  assert.equal(cardCover.searchParams.get("u"), page.items[0].cover, "TVBox card proxy must target the original poster");
  assert.equal(cardCover.searchParams.get("r"), "https://tv.fixture.invalid/", "TVBox poster requests use the source origin as Referer");
  assert(!cardCover.searchParams.get("r").includes("token"), "TVBox source query tokens must not be sent as Referer");
  assert.equal(api.cover(card.cover), card.cover, "Img must not wrap an existing local poster proxy a second time");
  assert.equal(api.playlistRoute("ios"), "/hls/playlist.m3u8", "iOS native HLS route must expose the manifest extension");
  assert.equal(api.playlistRoute("linux"), "/hls", "Other platforms retain the existing HLS route");

  const wrapped = tvbox.parseTVBoxPage({ data: { list: [{ vod_id: "x", vod_name: "X" }], page: "1", pagecount: "0" } }, source);
  assert.equal(wrapped.items.length, 1, "data.list wrapper is supported");
  assert.equal(wrapped.pages, 1, "zero pagecount normalizes to one page");
  const topLevelPaging = tvbox.parseTVBoxPage({ page: 3, pagecount: 7, total: 61, data: { list: [{ vod_id: "nested", vod_name: "Nested" }] } }, source);
  assert.equal(topLevelPaging.page, 3, "Top-level paging fields are retained with data.list");
  assert.equal(topLevelPaging.pages, 7);
  assert.equal(topLevelPaging.total, 61);
  assert.equal(tvbox.parseTVBoxPage({ list: [{ vod_id: "missing-title" }] }, source).items.length, 0, "malformed entries are ignored");

  const directMp4 = new URL(tvbox.tvboxPlaybackSource("https://cdn.fixture.invalid/movie.MP4?token=a"));
  assert.equal(directMp4.pathname, "/seg", "Direct MP4 must not be sent to the HLS parser");
  assert.equal(directMp4.searchParams.get("u"), "https://cdn.fixture.invalid/movie.MP4?token=a");
  const directTypedMp4 = new URL(tvbox.tvboxPlaybackSource("https://cdn.fixture.invalid/play?id=1&type=video%2Fmp4"));
  assert.equal(directTypedMp4.pathname, "/seg", "Declared MP4 MIME must use the direct media route");
  assert.equal(new URL(tvbox.tvboxPlaybackSource("https://cdn.fixture.invalid/live/playlist.m3u8?token=b")).pathname, "/hls");
  assert.equal(new URL(tvbox.tvboxPlaybackSource("https://cdn.fixture.invalid/live/channel/123")).pathname, "/hls",
    "Extensionless HLS endpoints stay on the manifest-rewriting route");

  const mixedLines = tvbox.parseTVBoxPage({ list: [{ vod_id: "mixed", vod_name: "网页与直连", vod_play_from: "web$$$lzm3u8",
    vod_play_url: "第1集$https://cdn.fixture.invalid/share/player$$$第1集$https://cdn.fixture.invalid/video/index.m3u8" }] }, source).items[0];
  assert.equal(tvbox.preferredTVBoxLine(mixedLines), 1, "Explicit HLS must be preferred over a first-line player webpage");
  assert.equal(tvbox.preferredTVBoxLine({ ...mixedLines, playGroups: [{ name: "web", episodes: [{ name: "1", url: "https://cdn.fixture.invalid/share/1" }] },
    { name: "HLS", episodes: [{ name: "1", url: "https://cdn.fixture.invalid/opaque/1" }] }] }), 1, "HLS route hints support extensionless media");
  const perEpisodeLines = tvbox.parseTVBoxPage({ list: [{ vod_id: "per-episode", vod_name: "按集选择线路",
    vod_play_from: "网页线路$$$HLS备用",
    vod_play_url: "第1集$https://cdn.fixture.invalid/player?id=1#第2集$https://cdn.fixture.invalid/episode/2.m3u8$$$第1集$https://cdn.fixture.invalid/backup/1.m3u8#第2集$https://cdn.fixture.invalid/backup/2.m3u8" }] }, source).items[0];
  assert.equal(tvbox.preferredTVBoxLine(perEpisodeLines, 1), 1, "Episode 1 must prefer a media URL over the player webpage");
  assert.equal(tvbox.preferredTVBoxLine(perEpisodeLines, 2), 0, "Episode 2 may use a direct route even when episode 1 in that line is a player webpage");
  assert.equal(tvbox.tvboxMediaUrl(perEpisodeLines, 2, tvbox.preferredTVBoxLine(perEpisodeLines, 2)), "https://cdn.fixture.invalid/episode/2.m3u8");
  assert.equal(tvbox.preferredTVBoxLine(undefined), 0);

  const config = tvbox.parseTVBoxConfig({ sites: [
    { key: "api-a", name: "API A", type: 1, api: "https://api-a.fixture.invalid/vod" },
    { key: "api-b", api: "https://api-b.fixture.invalid/vod" },
    { key: "spider", type: 3, api: "https://spider.fixture.invalid/js/spider.js" },
    { key: "csp", api: "csp_CustomSpider" },
    { key: "xml", type: 0, api: "https://xml.fixture.invalid/api.php" },
  ] });
  assert.deepEqual(config.sites, [
    { name: "API A", url: "https://api-a.fixture.invalid/vod" },
    { name: "api-b", url: "https://api-b.fixture.invalid/vod" },
    { name: "spider", url: "https://spider.fixture.invalid/js/spider.js", kind: "js" },
  ]);
  assert.equal(config.spiderSkipped, 2);
  const relativeJs = tvbox.parseTVBoxConfig({ sites: [{ name: "ESM", type: 3, api: "./js/main.mjs", ext: "./rules/site.js" }] },
    "https://cfg.fixture.invalid/tvbox/api.json");
  assert.equal(relativeJs.sites[0].url, "https://cfg.fixture.invalid/tvbox/js/main.mjs");
  assert.equal(relativeJs.sites[0].ext, "https://cfg.fixture.invalid/tvbox/rules/site.js",
    "Spider ext relative paths resolve against config URL, not JS entry URL");
  const extRules = tvbox.parseTVBoxConfig({ sites: [
    { name: "plain", type: 3, api: "https://cfg.fixture.invalid/js/a.js", ext: "abc" },
    { name: "json", type: 3, api: "https://cfg.fixture.invalid/js/b.js", ext: '{"key":"value"}' },
  ] }, "https://cfg.fixture.invalid/config.json");
  assert.equal(extRules.sites[0].ext, "abc", "Plain Spider ext strings remain opaque");
  assert.equal(extRules.sites[1].ext, '{"key":"value"}', "JSON Spider ext text remains opaque");

  const repositories = tvbox.parseTVBoxRepositories({ urls: [
    { name: "标题但无地址" },
    { name: "相对仓", url: "./repos/a.json" },
    { name: "重复仓", url: "https://repo.fixture.invalid/a.json" },
    { name: "重复仓别名", url: "https://repo.fixture.invalid/a.json" },
    { name: "凭据", url: "https://user:pass@repo.fixture.invalid/private.json" },
    { name: "片段", url: "https://repo.fixture.invalid/a.json#config" },
    { name: "危险协议", url: "javascript:alert(1)" },
  ] }, "https://index.fixture.invalid/config/niuber.json");
  assert.deepEqual(repositories, [
    { name: "相对仓", url: "https://index.fixture.invalid/config/repos/a.json" },
    { name: "重复仓", url: "https://repo.fixture.invalid/a.json" },
  ], "Repository indexes ignore title-only, unsafe and duplicate entries");
  assert.deepEqual(tvbox.parseTVBoxRepositories({ data: { urls: [{ name: "嵌套仓", url: "/repo.json" }] } },
    "https://index.fixture.invalid/root.json"), [{ name: "嵌套仓", url: "https://index.fixture.invalid/repo.json" }]);
  assert.deepEqual(tvbox.parseTVBoxRepositories({ urls: [{ name: "空仓" }] }, "https://index.fixture.invalid/a.json"), []);

  assert.deepEqual(tvbox.parseTVBoxPage({ urls: [{ name: "not an API" }] }, source).items, [],
    "Arbitrary JSON is not interpreted as a populated API response");

  const searchUrl = new URL(tvbox.buildTVBoxApiUrl(source, { ac: "list", pg: 3, wd: "测试 片" }));
  assert.equal(searchUrl.searchParams.get("token"), "x", "Existing source query parameters are preserved");
  assert.equal(searchUrl.searchParams.get("ac"), "list");
  assert.equal(searchUrl.searchParams.get("pg"), "3");
  assert.equal(searchUrl.searchParams.get("wd"), "测试 片", "Unicode search terms are encoded by URLSearchParams");

  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const fetchCalls = [];
  const spiderCalls = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent: () => true, __TAURI_INTERNALS__: {
    invoke: async (command, args) => {
      if (command === "tvbox_spider") {
        spiderCalls.push({ method: args.method, args: args.args });
        if (args.method === "home") return { class: [{ type_id: "1", type_name: "电影" }] };
        if (args.method === "homeVod") return args.args[0] === 1
          ? { list: [{ vod_id: "home-vod", vod_name: "Home Vod" }] }
          : { list: [{ vod_id: "page-vod", vod_name: "Page Vod" }] };
        if (args.method === "category") return { list: [{ vod_id: "cat-vod", vod_name: "Category Vod" }] };
        if (args.method === "search") return { list: [{ vod_id: "search-vod", vod_name: "Search Vod" }] };
        if (args.method === "play") {
          if (args.args?.[1] === "parse") return { parse: 1, url: "https://media.fixture.invalid/page" };
          if (args.args?.[1] === "headers") return { url: "https://media.fixture.invalid/a.m3u8", headers: { Authorization: "x" } };
          if (args.args?.[1] === "credential") return { url: "https://user:pass@media.fixture.invalid/a.m3u8" };
          return Promise.reject("backend boundary error");
        }
        return { list: [] };
      }
      assert.equal(command, "tvbox_fetch");
      fetchCalls.push(args.url);
      const path = new URL(args.url).pathname;
      if (path === "/index.json") return { urls: [{ name: "子配置", url: "/spider.json" }] };
      if (path === "/spider.json") return { sites: [{ name: "Spider", type: 3, api: "csp_Test" }] };
      if (path === "/empty-api") return { list: [], class: [], page: 1 };
      return { message: "arbitrary JSON is not a VOD API" };
    },
  } } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => null,
    setItem: () => assert.fail("Repository indexes and invalid configs must not be persisted as sources"),
  } });
  try {
    const jsSource = { id: "js-fixture", name: "JS", kind: "js", url: "https://cfg.fixture.invalid/js/main.js", ext: "abc" };
    const first = await tvbox.tvboxList(jsSource, 1);
    assert.deepEqual(first.categories, [{ id: "1", name: "电影" }]);
    assert.deepEqual(first.items.map(item => item.id), ["home-vod"], "home class payload is merged with homeVod list");
    await tvbox.tvboxList(jsSource, 3);
    await tvbox.tvboxList(jsSource, 2, "1");
    await tvbox.tvboxSearch(jsSource, "kw", 4);
    assert.deepEqual(spiderCalls.slice(0, 6), [
      { method: "home", args: [true] },
      { method: "homeVod", args: [1] },
      { method: "homeVod", args: [3] },
      { method: "category", args: ["1", 2, true, {}] },
      { method: "search", args: ["kw", false, 4] },
    ].slice(0, spiderCalls.length), "Spider methods use standard catvod/drpy arguments");
    await assert.rejects(tvbox.tvboxResolveMedia(jsSource, "f", "id"), /backend boundary error/);
    await assert.rejects(tvbox.tvboxResolveMedia(jsSource, "f", "parse"), /嗅探|解析/);
    await assert.rejects(tvbox.tvboxResolveMedia(jsSource, "f", "headers"), /headers/);
    await assert.rejects(tvbox.tvboxResolveMedia(jsSource, "f", "credential"), /账号密码/);

    const result = await tvbox.importTVBoxSources("https://index.fixture.invalid/index.json");
    assert.deepEqual(result.sources, []);
    assert.equal(result.repositories[0].url, "https://index.fixture.invalid/spider.json");
    assert.equal(fetchCalls.length, 1, "Repository discovery must not recursively fetch children");
    await assert.rejects(tvbox.importTVBoxSources("https://index.fixture.invalid/spider.json"), /可支持|catvod/);
    await assert.rejects(tvbox.importTVBoxSources("https://index.fixture.invalid/arbitrary.json"), /标准 JSON API/);
    const empty = await tvbox.tvboxList({ ...source, url: "https://index.fixture.invalid/empty-api" });
    assert.deepEqual(empty.items, [], "An actual empty-list API remains valid");
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete globalThis.localStorage;
  }

  const storage = new Map();
  const oldWindow2 = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldStorage2 = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent: () => true, __TAURI_INTERNALS__: {
    invoke: async (command, args) => {
      assert.equal(command, "tvbox_fetch");
      if (new URL(args.url).pathname !== "/dedupe.json") throw new Error("unexpected dedupe URL");
      return { sites: [
        { name: "one", type: 3, api: "https://same.fixture.invalid/rules.js", ext: "./one.json" },
        { name: "two", type: 3, api: "https://same.fixture.invalid/rules.js", ext: "./two.json" },
      ] };
    },
  } } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  } });
  try {
    const added = await tvbox.importTVBoxSources("https://cfg.fixture.invalid/dedupe.json");
    assert.equal(added.sources.length, 2, "Same Spider URL with different ext rules must not deduplicate");
  } finally {
    if (oldWindow2) Object.defineProperty(globalThis, "window", oldWindow2); else delete globalThis.window;
    if (oldStorage2) Object.defineProperty(globalThis, "localStorage", oldStorage2); else delete globalThis.localStorage;
  }

  assert.throws(() => tvbox.tvboxMediaUrl({ ...page.items[0], playGroups: [] }, 1), /需要解析器/);
  console.log("TVBox checks passed: nested JSON, endpoint-relative URLs, paging, categories, idempotent image proxy, per-episode HLS/MP4 route selection, config Spider filtering and unsupported playback handling.");
} finally {
  await vite.close();
}
