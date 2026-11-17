import { useEffect, useMemo, useState } from "react";
import LivePlayer from "../components/LivePlayer";
import { Button, Form, Input, Surface } from "../components/ios/controls";
import { Empty } from "../components/ui";
import { IClapper, IClose, IRefresh, ISearch, IStar, IStarF } from "../icons";
import {
  activeLiveSource,
  channelFavKey,
  filterLiveChannels,
  isLiveFav,
  LIVE_FAVS_EVENT,
  LIVE_SOURCE_EVENT,
  liveLogoUrl,
  livePlaybackSource,
  loadLiveFavs,
  loadLiveSources,
  refreshLiveSource,
  selectLiveSource,
  toggleLiveFav,
  type LiveChannel,
  type LiveSource,
} from "../live";
import { useStore } from "../store";

export default function LivePage({
  active,
}: {
  active: boolean;
}) {
  const { push } = useStore();
  const [sources, setSources] = useState<LiveSource[]>(loadLiveSources);
  const [source, setSource] = useState<LiveSource | null>(activeLiveSource);
  const [favs, setFavs] = useState<string[]>(loadLiveFavs);
  const [group, setGroup] = useState<string>("all");
  const [keyword, setKeyword] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string>("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [brokenLogos, setBrokenLogos] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const syncSources = () => {
      const all = loadLiveSources();
      let current = activeLiveSource(all);
      if (!current && all[0]) {
        selectLiveSource(all[0].id);
        current = activeLiveSource(all);
      }
      setSources(all);
      setSource(current);
      setRefreshError("");
    };
    const syncFavs = () => setFavs(loadLiveFavs());
    window.addEventListener(LIVE_SOURCE_EVENT, syncSources);
    window.addEventListener(LIVE_FAVS_EVENT, syncFavs);
    return () => {
      window.removeEventListener(LIVE_SOURCE_EVENT, syncSources);
      window.removeEventListener(LIVE_FAVS_EVENT, syncFavs);
    };
  }, []);

  // Reset group filter if current source no longer has that group.
  useEffect(() => {
    if (!source) {
      setGroup("all");
      return;
    }
    if (group !== "all" && group !== "fav" && !source.groups.includes(group)) {
      setGroup("all");
    }
  }, [source, group]);

  const filteredChannels = useMemo(
    () => (source ? filterLiveChannels(source.channels, { group, keyword, favs }) : []),
    [source, group, keyword, favs],
  );

  // The selected channel must always belong to the visible filter pool. This also
  // clears the player when a filter has no matches, without an effect loop.
  useEffect(() => {
    const nextId = filteredChannels[0]?.id ?? "";
    if (!filteredChannels.some((ch) => ch.id === selectedId)) setSelectedId(nextId);
  }, [filteredChannels, selectedId]);

  const favCountInSource = useMemo(() => {
    if (!source) return 0;
    const favSet = new Set(favs);
    return source.channels.filter((ch) => favSet.has(channelFavKey(ch))).length;
  }, [source, favs]);

  const currentChannel: LiveChannel | null = useMemo(() => {
    if (!source) return null;
    return filteredChannels.find((ch) => ch.id === selectedId) ?? null;
  }, [source, filteredChannels, selectedId]);

  const switchPool = filteredChannels;
  const currentPoolIndex = currentChannel
    ? switchPool.findIndex((ch) => ch.id === currentChannel.id)
    : -1;

  const stepChannel = (delta: number) => {
    if (!switchPool.length) return;
    const baseIndex = currentPoolIndex >= 0 ? currentPoolIndex : 0;
    const nextIndex = (baseIndex + delta + switchPool.length) % switchPool.length;
    const nextChannel = switchPool[nextIndex];
    if (nextChannel) setSelectedId(nextChannel.id);
  };

  const handleRefresh = async () => {
    if (!source?.url || refreshing) return;
    setRefreshing(true);
    setRefreshError("");
    try {
      await refreshLiveSource(source);
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : "刷新直播订阅失败");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 px-4 pt-3 pb-2.5" style={{ paddingTop: "calc(var(--sat, 0px) + 12px)" }}>
        <div className="flex items-end gap-2.5 mb-2.5">
          <h1 className="ios-page-title text-on">直播</h1>
          <span className="text-[12px] text-mut pb-0.5">APTV / M3U 电视直播 · 通用订阅播放</span>
        </div>

        {!!sources.length && (
          <div className="mt-2.5 flex items-center gap-2">
            <select
              aria-label="直播数据源"
              value={source?.id ?? ""}
              onChange={(e) => selectLiveSource(e.target.value)}
              className="h-10 min-w-0 flex-1 rounded-(--r-ctl) bg-s2 px-3 text-[13px] text-on outline-none"
            >
              {sources.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}（{item.channels.length} 台）
                </option>
              ))}
            </select>
            {source?.url && (
              <Button
                type="button"
                aria-label="刷新当前直播源"
                disabled={refreshing}
                onClick={() => void handleRefresh()}
                className="h-10 shrink-0 rounded-(--r-ctl) bg-s2 px-3 text-[12px] text-on/85 flex items-center gap-1.5 pressable disabled:opacity-50"
              >
                <IRefresh size={15} className={refreshing ? "animate-spin" : ""} />
                <span>{refreshing ? "更新中" : "刷新"}</span>
              </Button>
            )}
          </div>
        )}
        {refreshError && (
          <div role="alert" className="mt-2 rounded-(--r-sm) bg-danger/15 px-3 py-2 text-[12px] text-danger flex items-center justify-between gap-2">
            <span className="truncate">{refreshError}</span>
            <Button type="button" onClick={() => void handleRefresh()} className="shrink-0 font-semibold underline">
              重试
            </Button>
          </div>
        )}
      </div>

      {!source ? (
        <div className="flex-1 scroll-y px-4 pb-24 pt-2">
          <Surface role="region" aria-label="添加 M3U 直播源" className="rounded-(--r-md) bg-s2 p-5 text-center">
            <div className="mx-auto grid size-12 place-items-center rounded-full bg-primary/15 text-primary">
              <IClapper size={23} />
            </div>
            <h2 className="mt-3 text-[16px] font-semibold text-on">先添加一个 APTV / M3U 直播源</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-mut">
              支持通用 Extended M3U（.m3u / .m3u8）订阅链接或本地文本/文件导入，兼容 APTV 使用的通用 M3U 订阅。不支持 APTV 私有加密配置；应用不内置未经请求的第三方直播频道。
            </p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-dim">
              仅提供直播流播放、分组筛选与频道收藏；不提供 EPG 节目单、时移、回看、录制或投屏。
            </p>
            <Button
              onClick={() => push({ kind: "settings" })}
              className="mt-4 h-10 w-full rounded-(--r-ctl) bg-primary px-4 text-[13px] font-semibold text-on-primary pressable"
            >
              前往设置管理直播源
            </Button>
          </Surface>
        </div>
      ) : (
        <div className="flex-1 scroll-y px-4 pb-24 pt-1 space-y-3">
          {currentChannel && (
            <LivePlayer
              src={active ? livePlaybackSource(currentChannel, source) : ""}
              channel={currentChannel}
              active={active}
              isFavorite={isLiveFav(currentChannel, favs)}
              canSwitchChannel={switchPool.length > 1}
              channelPositionText={
                currentPoolIndex >= 0 ? `${currentPoolIndex + 1} / ${switchPool.length}` : undefined
              }
              onToggleFavorite={() => toggleLiveFav(currentChannel)}
              onPrevChannel={() => stepChannel(-1)}
              onNextChannel={() => stepChannel(1)}
            />
          )}

          {/* Channel Search */}
          <Form
            className="ios-search-form flex items-center gap-2"
            onSubmit={(e) => e.preventDefault()}
          >
            <ISearch size={17} className="shrink-0 text-mut" />
            <Input
              aria-label="搜索直播频道"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索频道名称或分组…"
              className="min-w-0 flex-1 bg-transparent text-[14px] text-on placeholder-dim outline-none"
            />
            {keyword && (
              <Button
                type="button"
                aria-label="清除频道搜索"
                onClick={() => setKeyword("")}
                className="ios-icon-button"
              >
                <IClose size={16} />
              </Button>
            )}
          </Form>

          {/* Group & Favorites Filter Pills */}
          <div
            className="flex gap-2 overflow-x-auto pb-1 no-bar"
            role="group"
            aria-label="直播频道分组"
          >
            <Button
              aria-pressed={group === "all"}
              onClick={() => setGroup("all")}
              className={`h-8 shrink-0 rounded-(--r-ctl) px-3 text-[12px] pressable ${
                group === "all" ? "bg-primary text-on-primary" : "bg-s2 text-on/80"
              }`}
            >
              全部 ({source.channels.length})
            </Button>
            <Button
              aria-pressed={group === "fav"}
              onClick={() => setGroup("fav")}
              className={`h-8 shrink-0 rounded-(--r-ctl) px-3 text-[12px] pressable flex items-center gap-1 ${
                group === "fav" ? "bg-primary text-on-primary" : "bg-s2 text-on/80"
              }`}
            >
              <IStar size={13} />
              <span>收藏 ({favCountInSource})</span>
            </Button>
            {source.groups.map((grp) => (
              <Button
                key={grp}
                aria-pressed={group === grp}
                onClick={() => setGroup(grp)}
                className={`h-8 shrink-0 rounded-(--r-ctl) px-3 text-[12px] pressable ${
                  group === grp ? "bg-primary text-on-primary" : "bg-s2 text-on/80"
                }`}
              >
                {grp}
              </Button>
            ))}
          </div>

          {/* Channel List */}
          {!filteredChannels.length ? (
            <div className="py-6 text-center">
              <Empty
                icon={<IClapper size={26} />}
                title={
                  group === "fav"
                    ? "还没有收藏的直播频道"
                    : keyword
                      ? "没有匹配的直播频道"
                      : "当前分组下没有直播频道"
                }
                sub={group === "fav" ? "点击频道右侧星标即可加入收藏" : "试试其他关键词或切换回全部分组"}
              />
              {(group !== "all" || keyword) && (
                <Button
                  type="button"
                  onClick={() => {
                    setGroup("all");
                    setKeyword("");
                  }}
                  className="mt-2 h-8 rounded-(--r-ctl) bg-s2 px-3.5 text-[12px] text-primary pressable"
                >
                  查看全部频道
                </Button>
              )}
            </div>
          ) : (
            <div role="list" aria-label="直播频道列表" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {filteredChannels.map((ch) => {
                const selected = currentChannel?.id === ch.id;
                const fav = isLiveFav(ch, favs);
                const logoSrc = ch.logo && !brokenLogos[ch.id] ? liveLogoUrl(ch, source) : "";
                return (
                  <div
                    key={ch.id}
                    role="listitem"
                    className={`flex items-center gap-2.5 rounded-(--r-md) p-2.5 border transition ${
                      selected
                        ? "bg-primary/14 border-primary/45"
                        : "bg-s2/90 border-white/6 hover:bg-s2"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedId(ch.id)}
                      className="flex-1 min-w-0 flex items-center gap-2.5 text-left"
                    >
                      <div className="w-10 h-10 rounded-xl bg-black/35 border border-white/8 flex items-center justify-center shrink-0 overflow-hidden">
                        {logoSrc ? (
                          <img
                            src={logoSrc}
                            alt={ch.name}
                            loading="lazy"
                            onError={() => setBrokenLogos((m) => ({ ...m, [ch.id]: true }))}
                            className="w-full h-full object-contain p-1"
                          />
                        ) : (
                          <span className="text-[12px] font-bold text-mut">
                            {ch.name.slice(0, 2).toUpperCase()}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[14px] font-semibold text-on truncate">{ch.name}</span>
                          {selected && (
                            <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-on-primary">
                            已选择
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-mut truncate">
                          <span>{ch.group}</span>
                          {ch.tvgName && ch.tvgName !== ch.name && <span>· {ch.tvgName}</span>}
                        </div>
                      </div>
                    </button>

                    <Button
                      type="button"
                      aria-label={fav ? `取消收藏 ${ch.name}` : `收藏 ${ch.name}`}
                      aria-pressed={fav}
                      onClick={() => toggleLiveFav(ch)}
                      className={`p-2 rounded-full shrink-0 pressable ${
                        fav ? "text-amber-400" : "text-mut hover:text-on"
                      }`}
                    >
                      {fav ? <IStarF size={17} /> : <IStar size={17} />}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Compliance and scope notice */}
          <div className="pt-2 pb-2 text-[11px] leading-relaxed text-dim text-center">
            仅支持通用 Extended M3U（.m3u / .m3u8）直播订阅播放，不支持 APTV 私有加密配置，不提供 EPG 节目单、时移、回看、录制或投屏。第三方直播源内容与可用性由用户自行导入的源站提供。
          </div>
        </div>
      )}
    </div>
  );
}
