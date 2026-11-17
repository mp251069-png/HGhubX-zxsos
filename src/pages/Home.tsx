import { Loader } from "../components/ios/effects";
import { useCallback, useEffect, useRef, useState } from "react";
import Feed from "../components/Feed";
import { api } from "../api";
import type { VideoCard } from "../types";
import { useStore } from "../store";
import { ISearch } from "../icons";
import { Empty } from "../components/ui";
import {
  activeTVBoxSource,
  TVBOX_SOURCE_EVENT,
  tvboxList,
  type TVBoxSource,
  type TVBoxVideo,
} from "../tvbox";
import { BROWSE_MODE_EVENT, currentBrowseMode, type BrowseMode } from "../browseMode";

/* Fisher-Yates 洗牌：首页第一页随机打乱，避免每次进来都停在同一个 top1 */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function Home({ active, bottomInset }: { active: boolean; bottomInset: number }) {
  const { toast, lineEpoch } = useStore();
  const [mode, setMode] = useState<BrowseMode>(currentBrowseMode);
  const [tvboxSource, setTVBoxSource] = useState<TVBoxSource | null>(activeTVBoxSource);
  const [items, setItems] = useState<VideoCard[]>([]);
  const [tvboxItems, setTVBoxItems] = useState<TVBoxVideo[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const loadingRef = useRef(false);
  /* 翻页失败退避：失败后 5 秒内不再因滚动触发重试，连续失败只提示一次 */
  const retryAt = useRef(0);
  const failStreak = useRef(0);
  const lineEpochRef = useRef(lineEpoch);
  lineEpochRef.current = lineEpoch;
  const previousLineEpoch = useRef(lineEpoch);
  const requestSeq = useRef(0);
  const reloadAfterChange = useRef(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const resetResults = useCallback(() => {
    requestSeq.current += 1;
    loadingRef.current = false;
    setLoading(false);
    setItems([]);
    setTVBoxItems([]);
    setPage(1);
    setPages(1);
    setDone(false);
    setError("");
    retryAt.current = 0;
    failStreak.current = 0;
  }, []);

  const load = useCallback(async (p: number): Promise<void> => {
    if (loadingRef.current || (done && p > 1)) return;
    const requestEpoch = lineEpochRef.current;
    const requestMode = modeRef.current;
    const requestSource = tvboxSource;
    if (requestMode === "tvbox" && !requestSource) { setDone(true); return; }
    const requestSourceId = requestSource?.id ?? "";
    const requestId = ++requestSeq.current;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    try {
      if (requestMode === "tvbox" && requestSource) {
        const res = await tvboxList(requestSource, p);
        if (requestId !== requestSeq.current || requestMode !== modeRef.current
          || requestSourceId !== (tvboxSource?.id ?? "")) return;
        const nextItems = res.items;
        setTVBoxItems((prev) => {
          const base = p === 1 ? [] : prev;
          const seen = new Set(base.map((item) => item.localId));
          return [...base, ...nextItems.filter((item) => !seen.has(item.localId))];
        });
        setPage(p);
        setPages(Math.max(1, res.pages));
        setDone(!nextItems.length || p >= res.pages);
      } else {
        const res = await api.feed(p, 30);
        if (requestId !== requestSeq.current || requestEpoch !== lineEpochRef.current
          || requestMode !== modeRef.current) return;
        const list = res?.items || [];
        const ordered = p === 1 ? shuffle(list) : list;
        setItems((prev) => {
          const base = p === 1 ? [] : prev;
          const seen = new Set(base.map((x) => x.id));
          return [...base, ...ordered.filter((x) => !seen.has(x.id))];
        });
        setPage(p);
        setPages(Math.max(1, res?.pagination?.pages || 1));
        setDone(!list.length || (res?.pagination && p >= res.pagination.pages));
      }
      failStreak.current = 0;
      retryAt.current = 0;
    } catch (e) {
      const stale = requestId !== requestSeq.current || requestMode !== modeRef.current
        || (requestMode === "tvbox" && requestSourceId !== (tvboxSource?.id ?? ""))
        || (requestMode === "category" && requestEpoch !== lineEpochRef.current);
      if (!stale) {
        const message = (e as Error).message || "加载失败";
        setError(message);
        if (p > 1) retryAt.current = Date.now() + 5000;
        if (failStreak.current++ === 0) toast(message, "info");
      }
    } finally {
      if (requestId === requestSeq.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [done, toast, tvboxSource]);

  /* 影视页模式为来源唯一依据；切源/导入后首页同步同一 TVBox 源。 */
  useEffect(() => {
    const syncSource = () => {
      const current = activeTVBoxSource();
      setTVBoxSource(current);
      resetResults();
      reloadAfterChange.current = true;
    };
    window.addEventListener(TVBOX_SOURCE_EVENT, syncSource);
    return () => window.removeEventListener(TVBOX_SOURCE_EVENT, syncSource);
  }, [resetResults]);

  /* 首页跟随影视页的 HGhubX/TVBox 选择，不维护独立来源模式。 */
  useEffect(() => {
    const syncMode = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      const next = detail === "tvbox" || detail === "category" ? detail : currentBrowseMode();
      if (next === modeRef.current) return;
      modeRef.current = next;
      setMode(next);
      resetResults();
      reloadAfterChange.current = true;
    };
    window.addEventListener(BROWSE_MODE_EVENT, syncMode);
    return () => window.removeEventListener(BROWSE_MODE_EVENT, syncMode);
  }, [resetResults]);

  /* 切换数据线路后丢弃旧首页结果；TVBox API 不依赖 HGhubX 主线路。 */
  useEffect(() => {
    if (previousLineEpoch.current !== lineEpoch) {
      previousLineEpoch.current = lineEpoch;
      if (modeRef.current === "category") {
        resetResults();
        reloadAfterChange.current = true;
      }
    }
    if (reloadAfterChange.current && active) {
      reloadAfterChange.current = false;
      void load(1);
    }
  }, [active, lineEpoch, load, resetResults]);

  /* 切换模式后从第一页加载；直接复用新状态，避免旧模式闭包发出错误请求。 */
  useEffect(() => {
    if (!items.length && !tvboxItems.length && !loading && (active || !reloadAfterChange.current)) void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, mode, tvboxSource?.id]);

  const feedIds = mode === "tvbox" ? tvboxItems.map((video) => video.localId) : items.map((video) => video.id);
  const hasItems = feedIds.length > 0;
  const feedKey = `${mode}:${tvboxSource?.id ?? "hghubx"}:${lineEpoch}`;
  const canLoadMore = !done && page < pages;

  return (
    <div className="absolute inset-0 bg-black">
      {mode === "tvbox" && tvboxSource && (
        <div className="absolute left-3 right-3 z-10 grid gap-2" style={{ top: "calc(var(--sat, 0px) + 8px)" }}>
          <div className="px-1 text-[11px] text-mut">影视页当前来源 · TVBox · {tvboxSource.name}</div>
        </div>
      )}
      {hasItems ? (
        <Feed key={feedKey} videoIds={feedIds} mode="home" active={active} bottomInset={bottomInset}
          tvboxSource={mode === "tvbox" ? tvboxSource ?? undefined : undefined}
          tvboxItems={mode === "tvbox" ? tvboxItems : undefined}
          onNearEnd={() => { if (!loading && canLoadMore && Date.now() >= retryAt.current) void load(page + 1); }} />
      ) : !loading && error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg"><Empty icon={<ISearch size={26} />} title="首页加载失败" sub={error} action="重试" onAction={() => void load(1)} /></div>
      ) : !loading && done ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg"><Empty icon={<ISearch size={26} />}
          title={mode === "tvbox" && !tvboxSource ? "尚未选择 TVBox 源" : "暂无视频"}
          sub={mode === "tvbox" && !tvboxSource ? "请在影视页添加或选择 TVBox 源" : undefined} /></div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center"><Loader className="w-9 h-9 spinner" /></div>
      )}
    </div>
  );
}

