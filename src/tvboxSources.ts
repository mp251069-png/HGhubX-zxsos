import { invoke } from "@tauri-apps/api/core";

export type TvboxSource = {
  key: string;
  name: string;
  api: string;
  type: number;
  searchable: number;
  filterable: number;
  quickSearch: number;
  ext?: string;
};
export type TvboxParser = { name: string; url: string; type?: number };
export type TvboxRepository = { name: string; url: string };
export type TvboxLibrary = { sources: TvboxSource[]; parsers: TvboxParser[]; repositories?: TvboxRepository[] };
export type TvboxCategory = { id: string; name: string };
export type TvboxVideo = {
  id: string; name: string; pic: string; note: string; year: string; area: string;
  typeName: string; director: string; actor: string; description: string;
};
export type TvboxEpisode = { name: string; url: string; flag: string };
export type TvboxDetail = { video: TvboxVideo; flags: string[]; episodes: Record<string, TvboxEpisode[]> };

const LIBRARY_KEY = "hghubx.tvbox.library.v1";
export const readTvboxLibrary = (): TvboxLibrary => {
  try {
    const value = JSON.parse(localStorage.getItem(LIBRARY_KEY) || "{}");
    return {
      sources: Array.isArray(value.sources) ? value.sources : [],
      parsers: Array.isArray(value.parsers) ? value.parsers : [],
    };
  } catch { return { sources: [], parsers: [] }; }
};
export const writeTvboxLibrary = (library: TvboxLibrary) => {
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
};
export const fetchTvboxText = (url: string) => invoke<string>("tvbox_fetch_text", { url });

function stripJsonComments(input: string): string {
  let out = "";
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];
    if (quoted) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; out += ch; continue; }
    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  // Remove trailing commas without altering quoted strings.
  let clean = "";
  quoted = false; escaped = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (quoted) {
      clean += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') { quoted = true; clean += ch; }
    else if (ch === ",") {
      let j = i + 1;
      while (/\s/.test(out[j] || "")) j++;
      if (out[j] !== "]" && out[j] !== "}") clean += ch;
    } else clean += ch;
  }
  return clean;
}
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const stringValue = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : "";
const sourceListFrom = (root: unknown): unknown[] => {
  if (Array.isArray(root)) return root;
  const obj = asRecord(root);
  if (!obj) return [];
  for (const key of ["sites", "sources", "site", "source"]) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  const data = asRecord(obj.data);
  if (data) for (const key of ["sites", "sources", "site"]) if (Array.isArray(data[key])) return data[key] as unknown[];
  return obj.api && (obj.name || obj.key) ? [obj] : [];
};
const parserListFrom = (root: unknown): TvboxParser[] => {
  const obj = asRecord(root);
  const raw = obj?.parses;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item, index) => {
    const parser = asRecord(item);
    if (!parser) return [];
    const url = stringValue(parser.url).trim();
    if (!validHttpUrl(url)) return [];
    return [{ name: stringValue(parser.name) || `解析 ${index + 1}`, url, type: Number(parser.type) || 0 }];
  });
};
const repositoryListFrom = (root: unknown, baseUrl?: string): TvboxRepository[] => {
  const obj = asRecord(root);
  if (!Array.isArray(obj?.urls)) return [];
  return obj.urls.flatMap((item, index) => {
    const repository = asRecord(item);
    if (!repository) return [];
    const rawUrl = stringValue(repository.url).trim();
    let url = rawUrl;
    if (!validHttpUrl(url) && baseUrl) { try { url = new URL(rawUrl, baseUrl).toString(); } catch { /* ignore invalid relative URL */ } }
    return validHttpUrl(url) ? [{ name: stringValue(repository.name) || `仓库 ${index + 1}`, url }] : [];
  });
};
const validHttpUrl = (text: string) => {
  try { const u = new URL(text); return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname && !u.username && !u.password; }
  catch { return false; }
};

export function parseTvboxConfig(text: string, baseUrl?: string): TvboxLibrary {
  const root = JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, ""))) as unknown;
  const sources = sourceListFrom(root).flatMap((value, index) => {
    const item = asRecord(value);
    if (!item) return [];
    const api = stringValue(item.api ?? item.url).trim();
    if (!validHttpUrl(api)) return [];
    const type = Number(item.type ?? 1);
    if (![0, 1, 3, 4].includes(type)) return [];
    const extValue = item.ext;
    const ext = typeof extValue === "string" ? extValue : extValue == null ? undefined : JSON.stringify(extValue);
    const key = stringValue(item.key) || `${api}#${index}`;
    return [{
      key, name: stringValue(item.name) || `源 ${index + 1}`, api, type,
      searchable: Number(item.searchable ?? 1), filterable: Number(item.filterable ?? 1),
      quickSearch: Number(item.quickSearch ?? item.quicksearch ?? 0), ext,
    } satisfies TvboxSource];
  });
  return { sources, parsers: parserListFrom(root), repositories: repositoryListFrom(root, baseUrl) };
}

export function makeSource(name: string, api: string, type: number): TvboxSource {
  const normalized = api.trim();
  if (!name.trim()) throw new Error("请填写源名称");
  if (!validHttpUrl(normalized)) throw new Error("接口必须是有效的 HTTP(S) 地址");
  if (![0, 1, 3, 4].includes(type)) throw new Error("仅接受 TVBox type 0/1/3/4");
  return { key: `${normalized}#${Date.now()}`, name: name.trim(), api: normalized, type, searchable: 1, filterable: 1, quickSearch: 0 };
}

export function sourceTypeLabel(type: number) {
  return ({ 0: "XML", 1: "JSON", 3: "Spider/JAR", 4: "Remote" } as Record<number, string>)[type] || `type=${type}`;
}

function buildUrl(source: TvboxSource, values: Record<string, string>) {
  const url = new URL(source.api);
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return url.toString();
}
async function resolvedExt(source: TvboxSource): Promise<string> {
  const ext = source.ext?.trim() || "";
  if (!/^https?:\/\//i.test(ext)) return ext;
  try {
    const text = (await fetchTvboxText(ext)).trim();
    return text.length <= 2500 ? text : ext;
  } catch { return ext; }
}
function encodeBase64Utf8(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function requestUrl(source: TvboxSource, action: "class" | "list" | "detail" | "search", options: { category?: string; page?: number; id?: string; query?: string; ext?: string } = {}) {
  const { category = "", page = 1, id = "", query = "", ext = "" } = options;
  if (source.type === 0) {
    if (action === "class") return buildUrl(source, {});
    if (action === "list") return buildUrl(source, { ac: "videolist", t: category, pg: String(page) });
    if (action === "detail") return buildUrl(source, { ac: "videolist", ids: id });
    return buildUrl(source, { wd: query });
  }
  if (source.type === 4) {
    if (action === "class") return buildUrl(source, { filter: "true", ...(ext ? { extend: ext } : {}) });
    if (action === "list") return buildUrl(source, { ac: "detail", filter: "true", t: category, pg: String(page), ext: encodeBase64Utf8("{}"), ...(ext ? { extend: ext } : {}) });
    if (action === "detail") return buildUrl(source, { ac: "detail", ids: id, ...(ext ? { extend: ext } : {}) });
    return buildUrl(source, { wd: query, ac: "detail", quick: source.quickSearch ? "true" : "false", ...(ext ? { extend: ext } : {}) });
  }
  if (action === "class") return buildUrl(source, { ac: "class" });
  if (action === "list") return buildUrl(source, { ac: "videolist", t: category, pg: String(page) });
  if (action === "detail") return buildUrl(source, { ac: "detail", ids: id });
  return buildUrl(source, { wd: query });
}

function jsonRoot(text: string): Record<string, unknown> {
  const value = JSON.parse(text) as unknown;
  const root = asRecord(value);
  if (!root) throw new Error("源站返回的 JSON 不是对象");
  return root;
}
function xmlDocument(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("源站 XML 格式错误");
  return doc;
}
const xmlText = (node: Element, tag: string) => node.getElementsByTagName(tag)[0]?.textContent?.trim() || "";
const field = (obj: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) if (obj[key] != null) return stringValue(obj[key]).trim();
  return "";
};
export function parseTvboxCategories(text: string, type: number): TvboxCategory[] {
  if (type === 0) {
    const doc = xmlDocument(text);
    return Array.from(doc.getElementsByTagName("ty"), (node) => ({ id: node.getAttribute("id") || "", name: node.textContent?.trim() || "" })).filter((x) => x.id && x.name);
  }
  const root = jsonRoot(text);
  const data = asRecord(root.data) || root;
  const list = Array.isArray(data.class) ? data.class : [];
  return list.flatMap((value) => {
    const item = asRecord(value); if (!item) return [];
    const id = field(item, "type_id", "id"); const name = field(item, "type_name", "name");
    return id && name ? [{ id, name }] : [];
  });
}
export function parseTvboxVideos(text: string, type: number): TvboxVideo[] {
  if (type === 0) {
    const doc = xmlDocument(text);
    return Array.from(doc.getElementsByTagName("video"), (node) => ({
      id: xmlText(node, "id"), name: xmlText(node, "name"), pic: xmlText(node, "pic"), note: xmlText(node, "note"),
      year: xmlText(node, "year"), area: xmlText(node, "area"), typeName: xmlText(node, "type"),
      director: xmlText(node, "director"), actor: xmlText(node, "actor"), description: xmlText(node, "des"),
    })).filter((video) => video.id && video.name);
  }
  const root = jsonRoot(text);
  const data = asRecord(root.data) || root;
  const list = Array.isArray(data.list) ? data.list : [];
  return list.flatMap((value) => {
    const item = asRecord(value); if (!item) return [];
    const video = {
      id: field(item, "vod_id", "id"), name: field(item, "vod_name", "name"), pic: field(item, "vod_pic", "pic"),
      note: field(item, "vod_remarks", "note"), year: field(item, "vod_year", "year"), area: field(item, "vod_area", "area"),
      typeName: field(item, "type_name", "type"), director: field(item, "vod_director", "director"),
      actor: field(item, "vod_actor", "actor"), description: field(item, "vod_content", "des", "description"),
    };
    return video.id && video.name ? [video] : [];
  });
}
const decodeXml = (text: string) => text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
export function parseTvboxDetail(text: string, source: TvboxSource, fallback: TvboxVideo): TvboxDetail {
  let raw: Record<string, unknown> | null = null;
  let flagsText = ""; let urlsText = "";
  if (source.type === 0) {
    const doc = xmlDocument(text);
    const node = doc.getElementsByTagName("video")[0];
    if (node) {
      raw = {};
      for (const tag of ["id", "name", "pic", "note", "year", "area", "type", "director", "actor", "des"]) (raw as Record<string, unknown>)[tag] = xmlText(node, tag);
      const dd = Array.from(node.getElementsByTagName("dd"));
      flagsText = dd.map((entry, i) => entry.getAttribute("flag") || `线路${i + 1}`).join("$$$");
      urlsText = dd.map((entry) => decodeXml(entry.textContent || "").trim()).join("$$$");
    }
  } else {
    const root = jsonRoot(text); const data = asRecord(root.data) || root;
    const list = Array.isArray(data.list) ? data.list : [];
    raw = asRecord(list[0]);
    flagsText = field(raw || {}, "vod_play_from"); urlsText = field(raw || {}, "vod_play_url");
  }
  const video = raw ? {
    id: field(raw, "vod_id", "id") || fallback.id, name: field(raw, "vod_name", "name") || fallback.name,
    pic: field(raw, "vod_pic", "pic") || fallback.pic, note: field(raw, "vod_remarks", "note") || fallback.note,
    year: field(raw, "vod_year", "year") || fallback.year, area: field(raw, "vod_area", "area") || fallback.area,
    typeName: field(raw, "type_name", "type") || fallback.typeName, director: field(raw, "vod_director", "director") || fallback.director,
    actor: field(raw, "vod_actor", "actor") || fallback.actor, description: field(raw, "vod_content", "des", "description") || fallback.description,
  } : fallback;
  const flags = flagsText.split("$$$").filter(Boolean);
  const streams = urlsText.split("$$$");
  const episodes: Record<string, TvboxEpisode[]> = {};
  flags.forEach((flag, index) => {
    episodes[flag] = (streams[index] || "").split("#").flatMap((chunk, episodeIndex) => {
      const separator = chunk.indexOf("$");
      if (separator < 0) return [];
      const name = chunk.slice(0, separator).trim() || `第 ${episodeIndex + 1} 集`;
      const url = chunk.slice(separator + 1).trim();
      return url ? [{ name, url, flag }] : [];
    });
  });
  return { video, flags, episodes };
}
export async function tvboxCategories(source: TvboxSource): Promise<TvboxCategory[]> {
  if (source.type === 3) throw new Error("此源使用 Spider/JAR；HGhubX 当前未集成 Java Spider 运行时");
  const ext = source.type === 4 ? await resolvedExt(source) : "";
  const text = await fetchTvboxText(requestUrl(source, "class", { ext }));
  return parseTvboxCategories(text, source.type);
}
export async function tvboxList(source: TvboxSource, category = "", page = 1): Promise<TvboxVideo[]> {
  if (source.type === 3) throw new Error("Spider/JAR 源需要 Java Spider 运行时，当前版本不支持");
  const ext = source.type === 4 ? await resolvedExt(source) : "";
  const text = await fetchTvboxText(requestUrl(source, "list", { category, page, ext }));
  return parseTvboxVideos(text, source.type);
}
export async function tvboxSearch(source: TvboxSource, query: string): Promise<TvboxVideo[]> {
  if (source.type === 3) throw new Error("Spider/JAR 源需要 Java Spider 运行时，当前版本不支持");
  const ext = source.type === 4 ? await resolvedExt(source) : "";
  const text = await fetchTvboxText(requestUrl(source, "search", { query, ext }));
  return parseTvboxVideos(text, source.type);
}
export async function tvboxDetail(source: TvboxSource, video: TvboxVideo): Promise<TvboxDetail> {
  if (source.type === 3) throw new Error("Spider/JAR 源需要 Java Spider 运行时，当前版本不支持");
  const ext = source.type === 4 ? await resolvedExt(source) : "";
  const text = await fetchTvboxText(requestUrl(source, "detail", { id: video.id, ext }));
  return parseTvboxDetail(text, source, video);
}

async function resolveRemotePlay(source: TvboxSource, episode: TvboxEpisode): Promise<string> {
  const ext = await resolvedExt(source);
  const request = buildUrl(source, { play: episode.url, flag: episode.flag, ...(ext ? { extend: ext } : {}) });
  const response = jsonRoot(await fetchTvboxText(request));
  const flag = (value: unknown) => value === true || value === 1 || ["1", "true", "yes"].includes(stringValue(value).toLowerCase());
  if (flag(response.parse) || flag(response.jx)) throw new Error("Remote 源要求 parse/jx 解析器；当前只接受直接播放链接。");
  const header = response.header;
  if (header && (typeof header !== "object" || Object.keys(header as object).length > 0)) {
    throw new Error("Remote 源的播放链接依赖自定义请求头，当前播放器无法安全传递。");
  }
  const data = asRecord(response.data);
  const url = stringValue(response.url ?? data?.url).trim();
  if (!validHttpUrl(url)) throw new Error("Remote play 接口没有返回有效 HTTP(S) url。");
  return url;
}

function unescapeUrl(value: string) {
  // Keep percent-encoded path/query bytes intact: CDN signatures often depend on them.
  // URLSearchParams decodes nested player query parameters exactly once when unwrapped.
  return value.trim().replace(/&amp;/g, "&").replace(/\\\//g, "/");
}
function unwrapPlayUrl(raw: string): string {
  let current = unescapeUrl(raw);
  for (let depth = 0; depth < 3; depth++) {
    if (!validHttpUrl(current)) break;
    const url = new URL(current);
    const nested = ["url", "play", "vid", "v"].map((key) => url.searchParams.get(key)).find((value) => value && validHttpUrl(unescapeUrl(value)));
    if (!nested) break;
    current = unescapeUrl(nested);
  }
  return current;
}
const PLAYABLE_PATTERN = /\.(?:m3u8?|mp4|m4v|mpd|flv|mov|webm|ts)(?:[?#]|$)/i;
function extractPlayableText(text: string): string | null {
  try {
    const obj = asRecord(JSON.parse(text));
    if (obj) {
      const data = asRecord(obj.data);
      for (const value of [obj.url, obj.src, obj.playUrl, data?.url, data?.src, data?.playUrl]) {
        const candidate = unescapeUrl(stringValue(value));
        if (validHttpUrl(candidate)) return candidate;
      }
    }
  } catch { /* parser may return plain text or HTML */ }
  const html = new DOMParser().parseFromString(text, "text/html");
  const candidate = html.querySelector("video[src], source[src], meta[property='og:video']")?.getAttribute("src")
    || html.querySelector("meta[property='og:video']")?.getAttribute("content");
  if (candidate && validHttpUrl(candidate)) return candidate;
  const matches = text.match(/https?:\\?\/\\?\/[^\s"'<>\\]+/g) || [];
  return matches.map((value) => unescapeUrl(value.replace(/\\\//g, "/").replace(/[),;]+$/, ""))).find((value) => validHttpUrl(value) && PLAYABLE_PATTERN.test(value)) || null;
}
export async function resolveTvboxPlayback(episode: TvboxEpisode, source: TvboxSource, parsers: TvboxParser[] = []): Promise<string> {
  const raw = source.type === 4 && !validHttpUrl(episode.url) ? await resolveRemotePlay(source, episode) : episode.url;
  const direct = unwrapPlayUrl(raw);
  if (!validHttpUrl(direct)) throw new Error("剧集地址不是有效 HTTP(S) 媒体链接");
  if (PLAYABLE_PATTERN.test(direct)) return direct;

  // Some CMS providers return a lightweight HTML player wrapper. Try extracting
  // a direct stream URL without evaluating scripts or executing site code.
  if (/\.html?(?:[?#]|$)/i.test(new URL(direct).pathname) || /(?:^|\.)player\./i.test(new URL(direct).hostname)) {
    try {
      const extracted = extractPlayableText(await fetchTvboxText(direct));
      if (extracted) return unwrapPlayUrl(extracted);
    } catch { /* Fall through to configured parser endpoints. */ }
  }

  for (const parser of parsers.slice(0, 5)) {
    try {
      const endpoint = new URL(parser.url);
      endpoint.searchParams.set("url", direct);
      if (parser.type != null && !endpoint.searchParams.has("type")) endpoint.searchParams.set("type", String(parser.type));
      const resolved = extractPlayableText(await fetchTvboxText(endpoint.toString()));
      if (resolved) return unwrapPlayUrl(resolved);
    } catch { /* Try next configured parser; no scripts are evaluated. */ }
  }
  // Opaque direct links are still accepted: the existing HLS/byte-range proxy
  // can play media endpoints even when they do not expose a filename extension.
  return direct;
}
