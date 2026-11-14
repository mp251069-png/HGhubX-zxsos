import { invoke } from "@tauri-apps/api/core";
import { cover, directMedia, playlist } from "./api";
import type { Detail, Episode, VideoCard } from "./types";

const SOURCES_KEY = "hghubx_tvbox_sources_v1";
const ACTIVE_KEY = "hghubx_tvbox_active_v1";
export const TVBOX_SOURCE_EVENT = "hghubx:tvbox-source-changed";

export type TVBoxSource = { id: string; name: string; url: string };
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
  actor: string;
  director: string;
  score: number;
  status: string;
  playGroups: TVBoxPlayGroup[];
};
export type TVBoxVideo = TVBoxVod & { localId: number };
export type TVBoxPage = {
  items: TVBoxVideo[];
  categories: TVBoxCategory[];
  page: number;
  pages: number;
  total: number;
};

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
  if (!valid) throw new Error("不是受支持的标准 JSON API 响应：必须包含 list、vod 或 class 数组；Spider/脚本源暂不支持");
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
      const url = resolvedUrl(rawUrl, mediaBase);
      if (!url) return [];
      const name = separator >= 0 ? part.slice(0, separator).trim() : `第 ${episodeIndex + 1} 集`;
      return [{ name: name || `第 ${episodeIndex + 1} 集`, url }];
    });
    return { name: playFrom[index]?.trim() || `线路 ${index + 1}`, episodes };
  }).filter(group => group.episodes.length > 0);
  const rawScore = text(item.vod_score).replace(/[^\d.]/g, "");
  return {
    id,
    title,
    cover: resolvedUrl(text(item.vod_pic ?? item.pic ?? item.cover), mediaBase),
    remarks: text(item.vod_remarks ?? item.remarks ?? item.vod_serial),
    description: text(item.vod_content ?? item.vod_blurb ?? item.content ?? item.desc),
    year: text(item.vod_year),
    area: text(item.vod_area),
    language: text(item.vod_lang),
    actor: text(item.vod_actor),
    director: text(item.vod_director),
    score: number(rawScore),
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
    cover: video.cover ? cover(video.cover) : "",
    description: video.description,
    tags,
    score: video.score,
    episode_count: episodeCount,
    total_episodes: episodeCount,
    duration: video.remarks,
    hot: 0,
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
    cover: video.cover,
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

export async function tvboxList(source: TVBoxSource, page = 1, category = ""): Promise<TVBoxPage> {
  const data = await fetchTVBoxJson(buildTVBoxApiUrl(source, { ac: "list", pg: Math.max(1, page), t: category || undefined }));
  assertTVBoxApiPayload(data);
  return parseTVBoxPage(data, source);
}

export async function tvboxSearch(source: TVBoxSource, keyword: string, page = 1, category = ""): Promise<TVBoxPage> {
  const data = await fetchTVBoxJson(buildTVBoxApiUrl(source, { ac: "list", pg: Math.max(1, page), t: category || undefined, wd: keyword || undefined }));
  assertTVBoxApiPayload(data);
  return parseTVBoxPage(data, source);
}

export async function tvboxDetail(source: TVBoxSource, vodId: string): Promise<TVBoxVod> {
  const data = await fetchTVBoxJson(buildTVBoxApiUrl(source, { ac: "detail", ids: vodId }));
  assertTVBoxApiPayload(data);
  const raw = listFrom(data)[0] ?? record(payloadRoot(data))?.vod ?? null;
  const video = normalizeVod(raw, source);
  if (!video) throw new Error("TVBox 源没有返回有效影片详情");
  return video;
}

/** Prefer explicit media over embedded player pages; no source code or parser is run. */
export function preferredTVBoxLine(video: TVBoxVod | undefined): number {
  const groups = video?.playGroups ?? [];
  const direct = groups.findIndex(group => {
    const raw = group.episodes[0]?.url;
    if (!raw) return false;
    try {
      const url = new URL(raw);
      return /\.(?:m3u8|mp4|m4v|mov|webm)$/i.test(url.pathname)
        || ["format", "type", "mime"].some(key => /^(?:m3u8|hls|mp4|m4v|video\/mp4|application\/(?:vnd\.apple\.mpegurl|x-mpegurl))$/i.test(url.searchParams.get(key) ?? ""));
    } catch { return false; }
  });
  if (direct >= 0) return direct;
  const hinted = groups.findIndex(group => /m3u8|hls|mp4/i.test(group.name) && group.episodes.length > 0);
  return hinted >= 0 ? hinted : 0;
}

export function tvboxMediaUrl(video: TVBoxVod | undefined, episode: number, groupIndex = 0): string {
  const group = video?.playGroups[groupIndex] ?? video?.playGroups[0];
  const entry = group?.episodes[episode - 1];
  if (!entry) throw new Error("该集没有可直接播放的 HTTP(S) 地址；需要解析器的源暂不支持");
  const url = new URL(entry.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只支持 HTTP(S) 视频地址");
  return url.toString();
}

/** Build a local player URL: direct MP4-family files use /seg; HLS (including
 * extensionless playlist endpoints) stays on /hls so nested playlists are rewritten. */
export function tvboxPlaybackSource(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只支持 HTTP(S) 视频地址");
  const path = url.pathname.toLowerCase();
  const declaredMp4 = ["format", "type", "mime"].some(key => {
    const value = (url.searchParams.get(key) ?? "").toLowerCase();
    return value === "mp4" || value === "video/mp4" || value === "m4v";
  });
  return /\.(?:mp4|m4v|mov|webm)$/.test(path) || declaredMp4
    ? directMedia(url.toString())
    : playlist(url.toString());
}

function normalizeSourceUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("请输入不含账号密码或片段的 HTTP(S) JSON/API 地址");
  }
  return url.toString();
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
      try { return [{ id: item.id, name: item.name, url: normalizeSourceUrl(item.url) }]; } catch { return []; }
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

function siteEntries(value: unknown): { name: string; url: string; type: string }[] {
  const root = record(value) ?? {};
  const data = record(root.data);
  const sites = Array.isArray(root.sites) ? root.sites : Array.isArray(data?.sites) ? data!.sites as unknown[] : [];
  return asArray(sites).flatMap(entry => {
    const site = record(entry);
    const api = site && text(site.api);
    if (!api) return [];
    try { return [{ name: text(site.name ?? site.key) || (/^https?:\/\//i.test(api) ? new URL(api).host : ""), url: api, type: text(site.type) }]; }
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

export function parseTVBoxConfig(value: unknown): { sites: { name: string; url: string }[]; spiderSkipped: number } {
  const entries = siteEntries(value);
  const sites = entries.filter(site => /^https?:\/\//i.test(site.url) && !/csp_|spider|\.(?:js|mjs|py|jar)(?:$|[?#])/i.test(site.url)
    && (!site.type || site.type === "1"));
  return {
    sites: sites.map(({ name, url }) => ({ name, url })),
    spiderSkipped: entries.length - sites.length,
  };
}

/** Import a TVBox config JSON by adding only HTTP(S) API sites; Spider entries are skipped. */
export async function importTVBoxSources(rawUrl: string, fallbackName = ""): Promise<{ sources: TVBoxSource[]; spiderSkipped: number; repositories?: TVBoxRepository[] }> {
  const url = normalizeSourceUrl(rawUrl);
  const raw = await fetchTVBoxJson(url);
  const repositories = parseTVBoxRepositories(raw, url);
  if (repositories.length) return { sources: [], spiderSkipped: 0, repositories };
  const config = parseTVBoxConfig(raw);
  const spiderSkipped = config.spiderSkipped;
  let candidates = config.sites;
  const root = record(raw);
  const data = record(root?.data);
  const hasSites = Array.isArray(root?.sites) || Array.isArray(data?.sites);
  if (hasSites && !candidates.length) {
    throw new Error("该配置没有标准 JSON API；Spider、JS、Python、JAR 及 XML 源当前不支持，不会执行脚本");
  }
  if (!candidates.length) {
    const direct: TVBoxSource = { id: randomId(), name: fallbackName.trim() || new URL(url).host, url };
    // Verify the endpoint uses the standard JSON list contract, without requiring content to exist.
    await tvboxList(direct, 1);
    candidates = [{ name: direct.name, url: direct.url }];
  }
  const existing = loadTVBoxSources();
  const seen = new Set(existing.map(source => source.url));
  const added = candidates.flatMap(candidate => {
    try {
      const normalized = normalizeSourceUrl(candidate.url);
      if (seen.has(normalized)) return [];
      seen.add(normalized);
      return [{ id: randomId(), name: candidate.name.trim() || new URL(normalized).host, url: normalized }];
    } catch { return []; }
  });
  if (!added.length) throw new Error("没有找到新的标准 JSON API 源；JS Spider 不会被导入");
  const next = [...existing, ...added];
  saveTVBoxSources(next);
  if (!activeTVBoxSource()) selectTVBoxSource(added[0].id);
  else window.dispatchEvent(new CustomEvent(TVBOX_SOURCE_EVENT, { detail: activeTVBoxSource() }));
  return { sources: added, spiderSkipped };
}
