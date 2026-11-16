import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/ios/controls";
import VideoSurface, { type VideoHandle } from "../components/VideoSurface";
import { Empty, Img } from "../components/ui";
import { cover } from "../api";
import { tvboxPlaybackSource } from "../tvbox";
import { IBack, IClose, IGlobe, IPlus, IRefresh, ISearch } from "../icons";
import {
  fetchTvboxText, makeSource, parseTvboxConfig, readTvboxLibrary, resolveTvboxPlayback,
  sourceTypeLabel, tvboxCategories, tvboxDetail, tvboxList, tvboxSearch, writeTvboxLibrary,
  type TvboxCategory, type TvboxDetail, type TvboxEpisode, type TvboxLibrary, type TvboxSource, type TvboxVideo,
} from "../tvboxSources";

async function readConfigTree(input: string): Promise<TvboxLibrary> {
  const firstUrl = /^https?:\/\//i.test(input) ? input : "";
  const firstText = firstUrl ? await fetchTvboxText(firstUrl) : input;
  const queue: { text: string; base?: string; depth: number }[] = [{ text: firstText, base: firstUrl || undefined, depth: 0 }];
  const seen = new Set(firstUrl ? [new URL(firstUrl).toString()] : []);
  const sources = new Map<string, TvboxSource>();
  const parsers = new Map<string, TvboxLibrary["parsers"][number]>();
  let visited = 0;
  while (queue.length && visited < 12) {
    const entry = queue.shift()!;
    const config = parseTvboxConfig(entry.text, entry.base);
    config.sources.forEach((item) => sources.set(`${item.api}|${item.type}|${item.ext || ""}`, item));
    config.parsers.forEach((item) => parsers.set(item.url, item));
    visited++;
    if (entry.depth < 4) for (const repository of config.repositories || []) {
      if (seen.has(repository.url) || seen.size >= 12) continue;
      seen.add(repository.url);
      try { queue.push({ text: await fetchTvboxText(repository.url), base: repository.url, depth: entry.depth + 1 }); }
      catch { /* Skip an unavailable repository but retain other imported sources. */ }
    }
  }
  return { sources: [...sources.values()], parsers: [...parsers.values()] };
}

function VideoDialog({ url, title, poster, active, error, onClose }: { url: string; title: string; poster: string; active: boolean; error: (message: string) => void; onClose: () => void }) {
  const player = useRef<VideoHandle>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => { const video = player.current?.el(); if (video) video.controls = true; }, 0);
    return () => window.clearTimeout(timer);
  }, [url]);
  return (
    <div className="absolute inset-0 z-[60] bg-black/90 backdrop-blur-sm flex flex-col" role="dialog" aria-modal="true" aria-label={title}>
      <div className="shrink-0 flex items-center gap-3 px-4 py-3 text-white" style={{ paddingTop: "max(env(safe-area-inset-top), 14px)" }}>
        <Button onClick={onClose} aria-label="关闭播放器" className="w-9 h-9 rounded-full bg-white/10 grid place-items-center"><IClose size={18} /></Button>
        <div className="min-w-0"><div className="font-semibold truncate">{title}</div><div className="text-xs text-white/50 truncate">{url}</div></div>
      </div>
      <div className="flex-1 min-h-0 grid place-items-center">
        <div className="w-full max-h-full aspect-video bg-black">
          <VideoSurface ref={player} src={url} poster={poster ? cover(poster) : undefined} active={active} autoPlay={active} muted={false} fit="contain" onError={error} />
        </div>
      </div>
      <div className="px-4 py-3 text-center text-xs text-white/55" style={{ paddingBottom: "max(env(safe-area-inset-bottom), 14px)" }}>使用 HGhubX 内置播放器；源地址由你导入，播放受源站授权、网络和格式兼容性影响。</div>
    </div>
  );
}

export default function TvboxPage({ onBack, wide, active = true }: { onBack: () => void; wide: boolean; active?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // The existing Face ID lock sets inert on the app wrapper. Observe only ancestors.
    const update = () => setVisible(document.visibilityState !== "hidden" && !root.closest("[inert]"));
    const observer = new MutationObserver(update);
    for (let node: HTMLElement | null = root; node; node = node.parentElement) {
      observer.observe(node, { attributes: true, attributeFilter: ["inert"] });
    }
    document.addEventListener("visibilitychange", update);
    update();
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);
  const [library, setLibrary] = useState<TvboxLibrary>(() => readTvboxLibrary());
  const [selectedKey, setSelectedKey] = useState(() => readTvboxLibrary().sources[0]?.key || "");
  const source = library.sources.find((item) => item.key === selectedKey) || null;
  const [categories, setCategories] = useState<TvboxCategory[]>([]);
  const [category, setCategory] = useState("");
  const [videos, setVideos] = useState<TvboxVideo[]>([]);
  const [queryInput, setQueryInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [detail, setDetail] = useState<TvboxDetail | null>(null);
  const [activeFlag, setActiveFlag] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [manage, setManage] = useState(false);
  const [configInput, setConfigInput] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [sourceApi, setSourceApi] = useState("");
  const [sourceType, setSourceType] = useState(1);
  const [playUrl, setPlayUrl] = useState("");
  const [playTitle, setPlayTitle] = useState("");
  const [playPoster, setPlayPoster] = useState("");
  const requestSeq = useRef(0);
  const detailSeq = useRef(0);
  const playSeq = useRef(0);
  const saveLibrary = useCallback((next: TvboxLibrary) => { setLibrary(next); writeTvboxLibrary(next); }, []);

  const load = useCallback(async (append = false) => {
    if (!source) { setCategories([]); setVideos([]); return; }
    const seq = ++requestSeq.current;
    const sourceKey = source.key;
    setBusy(true); setError("");
    try {
      if (source.type === 3) throw new Error("此兼容页不执行 Spider/JAR；受限 JavaScript Spider 请从「影视 → TVBox 源」入口使用，JAR 暂不支持。");
      if (!searchQuery && !categories.length) {
        const nextCategories = await tvboxCategories(source);
        if (seq !== requestSeq.current || sourceKey !== selectedKey) return;
        setCategories(nextCategories);
      }
      const nextPage = append ? page + 1 : 1;
      const result = searchQuery
        ? await tvboxSearch(source, searchQuery)
        : await tvboxList(source, category, nextPage);
      if (seq !== requestSeq.current || sourceKey !== selectedKey) return;
      setVideos((current) => append ? [...current, ...result] : result);
      setPage(nextPage);
      setMore(!searchQuery && result.length >= 20);
    } catch (e) {
      if (seq === requestSeq.current && sourceKey === selectedKey) setError((e as Error).message || "加载源失败");
    } finally { if (seq === requestSeq.current && sourceKey === selectedKey) setBusy(false); }
  }, [source, selectedKey, searchQuery, categories.length, category, page]);

  useEffect(() => {
    setCategories([]); setCategory(""); setSearchQuery(""); setQueryInput(""); setVideos([]); setPage(1); setMore(false);
    setDetail(null); setActiveFlag(""); setPlayUrl(""); setPlayTitle(""); setPlayPoster("");
    if (source) void load(false);
    return () => { requestSeq.current++; detailSeq.current++; playSeq.current++; };
    // source identity is the intentional reload boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);
  useEffect(() => { if (source && categories.length) void load(false); }, [category, searchQuery]);

  const visibleEpisodes = useMemo(() => detail?.episodes[activeFlag] || [], [detail, activeFlag]);
  const openVideo = async (video: TvboxVideo) => {
    if (!source) return;
    const sourceKey = source.key;
    const seq = ++detailSeq.current;
    playSeq.current++;
    setBusy(true); setError("");
    try {
      const value = await tvboxDetail(source, video);
      if (seq !== detailSeq.current || sourceKey !== selectedKey) return;
      setDetail(value);
      const first = value.flags[0] || "";
      setActiveFlag(first);
      if (!first || !(value.episodes[first]?.length)) setError("已加载详情，但该视频没有可识别的播放剧集。");
    } catch (e) { if (seq === detailSeq.current && sourceKey === selectedKey) setError((e as Error).message || "读取详情失败"); }
    finally { if (seq === detailSeq.current && sourceKey === selectedKey) setBusy(false); }
  };
  const playEpisode = async (episode: TvboxEpisode) => {
    if (!episode.url || !source) return;
    const sourceKey = source.key;
    const detailVideoId = detail?.video.id;
    const seq = ++playSeq.current;
    setBusy(true); setError("");
    try {
      const url = tvboxPlaybackSource(await resolveTvboxPlayback(episode, source, library.parsers));
      if (seq !== playSeq.current || sourceKey !== selectedKey || detailVideoId !== detail?.video.id) return;
      setPlayUrl(url); setPlayTitle(`${detail?.video.name || "TVBox"} · ${episode.name}`); setPlayPoster(detail?.video.pic || "");
    } catch (e) { if (seq === playSeq.current && sourceKey === selectedKey && detailVideoId === detail?.video.id) setError((e as Error).message || "无法解析播放链接"); }
    finally { if (seq === playSeq.current && sourceKey === selectedKey && detailVideoId === detail?.video.id) setBusy(false); }
  };
  const submitSearch = (event: React.FormEvent) => { event.preventDefault(); setSearchQuery(queryInput.trim()); };
  const refresh = () => { setCategories([]); void load(false); };
  const addManualSource = () => {
    try {
      const added = makeSource(sourceName, sourceApi, sourceType);
      const identity = `${added.api}|${added.type}|${added.ext || ""}`;
      const next = { ...library, sources: [added, ...library.sources.filter((item) => `${item.api}|${item.type}|${item.ext || ""}` !== identity)] };
      saveLibrary(next); setSelectedKey(added.key); setSourceName(""); setSourceApi(""); setError("");
    } catch (e) { setError((e as Error).message); }
  };
  const importConfig = async () => {
    const input = configInput.trim();
    if (!input) { setError("输入 TVBox 配置 JSON 或配置 URL"); return; }
    setBusy(true); setError("");
    try {
      const imported = await readConfigTree(input);
      if (!imported.sources.length) throw new Error("配置中未找到可用的 HTTP(S) 点播源（sites/sources）");
      const merged = new Map(library.sources.map((item) => [`${item.api}|${item.type}|${item.ext || ""}`, item]));
      imported.sources.forEach((item) => merged.set(`${item.api}|${item.type}|${item.ext || ""}`, item));
      const next = { sources: [...merged.values()], parsers: imported.parsers.length ? imported.parsers : library.parsers };
      saveLibrary(next); setSelectedKey(imported.sources[0].key); setConfigInput(""); setManage(false);
      setError(imported.sources.some((item) => item.type === 3) ? "已导入配置；Spider/JAR 项已保留但当前无法执行。" : "");
    } catch (e) { setError((e as Error).message || "导入配置失败"); }
    finally { setBusy(false); }
  };
  const removeSource = (item: TvboxSource) => {
    const sources = library.sources.filter((sourceItem) => sourceItem.key !== item.key);
    const next = { ...library, sources };
    saveLibrary(next);
    if (selectedKey === item.key) setSelectedKey(sources[0]?.key || "");
  };
  const title = detail?.video.name || source?.name || "电视源";

  return (
    <div ref={rootRef} className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="px-3 pt-2 pb-3 flex items-center gap-2">
          <Button aria-label="返回" onClick={detail ? () => { setDetail(null); setError(""); } : onBack} className="w-10 h-10 rounded-full grid place-items-center text-on hover:bg-s3"><IBack size={20} /></Button>
          <div className="min-w-0 flex-1">
            <div className="text-[17px] font-bold text-on truncate">{detail ? title : "TVBox"}</div>
            <div className="text-[11px] text-mut truncate">{detail ? `${source?.name || ""} · ${detail.flags.length} 条线路 · ${visibleEpisodes.length} 集` : "导入你的源，浏览目录并播放"}</div>
          </div>
          {!detail && <Button onClick={() => setManage((v) => !v)} className="h-9 px-3 rounded-full bg-s3 text-on text-[13px] font-semibold flex items-center gap-1.5"><IPlus size={16} />管理源</Button>}
          {!detail && source && <Button aria-label="刷新" onClick={refresh} className="w-9 h-9 rounded-full grid place-items-center text-mut"><IRefresh size={16} /></Button>}
        </div>
        {!detail && library.sources.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-4 pb-3">
            {library.sources.map((item) => <Button key={item.key} onClick={() => setSelectedKey(item.key)} className={`shrink-0 max-w-[180px] truncate px-3 py-1.5 rounded-full text-[12px] ${item.key === selectedKey ? "bg-primary text-on-primary" : "bg-s3 text-mut"}`}>{item.name} · {sourceTypeLabel(item.type)}</Button>)}
          </div>
        )}
      </div>

      {manage && !detail && (
        <div className="shrink-0 max-h-[48%] overflow-y-auto border-b border-white/10 bg-s2 px-4 py-3 space-y-3">
          <div className="flex items-center justify-between"><div className="font-semibold text-on">源管理</div><Button onClick={() => setManage(false)} aria-label="关闭" className="w-8 h-8 rounded-full grid place-items-center text-mut"><IClose size={16} /></Button></div>
          <label className="block text-xs text-mut">配置 URL 或 JSON（支持 TVBox sites/sources 与 parses）<textarea value={configInput} onChange={(e) => setConfigInput(e.target.value)} placeholder="粘贴 TVBox 配置 JSON，或填入配置 URL" rows={3} className="mt-1.5 w-full rounded-xl bg-bg border border-white/10 px-3 py-2 text-sm text-on outline-none focus:border-primary/60" /></label>
          <Button onClick={() => void importConfig()} disabled={busy} className="h-9 px-4 rounded-xl bg-primary text-on-primary text-sm font-semibold">{busy ? "导入中…" : "导入配置"}</Button>
          <div className="border-t border-white/10 pt-3">
            <div className="text-xs font-semibold text-mut mb-2">手动添加接口</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input value={sourceName} onChange={(e) => setSourceName(e.target.value)} placeholder="源名称" className="rounded-xl bg-bg border border-white/10 px-3 py-2 text-sm text-on outline-none" />
              <select value={sourceType} onChange={(e) => setSourceType(Number(e.target.value))} className="rounded-xl bg-bg border border-white/10 px-3 py-2 text-sm text-on"><option value={1}>JSON（type 1）</option><option value={0}>XML（type 0）</option><option value={4}>Remote（type 4）</option><option value={3}>Spider/JAR（保留，未支持）</option></select>
              <input value={sourceApi} onChange={(e) => setSourceApi(e.target.value)} placeholder="https://example.com/api.php/provide/vod" className="sm:col-span-2 rounded-xl bg-bg border border-white/10 px-3 py-2 text-sm text-on outline-none" />
            </div>
            <Button onClick={addManualSource} className="mt-2 h-9 px-4 rounded-xl bg-s3 text-on text-sm font-semibold">添加源</Button>
          </div>
          {!!library.sources.length && <div className="space-y-1.5 border-t border-white/10 pt-2">{library.sources.map((item) => <div key={item.key} className="flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate text-mut">{item.name} · {item.api}</span><Button onClick={() => removeSource(item)} className="px-2 py-1 text-red-300">移除</Button></div>)}</div>}
        </div>
      )}

      {!detail && source && source.type !== 3 && !manage && (
        <>
          {categories.length > 0 && <div className="shrink-0 flex gap-2 overflow-x-auto px-4 py-2.5 bg-bg">{[{ id: "", name: "推荐/全部" }, ...categories].map((item) => <Button key={`${item.id}-${item.name}`} onClick={() => { setCategory(item.id); setSearchQuery(""); setQueryInput(""); }} className={`shrink-0 px-3 py-1.5 rounded-full text-xs ${category === item.id && !searchQuery ? "bg-s3 text-on font-semibold" : "text-mut"}`}>{item.name}</Button>)}</div>}
          <form onSubmit={submitSearch} className="shrink-0 flex gap-2 px-4 py-2 bg-bg"><input value={queryInput} onChange={(e) => setQueryInput(e.target.value)} placeholder={`搜索 ${source.name}`} className="min-w-0 flex-1 rounded-xl bg-s2 border border-white/5 px-3 py-2 text-sm text-on outline-none focus:border-primary/50" /><Button type="submit" className="w-10 rounded-xl bg-s3 text-on grid place-items-center" aria-label="搜索"><ISearch size={17} /></Button>{searchQuery && <Button type="button" onClick={() => { setSearchQuery(""); setQueryInput(""); }} className="px-2 rounded-xl bg-s3 text-mut text-xs">清除</Button>}</form>
        </>
      )}

      {error && <div role="alert" className="mx-4 mt-2 rounded-xl bg-red-500/10 border border-red-400/20 px-3 py-2 text-xs text-red-200">{error}</div>}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {!library.sources.length ? (
          <Empty icon={<IGlobe size={25} />} title="还没有 TVBox 源" sub="导入配置 JSON/URL，或添加 XML、JSON、Remote 接口。源配置保存在本机。" action="管理源" onAction={() => setManage(true)} />
        ) : source?.type === 3 ? (
          <Empty icon={<IGlobe size={25} />} title="此页不执行 Spider/JAR" sub="导入的源会保留。受限 JavaScript Spider 请从「影视 → TVBox 源」入口使用；JAR 暂不支持。" />
        ) : detail ? (
          <div className="max-w-5xl mx-auto px-4 py-4">
            <div className={`grid gap-4 ${wide ? "grid-cols-[190px_1fr]" : "grid-cols-[96px_1fr]"}`}>
              <div className="relative overflow-hidden rounded-xl bg-s2 aspect-[2/3]">{detail.video.pic ? <Img src={detail.video.pic} /> : null}</div>
              <div className="min-w-0"><h2 className="text-xl font-bold text-on">{detail.video.name}</h2><div className="mt-1 text-xs text-mut">{[detail.video.year, detail.video.area, detail.video.typeName, detail.video.note].filter(Boolean).join(" · ")}</div>{detail.video.description && <p className="mt-3 text-sm leading-relaxed text-mut line-clamp-5">{detail.video.description.replace(/<[^>]*>/g, " ")}</p>}
                {detail.flags.length > 0 && <div className="mt-4"><div className="text-xs text-mut mb-2">播放线路</div><div className="flex gap-2 overflow-x-auto">{detail.flags.map((flag) => <Button key={flag} onClick={() => setActiveFlag(flag)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs ${activeFlag === flag ? "bg-primary text-on-primary" : "bg-s3 text-mut"}`}>{flag}</Button>)}</div></div>}
              </div>
            </div>
            <div className="mt-5 flex items-center gap-2"><h3 className="text-sm font-bold text-on">剧集</h3><span className="text-xs text-mut">{visibleEpisodes.length} 集</span></div>
            {visibleEpisodes.length ? <div className="mt-2 grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 gap-2">{visibleEpisodes.map((episode, index) => <Button key={`${episode.name}-${index}`} onClick={() => void playEpisode(episode)} disabled={busy} className="min-h-10 rounded-xl bg-s2 px-2 text-xs text-on hover:bg-s3 truncate">{episode.name}</Button>)}</div> : <div className="text-xs text-mut py-4">当前线路没有可识别的剧集。部分源使用的自定义解析格式不兼容。</div>}
          </div>
        ) : (
          <div className="max-w-6xl mx-auto px-4 py-3">
            {busy && !videos.length ? <div className="py-12 text-center text-sm text-mut">正在读取源…</div> : videos.length ? <div className={`grid gap-3 ${wide ? "grid-cols-3 lg:grid-cols-4 xl:grid-cols-5" : "grid-cols-2"}`}>{videos.map((video, index) => <Button key={`${video.id}-${index}`} onClick={() => void openVideo(video)} className="min-w-0 overflow-hidden rounded-xl bg-s1 text-left hover:bg-s2"><div className="relative aspect-[2/3] bg-s2">{video.pic && <Img src={video.pic} />}<span className="absolute bottom-2 left-2 right-2 rounded-lg bg-black/55 px-2 py-1 text-[11px] text-white truncate">{video.note || video.year || source?.name}</span></div><div className="p-2.5"><div className="text-[13px] font-semibold text-on line-clamp-2">{video.name}</div><div className="mt-1 text-[11px] text-mut truncate">{[video.year, video.area, video.typeName].filter(Boolean).join(" · ")}</div></div></Button>)}</div> : !busy && !error ? <Empty icon={<IGlobe size={25} />} title="这个源暂时没有内容" sub="切换分类、搜索标题，或检查接口地址和源站可用性。" action="重新加载" onAction={refresh} /> : null}
            {more && !searchQuery && <div className="py-5 text-center"><Button disabled={busy} onClick={() => void load(true)} className="rounded-xl bg-s3 px-5 py-2 text-sm text-on">{busy ? "加载中…" : "加载更多"}</Button></div>}
            {busy && videos.length > 0 && <div className="py-3 text-center text-xs text-mut">加载中…</div>}
          </div>
        )}
      </div>

      {detail && <div className="shrink-0 px-4 py-2 border-t border-white/5 text-xs text-mut">源：{source?.name || ""} · 播放链路优先直链，必要时尝试导入配置中的前 5 个静态解析接口；不会执行 Spider/JAR 或任意脚本。</div>}
      {playUrl && <VideoDialog url={playUrl} title={playTitle} poster={playPoster} active={active && visible} error={(message) => setError(`播放器：${message}`)} onClose={() => setPlayUrl("")} />}
    </div>
  );
}
