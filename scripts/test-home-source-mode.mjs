import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = await readFile(join(root, "src/pages/Home.tsx"), "utf8");
const browse = await readFile(join(root, "src/pages/Browse.tsx"), "utf8");
const modeModule = await readFile(join(root, "src/browseMode.ts"), "utf8");

function includes(text, pattern, message) {
  assert.match(text, pattern, message);
}

// TVBox mode must request the selected source and convert the exact returned
// TVBox videos into the cards passed to Feed.
includes(home, /tvboxList\(requestSource, p, requestCategory\)/, "TVBox mode must call tvboxList with the selected source and category");
includes(home, /setTVBoxItems\(\(prev\).*localId/s, "TVBox pagination must accumulate source videos");
includes(home, /tvboxSource=\{mode === "tvbox" \? tvboxSource \?\? undefined : undefined\}/,
  "Feed must receive the selected TVBox source only in TVBox mode");
includes(home, /tvboxItems=\{mode === "tvbox" \? feedTVBoxItems : undefined\}/,
  "Feed must receive the TVBox items corresponding to its source");

// Switching source/mode must invalidate requests and clear both catalogs before
// the next first-page request; Feed must remount across mode/source/line changes.
includes(home, /requestSeq\.current \+= 1/, "mode/source changes must invalidate in-flight requests");
includes(home, /setItems\(\[\]\)/, "mode/source changes must clear old cards");
includes(home, /setTVBoxItems\(\[\]\)/, "mode/source changes must clear old TVBox items");
includes(home, /const feedKey = `\$\{mode\}:\$\{tvboxSource\?\.id \?\? "hghubx"\}:\$\{category\}:\$\{ranking\}:\$\{lineEpoch\}`/,
  "Feed key must include mode, source, category, ranking and main-line epoch");
includes(home, /<Feed key=\{feedKey\}/, "Feed must remount when its source context changes");
includes(home, /window\.addEventListener\(TVBOX_SOURCE_EVENT, syncSource\)/,
  "Home must listen for TVBox source changes/imports");
includes(home, /TVBOX_SOURCE_EVENT/,
  "Home must react to imported or selected TVBox sources");
includes(home, /aria-label="首页 TVBox 分类"/, "Home TVBox mode must expose source categories");
includes(home, /aria-label="首页 TVBox 榜单"/, "Home TVBox mode must expose source-local ranking choices");
includes(home, /ranking === "hot".*b\.hot.*b\.score/s, "hot ranking must use source play-count data and score as a fallback");
includes(home, /ranking === "score".*b\.score/s, "score ranking must sort by source-provided scores");
includes(home, /useState<BrowseMode>\(currentBrowseMode\)/, "Home must initialize from the Movies page mode");
includes(home, /window\.addEventListener\(BROWSE_MODE_EVENT, syncMode\)/, "Home must follow Movies page mode changes");
includes(browse, /setBrowseMode\(next\)/, "Movies page mode changes must publish the selected source mode");
includes(modeModule, /BROWSE_MODE_KEY = "hghubx_browse_mode_v1"/, "Movies source mode must persist for Home and Movies");
includes(modeModule, /BROWSE_MODE_EVENT = "hghubx:browse-mode-changed"/, "Movies source mode must notify Home immediately");
assert.doesNotMatch(home, /HOME_MODE_KEY|persistHomeMode|aria-label="首页数据源"|首页 TVBox 数据源/,
  "Home must not have an independent source mode or TVBox source selector");

// Near-end pagination continues through tvboxList, while HGhubX keeps its
// original api.feed path and a missing TVBox source does not silently switch modes.
includes(home, /onNearEnd=\{\(\) => \{ if \(!loading && canLoadMore/, "Feed must trigger guarded near-end pagination");
includes(home, /const res = await api\.feed\(p, 30\)/, "HGhubX mode must keep using api.feed");
includes(home, /if \(requestMode === "tvbox" && !requestSource\).*setDone\(true\)/s,
  "TVBox mode without a selected source must not silently fall back to HGhubX");

console.log("test-home-source-mode: ok");
