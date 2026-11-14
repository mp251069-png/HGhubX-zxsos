import assert from "node:assert/strict";
import { createServer } from "vite";

const vite = await createServer({
  configFile: "vite.config.ts",
  server: { middlewareMode: true },
  appType: "custom",
});
try {
  const tvbox = await vite.ssrLoadModule("/src/tvbox.ts");
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

  const config = tvbox.parseTVBoxConfig({ sites: [
    { key: "api-a", name: "API A", type: 1, api: "https://api-a.fixture.invalid/vod" },
    { key: "api-b", api: "https://api-b.fixture.invalid/vod" },
    { key: "spider", type: 3, api: "https://spider.fixture.invalid/js/spider.js" },
    { key: "csp", api: "csp_CustomSpider" },
  ] });
  assert.deepEqual(config.sites, [
    { name: "API A", url: "https://api-a.fixture.invalid/vod" },
    { name: "api-b", url: "https://api-b.fixture.invalid/vod" },
  ]);
  assert.equal(config.spiderSkipped, 2);

  const searchUrl = new URL(tvbox.buildTVBoxApiUrl(source, { ac: "list", pg: 3, wd: "测试 片" }));
  assert.equal(searchUrl.searchParams.get("token"), "x", "Existing source query parameters are preserved");
  assert.equal(searchUrl.searchParams.get("ac"), "list");
  assert.equal(searchUrl.searchParams.get("pg"), "3");
  assert.equal(searchUrl.searchParams.get("wd"), "测试 片", "Unicode search terms are encoded by URLSearchParams");

  assert.throws(() => tvbox.tvboxMediaUrl({ ...page.items[0], playGroups: [] }, 1), /需要解析器/);
  console.log("TVBox checks passed: nested JSON, endpoint-relative URLs, nested/top-level paging, categories, multiple play groups, HLS/MP4 proxy selection, image proxy, config Spider filtering and unsupported playback handling.");
} finally {
  await vite.close();
}
