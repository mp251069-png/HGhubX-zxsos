import { useEffect, useRef, useState } from "react";
import { isIos } from "../api";
import { IClose, ICompress, IExpand, IPauseF, IPlayF, IStar, IStarF, IVol, IVolMute } from "../icons";
import { liveFormatSupportError, type LiveChannel } from "../live";
import VideoSurface, { type VideoHandle } from "./VideoSurface";

interface Props {
  src: string;
  channel: LiveChannel;
  active?: boolean;
  isFavorite: boolean;
  canSwitchChannel: boolean;
  channelPositionText?: string;
  onToggleFavorite: () => void;
  onPrevChannel: () => void;
  onNextChannel: () => void;
}

export default function LivePlayer({
  src,
  channel,
  active = true,
  isFavorite,
  canSwitchChannel,
  channelPositionText,
  onToggleFavorite,
  onPrevChannel,
  onNextChannel,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<VideoHandle>(null);
  const hideTimer = useRef<number | null>(null);

  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [showCtrl, setShowCtrl] = useState(true);
  const [fs, setFs] = useState(false);
  const [retrySeq, setRetrySeq] = useState(0);
  const formatErr = liveFormatSupportError(channel);
  const displayError = formatErr || err;

  const poke = () => {
    setShowCtrl(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setShowCtrl(false), 3600);
  };

  useEffect(() => {
    setErr(null);
    setWaiting(true);
    setPlaying(false);
    setRetrySeq(0);
    poke();
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [channel.id, src]);

  useEffect(() => {
    const onFs = () => setFs(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const retryStream = () => {
    setErr(null);
    setWaiting(true);
    setRetrySeq((n) => n + 1);
    poke();
  };

  const toggleFullscreen = async () => {
    const el = wrapRef.current;
    const v = videoRef.current?.el() as (HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
      webkitExitFullscreen?: () => void;
    }) | null;
    if (!el) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (isIos && v?.webkitEnterFullscreen) {
        v.webkitEnterFullscreen();
      } else if (el.requestFullscreen) {
        await el.requestFullscreen();
      } else if (v?.webkitEnterFullscreen) {
        v.webkitEnterFullscreen();
      }
    } catch {
      if (v?.webkitEnterFullscreen) {
        try { v.webkitEnterFullscreen(); } catch { /* ignore */ }
      }
    }
  };

  return (
    <div
      ref={wrapRef}
      onMouseMove={poke}
      onTouchStart={poke}
      data-testid="live-player"
      className="relative w-full aspect-video bg-black select-none overflow-hidden rounded-2xl border border-white/10"
    >
      <VideoSurface
        key={`${channel.id}-${retrySeq}`}
        ref={videoRef}
        src={formatErr ? "" : src}
        active={active}
        diagnosticContext={{ surface: "live_player", channelId: channel.id, group: channel.group }}
        muted={muted}
        loop={false}
        onPlaying={() => {
          setPlaying(true);
          setWaiting(false);
          setErr(null);
        }}
        onPause={() => setPlaying(false)}
        onWaiting={() => setWaiting(true)}
        onError={(m) => {
          setErr(m);
          setWaiting(false);
        }}
        onClick={() => {
          poke();
          videoRef.current?.toggle();
        }}
      />

      {/* Top status bar: LIVE badge + channel title + favorite */}
      <div
        className={`absolute inset-x-0 top-0 p-3 flex items-center justify-between gap-2 bg-gradient-to-b from-black/75 via-black/35 to-transparent transition-opacity duration-200 ${
          showCtrl || !playing || displayError ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold tracking-wide text-white"
            style={{
              background: displayError
                ? "rgba(255, 69, 58, 0.86)"
                : playing
                  ? "rgba(255, 55, 95, 0.88)"
                  : "rgba(255, 255, 255, 0.2)",
            }}
          >
            <span className={`w-1.5 h-1.5 rounded-full bg-white ${playing && !displayError ? "animate-pulse" : ""}`} />
            {displayError ? "无法播放" : waiting ? "连接直播" : playing ? "LIVE 直播" : "已暂停"}
          </span>
          <span className="text-xs font-semibold text-white truncate">{channel.name}</span>
          <span className="text-[11px] text-white/70 px-2 py-0.5 rounded-full bg-white/10 shrink-0">
            {channel.group}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {channelPositionText && (
            <span className="text-[11px] text-white/75 px-2 py-0.5 rounded-full bg-black/45">
              {channelPositionText}
            </span>
          )}
          <button
            type="button"
            aria-label={isFavorite ? "取消收藏当前频道" : "收藏当前频道"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite();
            }}
            className={`px-2.5 py-1 rounded-full text-xs flex items-center gap-1 transition ${
              isFavorite ? "bg-amber-500/85 text-white" : "bg-black/55 text-white/85 hover:bg-black/75"
            }`}
          >
            {isFavorite ? <IStarF size={14} /> : <IStar size={14} />}
            <span>{isFavorite ? "已收藏" : "收藏"}</span>
          </button>
        </div>
      </div>

      {/* Buffering indicator */}
      {waiting && !displayError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
          <div className="w-9 h-9 rounded-full border-2 border-white/25 border-t-primary animate-spin" />
          <span className="text-xs text-white/75 bg-black/50 px-3 py-1 rounded-full">
            正在连接「{channel.name}」直播流…
          </span>
        </div>
      )}

      {/* Error overlay with retry & switch channel */}
      {displayError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-black/85 px-5 text-center z-10">
          <IClose size={26} className="text-danger" />
          <div className="text-sm font-medium text-white">直播流暂时无法播放（{displayError}）</div>
          <div className="text-xs text-mut max-w-xs">
            第三方直播源可能存在跨域防盗链、线路失效或地区网络限制，可尝试重试或切换频道。
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2 mt-1">
            {!formatErr && <button
              type="button"
              onClick={retryStream}
              className="px-3.5 py-1.5 rounded-full bg-primary text-on-primary text-xs font-medium"
            >
              重试当前频道
            </button>}
            {canSwitchChannel && (
              <button
                type="button"
                onClick={onNextChannel}
                className="px-3.5 py-1.5 rounded-full bg-white/15 text-white text-xs font-medium"
              >
                切换下一台
              </button>
            )}
          </div>
        </div>
      )}

      {/* Bottom live control bar (no fake VOD progress bar or episodes) */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={`absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/85 via-black/45 to-transparent transition-opacity duration-200 ${
          showCtrl || !playing ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        <div className="flex items-center justify-between gap-2 text-white">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-label={playing ? "暂停直播" : "播放直播"}
              onClick={() => videoRef.current?.toggle()}
              className="p-1.5 rounded-full bg-white/15 hover:bg-white/25"
            >
              {playing ? <IPauseF size={16} /> : <IPlayF size={16} />}
            </button>
            <button
              type="button"
              aria-label="上一台"
              disabled={!canSwitchChannel}
              onClick={onPrevChannel}
              className="px-2.5 py-1 rounded-full bg-white/15 hover:bg-white/25 disabled:opacity-40 text-xs font-medium"
            >
              上一台
            </button>
            <button
              type="button"
              aria-label="下一台"
              disabled={!canSwitchChannel}
              onClick={onNextChannel}
              className="px-2.5 py-1 rounded-full bg-white/15 hover:bg-white/25 disabled:opacity-40 text-xs font-medium"
            >
              下一台
            </button>
            <button
              type="button"
              aria-label="刷新直播流"
              onClick={retryStream}
              className="px-2.5 py-1 rounded-full bg-white/10 hover:bg-white/20 text-xs text-white/85"
            >
              重连
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label={muted ? "取消静音" : "静音"}
              onClick={() => setMuted((m) => !m)}
              className="p-1.5 rounded-full bg-white/15 hover:bg-white/25"
            >
              {muted ? <IVolMute size={16} /> : <IVol size={16} />}
            </button>
            <button
              type="button"
              aria-label={fs ? "退出全屏" : "全屏"}
              onClick={toggleFullscreen}
              className="p-1.5 rounded-full bg-white/15 hover:bg-white/25"
            >
              {fs ? <ICompress size={16} /> : <IExpand size={16} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
