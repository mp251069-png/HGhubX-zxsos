import assert from "node:assert/strict";
import { createServer } from "vite";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, val) => storage.set(key, String(val)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
};

const vite = await createServer({
  configFile: "vite.config.ts",
  server: { middlewareMode: true },
  appType: "custom",
});

try {
  const live = await vite.ssrLoadModule("/src/live.ts");

  // 1. Parse Extended M3U with BOM, CRLF, #EXTINF attributes, #EXTGRP, relative URLs, and per-channel HTTP headers
  const m3uSample = [
    "\uFEFF#EXTM3U x-tvg-url=\"https://epg.example.invalid/epg.xml\"",
    "#EXTINF:-1 tvg-id=\"cctv1\" tvg-name=\"CCTV-1,HD\" tvg-logo=\"logos/cctv1.png\" group-title=\"央视\",CCTV-1 综合",
    "#EXTVLCOPT:http-referrer=https://live-portal.example.invalid/watch?token=secret123",
    "#EXTVLCOPT:http-user-agent=APTV/1.4",
    "channels/cctv1.m3u8?sig=alpha",
    "#EXTINF:-1 tvg-id='cctv5' tvg-name='CCTV5' tvg-logo='https://img.example.invalid/cctv5.png',CCTV-5 体育",
    "#EXTGRP:体育频道",
    "#KODIPROP:inputstream.adaptive.stream_headers=Referer=https%3A%2F%2Fsports.example.invalid%2Froom&User-Agent=CustomPlayer%2F2.0",
    "https://stream.example.invalid/live/cctv5.m3u8",
    "#EXTINF:-1 group-title=\"电影\",电影轮播 MP4",
    "https://vod.example.invalid/direct/movie.mp4|Referer=https://cinema.example.invalid/path&User-Agent=MovieUA/1.0",
    "#EXTINF:-1 group-title=\"不安全\",恶意脚本频道",
    "javascript:alert(1)",
    "#EXTINF:-1 group-title=\"不安全\",本地文件频道",
    "file:///etc/passwd",
    "#EXTINF:-1 group-title=\"不安全\",内嵌凭据频道",
    "https://user:pass@stream.example.invalid/private.m3u8",
    "#EXTINF:-1 group-title=\"不安全\",RTMP频道",
    "rtmp://stream.example.invalid/live/room1",
  ].join("\r\n");

  const parsed = live.parseM3U(
    m3uSample,
    "https://sub.example.invalid/iptv/list/index.m3u?sub_token=xyz",
  );

  assert.equal(parsed.channels.length, 3, "Only valid HTTP(S) channels without credentials should be accepted");
  assert.equal(parsed.skippedUnsafe, 4, "Unsafe protocols and credentialed URLs must be rejected and counted");
  assert.deepEqual(parsed.groups, ["央视", "体育频道", "电影"]);

  // Verify channel 1: #EXTINF attributes + relative URL resolution + #EXTVLCOPT headers
  const ch1 = parsed.channels[0];
  assert.equal(ch1.name, "CCTV-1 综合");
  assert.equal(ch1.tvgId, "cctv1");
  assert.equal(ch1.tvgName, "CCTV-1,HD", "Quoted commas inside #EXTINF attributes must not split the title early");
  assert.equal(ch1.group, "央视");
  assert.equal(ch1.url, "https://sub.example.invalid/iptv/list/channels/cctv1.m3u8?sig=alpha");
  assert.equal(ch1.logo, "https://sub.example.invalid/iptv/list/logos/cctv1.png");
  assert.equal(ch1.headers?.referer, "https://live-portal.example.invalid/");
  assert.equal(ch1.headers?.userAgent, "APTV/1.4");

  // Verify channel 2: #EXTGRP fallback + #KODIPROP stream_headers
  const ch2 = parsed.channels[1];
  assert.equal(ch2.name, "CCTV-5 体育");
  assert.equal(ch2.group, "体育频道");
  assert.equal(ch2.headers?.referer, "https://sports.example.invalid/");
  assert.equal(ch2.headers?.userAgent, "CustomPlayer/2.0");

  // Verify channel 3: Pipe syntax headers + direct MP4 routing
  const ch3 = parsed.channels[2];
  assert.equal(ch3.name, "电影轮播 MP4");
  assert.equal(ch3.group, "电影");
  assert.equal(ch3.url, "https://vod.example.invalid/direct/movie.mp4");
  assert.equal(ch3.headers?.referer, "https://cinema.example.invalid/");
  assert.equal(ch3.headers?.userAgent, "MovieUA/1.0");

  // 2. Reject APTV proprietary encrypted configs, HTML, JSON, or all-unsafe lists
  assert.throws(
    () => live.parseM3U("aptv://encrypted-config-payload"),
    /不支持 APTV 私有加密配置/,
  );
  assert.throws(
    () => live.parseM3U("<!DOCTYPE html><html><body>404</body></html>"),
    /网页 HTML/,
  );
  assert.throws(
    () => live.parseM3U(JSON.stringify({ sites: [] })),
    /仅支持通用 Extended M3U/,
  );
  assert.throws(
    () => live.parseM3U("#EXTM3U\n#EXTINF:-1,Bad\njavascript:alert(1)\nfile:///tmp/a.m3u8"),
    /没有安全的 HTTP\/HTTPS 直播频道/,
  );

  // 3. Local persistence of sources & favorites + filtering
  storage.clear();
  const imported = live.importLiveSourceFromText(
    m3uSample,
    "测试 APTV 订阅",
    "https://sub.example.invalid/iptv/list/index.m3u",
    "https://sub.example.invalid/iptv/list/index.m3u",
  );
  assert.equal(live.loadLiveSources().length, 1);
  assert.equal(live.activeLiveSource()?.id, imported.id);
  assert.equal(live.activeLiveSource()?.name, "测试 APTV 订阅");

  // Favorites persistence
  assert.equal(live.isLiveFav(ch1), false);
  assert.equal(live.toggleLiveFav(ch1), true);
  assert.equal(live.isLiveFav(ch1), true);
  assert.equal(live.loadLiveFavs().length, 1);

  // Filtering by group, favorites, and keyword
  assert.equal(live.filterLiveChannels(imported.channels, { group: "all" }).length, 3);
  assert.equal(live.filterLiveChannels(imported.channels, { group: "体育频道" }).length, 1);
  assert.equal(live.filterLiveChannels(imported.channels, { group: "fav" }).length, 1);
  assert.equal(live.filterLiveChannels(imported.channels, { group: "all", keyword: "cctv-5" }).length, 1);
  assert.equal(live.filterLiveChannels(imported.channels, { group: "all", keyword: "不存在的台" }).length, 0);

  // 4. Proxy playback & logo URLs
  const hlsPlayUrl = new URL(live.livePlaybackSource(ch1, imported));
  assert(hlsPlayUrl.pathname === "/hls" || hlsPlayUrl.pathname === "/hls/playlist.m3u8");
  assert.equal(hlsPlayUrl.searchParams.get("u"), ch1.url);
  assert.equal(hlsPlayUrl.searchParams.get("r"), "https://live-portal.example.invalid/");
  assert.equal(hlsPlayUrl.searchParams.get("ua"), "APTV/1.4");

  const mp4PlayUrl = new URL(live.livePlaybackSource(ch3, imported));
  assert.equal(mp4PlayUrl.pathname, "/seg");
  assert.equal(mp4PlayUrl.searchParams.get("u"), ch3.url);
  assert.equal(mp4PlayUrl.searchParams.get("r"), "https://cinema.example.invalid/");
  assert.equal(mp4PlayUrl.searchParams.get("ua"), "MovieUA/1.0");

  const logoProxyUrl = new URL(live.liveLogoUrl(ch1, imported));
  assert.equal(logoProxyUrl.pathname, "/img");
  assert.equal(logoProxyUrl.searchParams.get("u"), ch1.logo);
  assert.equal(logoProxyUrl.searchParams.get("r"), "https://live-portal.example.invalid/");
  assert.equal(logoProxyUrl.searchParams.get("ua"), "APTV/1.4");

  // Direct media extensions must never be mistaken for HLS playlists.
  for (const ext of ["ts", "flv", "mpeg", "mkv"]) {
    const direct = new URL(live.livePlaybackSource({
      id: `direct-${ext}`,
      name: `direct ${ext}`,
      url: `https://vod.example.invalid/live/channel.${ext}?sig=1`,
      group: "直连",
      headers: { userAgent: "DirectUA/1.0" },
    }, imported));
    assert.equal(direct.pathname, "/seg", `${ext} should use direct media routing`);
    assert.equal(direct.searchParams.get("ua"), "DirectUA/1.0");
  }

  // Removing source updates storage cleanly
  live.removeLiveSource(imported.id);
  assert.equal(live.loadLiveSources().length, 0);
  assert.equal(live.activeLiveSource(), null);

  console.log("PASS live: Extended M3U parser, header metadata, unsafe URL rejection, persistence, and proxy routing");
} finally {
  await vite.close();
}
