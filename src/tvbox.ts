import { invoke } from "@tauri-apps/api/core";
import { cover, directMedia, playlist } from "./api";
import type { Detail, Episode, VideoCard } from "./types";
import { fetchLiveM3U, importLiveSourceFromText, loadLiveSources, parseM3U, safeLiveHttpUrl, type LiveSource } from "./live";

const SOURCES_KEY = "hghubx_tvbox_sources_v1";
const ACTIVE_KEY = "hghubx_tvbox_active_v1";
const FAVORITES_KEY = "hghubx_tvbox_favorites_v1";
const HISTORY_KEY = "hghubx_tvbox_history_v1";
export const TVBOX_SOURCE_EVENT = "hghubx:tvbox-source-changed";
export const TVBOX_LIBRARY_EVENT = "hghubx:tvbox-library-changed";

export type TVBoxSourceKind = "xml" | "remote" | "js";
// A missing kind is the legacy standard JSON API representation.
export type TVBoxSource = { id: string; name: string; url: string; kind?: TVBoxSourceKind; ext?: unknown; quickSearch?: boolean };
export type TVBoxRepository = { name: string; url: string };
export type TVBoxCategory = { id: string; name: string };
export type TVBoxEpisode = { name: string; url: string };
export type TVBoxPlayGroup = { name: string; episodes: TVBoxEpisode[] };
export type TVBoxVod = {
  id: string;
  title: string;
  cover: string;
  remarks: string;
  description: string;
  year: string;
  area: string;
  language: string;
  type: string;
  actor: string;
  director: string;
  score: number;
  hot?: number;
  status: string;
  playGroups: TVBoxPlayGroup[];
};
export type TVBoxVideo = TVBoxVod & { localId: number };
export type TVBoxLibraryEntry = {
  source: TVBoxSource;
  video: TVBoxVideo;
  ep: number;
  t: number;
  dur: number;
  updatedAt: number;
};
export type TVBoxPage = {
  items: TVBoxVideo[];
  categories: TVBoxCategory[];
  page: number;
  pages: number;
  total: number;
};

export function isTVBoxJsSource(source: TVBoxSource): boolean {
  return source.kind === "js";
}

export function isTVBoxRemoteSource(source: TVBoxSource): boolean {
  return source.kind === "remote";
}

function isTVBoxResolverSource(source: TVBoxSource): boolean {
  return isTVBoxJsSource(source) || isTVBoxRemoteSource(source);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  return "";
}

function number(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function decodeSpiderPayload(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

/** JS is executed only by the isolated backend runtime, never by WebView code. */
export async function invokeTVBoxSpider(source: TVBoxSource, method: string, args: unknown[] = []): Promise<unknown> {
  if (!isTVBoxJsSource(source)) throw new Error("当前源不是 JavaScript Spider");
  try {
    return decodeSpiderPayload(await invoke<unknown>("tvbox_spider", {
      source: { url: source.url, ...(source.ext === undefined ? {} : { ext: source.ext }) }, method, args,
    }));
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(typeof error === "string" ? error : "JS Spider 调用失败");
  }
}

export function buildTVBoxApiUrl(source: TVBoxSource, params: Record<string, string | number | undefined>): string {
  const url = new URL(source.url);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Native Tauri networking keeps source requests on the app proxy and SSRF policy. */
export async function fetchTVBoxJson(url: string): Promise<unknown> {
  return invoke<unknown>("tvbox_fetch", { url });
}

/** Bounded native UTF-8 reads are used for XML so WebView networking stays out of the source path. */
export async function fetchTVBoxText(url: string): Promise<string> {
  return invoke<string>("tvbox_fetch_text", { url });
}

function payloadRoot(value: unknown): Record<string, unknown> {
  const root = record(value) ?? {};
  const data = record(root.data);
  return data && (Array.isArray(data.list) || Array.isArray(data.class) || Array.isArray(data.vod)) ? data : root;
}

function assertTVBoxApiPayload(value: unknown): void {
  const root = record(value);
  const data = record(root?.data);
  const valid = [root, data].some(candidate => candidate !== null
    && (Array.isArray(candidate.list) || Array.isArray(candidate.vod) || Array.isArray(candidate.class)));
  if (!valid) throw new Error("当前源不是标准 JSON API 响应；JS 源需作为脚本源导入");
}

function listFrom(value: unknown): unknown[] {
  const root = payloadRoot(value);
  if (Array.isArray(root.list)) return root.list;
  if (Array.isArray(root.vod)) return root.vod;
  const data = record(root.data);
  if (data && Array.isArray(data.list)) return data.list;
  return [];
}

function categoryList(value: unknown): TVBoxCategory[] {
  const root = payloadRoot(value);
  const raw = Array.isArray(root.class) ? root.class : Array.isArray(record(root.data)?.class) ? record(root.data)?.class : [];
  return asArray(raw).flatMap((entry) => {
    const item = record(entry);
    const id = item && text(item.type_id ?? item.id);
    const name = item && text(item.type_name ?? item.name);
    return id && name ? [{ id, name }] : [];
  });
}

function xmlDecode(raw: string): string {
  let value = raw.trim();
  const cdata = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
  if (cdata) value = cdata[1];
  return value
    .replace(/&#x([\da-f]+);/gi, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      try { return Number.isFinite(code) ? String.fromCodePoint(code) : ""; } catch { return ""; }
    })
    .replace(/&#(\d+);/g, (_match, dec: string) => {
      const code = Number.parseInt(dec, 10);
      try { return Number.isFinite(code) ? String.fromCodePoint(code) : ""; } catch { return ""; }
    })
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&amp;/gi, "&")
    .trim();
}

function xmlElements(xml: string, tag: string): { attributes: string; content: string }[] {
  const regex = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi");
  return [...xml.matchAll(regex)].map(match => ({ attributes: match[1] || "", content: match[2] || "" }));
}

function xmlAttribute(attributes: string, name: string): string {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return xmlDecode(match?.[1] ?? match?.[2] ?? "");
}

function xmlValue(block: string, ...names: string[]): string {
  for (const name of names) {
    const node = xmlElements(block, name)[0];
    if (node) return xmlDecode(node.content);
  }
  return "";
}

/** Parse the data-only type=0 XML contract; no scripts, entities, or player pages are executed. */
export function parseTVBoxXmlPage(xml: string, source: TVBoxSource): TVBoxPage {
  const categories = xmlElements(xml, "ty").flatMap(({ attributes, content }) => {
    const id = xmlAttribute(attributes, "id");
    const name = xmlDecode(content);
    return id && name ? [{ type_id: id, type_name: name }] : [];
  });
  const list = xmlElements(xml, "video").map(({ content }) => {
    const groups = xmlElements(content, "dd").flatMap(({ attributes, content: body }) => {
      const raw = xmlDecode(body);
      return raw ? [{ flag: xmlAttribute(attributes, "flag"), raw }] : [];
    });
    return {
      vod_id: xmlValue(content, "id", "vod_id"),
      vod_name: xmlValue(content, "name", "title", "vod_name"),
      vod_pic: xmlValue(content, "pic", "vod_pic"),
      vod_remarks: xmlValue(content, "note", "remarks", "vod_remarks"),
      vod_content: xmlValue(content, "des", "content", "vod_content"),
      vod_year: xmlValue(content, "year", "vod_year"),
      vod_area: xmlValue(content, "area", "vod_area"),
      vod_lang: xmlValue(content, "lang", "language", "vod_lang"),
      vod_type: xmlValue(content, "type", "type_name", "vod_type"),
      vod_actor: xmlValue(content, "actor", "vod_actor"),
      vod_director: xmlValue(content, "director", "vod_director"),
      vod_score: xmlValue(content, "score", "vod_score"),
      vod_state: xmlValue(content, "state", "vod_state"),
      vod_play_from: groups.map((group, index) => group.flag || `线路 ${index + 1}`).join("$$$"),
      vod_play_url: groups.map(group => group.raw).join("$$$"),
    };
  });
  const listNode = xmlElements(xml, "list")[0];
  const page = number(xmlAttribute(listNode?.attributes || "", "page"), 1);
  const pages = number(xmlAttribute(listNode?.attributes || "", "pagecount"), 1);
  const total = number(xmlAttribute(listNode?.attributes || "", "recordcount"), list.length);
  return parseTVBoxPage({ class: categories, list, page, pagecount: pages, total }, source);
}

function resolvedUrl(raw: string, base: string): string {
  if (!raw) return "";
  try {
    const result = new URL(raw, base);
    return result.protocol === "http:" || result.protocol === "https:" ? result.toString() : "";
  } catch {
    return "";
  }
}

function stableLocalId(sourceId: string, vodId: string): number {
  const input = `${sourceId}\u0000${vodId}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2_000_000_000 + 1;
}

function normalizeVod(value: unknown, source: TVBoxSource): TVBoxVod | null {
  const item = record(value);
  if (!item) return null;
  const id = text(item.vod_id ?? item.id);
  const title = text(item.vod_name ?? item.title ?? item.name);
  if (!id || !title) return null;
  // Resolve paths against the configured endpoint, not only its origin; some APIs
  // place relative media and poster URLs beneath their own directory.
  const mediaBase = source.url;
  const playFrom = text(item.vod_play_from).split("$$$");
  const playUrl = text(item.vod_play_url).split("$$$");
  const playGroups = playUrl.map((rawGroup, index) => {
    const episodes = rawGroup.split("#").flatMap((part, episodeIndex) => {
      const separator = part.indexOf("$");
      const rawUrl = separator >= 0 ? part.slice(separator + 1).trim() : part.trim();
      const url = isTVBoxResolverSource(source) ? rawUrl : resolvedUrl(rawUrl, mediaBase);
      if (!url) return [];
      const name = separator >= 0 ? part.slice(0, separator).trim() : `第 ${episodeIndex + 1} 集`;
      return [{ name: name || `第 ${episodeIndex + 1} 集`, url }];
    });
    return { name: playFrom[index]?.trim() || `线路 ${index + 1}`, episodes };
  }).filter(group => group.episodes.length > 0);
  const rawScore = text(item.vod_score).replace(/[^\d.]/g, "");
  const hot = number(item.vod_hits ?? item.vod_hits_month ?? item.vod_play_count ?? item.hits ?? item.play_count);
  return {
    id,
    title,
    cover: resolvedUrl(text(item.vod_pic ?? item.pic ?? item.cover), mediaBase),
    remarks: text(item.vod_remarks ?? item.remarks ?? item.vod_serial),
    description: text(item.vod_content ?? item.vod_blurb ?? item.content ?? item.desc),
    year: text(item.vod_year),
    area: text(item.vod_area),
    language: text(item.vod_lang),
    type: text(item.type_name ?? item.vod_type ?? item.type),
    actor: text(item.vod_actor),
    director: text(item.vod_director),
    score: number(rawScore),
    hot,
    status: text(item.vod_state ?? item.vod_remarks ?? item.vod_serial),
    playGroups,
  };
}

export function tvboxVideoCard(video: TVBoxVideo | TVBoxVod, source: TVBoxSource): VideoCard {
  const localId = "localId" in video ? video.localId : stableLocalId(source.id, video.id);
  const episodeCount = Math.max(0, ...video.playGroups.map(group => group.episodes.length),
    number(video.status.match(/\d+/)?.[0]), number(video.remarks.match(/\d+/)?.[0]));
  const tags = [video.year, video.area, video.language].filter(Boolean).slice(0, 4);
  const finished = /完结|已完结|全集/i.test(`${video.status} ${video.remarks}`);
  return {
    id: localId,
    title: video.title,
    cover: video.cover ? cover(video.cover, 480, source.url) : "",
    description: video.description,
    tags,
    score: video.score,
    episode_count: episodeCount,
    total_episodes: episodeCount,
    duration: video.remarks,
    hot: video.hot ?? 0,
    like_count: 0,
    collect_count: 0,
    comment_count: 0,
    is_finished: finished,
    is_original: 0,
  };
}

export function tvboxDetailModel(video: TVBoxVod, source: TVBoxSource, groupIndex = 0): Detail {
  const group = video.playGroups[groupIndex] ?? video.playGroups[0];
  const episodes: Episode[] = (group?.episodes ?? []).map((episode, index) => ({
    ep_num: index + 1,
    title: episode.name,
    duration: 0,
    status: 0,
  }));
  return {
    id: stableLocalId(source.id, video.id),
    title: video.title,
    description: video.description,
    cover: video.cover ? cover(video.cover, 480, source.url) : "",
    tags: [video.year, video.area, video.language].filter(Boolean),
    score: video.score,
    episode_count: episodes.length,
    total_episodes: episodes.length,
    episodes,
    counts: { collect: 0, comment: 0, hot: 0, like: 0 },
    author: { id: 0, name: source.name },
    interaction: { collected: false, liked: false },
    video_url: group?.episodes[0]?.url,
    is_finished: /完结|已完结|全集/i.test(video.status),
    is_original: 0,
  };
}

export function parseTVBoxPage(value: unknown, source: TVBoxSource): TVBoxPage {
  const root = payloadRoot(value);
  const envelope = record(value) ?? {};
  const page = Math.max(1, number(root.page ?? envelope.page, 1));
  const rawPages = number(root.pagecount ?? root.page_count ?? root.pages
    ?? envelope.pagecount ?? envelope.page_count ?? envelope.pages, 1);
  const items = listFrom(value).flatMap((entry) => {
    const video = normalizeVod(entry, source);
    return video ? [{ ...video, localId: stableLocalId(source.id, video.id) }] : [];
  });
  return {
    items,
    categories: categoryList(value),
    page,
    pages: Math.max(1, rawPages),
    total: number(root.total ?? envelope.total, items.length),
  };
}

const remoteExtendCache = new Map<string, Promise<string | undefined>>();

async function resolvedRemoteExtend(source: TVBoxSource): Promise<string | undefined> {
  if (source.ext === undefined || source.ext === null) return undefined;
  if (typeof source.ext !== "string") {
    try { return JSON.stringify(source.ext); } catch { return undefined; }
  }
  const raw = source.ext.trim();
  if (!raw) return undefined;
  if (!/^https?:\/\//i.test(raw)) return raw;
  const cached = remoteExtendCache.get(source.id);
  if (cached) return cached;
  const pending = (async () => {
    try {
      const url = normalizeSourceUrl(raw);
      const text = await fetchTVBoxText(url);
      return text.length <= 2500 ? text.trim() : url;
    } catch {
      // TVBox-Swift uses the URL itself when an ext endpoint is unavailable.
      try { return normalizeSourceUrl(raw); } catch { return raw; }
    }
  })();
  remoteExtendCache.set(source.id, pending);
  return pending;
}

function encodeTVBoxJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function remoteRequest(source: TVBoxSource, params: Record<string, string | number | undefined>): Promise<unknown> {
  const extend = await resolvedRemoteExtend(source);
  return fetchTVBoxJson(buildTVBoxApiUrl(source, { ...params, extend }));
}

function needsHomeFallback(page: TVBoxPage): boolean {
  return page.items.length === 0 || page.items.filter(item => !item.cover).length > page.items.length / 2;
}

function normalizedSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

function filterTVBoxSearch(page: TVBoxPage, keyword: string): TVBoxPage {
  const terms = keyword.split(/\s+/).map(normalizedSearchText).filter(Boolean);
  if (!terms.length) return page;
  const items = page.items.filter(video => {
    const text = normalizedSearchText([video.title, video.remarks, video.actor, video.director,
      video.type, video.area, video.year, video.description].join(" "));
    return terms.every(term => text.includes(term));
  });
  return { ...page, items };
}

async function fetchJsonPageWithFallback(
  source: TVBoxSource,
  params: Record<string, string | number | undefined>,
  fallbackParams: Record<string, string | number | undefined>[] = [],
  shouldFallback: (page: TVBoxPage) => boolean = page => page.items.length === 0,
): Promise<TVBoxPage> {
  let primary: TVBoxPage | null = null;
  let bestFallback: TVBoxPage | null = null;
  let lastError: unknown;
  try {
    const data = await fetchTVBoxJson(buildTVBoxApiUrl(source, params));
    assertTVBoxApiPayload(data);
    primary = parseTVBoxPage(data, source);
  } catch (error) { lastError = error; }
  if (primary && !shouldFallback(primary)) return primary;

  for (const fallback of fallbackParams) {
    try {
      const data = await fetchTVBoxJson(buildTVBoxApiUrl(source, fallback));
      assertTVBoxApiPayload(data);
      const parsed = parseTVBoxPage(data, source);
      if (!primary) primary = parsed;
      if (parsed.items.length) {
        bestFallback = parsed;
        if (!shouldFallback(parsed)) break;
      }
    } catch (error) { lastError = error; }
  }
  const result = bestFallback ?? primary;
  if (result) return bestFallback && primary
    ? { ...bestFallback, categories: primary.categories.length ? primary.categories : bestFallback.categories }
    : result;
  throw lastError instanceof Error ? lastError : new Error("TVBox JSON 源请求失败");
}

export async function tvboxList(source: TVBoxSource, page = 1, category = ""): Promise<TVBoxPage> {
  const safePage = Math.max(1, page);
  if (isTVBoxJsSource(source)) {
    if (category) return parseTVBoxPage(
      await invokeTVBoxSpider(source, "category", [category, safePage, true, {}]), source,
    );
    if (safePage > 1) return parseTVBoxPage(await invokeTVBoxSpider(source, "homeVod", [safePage]), source);
    const home = await invokeTVBoxSpider(source, "home", [true]);
    const homeVod = await invokeTVBoxSpider(source, "homeVod", [1]);
    const homePage = parseTVBoxPage(home, source);
    const vodPage = parseTVBoxPage(homeVod, source);
    return { ...vodPage, categories: homePage.categories.length ? homePage.categories : vodPage.categories,
      items: [...homePage.items, ...vodPage.items],
      total: Math.max(homePage.total, vodPage.total, homePage.items.length + vodPage.items.length) };
  }

  if (source.kind === "xml") {
    if (safePage === 1 && !category) {
      return parseTVBoxXmlPage(await fetchTVBoxText(source.url), source);
    }
    const url = buildTVBoxApiUrl(source, { ac: "videolist", pg: safePage, t: category || undefined });
    return parseTVBoxXmlPage(await fetchTVBoxText(url), source);
  }

  if (isTVBoxRemoteSource(source)) {
    if (safePage === 1 && !category) {
      const data = await remoteRequest(source, { filter: "true" });
      assertTVBoxApiPayload(data);
      const home = parseTVBoxPage(data, source);
      if (needsHomeFallback(home)) {
        try {
          const fallback = await remoteRequest(source, { ac: "detail", filter: "true", pg: 1, ext: encodeTVBoxJson({}) });
          assertTVBoxApiPayload(fallback);
          const fallbackPage = parseTVBoxPage(fallback, source);
          if (fallbackPage.items.length) return { ...fallbackPage, categories: home.categories.length ? home.categories : fallbackPage.categories };
        } catch { /* keep the usable category/home response if the optional fallback is unavailable */ }
      }
      return home;
    }
    const data = await remoteRequest(source, { ac: "detail", filter: "true", pg: safePage,
      t: category || undefined, ext: encodeTVBoxJson({}) });
    assertTVBoxApiPayload(data);
    return parseTVBoxPage(data, source);
  }

  if (safePage === 1 && !category) {
    return fetchJsonPageWithFallback(source, { ac: "class" },
      [{ ac: "videolist", pg: 1 }, { ac: "list", pg: 1 }], needsHomeFallback);
  }
  return fetchJsonPageWithFallback(source,
    { ac: "videolist", pg: safePage, t: category || undefined },
    [{ ac: "list", pg: safePage, t: category || undefined }]);
}

export async function tvboxSearch(source: TVBoxSource, keyword: string, page = 1, _category = ""): Promise<TVBoxPage> {
  if (isTVBoxJsSource(source)) {
    return parseTVBoxPage(await invokeTVBoxSpider(source, "search", [keyword, false, Math.max(1, page)]), source);
  }
  if (source.kind === "xml") {
    const data = await fetchTVBoxText(buildTVBoxApiUrl(source, { wd: keyword }));
    const result = filterTVBoxSearch(parseTVBoxXmlPage(data, source), keyword);
    return { ...result, page: 1, pages: 1 };
  }
  if (isTVBoxRemoteSource(source)) {
    const data = await remoteRequest(source, { wd: keyword, ac: "detail", quick: source.quickSearch ? "true" : "false" });
    assertTVBoxApiPayload(data);
    const result = filterTVBoxSearch(parseTVBoxPage(data, source), keyword);
    return { ...result, page: 1, pages: 1 };
  }
  const pageResult = await fetchJsonPageWithFallback(source, { wd: keyword },
    [{ ac: "list", wd: keyword, pg: 1 }]);
  const result = filterTVBoxSearch(pageResult, keyword);
  return { ...result, page: 1, pages: 1 };
}

export async function tvboxDetail(source: TVBoxSource, vodId: string): Promise<TVBoxVod> {
  if (isTVBoxJsSource(source)) {
    const video = normalizeVod(listFrom(await invokeTVBoxSpider(source, "detail", [vodId]))[0], source);
    if (!video) throw new Error("JS Spider 没有返回有效影片详情");
    return video;
  }
  if (source.kind === "xml") {
    const xml = await fetchTVBoxText(buildTVBoxApiUrl(source, { ac: "videolist", ids: vodId }));
    const video = parseTVBoxXmlPage(xml, source).items[0];
    if (!video) throw new Error("TVBox XML 源没有返回有效影片详情");
    return video;
  }
  const data = isTVBoxRemoteSource(source)
    ? await remoteRequest(source, { ac: "detail", ids: vodId })
    : await fetchTVBoxJson(buildTVBoxApiUrl(source, { ac: "detail", ids: vodId }));
  assertTVBoxApiPayload(data);
  const raw = listFrom(data)[0] ?? record(payloadRoot(data))?.vod ?? null;
  const video = normalizeVod(raw, source);
  if (!video) throw new Error("TVBox 源没有返回有效影片详情");
  return video;
}

type TVBoxMediaKind = "hls" | "file" | null;

/** Identify only media formats declared by the URL itself; never inspect or run a player page. */
function explicitTVBoxMediaKind(raw: string): TVBoxMediaKind {
  try {
    const url = new URL(raw);
    const path = url.pathname.toLowerCase();
    const values = ["format", "type", "mime"].map(key => (url.searchParams.get(key) ?? "").toLowerCase());
    if (/\.(?:mp4|m4v|mov|webm)$/.test(path)
      || values.some(value => /^(?:mp4|m4v|video\/mp4)$/.test(value))) return "file";
    if (/\.m3u8$/.test(path)
      || values.some(value => /^(?:m3u8|hls|application\/(?:vnd\.apple\.mpegurl|x-mpegurl))$/.test(value))) return "hls";
    return null;
  } catch { return null; }
}

/** Prefer explicit media over embedded player pages for the requested episode; never run a source parser. */
export function preferredTVBoxLine(video: TVBoxVod | undefined, episode = 1): number {
  const groups = video?.playGroups ?? [];
  const direct = groups.findIndex(group => explicitTVBoxMediaKind(group.episodes[episode - 1]?.url ?? "") !== null);
  if (direct >= 0) return direct;
  const hinted = groups.findIndex(group => /m3u8|hls|mp4/i.test(group.name) && !!group.episodes[episode - 1]);
  return hinted >= 0 ? hinted : 0;
}

export function tvboxMediaUrl(video: TVBoxVod | undefined, episode: number, groupIndex = 0): string {
  const group = video?.playGroups[groupIndex] ?? video?.playGroups[0];
  const entry = group?.episodes[episode - 1];
  if (!entry) throw new Error("该集没有可直接播放的 HTTP(S) 地址；需要解析器的源暂不支持");
  const url = new URL(entry.url);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error("只支持不含账号密码的 HTTP(S) 视频地址");
  return url.toString();
}

/** Build a local player URL: direct MP4-family files use /seg; HLS (including
 * extensionless playlist endpoints) stays on /hls so nested playlists are rewritten. */
function mediaUrlFromSpider(value: unknown): string {
  const root = record(value);
  const parse = root?.parse;
  const jx = root?.jx;
  const requiresResolver = (flag: unknown): boolean => {
    if (typeof flag === "number") return flag !== 0;
    if (typeof flag === "boolean") return flag;
    const value = text(flag).trim().toLowerCase();
    return ["1", "true", "yes"].includes(value) || /parse|sniff/.test(value);
  };
  if (requiresResolver(parse) || requiresResolver(jx)) {
    throw new Error("该 TVBox 源返回需要嗅探/解析的播放页，当前不支持；不会加载网页执行");
  }
  const headers = root?.headers ?? root?.header ?? record(root?.data)?.headers ?? record(root?.data)?.header;
  const hasUnsupportedHeaders = headers !== undefined && headers !== null
    && (typeof headers === "string" ? !!headers.trim()
      : record(headers) ? Object.keys(headers as Record<string, unknown>).length > 0 : true);
  if (hasUnsupportedHeaders) {
    throw new Error("该 TVBox 源返回了播放请求 headers，当前代理无法安全贯通；已拒绝");
  }
  const candidates = [value, root?.url, root?.url1, root?.playUrl, root?.video, record(root?.data)?.url, record(root?.data)?.playUrl];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    try { const url = new URL(candidate); if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password) return url.toString(); } catch { /* next field */ }
  }
  if (candidates.some(candidate => typeof candidate === "string" && /https?:\/\/[^\s/]+:[^\s/@]+@/i.test(candidate))) {
    throw new Error("播放地址包含账号密码，当前不支持");
  }
  throw new Error("TVBox 解析未返回可直接播放的 HTTP(S) 媒体地址");
}

export async function tvboxResolveMedia(source: TVBoxSource, flag: string, id: string): Promise<string> {
  if (isTVBoxJsSource(source)) {
    return mediaUrlFromSpider(await invokeTVBoxSpider(source, "play", [flag, id, []]));
  }
  if (isTVBoxRemoteSource(source)) {
    return mediaUrlFromSpider(await remoteRequest(source, { play: id, flag }));
  }
  throw new Error("当前 TVBox 源不需要远端播放解析");
}

export function tvboxPlaybackSource(raw: string): string {
  const url = new URL(raw);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error("只支持不含账号密码的 HTTP(S) 视频地址");
  return explicitTVBoxMediaKind(url.toString()) === "file"
    ? directMedia(url.toString())
    : playlist(url.toString());
}

function normalizeSourceUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("请输入不含账号密码或片段的 HTTP(S) API 地址");
  }
  return url.toString();
}

function normalizeJsEntry(raw: string, baseUrl = ""): string {
  let url: URL;
  try { url = new URL(raw, baseUrl || undefined); } catch { throw new Error("JS Spider 入口必须是 HTTP(S) 地址"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash || !/\.(?:js|mjs)$/i.test(url.pathname)) {
    throw new Error("仅支持 HTTP(S) .js/.mjs Spider 入口；drpy/JAR/Python 等未知运行器不会执行");
  }
  return url.toString();
}

function normalizeSpiderExt(raw: unknown, baseUrl: string): unknown {
  if (typeof raw !== "string") return raw;
  const value = raw.trim();
  if (!value || /^[\[{]/.test(value)) return raw;
  if (/^https?:\/\//i.test(value) || value.startsWith("./") || value.startsWith("../") || value.startsWith("/")) {
    try {
      const url = new URL(value, baseUrl || undefined);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) return raw;
      return url.toString();
    } catch { return raw; }
  }
  return raw;
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function loadTVBoxSources(): TVBoxSource[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SOURCES_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      const item = record(value);
      if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.url !== "string") return [];
      try {
        const kind = item.kind === "js" || item.kind === "xml" || item.kind === "remote" ? item.kind : undefined;
        const url = kind === "js" ? normalizeJsEntry(item.url) : normalizeSourceUrl(item.url);
        return [{ id: item.id, name: item.name, url,
          ...(kind ? { kind, ...(item.ext === undefined ? {} : { ext: item.ext }),
            ...(kind === "remote" ? { quickSearch: item.quickSearch === true } : {}) } : {}) }];
      } catch { return []; }
    });
  } catch {
    return [];
  }
}

export function activeTVBoxSource(): TVBoxSource | null {
  try {
    const id = localStorage.getItem(ACTIVE_KEY);
    return loadTVBoxSources().find(source => source.id === id) ?? null;
  } catch {
    return null;
  }
}

function saveTVBoxSources(sources: TVBoxSource[]): void {
  localStorage.setItem(SOURCES_KEY, JSON.stringify(sources));
}

export function selectTVBoxSource(id: string | null): void {
  if (id) localStorage.setItem(ACTIVE_KEY, id);
  else localStorage.removeItem(ACTIVE_KEY);
  window.dispatchEvent(new CustomEvent(TVBOX_SOURCE_EVENT, { detail: activeTVBoxSource() }));
}

export function removeTVBoxSource(id: string): void {
  const remaining = loadTVBoxSources().filter(source => source.id !== id);
  saveTVBoxSources(remaining);
  if (localStorage.getItem(ACTIVE_KEY) === id) selectTVBoxSource(remaining[0]?.id ?? null);
  else window.dispatchEvent(new CustomEvent(TVBOX_SOURCE_EVENT, { detail: activeTVBoxSource() }));
}

function tvboxLibraryKey(entry: Pick<TVBoxLibraryEntry, "source" | "video">): string {
  return `${entry.source.id}\u0000${entry.video.id}`;
}

function normalizeLibraryEntry(value: unknown): TVBoxLibraryEntry | null {
  const item = record(value);
  const rawSource = record(item?.source);
  const rawVideo = record(item?.video);
  if (!item || !rawSource || !rawVideo) return null;
  const id = text(rawSource.id);
  const name = text(rawSource.name);
  const rawSourceUrl = text(rawSource.url);
  const videoId = text(rawVideo.id);
  const title = text(rawVideo.title);
  if (!id || !name || !rawSourceUrl || !videoId || !title) return null;
  try {
    const kind = rawSource.kind === "js" || rawSource.kind === "xml" || rawSource.kind === "remote" ? rawSource.kind : undefined;
    const url = kind === "js" ? normalizeJsEntry(rawSourceUrl) : normalizeSourceUrl(rawSourceUrl);
    const source: TVBoxSource = { id, name, url,
      ...(kind ? { kind, ...(rawSource.ext === undefined ? {} : { ext: rawSource.ext }),
        ...(kind === "remote" ? { quickSearch: rawSource.quickSearch === true } : {}) } : {}) };
    const localIdRaw = number(rawVideo.localId, 0);
    const video: TVBoxVideo = {
      id: videoId,
      localId: Number.isSafeInteger(localIdRaw) && localIdRaw > 0 ? localIdRaw : stableLocalId(id, videoId),
      title,
      cover: safeLiveHttpUrl(text(rawVideo.cover), url) || "",
      remarks: text(rawVideo.remarks),
      description: text(rawVideo.description),
      year: text(rawVideo.year),
      area: text(rawVideo.area),
      language: text(rawVideo.language),
      type: text(rawVideo.type),
      actor: text(rawVideo.actor),
      director: text(rawVideo.director),
      score: number(rawVideo.score),
      hot: number(rawVideo.hot),
      status: text(rawVideo.status),
      // Playback URLs are reloaded from the source when the saved item is opened.
      playGroups: [],
    };
    return { source, video, ep: Math.max(0, Math.floor(number(item.ep, 0))),
      t: Math.max(0, number(item.t)), dur: Math.max(0, number(item.dur)),
      updatedAt: Math.max(0, number(item.updatedAt, Date.now())) };
  } catch { return null; }
}

function readTVBoxLibrary(key: string): TVBoxLibraryEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const values: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(values) ? values.flatMap(value => {
      const entry = normalizeLibraryEntry(value);
      return entry ? [entry] : [];
    }) : [];
  } catch { return []; }
}

function writeTVBoxLibrary(key: string, entries: TVBoxLibraryEntry[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(key, JSON.stringify(entries));
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(TVBOX_LIBRARY_EVENT));
}

function makeTVBoxLibraryEntry(source: TVBoxSource, video: TVBoxVideo, ep = 0, t = 0, dur = 0): TVBoxLibraryEntry {
  return { source: { ...source }, video: { ...video, playGroups: [] }, ep, t, dur, updatedAt: Date.now() };
}

export function loadTVBoxFavorites(): TVBoxLibraryEntry[] {
  return readTVBoxLibrary(FAVORITES_KEY);
}

export function loadTVBoxHistory(): TVBoxLibraryEntry[] {
  return readTVBoxLibrary(HISTORY_KEY);
}

export function isTVBoxFavorite(sourceId: string, videoId: string): boolean {
  return loadTVBoxFavorites().some(entry => entry.source.id === sourceId && entry.video.id === videoId);
}

export function toggleTVBoxFavorite(source: TVBoxSource, video: TVBoxVideo): boolean {
  const current = loadTVBoxFavorites();
  const exists = current.some(entry => entry.source.id === source.id && entry.video.id === video.id);
  const next = exists
    ? current.filter(entry => entry.source.id !== source.id || entry.video.id !== video.id)
    : [makeTVBoxLibraryEntry(source, video), ...current].slice(0, 500);
  writeTVBoxLibrary(FAVORITES_KEY, next);
  return !exists;
}

export function addTVBoxHistory(source: TVBoxSource, video: TVBoxVideo, ep: number, t = 0, dur = 0): void {
  const entry = makeTVBoxLibraryEntry(source, video, ep, t, dur);
  const key = tvboxLibraryKey(entry);
  const next = [entry, ...loadTVBoxHistory().filter(item => tvboxLibraryKey(item) !== key)].slice(0, 200);
  writeTVBoxLibrary(HISTORY_KEY, next);
}

export function clearTVBoxHistory(): void {
  writeTVBoxLibrary(HISTORY_KEY, []);
}

function flagEnabled(value: unknown): boolean {
  const wrapped = record(value);
  const raw = wrapped && "value" in wrapped ? wrapped.value : value;
  const normalized = text(raw).toLowerCase();
  return raw === true || raw === 1 || normalized === "1" || normalized === "true" || normalized === "yes";
}

function siteEntries(value: unknown): { name: string; url: string; type: string; ext?: unknown; quickSearch?: boolean }[] {
  const root = record(value) ?? {};
  const data = record(root.data);
  const sites = Array.isArray(root.sites) ? root.sites : Array.isArray(data?.sites) ? data!.sites as unknown[] : [];
  return asArray(sites).flatMap(entry => {
    const site = record(entry);
    const api = site && text(site.api);
    if (!api) return [];
    try { return [{ name: text(site.name ?? site.key) || (/^https?:\/\//i.test(api) ? new URL(api).host : ""),
      url: api, type: text(site.type), ext: site.ext, quickSearch: flagEnabled(site.quickSearch) }]; }
    catch { return []; }
  });
}

/** Parse only the shallow `urls` repository index; entries are never fetched or executed. */
export function parseTVBoxRepositories(value: unknown, baseUrl: string): TVBoxRepository[] {
  const root = record(value);
  const data = record(root?.data);
  const rawUrls = [
    ...(Array.isArray(root?.urls) ? root.urls : []),
    ...(Array.isArray(data?.urls) ? data.urls : []),
  ];
  let base: URL;
  try { base = new URL(baseUrl); } catch { return []; }
  if (base.protocol !== "http:" && base.protocol !== "https:") return [];
  const seen = new Set<string>();
  return rawUrls.flatMap((entry): TVBoxRepository[] => {
    const item = record(entry);
    const raw = item && text(item.url);
    if (!raw) return [];
    try {
      const url = new URL(raw, base);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) return [];
      const normalized = url.toString();
      if (seen.has(normalized)) return [];
      seen.add(normalized);
      return [{ name: text(item.name) || url.host, url: normalized }];
    } catch { return []; }
  }).slice(0, 100);
}

export function parseTVBoxConfig(value: unknown, baseUrl = ""): { sites: Omit<TVBoxSource, "id">[]; spiderSkipped: number } {
  const entries = siteEntries(value);
  const sites = entries.flatMap(site => {
    if (/^csp_/i.test(site.url.trim())) return [];
    try {
      const url = new URL(site.url, baseUrl || undefined).toString();
      if (!site.type || site.type === "1") return [{ name: site.name, url: normalizeSourceUrl(url) }];
      if (site.type === "0") return [{ name: site.name, url: normalizeSourceUrl(url), kind: "xml" as const }];
      if (site.type === "4") return [{ name: site.name, url: normalizeSourceUrl(url), kind: "remote" as const,
        ...(site.ext === undefined ? {} : { ext: normalizeSpiderExt(site.ext, baseUrl) }),
        quickSearch: site.quickSearch === true }];
      if (site.type === "3") {
        const jsUrl = normalizeJsEntry(url);
        return [{ name: site.name, url: jsUrl, kind: "js" as const,
          ...(site.ext === undefined ? {} : { ext: normalizeSpiderExt(site.ext, baseUrl) }) }];
      }
      return [];
    } catch { return []; }
  });
  return {
    sites,
    // Keep the existing result field for callers; it now counts every unsupported/invalid entry type.
    spiderSkipped: entries.length - sites.length,
  };
}

export type TVBoxLiveEntry = { name: string; url: string };

/** Read only live playlist links; type/ua are deliberately not executed or forwarded as code. */
export function parseTVBoxLiveEntries(value: unknown, baseUrl: string): { entries: TVBoxLiveEntry[]; skipped: number; duplicates: number } {
  const root = record(value);
  const data = record(root?.data);
  const rawLives = [
    ...(Array.isArray(root?.lives) ? root.lives : []),
    ...(Array.isArray(data?.lives) ? data.lives : []),
  ];
  const boundedLives = rawLives.slice(0, 50);
  const seen = new Set<string>();
  let skipped = rawLives.length - boundedLives.length;
  let duplicates = 0;
  const entries = boundedLives.flatMap((raw): TVBoxLiveEntry[] => {
    const item = record(raw);
    const rawUrl = item && text(item.url);
    const url = rawUrl ? safeLiveHttpUrl(rawUrl, baseUrl) : "";
    if (!url) {
      skipped += 1;
      return [];
    }
    if (seen.has(url)) {
      duplicates += 1;
      return [];
    }
    seen.add(url);
    return [{ name: text(item?.name) || text(item?.title) || "TVBox 直播源", url }];
  });
  return { entries, skipped, duplicates };
}

function tvboxPlainLiveTextToM3U(rawText: string, baseUrl: string): string {
  const lines = rawText.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const output = ["#EXTM3U"];
  let group = "未分组";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const comma = line.indexOf(",");
    if (comma < 1) continue;
    const name = line.slice(0, comma).trim().replace(/[\r\n]/g, "").slice(0, 160);
    const value = line.slice(comma + 1).trim();
    if (!name || !value) continue;
    if (/#genre#/i.test(value)) {
      group = name;
      continue;
    }
    const safeGroup = group.replace(/[\r\n"]/g, "").slice(0, 120) || "未分组";
    for (const candidate of value.split("#")) {
      const url = safeLiveHttpUrl(candidate.trim(), baseUrl);
      if (!url) continue;
      output.push(`#EXTINF:-1 group-title="${safeGroup}",${name}`, url);
    }
  }
  return output.join("\n");
}

async function importTVBoxLiveSources(value: unknown, baseUrl: string): Promise<{
  sources: LiveSource[];
  imported: number;
  failed: number;
  skipped: number;
}> {
  const parsed = parseTVBoxLiveEntries(value, baseUrl);
  const existingUrls = new Set(loadLiveSources().flatMap(source => source.url ? [source.url] : []));
  const sources: LiveSource[] = [];
  let failed = 0;
  let skipped = parsed.skipped + parsed.duplicates;
  for (const entry of parsed.entries) {
    if (existingUrls.has(entry.url)) {
      skipped += 1;
      continue;
    }
    try {
      const { text: rawText, finalUrl } = await fetchLiveM3U(entry.url);
      const playlistText = /#EXTINF:/i.test(rawText)
        ? rawText
        : tvboxPlainLiveTextToM3U(rawText, finalUrl);
      parseM3U(playlistText, finalUrl);
      const source = importLiveSourceFromText(playlistText, entry.name, finalUrl, entry.url, { preserveActive: true });
      existingUrls.add(entry.url);
      sources.push(source);
    } catch {
      // A bad live playlist must never make the TVBox VOD import fail; report only a count.
      failed += 1;
    }
  }
  return { sources, imported: sources.length, failed, skipped };
}

/** Import a TVBox config JSON, including XML/JSON/Remote APIs and bounded HTTP(S) JS/MJS Spiders. */
export async function importTVBoxSources(rawUrl: string, fallbackName = ""): Promise<{
  sources: TVBoxSource[];
  spiderSkipped: number;
  repositories?: TVBoxRepository[];
  liveSources: LiveSource[];
  liveImported: number;
  liveFailed: number;
  liveSkipped: number;
}> {
  const url = normalizeSourceUrl(rawUrl);
  const raw = await fetchTVBoxJson(url);
  const root = record(raw);
  const data = record(root?.data);
  const hasLiveEntries = [root?.lives, data?.lives].some(value => Array.isArray(value) && value.length > 0);
  const live = await importTVBoxLiveSources(raw, url);
  const liveResult = { liveSources: live.sources, liveImported: live.imported, liveFailed: live.failed, liveSkipped: live.skipped };
  const repositories = parseTVBoxRepositories(raw, url);
  if (repositories.length) return { sources: [], spiderSkipped: 0, repositories, ...liveResult };
  const config = parseTVBoxConfig(raw, url);
  const spiderSkipped = config.spiderSkipped;
  let candidates = config.sites;
  const hasSites = Array.isArray(root?.sites) || Array.isArray(data?.sites);
  if (hasSites && !candidates.length) {
    if (hasLiveEntries) return { sources: [], spiderSkipped, ...liveResult };
    throw new Error("该配置没有可支持的 XML/JSON/Remote API 或 catvod JS 入口；JAR/Python 等未知运行器不会执行");
  }
  if (!candidates.length && hasLiveEntries) return { sources: [], spiderSkipped, ...liveResult };
  if (!candidates.length) {
    const direct: TVBoxSource = { id: randomId(), name: fallbackName.trim() || new URL(url).host, url };
    // Verify the endpoint uses the standard JSON list contract, without requiring content to exist.
    await tvboxList(direct, 1);
    candidates = [{ name: direct.name, url: direct.url }];
  }
  const existing = loadTVBoxSources();
  const stableExt = (value: unknown): string => {
    if (value === undefined) return "";
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  const sourceKey = (source: Pick<TVBoxSource, "kind" | "url" | "ext" | "quickSearch">): string =>
    `${source.kind || "api"}:${source.url}:${stableExt(source.ext)}:${source.quickSearch ? "quick" : "normal"}`;
  const seen = new Set(existing.map(sourceKey));
  const added = candidates.flatMap(candidate => {
    try {
      const kind = candidate.kind;
      const normalized = kind === "js" ? normalizeJsEntry(candidate.url) : normalizeSourceUrl(candidate.url);
      const quickSearch = kind === "remote" && candidate.quickSearch === true;
      const key = sourceKey({ kind, url: normalized, ext: candidate.ext, quickSearch });
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ id: randomId(), name: candidate.name.trim() || new URL(normalized).host, url: normalized,
        ...(kind ? { kind, ...(candidate.ext === undefined ? {} : { ext: candidate.ext }),
          ...(kind === "remote" ? { quickSearch } : {}) } : {}) }];
    } catch { return []; }
  });
  if (!added.length) {
    if (hasLiveEntries) return { sources: [], spiderSkipped, ...liveResult };
    throw new Error("没有找到新的 XML/JSON/Remote API 或 HTTP(S) JS/MJS Spider 源");
  }
  const next = [...existing, ...added];
  saveTVBoxSources(next);
  if (!activeTVBoxSource()) selectTVBoxSource(added[0].id);
  else window.dispatchEvent(new CustomEvent(TVBOX_SOURCE_EVENT, { detail: activeTVBoxSource() }));
  return { sources: added, spiderSkipped, ...liveResult };
}
