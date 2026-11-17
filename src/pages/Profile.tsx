import { Button, SegmentedControl, Surface } from "../components/ios/controls";
import { Loader } from "../components/ios/effects";
import { useEffect, useState } from "react";
import { api, APP_VERSION, fmt, fmtTime, isMobile, platform } from "../api";
import type { Detail } from "../types";
import { useStore } from "../store";
import { Avatar, Empty } from "../components/ui";
import { MediaCard } from "../components/cards";
import { CollectionLink, CollectionLinks } from "../components/CollectionLink";
import {
  clearTVBoxHistory, loadTVBoxFavorites, loadTVBoxHistory, TVBOX_LIBRARY_EVENT,
  tvboxVideoCard, type TVBoxLibraryEntry,
} from "../tvbox";
import { IChevR, IClock, IHeart, ILogout, ISettings, IStar, IUser, IUserF } from "../icons";

type ProfileItem =
  | { kind: "hghubx"; card: Detail; progress?: { ep: number; t: number; dur: number } }
  | { kind: "tvbox"; entry: TVBoxLibraryEntry };

/* 我的：结构固定（资料卡 + 我的收藏 / 观看历史）。
   收藏与观看记录都存在本地，所以未登录也照常展示；未登录时资料卡本身就是登录入口。 */
export default function Profile({ wide }: { wide: boolean }) {
  const { user, setLoginOpen, logout, history, favs, clearHistory, push } = useStore();
  const [tab, setTab] = useState<"fav" | "history">("fav");
  const [tvboxFavorites, setTVBoxFavorites] = useState<TVBoxLibraryEntry[]>(loadTVBoxFavorites);
  const [tvboxHistory, setTVBoxHistory] = useState<TVBoxLibraryEntry[]>(loadTVBoxHistory);
  const [hghubxItems, setHGhubxItems] = useState<ProfileItem[]>([]);
  const [loading, setLoading] = useState(false);

  const reloadTVBoxLibrary = () => {
    setTVBoxFavorites(loadTVBoxFavorites());
    setTVBoxHistory(loadTVBoxHistory());
  };
  const localEntries = (tab === "fav" ? tvboxFavorites : tvboxHistory).slice(0, 12);
  const localEntryKey = localEntries.map((entry) => `${entry.source.id}:${entry.video.id}`).join(",");

  useEffect(() => {
    reloadTVBoxLibrary();
    const onLibraryChange = () => reloadTVBoxLibrary();
    window.addEventListener(TVBOX_LIBRARY_EVENT, onLibraryChange);
    return () => window.removeEventListener(TVBOX_LIBRARY_EVENT, onLibraryChange);
  }, []);

  useEffect(() => {
    let alive = true;
    const localEntries = (tab === "fav" ? tvboxFavorites : tvboxHistory).slice(0, 12);
    const hghubxIds = tab === "fav" ? favs : history.map((h) => h.id);
    const limitedIds = hghubxIds.slice(0, Math.max(0, 12 - localEntries.length));
    if (!limitedIds.length) {
      setHGhubxItems([]);
      setLoading(false);
      return () => { alive = false; };
    }
    setLoading(true);
    Promise.allSettled(limitedIds.map((id) => api.video(id)))
      .then((rs) => {
        if (!alive) return;
        const loaded: ProfileItem[] = rs
          .filter((r): r is PromiseFulfilledResult<Detail> => r.status === "fulfilled")
          .map((r) => {
            const progress = tab === "history" ? history.find((h) => h.id === r.value.id) : undefined;
            return { kind: "hghubx", card: r.value, progress };
          });
        setHGhubxItems(loaded);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tab, favs.join(","), history.map((h) => `${h.id}:${h.ep}:${h.t}:${h.dur}`).join(","), localEntryKey]);

  const items: ProfileItem[] = [...localEntries.map((entry) => ({ kind: "tvbox" as const, entry })), ...hghubxItems].slice(0, 12);

  const clearAllHistory = () => {
    clearHistory();
    clearTVBoxHistory();
    reloadTVBoxLibrary();
  };
  const localFavoriteCount = tvboxFavorites.length;
  const localHistoryCount = tvboxHistory.length;

  const openTVBox = (entry: TVBoxLibraryEntry) => {
    const { source, video } = entry;
    push({
      kind: "feed", videoIds: [video.localId], index: 0, title: tab === "fav" ? "我的收藏" : "观看历史", tvboxSource: source,
      tvboxItems: [video], startEp: tab === "history" ? entry.ep : undefined,
      startTime: tab === "history" ? entry.t : undefined,
    });
  };

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-page-heading shrink-0 px-4 flex items-center">
        <div className="ios-page-title text-on">我的</div>
        {isMobile && (
          <Button onClick={() => push({ kind: "settings" })} aria-label="设置" className="ios-icon-button ml-auto">
            <ISettings size={17} strokeWidth={1.7} />
          </Button>
        )}
      </div>

      <div className="ios-page-body flex-1 scroll-y px-4 pt-2 pb-24">
        {user ? (
          <Surface className="ios-account-card flex items-center gap-3.5 a-rise">
            <Avatar size={56} name={user.nickname} hue={280} ring />
            <div className="flex-1 min-w-0">
              <div className="text-[16px] font-bold text-on truncate">{user.nickname}</div>
              <div className="text-[12px] text-mut mt-0.5">@{user.username} · ID {user.id}</div>
              <div className="flex gap-3 mt-2 text-[12px] text-mut">
                <span>点赞 <b className="text-on">{fmt(user.counts?.like)}</b></span>
                <span>收藏 <b className="text-on">{fmt((user.counts?.collect || 0) + localFavoriteCount)}</b></span>
                <span>观看 <b className="text-on">{fmt(localHistoryCount + history.length)}</b></span>
              </div>
            </div>
            <Button onClick={async () => { await logout(); }} className="ios-icon-button" aria-label="退出登录"><ILogout size={17} /></Button>
          </Surface>
        ) : (
          <Button onClick={() => setLoginOpen(true)} className="ios-account-card w-full text-left flex items-center gap-3.5 pressable a-rise">
            <Avatar size={56} icon={<IUser size={26} />} hue={220} ring />
            <div className="flex-1 min-w-0">
              <div className="text-[16px] font-bold text-on">未登录</div>
              <div className="text-[12px] text-mut mt-0.5">登录后可同步点赞、收藏与评论</div>
              <div className="flex gap-3 mt-2 text-[12px] text-mut">
                <span>收藏 <b className="text-on">{favs.length + localFavoriteCount}</b></span>
                <span>观看 <b className="text-on">{history.length + localHistoryCount}</b></span>
              </div>
            </div>
            <span className="flex items-center gap-0.5 h-8 pl-3 pr-2 rounded-full bg-primary text-on-primary text-[12px] font-semibold">登录<IChevR size={13} /></span>
          </Button>
        )}

        {user && (
          <CollectionLinks className="ios-profile-links mt-4">
            <CollectionLink icon={<IHeart size={18} />} title="我的关注" subtitle="关注作者的更新" onClick={() => push({ kind: "following" })} />
            <CollectionLink icon={<IUserF size={18} />} title="我的主页" subtitle="我的作品与资料" onClick={() => push({ kind: "user", id: user.id, name: user.nickname })} />
          </CollectionLinks>
        )}

        <SegmentedControl className="mt-4" aria-label="我的内容" activeIndex={tab === "fav" ? 0 : 1}>
          {([ ["fav", "我的收藏"], ["history", "观看历史"] ] as const).map(([k, l]) => (
            <Button aria-pressed={tab === k} key={k} onClick={() => setTab(k)}>{l}</Button>
          ))}
        </SegmentedControl>

        <div className="mt-3">
          {loading ? (
            <div className="flex justify-center py-8"><Loader className="w-7 h-7 spinner" /></div>
          ) : items.length ? (
            <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
              {items.map((item) => {
                if (item.kind === "tvbox") {
                  const { entry } = item;
                  const card = tvboxVideoCard(entry.video, entry.source);
                  return <MediaCard key={`${entry.source.id}:${entry.video.id}`} title={entry.video.title} cover={card.cover}
                    score={entry.video.score} badge={entry.video.status || entry.video.remarks || undefined}
                    subtitle={[entry.video.year, entry.video.area].filter(Boolean).join(" · ") || entry.source.name}
                    progress={tab === "history" ? `第 ${entry.ep} 集 · ${fmtTime(entry.t)}${entry.dur > 0 ? ` / ${fmtTime(entry.dur)}` : ""}` : undefined}
                    onOpen={() => openTVBox(entry)} />;
                }
                const { card, progress } = item;
                return <MediaCard key={card.id} title={card.title} cover={card.cover} score={card.score}
                  badge={card.is_finished ? "已完结" : `${card.episode_count} 集`}
                  subtitle={card.tags?.slice(0, 2).join(" · ")}
                  progress={progress ? `第 ${progress.ep} 集 · ${fmtTime(progress.t)}` : undefined}
                  onOpen={() => push({ kind: "feed", videoIds: items.filter((x): x is Extract<ProfileItem, { kind: "hghubx" }> => x.kind === "hghubx").map((x) => x.card.id), index: items.filter((x) => x.kind === "hghubx").findIndex((x) => x.kind === "hghubx" && x.card.id === card.id), title: tab === "fav" ? "我的收藏" : "观看历史", startEp: progress?.ep, startTime: progress?.t })} />;
              })}
            </div>
          ) : (
            <Empty icon={tab === "fav" ? <IStar size={24} /> : <IClock size={24} />} title={tab === "fav" ? "还没有收藏" : "还没有观看记录"}
              sub={tab === "fav" ? "在剧集页点收藏，之后就能在这里找到" : "看过的剧集会出现在这里"} action="去逛逛" onAction={() => push({ kind: "ranks" })} />
          )}
          {items.length > 0 && tab === "history" && (
            <Button onClick={clearAllHistory} className="mt-3 w-full h-9 rounded-(--r-ctl) bg-s3 text-[13px] text-mut pressable">清空观看历史</Button>
          )}
        </div>

        <div className="text-center text-[12px] text-dim mt-5">HGhubX {APP_VERSION} · {platform === "android" ? "Android" : platform === "ios" ? "iOS" : platform === "macos" ? "macOS" : platform === "linux" ? "Linux" : "Windows"} 客户端</div>
      </div>
    </div>
  );
}
