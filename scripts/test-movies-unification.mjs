// Movies page regression: HGhubX and TVBox share one header, shelf and poster geometry.
// Real App in Chromium; Tauri IPC, TVBox upstream and poster images are local fixtures.
// Run: BROWSER_EXECUTABLE=/usr/bin/google-chrome node scripts/test-movies-unification.mjs
// Optional: MOVIES_UI_OUTPUT=<dir> writes screenshots/report there instead of test-results/.
// MOVIES_UI_SOFT=1 records failed geometry checks without stopping (used for baselines).
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.env.MOVIES_UI_OUTPUT
  || join(root, "test-results", "movies-unification", new Date().toISOString().replace(/[:.]/g, "-")));
const soft = process.env.MOVIES_UI_SOFT === "1";
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1";
const cases = [
  { width: 390, height: 844, theme: "dark", mobile: true, flows: true },
  { width: 320, height: 694, theme: "dark", mobile: true },
  { width: 390, height: 844, theme: "light", mobile: true },
  { width: 320, height: 694, theme: "light", mobile: true },
  { width: 844, height: 390, theme: "dark", mobile: true },
  { width: 1280, height: 800, theme: "dark", mobile: false },
  { width: 1280, height: 800, theme: "light", mobile: false },
];
const caseName = test => `${test.width}x${test.height}-${test.theme}${test.mobile ? "" : "-desktop"}`;
const selected = process.env.MOVIES_UI_CASE ? cases.filter(test => caseName(test) === process.env.MOVIES_UI_CASE) : cases;
assert(selected.length, "MOVIES_UI_CASE must match a defined case");
const report = {
  environment: {
    browser: "Chromium (playwright-core)",
    transport: "Real App; Tauri IPC, TVBox API and poster images mocked; no upstream traffic",
    limitation: "Does not replace native iOS WKWebView or device playback verification",
  },
  cases: [], failures: [], external: [], pageErrors: [],
};
await mkdir(output, { recursive: true });

function installFixture({ theme }) {
  const hgTitles = ["城市与晚风", "重逢在夏日以后", "星河旅人", "无声的答案", "我的奇妙假期", "晴天来信", "雾港夜航", "远山回信"];
  const cards = hgTitles.map((title, i) => ({
    id: i + 1, title, cover: `https://fixture.invalid/poster/hg-${i}`, tags: ["都市", "剧情"], score: i % 2 === 0 ? 8.6 - i / 10 : 0,
    episode_count: 24 + i, total_episodes: 24 + i, hot: 286000 - i * 1000, like_count: 1800, collect_count: 900,
    comment_count: 20, is_finished: i % 3 === 0, is_original: 0, description: "界面回归示例数据", author: { id: 1, name: "示例作者" },
  }));
  const posts = hgTitles.slice(0, 5).map((title, i) => ({ id: i + 1, title: `${title}幕后花絮`, cover: `https://fixture.invalid/poster/post-${i}`, hot: 12000 + i }));
  const paged = (items, pages = 1) => ({ items, pagination: { page: 1, pages, size: items.length, total: items.length } });
  const tvCategories = [["17", "电影"], ["23", "剧集"], ["39", "综艺"], ["42", "动漫"]];
  const tvNames = {
    "": ["晨光列车", "海岸档案", "长夜书店", "风起之城", "白鹭湾", "第七站台", "山海旅馆", "北方来客"],
    17: ["远航计划", "沉默信号", "夏夜追光", "银色轨道", "雪原来信", "迷雾车站", "蓝色潮汐", "最后一班车"],
    23: ["小城四季", "灯火人家", "南巷往事", "云上学堂", "青石街", "归途", "春日晚餐", "邻里之间"],
    39: ["周末厨房", "旅行笔记", "声音实验室", "城市漫游", "手作时光", "一起露营"],
    42: ["星海少年", "纸飞机", "月光森林", "机械之心", "风之谷地", "童话邮局"],
  };
  const vod = (category, title, i, page) => ({
    vod_id: `${category || "home"}-${page}-${i}`, vod_name: page > 1 ? `${title} 第${page}页` : title,
    vod_pic: `https://img.fixture.invalid/tvbox/${category || "home"}-${page}-${i}.jpg`,
    vod_remarks: i % 3 === 0 ? "HD" : i % 3 === 1 ? `更新至${i + 6}集` : "已完结",
    vod_score: i % 2 === 0 ? (8.4 - i / 10).toFixed(1) : "", vod_year: "2025", vod_area: i % 2 ? "大陆" : "香港", vod_lang: "国语",
    ...(i % 4 === 3 ? {} : { vod_hits: String(1000 * (i + 1) * 37) }),
    vod_play_from: "线路一", vod_play_url: "正片$https://media.fixture.invalid/movie.mp4",
  });
  const fixture = { calls: [], unexpected: [] };
  localStorage.setItem("hghubx_theme", theme);
  localStorage.setItem("hghubx_swipe_ep_v2", "1");
  if (!sessionStorage.getItem("movies-fixture-seeded")) {
    sessionStorage.setItem("movies-fixture-seeded", "1");
    localStorage.setItem("hghubx_browse_mode_v1", "category");
    localStorage.setItem("hghubx_tvbox_sources_v1", JSON.stringify([
      { id: "fixture-a", name: "示例影视源", url: "https://tv-a.fixture.invalid/api.php/provide/vod/" },
      { id: "fixture-b", name: "备用演示源（名称较长）", url: "https://tv-b.fixture.invalid/api.php/provide/vod/" },
    ]));
    localStorage.setItem("hghubx_tvbox_active_v1", "fixture-a");
  }
  // Poster requests go to the app's local /img proxy (hg:// on iOS). Replace them with
  // deterministic SVG art so screenshots never touch real covers or upstream hosts.
  const palette = [["#4f7a96", "#1b2f45"], ["#8a6a9e", "#2b1d3d"], ["#5e8f74", "#1a3326"], ["#a07a52", "#3a2614"], ["#5868a8", "#1c2148"], ["#9a5a66", "#3a1820"]];
  const art = value => {
    let hash = 0;
    for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    const [a, b] = palette[hash % palette.length];
    const x = 60 + hash % 240, y = 90 + (hash >> 5) % 160;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="360" height="480" fill="url(#g)"/><circle cx="${x}" cy="${y}" r="58" fill="rgb(255 255 255 / .22)"/><path d="M0 480Q180 ${220 + hash % 120} 360 480" fill="rgb(0 0 0 / .22)"/></svg>`)}`;
  };
  const rewrite = value => typeof value === "string" && /\/img\?/.test(value) ? art(value) : value;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  Object.defineProperty(HTMLImageElement.prototype, "src", { ...descriptor, set(value) { descriptor.set.call(this, rewrite(value)); } });
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    return setAttribute.call(this, name, this instanceof HTMLImageElement && name === "src" ? rewrite(value) : value);
  };
  window.moviesFixture = fixture;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback() { return 1; },
    unregisterCallback() {},
    async invoke(cmd, args = {}) {
      fixture.calls.push({ cmd, args });
      if (cmd === "app_boot") return { user: null, logged_in: false, base: "https://fixture.invalid", strict_security: true };
      if (cmd === "playback_log_status") return { enabled: false, path: null, error: null };
      if (cmd === "debug_log" || cmd === "set_text_interaction") return;
      if (cmd === "proxy_state") return { mode: "system", url: "", enabled: false };
      if (cmd === "line_state") return { base: "https://fixture.invalid", previous: "https://fixture.invalid" };
      if (cmd === "line_auto") return { base: "https://fixture.invalid", previous: "https://fixture.invalid", switched: false, pick: { tier: "main", ms: 1, reason: "fixture", candidates: [] } };
      if (cmd === "api_feed" || cmd === "api_search_hot" || cmd === "api_search") return paged([]);
      if (cmd === "api_category" || cmd === "api_original_videos") return paged(cards, 2);
      if (cmd === "api_post_category" || cmd === "api_posts") return paged(posts);
      if (cmd === "api_rank") return { items: [] };
      if (cmd === "api_play") throw "Movies fixture has no playback media";
      if (cmd === "tvbox_fetch") {
        const url = new URL(String(args.url || ""));
        const params = url.searchParams;
        const category = params.get("t") || "";
        const page = Number(params.get("pg") || 1);
        const keyword = params.get("wd") || "";
        const names = keyword ? [`${keyword}·上篇`, `${keyword}·下篇`, `寻找${keyword}`] : (tvNames[category] || tvNames[""]);
        return { code: 1, page, pagecount: keyword ? 1 : 2, total: names.length * 2,
          class: tvCategories.map(([type_id, type_name]) => ({ type_id, type_name })),
          list: names.map((title, i) => vod(category, title, i, page)) };
      }
      if (cmd.startsWith("plugin:")) return cmd.includes("is_") ? false : null;
      fixture.unexpected.push(cmd);
      throw `Unexpected IPC: ${cmd}`;
    },
  };
}

function check(result, condition, message, detail) {
  result.checks.push({ message, passed: Boolean(condition), ...(condition ? {} : { detail }) });
  if (condition) return;
  report.failures.push(`${result.name}: ${message}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
  if (!soft) throw new assert.AssertionError({ message: `${result.name}: ${message} ${JSON.stringify(detail ?? "")}` });
}

// Geometry of the visible Movies page. Selectors fall back to the pre-refactor markup
// so the same script can document a baseline.
async function measure(page) {
  return page.evaluate(() => {
    const activePage = [...document.querySelectorAll(".ios-page")].find(el => el.getClientRects().length
      && !el.closest("[inert]") && el.querySelector("h1")?.textContent === "影视");
    if (!activePage) throw new Error("No visible Movies page");
    const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const switcher = activePage.querySelector('[aria-label="影视内容来源"]');
    const shelf = [...activePage.querySelectorAll("section[aria-label]")].find(el => el.querySelector(".ios-row-card"));
    const title = shelf?.querySelector('[data-ui="movies-shelf-title"]') || shelf?.querySelector("h2") || shelf?.querySelector(".font-semibold");
    const card = shelf?.querySelector(".ios-row-card");
    const poster = card?.querySelector(".ios-poster-art");
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentOverflow: document.documentElement.scrollWidth - innerWidth,
      pageOverflow: activePage.scrollWidth - activePage.clientWidth,
      title: box(activePage.querySelector("h1")),
      switcher: box(switcher),
      note: box(activePage.querySelector('[data-ui="movies-header-note"]')),
      header: box(activePage.querySelector('[data-ui="movies-header"]')),
      shelf: shelf ? {
        label: shelf.getAttribute("aria-label"),
        icon: box(shelf.querySelector('[data-ui="movies-shelf-icon"]') || shelf.querySelector(".tonal")),
        title: box(title), titleFont: title ? getComputedStyle(title).fontSize : null,
        viewAll: box(shelf.querySelector('[data-ui="movies-shelf-more"]')),
        card: box(card), poster: box(poster), cardTitle: box(card?.querySelector(".ios-poster-title")),
        cardOverlay: Boolean(card?.querySelector(".ios-poster-progress")),
        rail: box(shelf.querySelector(".scroll-x")),
      } : null,
      firstPoster: box(activePage.querySelector(".ios-poster-art")),
      source: box(activePage.querySelector('[aria-label="TVBox 数据源"]')),
      search: box(activePage.querySelector("form.ios-search-form")),
      ranking: box(activePage.querySelector('[aria-label="TVBox 榜单"]')),
      shelves: [...activePage.querySelectorAll("section[aria-label]")].map(el => el.getAttribute("aria-label")),
    };
  });
}

async function settle(page) {
  await page.waitForFunction(() => [...document.querySelectorAll(".ios-page")].some(el => el.getClientRects().length
    && !el.closest("[inert]") && el.querySelector(".ios-poster-art img[src^='data:image/svg']")));
  await page.evaluate(async () => {
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    const animations = document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity);
    await Promise.race([
      Promise.allSettled(animations.map(animation => animation.finished)),
      new Promise(done => setTimeout(done, 1000)),
    ]);
    // Fixture posters are inline SVG. Do not wait for unrelated or browser-cancelled
    // image events, which can leave headless Chromium blocked indefinitely.
  });
}

async function shot(page, result, label, full = false) {
  const file = `${result.name}-${label}.png`;
  await page.screenshot({ path: join(output, file), animations: "disabled" });
  result.screenshots.push(file);
  if (!full) return;
  // The Movies page scrolls inside the app shell, so grow the viewport to the scroll
  // height for a whole-page capture, then restore the device size.
  const extra = await page.evaluate(() => {
    const activePage = [...document.querySelectorAll(".ios-page")].find(el => el.getClientRects().length && !el.closest("[inert]") && el.querySelector("h1")?.textContent === "影视");
    const scroller = [...(activePage?.querySelectorAll(".scroll-y") || [])].find(el => el.getClientRects().length);
    return scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0;
  });
  if (extra > 0) {
    const size = page.viewportSize();
    await page.setViewportSize({ width: size.width, height: size.height + extra });
    await settle(page);
    const fullFile = `${result.name}-${label}-full.png`;
    await page.screenshot({ path: join(output, fullFile), animations: "disabled" });
    result.screenshots.push(fullFile);
    await page.setViewportSize(size);
    await settle(page);
  }
}

const close = (a, b, tolerance = 1) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) < tolerance;

let vite, browser;
const progress = step => console.log(`[movies-ui ${new Date().toISOString()}] ${step}`);
try {
  progress("starting fixture server");
  vite = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  progress(`fixture server ready at ${origin}`);
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  progress("browser ready");
  for (const test of selected) {
    const result = { ...test, name: caseName(test), checks: [], screenshots: [], geometry: {} };
    report.cases.push(result);
    const context = await browser.newContext({
      viewport: { width: test.width, height: test.height }, colorScheme: test.theme,
      ...(test.mobile ? { userAgent: iphone, isMobile: true, hasTouch: true } : {}),
    });
    await context.addInitScript(installFixture, { theme: test.theme });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(15000);
    page.on("pageerror", error => report.pageErrors.push(`${result.name}: ${error.message}`));
    page.on("console", message => { if (message.type() === "error") report.pageErrors.push(`${result.name}: ${message.text()}`); });
    await page.route("**/*", route => {
      const url = route.request().url();
      if (url.startsWith("data:") || new URL(url).origin === new URL(origin).origin) return route.continue();
      report.external.push(url);
      return route.abort();
    });
    try {
      progress(`${result.name}: navigating`);
      await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 15000 });
      progress(`${result.name}: app loaded`);
      const nav = page.getByRole("navigation", { name: "主导航" });
      await nav.getByRole("button", { name: "影视", exact: true }).click();
      progress(`${result.name}: opened Movies`);
      await page.getByRole("heading", { name: "影视", exact: true }).waitFor();
      const switcher = page.getByRole("group", { name: "影视内容来源" });
      await page.getByRole("region", { name: "AI成人短剧" }).locator(".ios-row-card").first().waitFor();
      progress(`${result.name}: HGhubX first shelf loaded`);
      await settle(page);
      const hg = await measure(page);
      result.geometry.hghubx = hg;
      await shot(page, result, "hghubx", true);

      await switcher.getByRole("button", { name: "TVBox 源", exact: true }).click();
      progress(`${result.name}: switched to TVBox`);
      await page.getByRole("region", { name: "电影" }).locator(".ios-row-card").first().waitFor();
      progress(`${result.name}: TVBox first category shelf loaded`);
      await settle(page);
      const tv = await measure(page);
      result.geometry.tvbox = tv;
      await shot(page, result, "tvbox", true);

      check(result, close(hg.title?.top, tv.title?.top) && close(hg.title?.left, tv.title?.left), "page title stays in place across modes", { hg: hg.title, tv: tv.title });
      for (const side of ["left", "top", "width", "height"]) {
        check(result, close(hg.switcher?.[side], tv.switcher?.[side]), `source switch ${side} is identical in both modes`, { hg: hg.switcher, tv: tv.switcher });
      }
      check(result, hg.note && tv.note && close(hg.note.top, tv.note.top) && close(hg.note.left, tv.note.left), "header note shares one slot", { hg: hg.note, tv: tv.note });
      check(result, hg.shelf?.icon && tv.shelf?.icon && close(hg.shelf.icon.left, tv.shelf.icon.left) && close(hg.shelf.icon.width, tv.shelf.icon.width),
        "shelf icon column matches", { hg: hg.shelf?.icon, tv: tv.shelf?.icon });
      check(result, close(hg.shelf?.title?.left, tv.shelf?.title?.left) && hg.shelf?.titleFont === tv.shelf?.titleFont,
        "shelf title column and type size match", { hg: [hg.shelf?.title, hg.shelf?.titleFont], tv: [tv.shelf?.title, tv.shelf?.titleFont] });
      check(result, close(hg.shelf?.card?.left, tv.shelf?.card?.left) && close(hg.shelf?.card?.width, tv.shelf?.card?.width),
        "first rail poster starts at the same inset with the same width", { hg: hg.shelf?.card, tv: tv.shelf?.card });
      check(result, close(hg.shelf?.poster?.height, tv.shelf?.poster?.height) && close(hg.shelf?.icon?.left, hg.shelf?.card?.left),
        "poster art height matches and rail aligns with the shelf heading", { hg: hg.shelf, tv: tv.shelf?.poster });
      check(result, hg.shelf?.cardOverlay === tv.shelf?.cardOverlay, "both rails use the same poster presentation", { hg: hg.shelf?.cardOverlay, tv: tv.shelf?.cardOverlay });
      for (const [mode, geometry] of [["HGhubX", hg], ["TVBox", tv]]) {
        check(result, geometry.documentOverflow <= 1 && geometry.pageOverflow <= 1, `${mode} has no horizontal overflow`, { document: geometry.documentOverflow, page: geometry.pageOverflow });
        check(result, geometry.switcher && geometry.switcher.right <= test.width + 0.5 && geometry.switcher.left >= 0, `${mode} switch stays inside the viewport`, geometry.switcher);
      }
      check(result, tv.source && tv.search && close((tv.source.top + tv.source.bottom) / 2, (tv.search.top + tv.search.bottom) / 2) && tv.source.right <= tv.search.left,
        "TVBox source and search share one row without overlap", { source: tv.source, search: tv.search });
      check(result, tv.search && tv.search.right <= test.width + 0.5, "TVBox search stays inside the viewport", tv.search);
      check(result, tv.ranking && tv.ranking.left >= 0 && tv.ranking.right <= test.width + 0.5, "TVBox ranking stays inside the viewport", tv.ranking);
      if (test.width < test.height) check(result, tv.firstPoster && tv.firstPoster.top < test.height - 100, "first TVBox poster is visible on the opening screen", tv.firstPoster);
      check(result, tv.shelves.includes("源推荐") && tv.shelves.includes("电影") && tv.shelves.includes("动漫"), "TVBox keeps the source home rail and every source category shelf", tv.shelves);

      if (test.flows) {
        const rankings = page.getByRole("group", { name: "TVBox 榜单" });
        for (const label of ["源推荐", "热度优先", "评分优先"]) await rankings.getByRole("button", { name: label, exact: true }).waitFor();
        await rankings.getByRole("button", { name: "热度优先", exact: true }).click();
        check(result, await rankings.getByRole("button", { name: "热度优先", exact: true }).getAttribute("aria-pressed") === "true", "ranking selection is exposed");
        await shot(page, result, "tvbox-hot");
        await rankings.getByRole("button", { name: "源推荐", exact: true }).click();

        const before = await page.evaluate(() => window.moviesFixture.calls.filter(c => c.cmd === "tvbox_fetch" && new URL(c.args.url).searchParams.get("t") === "17" && new URL(c.args.url).searchParams.get("pg") === "1").length);
        await page.getByRole("region", { name: "电影" }).getByRole("button", { name: "查看全部电影", exact: true }).click();
        await page.waitForFunction(n => window.moviesFixture.calls.filter(c => c.cmd === "tvbox_fetch" && new URL(c.args.url).searchParams.get("t") === "17" && new URL(c.args.url).searchParams.get("pg") === "1").length > n, before);
        const crumb = page.getByRole("navigation", { name: "TVBox 分类位置" });
        await crumb.getByRole("heading", { name: "电影", exact: true }).waitFor();
        await page.locator('[data-ui="media-grid"] .ios-poster-art img[src^="data:image/svg"]').first().waitFor();
        check(result, await page.locator(".ios-page:visible section[aria-label]").filter({ has: page.locator(".ios-row-card") }).count() === 0, "category list replaces the shelves");
        await settle(page);
        result.geometry.category = await measure(page);
        await shot(page, result, "tvbox-category", true);
        check(result, close(result.geometry.category.switcher?.top, tv.switcher?.top), "header stays fixed inside the category list", result.geometry.category.switcher);
        const pageTwo = await page.evaluate(() => window.moviesFixture.calls.filter(c => c.cmd === "tvbox_fetch" && new URL(c.args.url).searchParams.get("t") === "17" && new URL(c.args.url).searchParams.get("pg") === "2").length);
        await page.getByRole("button", { name: "加载更多", exact: true }).click();
        await page.waitForFunction(n => window.moviesFixture.calls.filter(c => c.cmd === "tvbox_fetch" && new URL(c.args.url).searchParams.get("t") === "17" && new URL(c.args.url).searchParams.get("pg") === "2").length > n, pageTwo);
        check(result, await page.evaluate(() => window.moviesFixture.calls.some(c => c.cmd === "tvbox_fetch" && new URL(c.args.url).searchParams.get("t") === "17" && new URL(c.args.url).searchParams.get("pg") === "2")), "pagination keeps the original non-index TVBox category id 17");
        await page.getByRole("button", { name: "远航计划 第2页", exact: true }).waitFor();

        const search = page.getByRole("textbox", { name: "搜索 TVBox 影片" });
        await search.fill("晚风");
        await search.press("Enter");
        await page.waitForFunction(() => window.moviesFixture.calls.some(c => c.cmd === "tvbox_fetch" && new URL(c.args.url).searchParams.get("wd") === "晚风"));
        await crumb.getByRole("heading", { name: "搜索“晚风”", exact: true }).waitFor();
        await page.getByRole("button", { name: "晚风·上篇", exact: true }).waitFor();
        await settle(page);
        await shot(page, result, "tvbox-search");
        await crumb.getByRole("button", { name: "返回电影", exact: true }).click();
        await crumb.getByRole("heading", { name: "电影", exact: true }).waitFor();
        check(result, await search.inputValue() === "", "leaving search clears the query and restores the category list");
        await crumb.getByRole("button", { name: "返回分类总览", exact: true }).click();
        await page.getByRole("region", { name: "电影" }).locator(".ios-row-card").first().waitFor();
        check(result, await crumb.count() === 0, "returning to the overview restores the shelves");

        await page.getByLabel("TVBox 数据源", { exact: true }).selectOption("fixture-b");
        await page.waitForFunction(() => window.moviesFixture.calls.some(c => c.cmd === "tvbox_fetch" && new URL(c.args.url).host === "tv-b.fixture.invalid"));
        await page.getByRole("region", { name: "电影" }).locator(".ios-row-card").first().waitFor();
        await settle(page);
        await shot(page, result, "tvbox-source-b");
        const ipc = await page.evaluate(() => window.moviesFixture.unexpected);
        check(result, ipc.length === 0, "no unexpected IPC", ipc);
      }
      result.passed = result.checks.every(item => item.passed);
    } catch (error) {
      result.error = String(error.stack || error);
      report.failures.push(`${result.name}: ${error.message}`);
      await page.screenshot({ path: join(output, `${result.name}-failure.png`) }).catch(() => {});
      if (!soft) throw error;
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(report.pageErrors, [], "No page errors");
  assert.deepEqual(report.external, [], "No upstream traffic");
  if (!soft) assert.deepEqual(report.failures, [], "All geometry checks pass");
  report.passed = report.failures.length === 0;
  console.log(`${report.passed ? "Passed" : "Recorded"}: ${report.cases.reduce((n, c) => n + c.checks.length, 0)} checks across ${report.cases.length} cases`);
  if (report.failures.length) console.log(report.failures.join("\n"));
} catch (error) {
  report.error = String(error.stack || error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
  console.log(`Artifacts: ${output}`);
}
