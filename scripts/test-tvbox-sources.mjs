import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempModule = resolve(root, "src", `.tvbox-sources-test-${randomUUID()}.mjs`);
const compiled = ts.transpileModule(await readFile(resolve(root, "src/tvboxSources.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
}).outputText;
await writeFile(tempModule, compiled);
let tvbox;
try { tvbox = await import(pathToFileURL(tempModule).href); }
finally { await rm(tempModule, { force: true }); }
const {
  parseTvboxCategories,
  parseTvboxConfig,
  parseTvboxDetail,
  parseTvboxVideos,
  resolveTvboxPlayback,
  tvboxCategories,
} = tvbox;

const source = {
  key: "demo", name: "示例源", api: "https://example.com/api.php", type: 1,
  searchable: 1, filterable: 1, quickSearch: 0,
};

test("imports JSONC source lists, parsers and relative repositories", () => {
  const result = parseTvboxConfig(`{
    // source URLs may contain // and are not comments
    "sites": [{"key":"demo","name":"示例","api":"https://example.com/api.php","type":1,}],
    "parses": [{"name":"解析","url":"https://parser.example/?url=","type":0}],
    "urls": [{"name":"仓库","url":"./other.json"}],
  }`, "https://config.example/list.json");
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].api, "https://example.com/api.php");
  assert.equal(result.parsers.length, 1);
  assert.equal(result.repositories?.[0].url, "https://config.example/other.json");
  const bom = parseTvboxConfig(`\uFEFF{"sites":[{"api":"https://json.example/api","type":1},{"api":"https://unknown.example/api","type":2}]}`);
  assert.deepEqual(bom.sources.map((item) => item.type), [1], "BOM is stripped and unsupported source types are ignored");
});

test("reads JSON CMS categories and video fields with numeric IDs", () => {
  assert.deepEqual(parseTvboxCategories(JSON.stringify({ class: [{ type_id: 4, type_name: "电影" }] }), 1), [{ id: "4", name: "电影" }]);
  const videos = parseTvboxVideos(JSON.stringify({ list: [{ vod_id: 77, vod_name: "样片", vod_pic: "https://img.example/p.jpg", vod_remarks: "更新中" }] }), 1);
  assert.equal(videos[0].id, "77");
  assert.equal(videos[0].name, "样片");
  assert.equal(videos[0].pic, "https://img.example/p.jpg");
});

test("splits multi-line episode lists while preserving dollar signs in URLs", () => {
  const detail = parseTvboxDetail(JSON.stringify({ list: [{
    vod_id: 7, vod_name: "样片", vod_play_from: "线路甲$$$线路乙",
    vod_play_url: "第1集$https://cdn.example/video$token.m3u8#第2集$https://cdn.example/two.m3u8$$$正片$https://cdn.example/movie.mp4",
  }] }), source, { id: "7", name: "样片", pic: "", note: "", year: "", area: "", typeName: "", director: "", actor: "", description: "" });
  assert.deepEqual(detail.flags, ["线路甲", "线路乙"]);
  assert.equal(detail.episodes["线路甲"][0].url, "https://cdn.example/video$token.m3u8");
  assert.equal(detail.episodes["线路乙"][0].name, "正片");
});

test("routes direct media URLs without requiring a parser", async () => {
  const url = "https://cdn.example/video.m3u8?token=x";
  assert.equal(await resolveTvboxPlayback({ name: "第1集", url, flag: "线路甲" }, source), url);
  const signed = "https://cdn.example/video.m3u8?token=part%2Fsub%2520value";
  assert.equal(await resolveTvboxPlayback({ name: "签名流", url: signed, flag: "线路甲" }, source), signed);
});

test("plays Remote direct links without changing the existing player route", async () => {
  const remote = { ...source, type: 4 };
  const url = "https://cdn.example/remote.m3u8?sig=a%2Fb";
  assert.equal(await resolveTvboxPlayback({ name: "Remote 直链", url, flag: "线路甲" }, remote), url);
});

test("Spider/JAR sources fail with an explicit compatibility message", async () => {
  await assert.rejects(tvboxCategories({ ...source, type: 3 }), /Spider\/JAR/);
});
