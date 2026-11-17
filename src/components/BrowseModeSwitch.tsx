import { Button, SegmentedControl } from "./ios/controls";

export type BrowseMode = "category" | "tvbox";

export default function BrowseModeSwitch({
  mode,
  onChange,
}: {
  mode: BrowseMode;
  onChange?: (mode: BrowseMode) => void;
}) {
  if (!onChange) return null;

  return (
    <div className="movies-mode-switch mt-3 w-full">
      <SegmentedControl
        aria-label="影视内容来源"
        activeIndex={mode === "category" ? 0 : 1}
        className="w-full"
      >
        <Button aria-pressed={mode === "category"} onClick={() => onChange("category")}>
          HGhubX
        </Button>
        <Button aria-pressed={mode === "tvbox"} onClick={() => onChange("tvbox")}>
          TVBox 源
        </Button>
      </SegmentedControl>
    </div>
  );
}
