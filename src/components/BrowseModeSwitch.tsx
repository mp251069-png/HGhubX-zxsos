import { Button, SegmentedControl } from "./ios/controls";

export type BrowseMode = "category" | "tvbox" | "live";

export default function BrowseModeSwitch({
  mode,
  lastVodMode = "category",
  onChange,
}: {
  mode: BrowseMode;
  lastVodMode?: "category" | "tvbox";
  onChange?: (mode: BrowseMode) => void;
}) {
  if (!onChange) return null;
  const topKey: "vod" | "live" = mode === "live" ? "live" : "vod";
  const vodKey: "category" | "tvbox" = mode === "tvbox" ? "tvbox" : "category";

  return (
    <div className="mt-2.5 space-y-2.5">
      <div className="space-y-1">
        <SegmentedControl
          aria-label="影视与直播模式"
          activeIndex={topKey === "vod" ? 0 : 1}
        >
          <Button
            aria-pressed={topKey === "vod"}
            onClick={() => {
              if (mode === "live") onChange(lastVodMode);
            }}
          >
            影视
          </Button>
          <Button
            aria-pressed={topKey === "live"}
            onClick={() => onChange("live")}
          >
            直播
          </Button>
        </SegmentedControl>
        <div className="text-[11px] text-mut px-1">
          {topKey === "vod"
            ? "看电视直播？切换到「直播」"
            : "看影视点播？切换到「影视」 · 支持通用 Extended M3U（.m3u/.m3u8）直播订阅"}
        </div>
      </div>

      {topKey === "vod" && (
        <div className="space-y-1">
          <SegmentedControl
            aria-label="影视浏览模式"
            activeIndex={vodKey === "category" ? 0 : 1}
          >
            <Button
              aria-pressed={vodKey === "category"}
              onClick={() => onChange("category")}
            >
              HGhubX
            </Button>
            <Button
              aria-pressed={vodKey === "tvbox"}
              onClick={() => onChange("tvbox")}
            >
              TVBox 源
            </Button>
          </SegmentedControl>
          <div className="text-[11px] text-mut px-1">
            {vodKey === "category"
              ? "当前：原软件播放源 · 分类频道"
              : "当前：TVBox 点播源 · 标准 JSON/API 与隔离 JS Spider"}
          </div>
        </div>
      )}
    </div>
  );
}
