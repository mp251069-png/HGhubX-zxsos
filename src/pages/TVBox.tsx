import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Form, Input, Surface } from "../components/ios/controls";
import { Loader } from "../components/ios/effects";
import { Empty } from "../components/ui";
import { Masonry, RowCard } from "../components/cards";
import type { BrowseMode } from "../components/BrowseModeSwitch";
import { MoviesPageHeader, MoviesShelfHeading } from "../components/MoviesChrome";
import { IBack, IClapper, IClose, ISearch } from "../icons";
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

type TVBoxRanking = "source" | "hot" | "score";
type TVBoxShelfState = { items: TVBoxVideo[]; loading: boolean; error: string };

function sortTVBoxVideos(items: TVBoxVideo[], ranking: TVBoxRanking): TVBoxVideo[] {
  if (ranking === "source") return items;
  return [...items].sort((a, b) => ranking === "hot"
    ? (b.hot ?? 0) - (a.hot ?? 0) || b.score - a.score
    : b.score - a.score || (b.hot ?? 0) - (a.hot ?? 0));
}

function TVBoxVideoRail({ items, source, ranking, onOpen }: {
  items: TVBoxVideo[]; source: TVBoxSource; ranking: TVBoxRanking;
  onOpen: (videos: TVBoxVideo[], video: TVBoxVideo) => void;
}) {
  const ordered = sortTVBoxVideos(items, ranking);
  return <div className="scroll-x flex gap-2.5 snap-x" aria-label={`${source.name} 影片横向列表`}>
    {ordered.map(video => <RowCard key={video.localId} v={tvboxVideoCard(video, source)}
      onOpen={() => onOpen(ordered, video)} />)}
  </div>;
}

export default function TVBoxPage({ active, wide, onBrowseModeChange }: { active: boolean; wide: boolean; onBrowseModeChange: (mode: BrowseMode) => void }) {
  const { push } = useStore();
  const [sources, setSources] = useState<TVBoxSource[]>(loadTVBoxSources);
  const [source, setSource] = useState<TVBoxSource | null>(activeTVBoxSource);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [category, setCategory] = useState("");
  const [ranking, setRanking] = useState<TVBoxRanking>("source");
  const [categories, setCategories] = useState<TVBoxCategory[]>([]);
  const [shelves, setShelves] = useState<Record<string, TVBoxShelfState>>({});
  const [shelfReload, setShelfReload] = useState(0);
  const [videos, setVideos] = useState<TVBoxVideo[]>([]);
  const [cards, setCards] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const seqRef = useRef(0);
  const busy = useRef(false);
  const pagesRef = useRef(pages);
  const shelfSeqRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
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
      setShelves({});
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
      if (result.categories.length) setCategories(previous => {
        const unchanged = previous.length === result.categories.length
          && previous.every((item, index) => item.id === result.categories[index]?.id
            && item.name === result.categories[index]?.name);
        return unchanged ? previous : result.categories;
      });
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

  const visibleCards = useMemo(() => {
    if (ranking === "source") return cards;
    return [...cards].sort((a, b) => ranking === "hot"
      ? b.hot - a.hot || b.score - a.score
      : b.score - a.score || b.hot - a.hot);
  }, [cards, ranking]);

  const categoryName = categories.find(item => item.id === category)?.name ?? (category ? "当前分类" : "");
  const contextTitle = submitted ? `搜索“${submitted}”` : categoryName || "影视目录";
  const contextBackLabel = submitted && category ? `返回${categoryName}` : "返回分类总览";
  const leaveContext = () => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setQuery("");
    setSubmitted("");
    if (category && !submitted) chooseCategory("");
  };

  useEffect(() => {
    if (!active || !source) return;
    void loadPage(submitted, 1);
    return () => {
      seqRef.current++;
      busy.current = false;
    };
  }, [active, source, category, submitted, loadPage]);

  useEffect(() => {
    if (!active || !source || category || submitted || !categories.length) return;
    let cancelled = false;
    const request = ++shelfSeqRef.current;
    setShelves(Object.fromEntries(categories.map(item => [item.id, { items: [], loading: true, error: "" }])));
    let cursor = 0;
    const loadWorker = async () => {
      while (cursor < categories.length) {
        const item = categories[cursor++];
        try {
          const result = await tvboxList(source, 1, item.id);
          if (cancelled || shelfSeqRef.current !== request) return;
          setShelves(previous => ({ ...previous, [item.id]: { items: result.items, loading: false, error: "" } }));
        } catch (cause) {
          if (cancelled || shelfSeqRef.current !== request) return;
          setShelves(previous => ({ ...previous, [item.id]: {
            items: [], loading: false, error: cause instanceof Error ? cause.message : "分类加载失败",
          } }));
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(3, categories.length) }, () => loadWorker()));
    return () => {
      cancelled = true;
      if (shelfSeqRef.current === request) shelfSeqRef.current++;
    };
  }, [active, source, category, submitted, categories, shelfReload]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const next = query.trim();
    if (next === submitted) void loadPage(next, 1);
    else setSubmitted(next);
  };

  const chooseCategory = (next: string) => {
    if (next === category) return;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setCategory(next);
    setVideos([]);
    setCards([]);
    setPage(0);
    setPages(1);
    setError("");
  };

  const openVideoList = (items: TVBoxVideo[], selected: TVBoxVideo) => {
    if (!source) return;
    const ordered = sortTVBoxVideos(items, ranking);
    const index = ordered.findIndex(video => video.localId === selected.localId);
    if (index >= 0) push({ kind: "feed", videoIds: ordered.map(video => video.localId), index,
      title: `${source.name} · ${selected.title}`, tvboxSource: source, tvboxItems: ordered });
  };

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <MoviesPageHeader mode="tvbox" onChange={onBrowseModeChange}
        summary={`${sources.length} 个源 · 分类浏览与搜索`} />
      {!!sources.length && (
        <div className="movies-tvbox-tools shrink-0 px-4 pb-2">
          <div className="mt-3 flex min-w-0 items-center gap-2">
            <select aria-label="TVBox 数据源" value={source?.id ?? ""}
              onChange={event => selectTVBoxSource(event.target.value)}
              className="h-12 w-[42%] max-w-[200px] min-w-0 shrink-0 truncate rounded-(--r-ctl) bg-s2 px-3 text-[13px] text-on outline-none">
              {sources.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <Form className="ios-search-form flex min-w-0 flex-1 items-center gap-2" onSubmit={submit}>
              <Input aria-label="搜索 TVBox 影片" value={query} onChange={event => setQuery(event.target.value)}
                placeholder="搜索影视…" className="min-w-0 flex-1 bg-transparent text-[13px] text-on placeholder-dim outline-none" />
              {query && <Button type="button" aria-label="清除搜索" onClick={() => { setQuery(""); if (submitted) setSubmitted(""); else void loadPage("", 1); }}
                className="ios-icon-button"><IClose size={16} /></Button>}
              <Button type="submit" aria-label="搜索" className="ios-icon-button ios-button-primary mr-0.5"><ISearch size={16} /></Button>
            </Form>
          </div>
        </div>
      )}

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
          <div className="movies-tvbox-ranking shrink-0 space-y-2 px-4 pb-2">
            <div role="group" aria-label="TVBox 榜单" className="scroll-x flex gap-2"
              title="按 TVBox 源返回的播放量排序；源未提供播放量时以评分作为次级排序">
              <Button aria-pressed={ranking === "source"} onClick={() => setRanking("source")}
                className="ios-filter-pill shrink-0">源推荐</Button>
              <Button aria-pressed={ranking === "hot"} onClick={() => setRanking("hot")}
                className="ios-filter-pill shrink-0">热度优先</Button>
              <Button aria-pressed={ranking === "score"} onClick={() => setRanking("score")}
                className="ios-filter-pill shrink-0">评分优先</Button>
            </div>
          </div>
          <div ref={scrollRef} className="flex-1 scroll-y px-4 pb-24">
            {(submitted || category) && <nav aria-label="TVBox 分类位置" className="movies-context-nav">
              <Button onClick={leaveContext} aria-label={contextBackLabel} className="movies-context-back pressable">
                <IBack size={16} /><span>{contextBackLabel}</span>
              </Button>
              <div className="movies-context-copy">
                <h2>{contextTitle}</h2>
                <p>{source.name}{categoryName ? ` · ${categoryName}` : " · 全部分类"}</p>
              </div>
            </nav>}
            {!submitted && !category ? (
              <>
                {cards.length > 0 && <section aria-label="源推荐" className="mb-5">
                  <MoviesShelfHeading title="源推荐" subtitle={`${source.name} · 数据源首页内容`} />
                  <TVBoxVideoRail items={videos} source={source} ranking={ranking} onOpen={openVideoList} />
                </section>}
                {categories.map(item => {
                  const shelf = shelves[item.id];
                  return <section key={item.id} aria-label={item.name} className="mb-5">
                    <MoviesShelfHeading title={item.name} subtitle={`${source.name} · 源分类`}
                      actionLabel="查看全部" actionAriaLabel={`查看全部${item.name}`}
                      onAction={() => chooseCategory(item.id)} />
                    {shelf?.items.length ? <TVBoxVideoRail items={shelf.items} source={source} ranking={ranking} onOpen={openVideoList} />
                      : shelf?.loading ? <div role="status" aria-label={`正在加载${item.name}`} className="flex h-[150px] items-center justify-center"><Loader className="h-7 w-7 spinner" /></div>
                        : shelf?.error ? <div className="flex min-h-[92px] items-center gap-3 rounded-(--r-sm) bg-s2 px-3 text-[12px] text-mut">
                          <span className="min-w-0 flex-1">{shelf.error}</span>
                          <Button onClick={() => setShelfReload(value => value + 1)} className="shrink-0 text-primary pressable">重试</Button>
                        </div>
                          : <p className="px-1 py-4 text-[12px] text-dim">此分类暂无影视</p>}
                  </section>;
                })}
                {!cards.length && !categories.length && loading && <div role="status" className="flex justify-center py-12"><Loader className="h-8 w-8 spinner" /></div>}
                {!cards.length && !categories.length && !loading && <Empty icon={<ISearch size={26} />} title={error || "此分类暂无影视"}
                  sub={error ? "检查网络或数据源地址后重试" : "换一个分类，或搜索影片名称"}
                  action={error ? "重试" : undefined} onAction={error ? () => void loadPage(submitted, 1) : undefined} />}
              </>
            ) : cards.length > 0 ? (
              <>
                <p className="mb-2 text-[12px] text-mut">{source.name}{submitted ? ` · 搜索“${submitted}”` : " · 影视目录"} · 点击封面查看详情</p>
                <Masonry videos={visibleCards} wide={wide} onOpen={card => {
                  const selected = videos.find(video => video.localId === card.id);
                  if (selected) openVideoList(videos, selected);
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
              {loading && (cards.length > 0 || submitted || category) ? <Loader className="h-6 w-6 spinner" />
                : page < pages ? <Button onClick={() => void loadPage(submitted, page + 1)}
                  className="h-9 rounded-(--r-ctl) bg-s2 px-5 text-[13px] text-on/85 pressable">加载更多</Button>
                  : cards.length > 0 && (submitted || category) ? <span className="text-[12px] text-dim">— 已经到底啦 —</span> : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
