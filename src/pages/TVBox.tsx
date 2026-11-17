import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Form, Input, Surface } from "../components/ios/controls";
import { Loader } from "../components/ios/effects";
import { Empty } from "../components/ui";
import { Masonry } from "../components/cards";
import BrowseModeSwitch, { type BrowseMode } from "../components/BrowseModeSwitch";
import { IClapper, IClose, ISearch } from "../icons";
import { useStore } from "../store";
import {
  activeTVBoxSource,
  loadTVBoxSources,
  selectTVBoxSource,
  TVBOX_SOURCE_EVENT,
  tvboxList,
  tvboxSearch,
  tvboxVideoCard,
  type TVBoxCategory,
  type TVBoxSource,
  type TVBoxVideo,
} from "../tvbox";
import type { VideoCard } from "../types";

export default function TVBoxPage({ active, wide, onBrowseModeChange }: { active: boolean; wide: boolean; onBrowseModeChange: (mode: BrowseMode) => void }) {
  const { push } = useStore();
  const [sources, setSources] = useState<TVBoxSource[]>(loadTVBoxSources);
  const [source, setSource] = useState<TVBoxSource | null>(activeTVBoxSource);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState<TVBoxCategory[]>([]);
  const [videos, setVideos] = useState<TVBoxVideo[]>([]);
  const [cards, setCards] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const seqRef = useRef(0);
  const busy = useRef(false);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  useEffect(() => {
    const syncSources = () => {
      const all = loadTVBoxSources();
      let current = activeTVBoxSource();
      if (!current && all[0]) {
        selectTVBoxSource(all[0].id);
        current = activeTVBoxSource();
      }
      setSources(all);
      setSource(current);
      setQuery("");
      setSubmitted("");
      setCategory("");
      setCategories([]);
      setVideos([]);
      setCards([]);
      setPage(0);
      setPages(1);
      setError("");
    };
    window.addEventListener(TVBOX_SOURCE_EVENT, syncSources);
    return () => window.removeEventListener(TVBOX_SOURCE_EVENT, syncSources);
  }, []);

  const loadPage = useCallback(async (keyword: string, nextPage: number) => {
    const currentSource = source;
    if (!currentSource || (nextPage > 1 && (busy.current || nextPage > pagesRef.current))) return;
    const seq = ++seqRef.current;
    busy.current = true;
    setLoading(true);
    setError("");
    try {
      const result = keyword
        ? await tvboxSearch(currentSource, keyword, nextPage, category)
        : await tvboxList(currentSource, nextPage, category);
      if (seq !== seqRef.current) return;
      setVideos(previous => {
        const base = nextPage === 1 ? [] : previous;
        const seen = new Set(base.map(video => video.localId));
        return [...base, ...result.items.filter(video => !seen.has(video.localId))];
      });
      setCards(previous => {
        const base = nextPage === 1 ? [] : previous;
        const mapped = result.items.map(video => tvboxVideoCard(video, currentSource));
        const seen = new Set(base.map(card => card.id));
        return [...base, ...mapped.filter(card => !seen.has(card.id))];
      });
      setCategories(result.categories);
      setPage(nextPage);
      setPages(result.pages);
    } catch (cause) {
      if (seq === seqRef.current) {
        setError(cause instanceof Error ? cause.message : "TVBox 影片加载失败");
        if (nextPage === 1) {
          setVideos([]);
          setCards([]);
        }
      }
    } finally {
      if (seq === seqRef.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  }, [source, category]);

  useEffect(() => {
    if (!active || !source) return;
    void loadPage(submitted, 1);
    return () => {
      seqRef.current++;
      busy.current = false;
    };
  }, [active, source, category, submitted, loadPage]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const next = query.trim();
    if (next === submitted) void loadPage(next, 1);
    else setSubmitted(next);
  };

  const chooseCategory = (next: string) => {
    if (next === category) return;
    setCategory(next);
  };

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 px-4 pt-3 pb-3" style={{ paddingTop: "calc(var(--sat, 0px) + 12px)" }}>
        <div className="flex items-end gap-2.5 mb-2.5">
          <h1 className="ios-page-title text-on">影视</h1>
          <span className="text-[12px] text-mut pb-0.5">TVBox 点播源 · 选片、搜索并播放</span>
        </div>
        <BrowseModeSwitch mode="tvbox" onChange={onBrowseModeChange} />
        {!!sources.length && (
          <select aria-label="TVBox 数据源" value={source?.id ?? ""}
            onChange={event => selectTVBoxSource(event.target.value)}
            className="mt-3 h-10 w-full rounded-(--r-ctl) bg-s2 px-3 text-[13px] text-on outline-none">
            {sources.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        )}
      </div>

      {!source ? (
        <div className="flex-1 scroll-y px-4 pb-24 pt-2">
          <Surface role="region" aria-label="添加 TVBox 数据源" className="rounded-(--r-md) bg-s2 p-5 text-center">
            <div className="mx-auto grid size-12 place-items-center rounded-full bg-primary/15 text-primary"><IClapper size={23} /></div>
            <h2 className="mt-3 text-[16px] font-semibold text-on">先添加一个 TVBox 源</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-mut">支持 TVBox XML、JSON API、Remote（type=4）以及后端隔离执行的 HTTP(S) .js/.mjs Spider。JAR、Python、csp_drpy 等未知运行器不会执行；需要网页嗅探的播放也不支持。</p>
            <Button onClick={() => push({ kind: "settings" })}
              className="mt-4 h-10 w-full rounded-(--r-ctl) bg-primary px-4 text-[13px] font-semibold text-on-primary pressable">
              添加或导入 TVBox 源
            </Button>
          </Surface>
        </div>
      ) : (
        <>
          <div className="shrink-0 px-4 pb-3">
            <Form className="ios-search-form flex items-center gap-2" onSubmit={submit}>
              <ISearch size={17} className="shrink-0 text-mut" />
              <Input aria-label="搜索 TVBox 影片" value={query} onChange={event => setQuery(event.target.value)}
                placeholder="搜索影视名称…" className="min-w-0 flex-1 bg-transparent text-[14px] text-on placeholder-dim outline-none" />
              {query && <Button type="button" aria-label="清除搜索" onClick={() => { setQuery(""); if (submitted) setSubmitted(""); else void loadPage("", 1); }}
                className="ios-icon-button"><IClose size={16} /></Button>}
              <Button type="submit" aria-label="搜索" className="h-8 rounded-(--r-ctl) bg-primary px-3 text-[12px] font-semibold text-on-primary">搜索</Button>
            </Form>
          </div>
          {!!categories.length && (
            <div className="shrink-0 flex gap-2 overflow-x-auto px-4 pb-3 no-bar" role="group" aria-label="TVBox 影视分类">
              <Button aria-pressed={!category} onClick={() => chooseCategory("")}
                className={`h-8 shrink-0 rounded-(--r-ctl) px-3 text-[12px] pressable ${!category ? "bg-primary text-on-primary" : "bg-s2 text-on/80"}`}>全部</Button>
              {categories.map(item => (
                <Button key={item.id} aria-pressed={category === item.id} onClick={() => chooseCategory(item.id)}
                  className={`h-8 shrink-0 rounded-(--r-ctl) px-3 text-[12px] pressable ${category === item.id ? "bg-primary text-on-primary" : "bg-s2 text-on/80"}`}>{item.name}</Button>
              ))}
            </div>
          )}
          <div className="flex-1 scroll-y px-4 pb-24">
            {cards.length > 0 ? (
              <>
                <p className="mb-2 text-[12px] text-mut">{source.name}{submitted ? ` · 搜索“${submitted}”` : " · 影视目录"} · 点击封面查看详情</p>
                <Masonry videos={cards} wide={wide} onOpen={card => {
                  const index = videos.findIndex(video => video.localId === card.id);
                  if (index >= 0) push({ kind: "feed", videoIds: videos.map(video => video.localId), index,
                    title: `${source.name} · ${card.title}`, tvboxSource: source, tvboxItems: videos });
                }} />
              </>
            ) : loading ? (
              <div role="status" className="flex justify-center py-12"><Loader className="h-8 w-8 spinner" /></div>
            ) : (
              <Empty icon={<ISearch size={26} />} title={error || "此分类暂无影视"}
                sub={error ? "检查网络或数据源地址后重试" : "换一个分类，或搜索影片名称"}
                action={error ? "重试" : undefined} onAction={error ? () => void loadPage(submitted, 1) : undefined} />
            )}
            <div className="flex justify-center py-4">
              {loading && cards.length > 0 ? <Loader className="h-6 w-6 spinner" />
                : page < pages ? <Button onClick={() => void loadPage(submitted, page + 1)}
                  className="h-9 rounded-(--r-ctl) bg-s2 px-5 text-[13px] text-on/85 pressable">加载更多</Button>
                  : cards.length > 0 ? <span className="text-[12px] text-dim">— 已经到底啦 —</span> : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
