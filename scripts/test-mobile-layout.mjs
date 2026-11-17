// Exercise the real App and its mobile navigation; only Tauri IPC is replaced.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "mobile-layout", new Date().toISOString().replace(/[:.]/g, "-"));
const userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1";
const viewports = [{ width: 320, height: 694 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 844, height: 390 }];
const tabs = ["首页", "搜索", "影视", "直播", "我的"];
const report = {
  environment: { browser: "Chromium with iPhone UA", transport: "real App; Tauri IPC mocked; no upstream traffic", limitation: "Does not replace native iOS/WKWebView verification", userAgent },
  cases: [], external: [], pageErrors: [],
};
await mkdir(output, { recursive: true });
let vite, browser, page;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const context = await browser.newContext({ userAgent, isMobile: true, hasTouch: true, colorScheme: "dark", viewport: viewports[0] });
  await context.addInitScript(() => {
    const fixture = { calls: [], unexpected: [] };
    const emptyPage = { items: [], pagination: { page: 1, pages: 1, size: 8, total: 0 } };
    Object.assign(window, {
      mobileLayoutFixture: fixture,
      __TAURI_INTERNALS__: { invoke(cmd, args = {}) {
        fixture.calls.push({ cmd, args });
        if (cmd === "app_boot") return Promise.resolve({ user: null, logged_in: false, base: "https://fixture.invalid", strict_security: true });
        if (cmd === "playback_log_status") return Promise.resolve({ enabled: false, path: null, error: null });
        if (cmd === "debug_log") return Promise.resolve();
        if (cmd === "proxy_state") return Promise.resolve({ mode: "system", url: "", enabled: false });
        if (cmd === "line_state") return Promise.resolve({ base: "https://fixture.invalid", previous: "https://fixture.invalid" });
        if (cmd === "set_text_interaction") return Promise.resolve();
        if (cmd === "line_auto") return Promise.resolve({ base: "https://fixture.invalid", previous: "https://fixture.invalid", switched: false, pick: { tier: "main", ms: 1, reason: "fixture", candidates: [] } });
        if (cmd === "tvbox_fetch") {
          const url = String(args.url || "");
          if (url === "https://fixture.invalid/tvbox-root.json") return Promise.resolve({ urls: [
            { name: "全 Spider 子仓", url: "https://fixture.invalid/tvbox-spider.json" },
            { name: "标准 API 子仓", url: "https://fixture.invalid/tvbox-standard.json" },
          ] });
          if (url === "https://fixture.invalid/tvbox-spider.json") return Promise.resolve({ sites: [{ name: "仅 Spider", type: 3, api: "csp_fixture_spider" }] });
          if (url === "https://fixture.invalid/tvbox-standard.json") return Promise.resolve({ sites: [{ name: "标准影片 API", type: 1, api: "https://fixture.invalid/api.php/provide/vod/" }] });
          return Promise.resolve({ code: 1, page: 1, pagecount: 1, total: 1, data: { class: [{ type_id: "1", type_name: "电影" }], list: [{ vod_id: "movie-1", vod_name: "Fixture 影视", vod_year: "2026", vod_play_from: "线路一", vod_play_url: "正片$https://media.fixture.invalid/movie.mp4" }] } });
        }
        if (cmd === "live_fetch") {
          return Promise.resolve({
            final_url: "https://fixture.invalid/iptv/live.m3u8",
            text: [
              "#EXTM3U",
              '#EXTINF:-1 tvg-id="cctv1" group-title="央视",CCTV-1 综合',
              "https://fixture.invalid/live/cctv1.m3u8",
              '#EXTINF:-1 tvg-id=" satellite1" group-title="卫视",卫视一台',
              "channels/sat1.m3u8",
            ].join("\n"),
          });
        }
        if (["api_feed", "api_category", "api_posts", "api_original_videos", "api_post_category", "api_search_hot", "api_search"].includes(cmd)) return Promise.resolve(emptyPage);
        if (cmd === "api_rank") return Promise.resolve({ items: [] });
        // App's development-only playback self-test must not fetch media upstream.
        if (cmd === "api_play") return Promise.reject("Layout fixture has no playback media");
        fixture.unexpected.push(cmd);
        return Promise.reject(`Unexpected IPC: ${cmd}`);
      } },
    });
  });
  page = await context.newPage();
  page.on("pageerror", error => report.pageErrors.push(error.message));
  await page.route("**/*", route => {
    const url = route.request().url();
    if (new URL(url).origin === new URL(origin).origin) return route.continue();
    report.external.push(url);
    return route.abort();
  });
  await page.goto(origin);
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.waitFor({ state: "visible" });
  assert(await page.locator(".plat-ios").count() > 0, "The real App must select its iOS mobile shell");
  assert.equal(await page.locator(".win-titlebar").count(), 0, "Mobile navigation must not be rendered inside a desktop shell");

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const result = { viewport, tabs: [] };
    report.cases.push(result);
    for (const [index, name] of tabs.entries()) {
      await nav.getByRole("button", { name, exact: true }).click();
      await page.waitForFunction(label => document.querySelector('.hg-tabbar button[aria-current="page"]')?.textContent === label, name);
      if (name === "影视") {
        await page.getByRole("heading", { name: "影视" }).waitFor();
        const browseSwitch = page.getByRole("group", { name: "影视内容来源" });
        await browseSwitch.getByRole("button", { name: "TVBox 源", exact: true }).click();
        await page.getByRole("heading", { name: "影视" }).waitFor();
        assert.equal(await page.getByRole("button", { name: "管理 TVBox 源" }).count(), 0, "影视页顶部不得再放资源管理齿轮");
        await page.getByRole("button", { name: "添加或导入 TVBox 源" }).waitFor();
        assert.equal(await page.getByRole("group", { name: "影视与直播模式" }).count(), 0, "Live 不能再嵌在影视切换器中");
        await nav.getByRole("button", { name: "直播", exact: true }).click();
        await page.getByRole("heading", { name: "直播", exact: true }).waitFor();
        await page.getByRole("button", { name: "前往设置管理直播源" }).waitFor();
        if (viewport.width === 390 && viewport.height === 844) {
          await page.screenshot({ path: join(output, "390x844-live-dock-empty.png"), fullPage: true, animations: "disabled" });
        }
        await nav.getByRole("button", { name: "影视", exact: true }).click();
        assert.equal(await browseSwitch.getByRole("button", { name: "TVBox 源", exact: true }).getAttribute("aria-pressed"), "true", "离开 Movies 去 Live 再回来应保留 TVBox 选择");
        await browseSwitch.getByRole("button", { name: "HGhubX", exact: true }).click();
        await page.getByRole("button", { name: "专题", exact: true }).waitFor();
        await page.screenshot({ path: join(output, `${viewport.width}x${viewport.height}-movies.png`), fullPage: true, animations: "disabled" });
      }
      // Keep the production transition enabled and measure its final position.
      await page.locator(".hg-drop").evaluate(async el => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.all(el.getAnimations().map(animation => animation.finished));
      });
      const geometry = await nav.evaluate(el => {
        const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, center: r.left + r.width / 2 }; };
        return { drop: rect(el.querySelector(".hg-drop")), button: rect(el.querySelector('button[aria-current="page"]')), bar: rect(el.querySelector(".hg-glass")) };
      });
      const centerDelta = Math.abs(geometry.drop.center - geometry.button.center);
      const screenshot = `${viewport.width}x${viewport.height}-tab-${index}.png`;
      await nav.screenshot({ path: join(output, screenshot) });
      result.tabs.push({ name, centerDelta, geometry, screenshot });
      assert(centerDelta < 1, `${viewport.width}px ${name}: highlight is ${centerDelta.toFixed(2)}px off center`);
      assert(geometry.drop.left >= geometry.bar.left && geometry.drop.right <= geometry.bar.right, "Highlight must remain inside the glass bar");
    }
    result.screenshot = `${viewport.width}x${viewport.height}-full.png`;
    await page.screenshot({ path: join(output, result.screenshot), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await nav.getByRole("button", { name: "首页", exact: true }).click();
  await page.waitForFunction(() => window.mobileLayoutFixture.calls.some(call => call.cmd === "api_feed"));
  const feedCalls = await page.evaluate(() => window.mobileLayoutFixture.calls.filter(call => call.cmd === "api_feed").length);
  await page.evaluate(() => window.dispatchEvent(new Event("hg:line-changed")));
  await page.waitForFunction(before => window.mobileLayoutFixture.calls.filter(call => call.cmd === "api_feed").length > before, feedCalls);
  report.line_switch_home = { cleared_and_reloaded_from_page_1: true };

  await nav.getByRole("button", { name: "搜索", exact: true }).click();
  await page.getByRole("region", { name: "热搜榜" }).waitFor();
  await page.waitForFunction(() => window.mobileLayoutFixture.calls.some(call => call.cmd === "api_search_hot"));
  const hotCalls = await page.evaluate(() => window.mobileLayoutFixture.calls.filter(call => call.cmd === "api_search_hot").length);
  await page.evaluate(() => window.dispatchEvent(new Event("hg:line-changed")));
  await page.waitForFunction(before => window.mobileLayoutFixture.calls.filter(call => call.cmd === "api_search_hot").length > before, hotCalls);

  const searchInput = page.getByPlaceholder("搜索短剧、帖子、题材…");
  await searchInput.fill("切线测试");
  await searchInput.press("Enter");
  await page.waitForFunction(() => window.mobileLayoutFixture.calls.some(call => call.cmd === "api_search"));
  const searchCalls = await page.evaluate(() => window.mobileLayoutFixture.calls.filter(call => call.cmd === "api_search").length);
  await page.evaluate(() => window.dispatchEvent(new Event("hg:line-changed")));
  await page.waitForFunction(before => window.mobileLayoutFixture.calls.filter(call => call.cmd === "api_search").length > before, searchCalls);

  await page.getByRole("button", { name: "排行榜" }).click();
  await page.getByText("HG 热榜", { exact: true }).waitFor();
  await page.waitForFunction(() => window.mobileLayoutFixture.calls.some(call => call.cmd === "api_rank"));
  const rankCalls = await page.evaluate(() => window.mobileLayoutFixture.calls.filter(call => call.cmd === "api_rank").length);
  await page.evaluate(() => window.dispatchEvent(new Event("hg:line-changed")));
  await page.waitForFunction(before => window.mobileLayoutFixture.calls.filter(call => call.cmd === "api_rank").length > before, rankCalls);
  report.line_switch_search = { hot_list: true, keyword_results: true, full_ranks: true };
  await page.getByRole("button", { name: "返回" }).click();
  const homeCallsBeforeReturn = await page.evaluate(() => window.mobileLayoutFixture.calls.filter(call => call.cmd === "api_feed").length);
  await nav.getByRole("button", { name: "首页", exact: true }).click();
  await page.waitForFunction(before => window.mobileLayoutFixture.calls.filter(call => call.cmd === "api_feed").length > before, homeCallsBeforeReturn);
  report.line_switch_home.hidden_tab_reload = true;

  await page.evaluate(() => {
    localStorage.removeItem("hghubx_tvbox_sources_v1");
    localStorage.removeItem("hghubx_tvbox_active_v1");
    window.dispatchEvent(new CustomEvent("hghubx:tvbox-source-changed"));
  });
  await nav.getByRole("button", { name: "我的", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("heading", { name: "设置" }).waitFor();
  const rootFixtureUrl = "https://fixture.invalid/tvbox-root.json";
  const tvboxUrlInput = page.getByRole("textbox", { name: "TVBox 配置或 API 地址" });
  await tvboxUrlInput.fill(rootFixtureUrl);
  await page.getByRole("button", { name: "验证并添加", exact: true }).click();
  const repositories = page.getByRole("group", { name: "TVBox 子配置列表" });
  await repositories.waitFor();
  assert.equal(await repositories.getByRole("button", { name: /全 Spider 子仓/ }).count(), 1, "多仓列表必须显示全 Spider 子仓");
  assert.equal(await repositories.getByRole("button", { name: /标准 API 子仓/ }).count(), 1, "多仓列表必须显示标准 API 子仓");
  const rootStorage = await page.evaluate(() => ({ sources: localStorage.getItem("hghubx_tvbox_sources_v1"), active: localStorage.getItem("hghubx_tvbox_active_v1") }));
  assert.equal(rootStorage.sources, null, "根索引不得持久化为空 API 源");
  assert.equal(rootStorage.active, null, "根索引不得设置空 API 活跃源");
  await repositories.getByRole("button", { name: /全 Spider 子仓/ }).click();
  const spiderAlert = page.getByRole("alert");
  await spiderAlert.waitFor();
  assert.match(await spiderAlert.innerText(), /XML\/JSON\/Remote API|catvod JS|运行器/, "全 Spider 子仓必须说明不可支持的运行器");
  assert.equal(await page.getByRole("group", { name: "TVBox 子配置列表" }).count(), 1, "Spider 错误后不得关闭子配置列表");
  const afterSpiderStorage = await page.evaluate(() => ({ sources: localStorage.getItem("hghubx_tvbox_sources_v1"), active: localStorage.getItem("hghubx_tvbox_active_v1") }));
  assert.equal(afterSpiderStorage.sources, null, "全 Spider 子仓不得添加源");
  assert.equal(afterSpiderStorage.active, null, "全 Spider 子仓不得设置活跃源");
  await page.getByRole("group", { name: "TVBox 子配置列表" }).getByRole("button", { name: /标准 API 子仓/ }).click();
  await page.getByRole("heading", { name: "影视" }).waitFor();
  await page.getByText("Fixture 影视", { exact: true }).waitFor();
  const importedStorage = await page.evaluate(() => ({ sources: JSON.parse(localStorage.getItem("hghubx_tvbox_sources_v1") || "[]"), active: localStorage.getItem("hghubx_tvbox_active_v1") }));
  assert.equal(importedStorage.sources.length, 1, "标准 API 子仓应添加一个源");
  assert.equal(importedStorage.sources[0].url, "https://fixture.invalid/api.php/provide/vod/", "添加的源必须来自标准 API 子仓");
  assert.equal(importedStorage.active, importedStorage.sources[0].id, "添加标准 API 后应激活该源");
  report.tvbox_multi_repository = { root_index: true, repositories_visible: true, spider_rejected: true, standard_api_imported: true, tvbox_catalog_visible: true };
  await page.evaluate(() => {
    localStorage.setItem("hghubx_tvbox_sources_v1", JSON.stringify([
      { id: "fixture-a", name: "Fixture A", url: "https://tv-a.fixture.invalid/api.php/provide/vod/" },
      { id: "fixture-b", name: "Fixture B", url: "https://tv-b.fixture.invalid/api.php/provide/vod/" },
    ]));
    localStorage.setItem("hghubx_tvbox_active_v1", "fixture-a");
    window.dispatchEvent(new CustomEvent("hghubx:tvbox-source-changed"));
  });
  await page.getByRole("group", { name: "影视内容来源" }).getByRole("button", { name: "TVBox 源", exact: true }).click();
  await page.getByText("Fixture 影视", { exact: true }).waitFor();
  await page.getByLabel("TVBox 数据源", { exact: true }).selectOption("fixture-b");
  await page.waitForFunction(() => window.mobileLayoutFixture.calls.some(call => call.cmd === "tvbox_fetch" && new URL(call.args.url).host === "tv-b.fixture.invalid"));
  await page.getByRole("button", { name: "电影", exact: true }).click();
  await page.waitForFunction(() => window.mobileLayoutFixture.calls.some(call => call.cmd === "tvbox_fetch" && new URL(call.args.url).searchParams.get("t") === "1"));
  const tvboxSearch = page.getByRole("textbox", { name: "搜索 TVBox 影片" });
  await tvboxSearch.fill("测试片");
  await tvboxSearch.press("Enter");
  await page.waitForFunction(() => window.mobileLayoutFixture.calls.some(call => call.cmd === "tvbox_fetch" && new URL(call.args.url).searchParams.get("wd") === "测试片"));
  report.tvbox_browse = { source_switch: true, category_filter: true, keyword_search: true, catalog_visible: true };

  // Test APTV / M3U live source management in Settings and playback/filtering/switching in Live mode
  await nav.getByRole("button", { name: "我的", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("heading", { name: "设置" }).waitFor();
  await page.getByRole("textbox", { name: "M3U 订阅链接" }).fill("https://fixture.invalid/live.m3u8");
  await page.getByRole("button", { name: "导入 M3U 订阅", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.hg-tabbar button[aria-current="page"]')?.textContent === "直播");
  await page.getByTestId("live-player").waitFor();
  await page.getByRole("list", { name: "直播频道列表" }).waitFor();
  await page.screenshot({ path: join(output, "390x844-live-channels-fixture.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "收藏 CCTV-1 综合", exact: true }).click();
  await page.getByRole("group", { name: "直播频道分组" }).getByRole("button", { name: /收藏 \(1\)/ }).click();
  assert.equal(await page.getByRole("listitem").count(), 1, "收藏筛选应仅显示已收藏频道");
  await page.getByRole("group", { name: "直播频道分组" }).getByRole("button", { name: /全部 \(2\)/ }).click();
  await page.getByRole("button", { name: "下一台", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索直播频道" }).fill("卫视");
  assert.equal(await page.getByRole("listitem").count(), 1, "频道搜索应按关键词过滤");
  report.live_browse = { imported: true, player_mounted: true, favorite_filter: true, channel_switch: true, keyword_search: true };
  report.ipc = await page.evaluate(() => ({ calls: window.mobileLayoutFixture.calls.map(call => call.cmd), unexpected: window.mobileLayoutFixture.unexpected }));
  assert.deepEqual(report.ipc.unexpected, [], "No unexpected Tauri calls");
  assert.deepEqual(report.pageErrors, [], "No page errors");
  assert.deepEqual(report.external, [], "No upstream traffic");
  report.passed = true;
  console.log(`Passed: ${report.cases.length * tabs.length} mobile navigation alignment checks`);
} catch (error) {
  report.error = String(error.stack || error);
  await page?.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  const escape = text => String(text).replace(/[&<>\"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
  await writeFile(join(output, "report.html"), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>HGhubX mobile navigation layout</title><style>body{margin:24px;font:16px system-ui;background:#151515;color:#eee}h2{margin-top:32px}.tabs{display:grid;gap:12px;grid-template-columns:repeat(2,minmax(250px,1fr));max-width:1050px}figure{margin:0;padding:12px;background:#252525;border-radius:12px}img{display:block;max-width:100%;height:auto;margin-top:8px}a{color:#79cfff}pre{white-space:pre-wrap}</style><h1>HGhubX mobile navigation layout: ${report.passed ? "PASS" : "FAIL"}</h1><p>${escape(report.environment.transport)}. ${escape(report.environment.limitation)}.</p>${report.error ? `<pre>${escape(report.error)}</pre>` : ""}${report.cases.map(result => `<h2>${result.viewport.width} × ${result.viewport.height}</h2><a href="${result.screenshot || "failure.png"}">Full viewport screenshot</a><div class="tabs">${result.tabs.map(tab => `<figure><figcaption>${escape(tab.name)} — center error ${tab.centerDelta.toFixed(3)} px</figcaption><img src="${tab.screenshot}" alt="${escape(tab.name)} navigation highlight"></figure>`).join("")}</div>`).join("")}<p><a href="report.json">JSON measurements</a></p></html>`);
  await browser?.close();
  await vite?.close();
  console.log(`Artifacts: ${output}`);
}
