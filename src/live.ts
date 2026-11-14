import { invoke } from "@tauri-apps/api/core";
import { cover, directMedia, isLocalMedia, playlist } from "./api";

export const LIVE_SOURCES_KEY = "hghubx_live_sources_v1";
export const LIVE_ACTIVE_KEY = "hghubx_live_active_v1";
export const LIVE_FAVS_KEY = "hghubx_live_favs_v1";
export const LIVE_SOURCE_EVENT = "hghubx:live-source-change";
export const LIVE_FAVS_EVENT = "hghubx:live-favs-change";

export interface LiveChannelHeaders {
  referer?: string;
  userAgent?: string;
}

export interface LiveChannel {
  id: string;
  name: string;
  url: string;
  group: string;
  logo?: string;
  tvgId?: string;
  tvgName?: string;
  headers?: LiveChannelHeaders;
}

export interface LiveSource {
  id: string;
  name: string;
  url?: string;
  channels: LiveChannel[];
  groups: string[];
  updatedAt?: number;
  skippedUnsafe?: number;
}

export interface LiveParseResult {
  channels: LiveChannel[];
  groups: string[];
  skippedUnsafe: number;
}

const DIRECT_VIDEO_RE = /\.(mp4|webm|mov|m4v|ts|mts|m2ts|flv|mpeg|mpg|mkv|avi|ogg|ogv)(?:$|[?#])/i;
const UNSUPPORTED_DIRECT_VIDEO_RE = /\.(ts|mts|m2ts|flv|mpeg|mpg|mkv|avi|ogg|ogv)(?:$|[?#])/i;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const textOf = (value: unknown) =>
  typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";

const notifyLiveSources = (detail?: unknown) => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(LIVE_SOURCE_EVENT, { detail }));
  }
};

const notifyLiveFavs = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LIVE_FAVS_EVENT));
};

/**
 * Only allow http: and https: URLs without embedded credentials.
 * Rejects javascript:, file:, data:, rtmp:, rtsp:, udp:, blob:, etc.
 */
export const safeLiveHttpUrl = (raw: unknown, baseUrl = ""): string => {
  const value = textOf(raw);
  if (!value) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) && !/^https?:\/\//i.test(value)) {
    return "";
  }
  try {
    const parsed = baseUrl ? new URL(value, baseUrl) : new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (parsed.username || parsed.password) return "";
    return parsed.toString();
  } catch {
    return "";
  }
};

export const safeLiveReferer = (raw: unknown, baseUrl = ""): string => {
  const url = safeLiveHttpUrl(raw, baseUrl);
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.origin && parsed.origin !== "null" ? `${parsed.origin}/` : "";
  } catch {
    return "";
  }
};

const hashText = (input: string) => {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const splitExtinfLine = (line: string): { attrPart: string; title: string } => {
  const body = line.replace(/^#EXTINF:/i, "").trim();
  let inQuotes: '"' | "'" | null = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inQuotes) {
      if (ch === inQuotes && body[i - 1] !== "\\") {
        inQuotes = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuotes = ch;
      continue;
    }
    if (ch === ",") {
      return {
        attrPart: body.slice(0, i).trim(),
        title: body.slice(i + 1).trim(),
      };
    }
  }
  return { attrPart: body, title: "" };
};

const parseExtinfAttributes = (attrPart: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  const regex = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g;
  let match: RegExpExecArray | null = regex.exec(attrPart);
  while (match) {
    const key = match[1].toLowerCase();
    const val = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    attrs[key] = val;
    match = regex.exec(attrPart);
  }
  return attrs;
};

const applyHeaderOption = (headers: LiveChannelHeaders, rawKey: string, rawVal: string, baseUrl: string) => {
  const key = rawKey.trim().toLowerCase();
  const val = rawVal.trim().replace(/^["']|["']$/g, "");
  if (!val) return;
  if (key === "http-referrer" || key === "http-referer" || key === "referer" || key === "referrer" || key === "tvg-referer") {
    const ref = safeLiveReferer(val, baseUrl) || safeLiveHttpUrl(val, baseUrl);
    if (ref) headers.referer = ref;
  } else if (key === "http-user-agent" || key === "user-agent" || key === "tvg-user-agent" || key === "user_agent") {
    headers.userAgent = val.slice(0, 240);
  }
};

const parseHeaderKvString = (input: string, headers: LiveChannelHeaders, baseUrl: string) => {
  for (const part of input.split("&")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex <= 0) continue;
    const k = part.slice(0, eqIndex);
    let v = part.slice(eqIndex + 1);
    try {
      v = decodeURIComponent(v);
    } catch {
      /* keep raw value if not percent-encoded */
    }
    applyHeaderOption(headers, k, v, baseUrl);
  }
};

const splitPipeHeaders = (rawLine: string, headers: LiveChannelHeaders, baseUrl: string): string => {
  const pipeIndex = rawLine.indexOf("|");
  if (pipeIndex < 0) return rawLine.trim();
  const urlPart = rawLine.slice(0, pipeIndex).trim();
  const headerPart = rawLine.slice(pipeIndex + 1).trim();
  if (headerPart) {
    parseHeaderKvString(headerPart, headers, baseUrl);
  }
  return urlPart;
};

const looksLikeUnsupportedEncryptedOrNonM3U = (trimmed: string): string | null => {
  if (!trimmed) return "M3U 内容为空";
  if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return "响应是网页 HTML，不是有效的 Extended M3U 播放列表";
  }
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return "仅支持通用 Extended M3U（.m3u/.m3u8）订阅，不支持 JSON 或私有配置";
  }
  if (/^aptv:\/\//i.test(trimmed) || /^[A-Za-z0-9+/=]{64,}$/.test(trimmed.replace(/\s+/g, ""))) {
    return "不支持 APTV 私有加密配置，请导入通用 Extended M3U（.m3u/.m3u8）订阅或明文列表";
  }
  return null;
};

export const parseM3U = (rawText: string, baseUrl = ""): LiveParseResult => {
  const cleaned = rawText.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const trimmed = cleaned.trim();
  const formatErr = looksLikeUnsupportedEncryptedOrNonM3U(trimmed);
  if (formatErr) throw new Error(formatErr);

  const lines = cleaned.split("\n");
  const channels: LiveChannel[] = [];
  const groupSet = new Set<string>();
  const seenIds = new Map<string, number>();
  let skippedUnsafe = 0;

  let pendingAttrs: Record<string, string> | null = null;
  let pendingTitle = "";
  let pendingGroup = "";
  let pendingHeaders: LiveChannelHeaders = {};

  const resetPending = () => {
    pendingAttrs = null;
    pendingTitle = "";
    pendingGroup = "";
    pendingHeaders = {};
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#")) {
      if (/^#EXTM3U/i.test(line)) {
        continue;
      }
      if (/^#EXTINF:/i.test(line)) {
        const { attrPart, title } = splitExtinfLine(line);
        const attrs = parseExtinfAttributes(attrPart);
        pendingAttrs = attrs;
        pendingTitle = title;
        for (const [k, v] of Object.entries(attrs)) {
          applyHeaderOption(pendingHeaders, k, v, baseUrl);
        }
        continue;
      }
      if (/^#EXTGRP:/i.test(line)) {
        const grp = line.replace(/^#EXTGRP:/i, "").trim();
        if (grp) pendingGroup = grp;
        continue;
      }
      if (/^#EXTVLCOPT:/i.test(line)) {
        const opt = line.replace(/^#EXTVLCOPT:/i, "").trim();
        const eqIdx = opt.indexOf("=");
        if (eqIdx > 0) {
          applyHeaderOption(pendingHeaders, opt.slice(0, eqIdx), opt.slice(eqIdx + 1), baseUrl);
        }
        continue;
      }
      if (/^#KODIPROP:/i.test(line)) {
        const prop = line.replace(/^#KODIPROP:/i, "").trim();
        const eqIdx = prop.indexOf("=");
        if (eqIdx > 0) {
          const propKey = prop.slice(0, eqIdx).trim().toLowerCase();
          const propVal = prop.slice(eqIdx + 1).trim();
          if (propKey.endsWith("stream_headers") || propKey.endsWith("headers")) {
            parseHeaderKvString(propVal, pendingHeaders, baseUrl);
          } else {
            applyHeaderOption(pendingHeaders, propKey, propVal, baseUrl);
          }
        }
        continue;
      }
      continue;
    }

    const rowHeaders: LiveChannelHeaders = { ...pendingHeaders };
    const rawTarget = splitPipeHeaders(line, rowHeaders, baseUrl);
    const safeUrl = safeLiveHttpUrl(rawTarget, baseUrl);
    if (!safeUrl) {
      skippedUnsafe += 1;
      resetPending();
      continue;
    }

    const attrs: Record<string, string> = pendingAttrs ?? {};
    const tvgId = attrs["tvg-id"] || attrs["id"] || undefined;
    const tvgName = attrs["tvg-name"] || attrs["name"] || undefined;
    const rawLogo = attrs["tvg-logo"] || attrs["logo"] || "";
    const logo = rawLogo ? safeLiveHttpUrl(rawLogo, baseUrl) || undefined : undefined;
    const group = (attrs["group-title"] || attrs["group"] || pendingGroup || "未分组").trim() || "未分组";

    let name = pendingTitle || tvgName || tvgId || "";
    if (!name) {
      try {
        const parsed = new URL(safeUrl);
        const lastSeg = parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname;
        name = decodeURIComponent(lastSeg.replace(/\.(m3u8|m3u|ts|flv|mp4)$/i, "")) || `频道 ${channels.length + 1}`;
      } catch {
        name = `频道 ${channels.length + 1}`;
      }
    }

    const baseId = `ch-${hashText(`${name}|${safeUrl}|${group}`)}`;
    const count = (seenIds.get(baseId) ?? 0) + 1;
    seenIds.set(baseId, count);
    const id = count === 1 ? baseId : `${baseId}-${count}`;

    const hasHeaders = Boolean(rowHeaders.referer || rowHeaders.userAgent);
    channels.push({
      id,
      name,
      url: safeUrl,
      group,
      ...(logo ? { logo } : {}),
      ...(tvgId ? { tvgId } : {}),
      ...(tvgName ? { tvgName } : {}),
      ...(hasHeaders ? { headers: rowHeaders } : {}),
    });
    groupSet.add(group);
    resetPending();
  }

  if (!channels.length) {
    if (skippedUnsafe > 0) {
      throw new Error("播放列表中没有安全的 HTTP/HTTPS 直播频道（已拒绝不安全协议）");
    }
    throw new Error("未在 M3U 内容中解析到有效 HTTP/HTTPS 直播频道");
  }

  return {
    channels,
    groups: Array.from(groupSet),
    skippedUnsafe,
  };
};

const normalizeStoredChannel = (raw: unknown): LiveChannel | null => {
  const item = asRecord(raw);
  if (!item) return null;
  const url = safeLiveHttpUrl(item.url);
  if (!url) return null;
  const name = textOf(item.name) || "直播频道";
  const group = textOf(item.group) || "未分组";
  const id = textOf(item.id) || `ch-${hashText(`${name}|${url}|${group}`)}`;
  const logo = safeLiveHttpUrl(item.logo) || undefined;
  const tvgId = textOf(item.tvgId) || undefined;
  const tvgName = textOf(item.tvgName) || undefined;
  const rawHeaders = asRecord(item.headers);
  const referer = rawHeaders ? (safeLiveReferer(rawHeaders.referer) || safeLiveHttpUrl(rawHeaders.referer) || undefined) : undefined;
  const userAgent = rawHeaders ? (textOf(rawHeaders.userAgent) || undefined) : undefined;
  return {
    id,
    name,
    url,
    group,
    ...(logo ? { logo } : {}),
    ...(tvgId ? { tvgId } : {}),
    ...(tvgName ? { tvgName } : {}),
    ...(referer || userAgent ? { headers: { ...(referer ? { referer } : {}), ...(userAgent ? { userAgent } : {}) } } : {}),
  };
};

const normalizeStoredSource = (raw: unknown, index: number): LiveSource | null => {
  const item = asRecord(raw);
  if (!item) return null;
  const rawChannels = Array.isArray(item.channels) ? item.channels : [];
  const channels = rawChannels
    .map(normalizeStoredChannel)
    .filter((ch): ch is LiveChannel => Boolean(ch));
  if (!channels.length) return null;
  const name = textOf(item.name) || `M3U 直播源 ${index + 1}`;
  const url = safeLiveHttpUrl(item.url) || undefined;
  const id = textOf(item.id) || `live-${hashText(url || name)}-${index + 1}`;
  const groups = Array.from(new Set(channels.map((ch) => ch.group)));
  return {
    id,
    name,
    ...(url ? { url } : {}),
    channels,
    groups,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : undefined,
    skippedUnsafe: typeof item.skippedUnsafe === "number" ? item.skippedUnsafe : undefined,
  };
};

export const loadLiveSources = (): LiveSource[] => {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(LIVE_SOURCES_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .map((entry, idx) => normalizeStoredSource(entry, idx))
      .filter((entry): entry is LiveSource => Boolean(entry));
  } catch {
    return [];
  }
};

export const saveLiveSources = (sources: LiveSource[]) => {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(LIVE_SOURCES_KEY, JSON.stringify(sources));
  notifyLiveSources();
};

export const activeLiveSourceId = (): string =>
  typeof localStorage === "undefined" ? "" : localStorage.getItem(LIVE_ACTIVE_KEY) || "";

export const activeLiveSource = (sources = loadLiveSources()): LiveSource | null => {
  const activeId = activeLiveSourceId();
  return sources.find((s) => s.id === activeId) ?? sources[0] ?? null;
};

export const selectLiveSource = (id: string) => {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(LIVE_ACTIVE_KEY, id);
  notifyLiveSources(id);
};

export const removeLiveSource = (id: string): LiveSource[] => {
  const next = loadLiveSources().filter((s) => s.id !== id);
  if (activeLiveSourceId() === id && typeof localStorage !== "undefined") {
    localStorage.setItem(LIVE_ACTIVE_KEY, next[0]?.id ?? "");
  }
  saveLiveSources(next);
  return next;
};

const upsertLiveSource = (entry: LiveSource): LiveSource => {
  const current = loadLiveSources();
  const next = [
    entry,
    ...current.filter((item) => item.id !== entry.id && (!entry.url || item.url !== entry.url)),
  ];
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(LIVE_ACTIVE_KEY, entry.id);
    localStorage.setItem(LIVE_SOURCES_KEY, JSON.stringify(next));
  }
  notifyLiveSources(entry);
  return entry;
};

const deriveSourceNameFromUrl = (url: string, fallback = "M3U 直播源"): string => {
  try {
    const parsed = new URL(url);
    const file = parsed.pathname.split("/").filter(Boolean).pop() || "";
    const cleaned = decodeURIComponent(file.replace(/\.(m3u8|m3u|txt)$/i, "")).trim();
    return cleaned ? `${parsed.hostname} · ${cleaned}` : parsed.hostname || fallback;
  } catch {
    return fallback;
  }
};

export const fetchLiveM3U = async (url: string): Promise<{ text: string; finalUrl: string }> => {
  const safe = safeLiveHttpUrl(url);
  if (!safe) throw new Error("直播订阅地址必须是有效的 HTTP 或 HTTPS 链接");
  const res = await invoke<unknown>("live_fetch", { url: safe });
  if (typeof res === "string") {
    return { text: res, finalUrl: safe };
  }
  const obj = asRecord(res);
  const text = textOf(obj?.text);
  const finalUrl = safeLiveHttpUrl(obj?.final_url) || safe;
  if (!text) throw new Error("直播源返回内容为空");
  return { text, finalUrl };
};

export const importLiveSourceFromText = (
  rawText: string,
  name = "本地 M3U 直播源",
  baseUrl = "",
  sourceUrl?: string,
): LiveSource => {
  const safeBase = baseUrl ? safeLiveHttpUrl(baseUrl) : "";
  const parsed = parseM3U(rawText, safeBase);
  const cleanName = name.trim() || (sourceUrl ? deriveSourceNameFromUrl(sourceUrl) : "本地 M3U 直播源");
  const safeSourceUrl = sourceUrl ? safeLiveHttpUrl(sourceUrl) : "";
  const id = `live-${hashText(safeSourceUrl || `${cleanName}|${parsed.channels[0]?.url ?? ""}`)}`;
  const source: LiveSource = {
    id,
    name: cleanName,
    ...(safeSourceUrl ? { url: safeSourceUrl } : {}),
    channels: parsed.channels,
    groups: parsed.groups,
    updatedAt: Date.now(),
    skippedUnsafe: parsed.skippedUnsafe,
  };
  return upsertLiveSource(source);
};

export const importLiveSourceFromUrl = async (rawUrl: string, customName = ""): Promise<LiveSource> => {
  const safeUrl = safeLiveHttpUrl(rawUrl);
  if (!safeUrl) {
    throw new Error("直播订阅地址必须是有效的 HTTP 或 HTTPS 链接（不支持私有协议或内嵌账号密码）");
  }
  const { text, finalUrl } = await fetchLiveM3U(safeUrl);
  const name = customName.trim() || deriveSourceNameFromUrl(safeUrl);
  return importLiveSourceFromText(text, name, finalUrl, safeUrl);
};

export const refreshLiveSource = async (source: LiveSource): Promise<LiveSource> => {
  if (!source.url) {
    throw new Error("本地文本导入的直播源无远程订阅链接，请重新粘贴或导入文件");
  }
  return importLiveSourceFromUrl(source.url, source.name);
};

export const channelFavKey = (channel: Pick<LiveChannel, "url" | "name">) =>
  channel.url.trim();

export const loadLiveFavs = (): string[] => {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(LIVE_FAVS_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return Array.from(new Set(raw.map((v) => textOf(v)).filter(Boolean)));
  } catch {
    return [];
  }
};

export const saveLiveFavs = (favs: string[]) => {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(LIVE_FAVS_KEY, JSON.stringify(Array.from(new Set(favs))));
  notifyLiveFavs();
};

export const isLiveFav = (channel: Pick<LiveChannel, "url" | "name">, favs = loadLiveFavs()): boolean =>
  favs.includes(channelFavKey(channel));

export const toggleLiveFav = (channel: Pick<LiveChannel, "url" | "name">): boolean => {
  const key = channelFavKey(channel);
  const current = loadLiveFavs();
  const exists = current.includes(key);
  const next = exists ? current.filter((item) => item !== key) : [key, ...current];
  saveLiveFavs(next);
  return !exists;
};

export const filterLiveChannels = (
  channels: LiveChannel[],
  options: { group?: string; keyword?: string; favs?: string[] } = {},
): LiveChannel[] => {
  const group = (options.group || "all").trim();
  const keyword = (options.keyword || "").trim().toLowerCase();
  const favSet = new Set(options.favs ?? loadLiveFavs());

  return channels.filter((ch) => {
    if (group === "fav") {
      if (!favSet.has(channelFavKey(ch))) return false;
    } else if (group && group !== "all" && ch.group !== group) {
      return false;
    }
    if (keyword) {
      const hay = `${ch.name} ${ch.tvgName || ""} ${ch.group}`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });
};

export const liveChannelReferer = (channel: LiveChannel, source?: LiveSource | null): string | undefined =>
  safeLiveReferer(channel.headers?.referer) || safeLiveReferer(source?.url) || undefined;

/** Formats that are direct media, but are not reliably decodable by browser/WebView video. */
export const liveFormatSupportError = (channel: LiveChannel): string | null =>
  UNSUPPORTED_DIRECT_VIDEO_RE.test(channel.url.trim())
    ? "当前浏览器/WebView 不支持该直播格式（不会转码），请切换频道或使用 MP4/HLS 地址"
    : null;

export const livePlaybackSource = (channel: LiveChannel, source?: LiveSource | null): string => {
  const raw = channel.url.trim();
  if (!raw) return "";
  if (isLocalMedia(raw)) return raw;
  const referer = liveChannelReferer(channel, source);
  const userAgent = channel.headers?.userAgent;
  if (DIRECT_VIDEO_RE.test(raw)) return directMedia(raw, referer, userAgent);
  return playlist(raw, referer, userAgent);
};

export const liveLogoUrl = (channel: LiveChannel, source?: LiveSource | null): string => {
  if (!channel.logo) return "";
  return cover(channel.logo, 240, liveChannelReferer(channel, source), channel.headers?.userAgent);
};
