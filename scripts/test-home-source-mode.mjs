import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = await readFile(join(root, "src/pages/Home.tsx"), "utf8");
const tvboxPage = await readFile(join(root, "src/pages/TVBox.tsx"), "utf8");
const browse = await readFile(join(root, "src/pages/Browse.tsx"), "utf8");
const modeModule = await readFile(join(root, "src/browseMode.ts"), "utf8");

function includes(text, pattern, message) {
  assert.match(text, pattern, message);
}

// Home's TVBox mode follows its selected source and passes its exact videos to Feed,
// without adding its own category or ranking controls.
includes(home, /tvboxList\(requestSource, p\)/, "TVBox Home mode must request the selected source without a category override");
includes(home, /setTVBoxItems\(\(prev\).*localId/s, "TVBox pagination must accumulate source videos");
includes(home, /tvboxSource=\{mode === "tvbox" \? tvboxSource \?\? undefined : undefined\}/,
  "Feed must receive the selected TVBox source only in TVBox mode");
includes(home, /tvboxItems=\{mode === "tvbox" \? tvboxItems : undefined\}/,
  "Feed must receive the TVBox items corresponding to its source");
assert.doesNotMatch(home, /aria-label="首页 TVBox 分类"|aria-label="首页 TVBox 榜单"|全部分类|热度榜|评分榜|TVBoxRanking|feedTVBoxItems/,
  "Home must not expose TVBox category or ranking controls");

// The TVBox catalog exposes source categories as horizontal shelves with full-list
// navigation, while source-local ranking controls remain separate from Home.
assert.doesNotMatch(tvboxPage, /aria-label="TVBox 影视分类"/,
  "TVBox page must not restore the removed top category row");
includes(tvboxPage, /<section key=\{item\.id\} aria-label=\{item\.name\}/,
  "TVBox shelves must preserve source category IDs and names");
includes(tvboxPage, /onClick=\{\(\) => chooseCategory\(item\.id\)\} aria-label=\{`查看全部\$\{item\.name\}`\}/,
  "View all must open the selected source category by its original ID");
includes(tvboxPage, /<TVBoxVideoRail items=\{shelf\.items\}/,
  "Source categories must display horizontal video shelves");
includes(tvboxPage, /tvboxList\(currentSource, nextPage, category\)/,
  "Full lists must request the selected category on each page");
includes(tvboxPage, /loadPage\(submitted, page \+ 1\)/,
  "Full category lists must retain pagination");
includes(tvboxPage, /aria-label="TVBox 榜单"/, "TVBox page must retain ranking choices");
includes(tvboxPage, /ranking === "hot"[\s\S]*\(b\.hot \?\? 0\) - \(a\.hot \?\? 0\) \|\| b\.score - a\.score/,
  "hot ranking must use source play-count data and score as a fallback");
includes(tvboxPage, /b\.score - a\.score \|\| \(b\.hot \?\? 0\) - \(a\.hot \?\? 0\)/,
  "score ranking must sort by source-provided scores");

// Switching source/mode must invalidate requests and clear both catalogs before
// the next first-page request; Feed must remount across mode/source/line changes.
includes(home, /requestSeq\.current \+= 1/, "mode/source changes must invalidate in-flight requests");
includes(home, /setItems\(\[\]\)/, "mode/source changes must clear old cards");
includes(home, /setTVBoxItems\(\[\]\)/, "mode/source changes must clear old TVBox items");
includes(home, /const feedKey = `\$\{mode\}:\$\{tvboxSource\?\.id \?\? "hghubx"\}:\$\{lineEpoch\}`/,
  "Feed key must include mode, source and main-line epoch");
includes(home, /<Feed key=\{feedKey\}/, "Feed must remount when its source context changes");
includes(home, /window\.addEventListener\(TVBOX_SOURCE_EVENT, syncSource\)/,
  "Home must listen for TVBox source changes/imports");
includes(home, /TVBOX_SOURCE_EVENT/,
  "Home must react to imported or selected TVBox sources");
includes(home, /useState<BrowseMode>\(currentBrowseMode\)/,
  "Home must initialize from the Movies page mode");
includes(home, /window\.addEventListener\(BROWSE_MODE_EVENT, syncMode\)/,
  "Home must follow Movies page mode changes");
includes(browse, /setBrowseMode\(next\)/,
  "Movies page mode changes must publish the selected source mode");
includes(modeModule, /BROWSE_MODE_KEY = "hghubx_browse_mode_v1"/,
  "Movies source mode must persist for Home and Movies");
includes(modeModule, /BROWSE_MODE_EVENT = "hghubx:browse-mode-changed"/,
  "Movies source mode must notify Home immediately");
assert.doesNotMatch(home, /HOME_MODE_KEY|persistHomeMode|aria-label="首页数据源"|首页 TVBox 数据源/,
  "Home must not have an independent source mode or TVBox source selector");

// Near-end pagination continues through tvboxList, while HGhubX keeps its
// original api.feed path and a missing TVBox source does not silently switch modes.
includes(home, /onNearEnd=\{\(\) => \{ if \(!loading && canLoadMore/,
  "Feed must trigger guarded near-end pagination");
includes(home, /const res = await api\.feed\(p, 30\)/,
  "HGhubX mode must keep using api.feed");
includes(home, /if \(requestMode === "tvbox" && !requestSource\).*setDone\(true\)/s,
  "TVBox mode without a selected source must not silently fall back to HGhubX");

console.log("test-home-source-mode: ok");
