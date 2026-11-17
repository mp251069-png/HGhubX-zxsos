import { Button, SegmentedControl } from "./ios/controls";

export type BrowseMode = "category" | "tvbox";

export default function BrowseModeSwitch({
  mode,
  onChange,
  compact = false,
}: {
  mode: BrowseMode;
  onChange?: (mode: BrowseMode) => void;
  compact?: boolean;
}) {
  if (!onChange) return null;

  return (
    <div className={compact ? "min-w-0 flex-1 max-w-[248px]" : "mt-3 space-y-1.5"}>
      <SegmentedControl
        aria-label="影视内容来源"
        activeIndex={mode === "category" ? 0 : 1}
      >
        <Button aria-pressed={mode === "category"} onClick={() => onChange("category")}>
          HGhubX
        </Button>
        <Button aria-pressed={mode === "tvbox"} onClick={() => onChange("tvbox")}>
          TVBox 源
        </Button>
      </SegmentedControl>
      {!compact && <div className="flex min-h-5 items-center justify-between gap-2 px-1 text-[11px] text-mut">
        <span>{mode === "category" ? "分类频道 · 专题与标签" : "TVBox 点播目录 · 分类与搜索"}</span>
        <span className="shrink-0 text-dim">{mode === "category" ? "HGhubX" : "TVBox"} · 当前</span>
      </div>}
    </div>
  );
}
