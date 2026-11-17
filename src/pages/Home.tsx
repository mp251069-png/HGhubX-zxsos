import { Loader } from "../components/ios/effects";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Feed from "../components/Feed";
import { api } from "../api";
import type { VideoCard } from "../types";
import { useStore } from "../store";
import { ISearch } from "../icons";
import { Empty } from "../components/ui";

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
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(1);
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
  const reloadAfterLineChange = useRef(false);

  const load = useCallback(async (p: number): Promise<void> => {
    if (loadingRef.current || (done && p > 1)) return;
    const requestEpoch = lineEpochRef.current;
    const requestId = ++requestSeq.current;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    try {
      const res = await api.feed(p, 30);
      if (requestId !== requestSeq.current || requestEpoch !== lineEpochRef.current) return;
      const list = res?.items || [];
      const ordered = p === 1 ? shuffle(list) : list;
      setItems((prev) => {
        const base = p === 1 ? [] : prev;
        const seen = new Set(base.map((x) => x.id));
        return [...base, ...ordered.filter((x) => !seen.has(x.id))];
      });
      setPage(p);
      failStreak.current = 0;
      retryAt.current = 0;
      if (!list.length || (res?.pagination && p >= res.pagination.pages)) setDone(true);
    } catch (e) {
      const stale = requestId !== requestSeq.current || requestEpoch !== lineEpochRef.current;
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
  }, [done, toast]);

  useEffect(() => { if (!items.length) void load(1); /* eslint-disable-next-line */ }, []);

  /* 切换数据线路后丢弃旧首页结果，避免继续刷到上一条线路的缓存；隐藏时延迟请求到重新进入首页。 */
  useEffect(() => {
    if (previousLineEpoch.current !== lineEpoch) {
      previousLineEpoch.current = lineEpoch;
      requestSeq.current += 1;
      loadingRef.current = false;
      setLoading(false);
      setItems([]);
      setPage(1);
      setDone(false);
      setError("");
      retryAt.current = 0;
      failStreak.current = 0;
      reloadAfterLineChange.current = true;
    }
    if (reloadAfterLineChange.current && active) {
      reloadAfterLineChange.current = false;
      void load(1);
    }
  }, [active, lineEpoch, load]);

  const ids = useMemo(() => items.map((v) => v.id), [items]);

  return (
    <div className="absolute inset-0 bg-black">
      {items.length ? (
        <Feed videoIds={ids} mode="home" active={active} bottomInset={bottomInset}
          onNearEnd={() => { if (!loading && !done && Date.now() >= retryAt.current) void load(page + 1); }} />
      ) : !loading && error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg">
          <Empty icon={<ISearch size={26} />} title="首页加载失败" sub={error} action="重试" onAction={() => void load(1)} />
        </div>
      ) : !loading && done ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg"><Empty icon={<ISearch size={26} />} title="暂无视频" /></div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center"><Loader className="w-9 h-9 spinner" /></div>
      )}
    </div>
  );
}
