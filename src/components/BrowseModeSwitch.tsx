import { Button, SegmentedControl } from "./ios/controls";

export type BrowseMode = "category" | "tvbox";

export default function BrowseModeSwitch({ mode, onChange }: {
  mode: BrowseMode;
  onChange: (mode: BrowseMode) => void;
}) {
  return (
    <SegmentedControl aria-label="影视浏览模式" activeIndex={mode === "category" ? 0 : 1} className="mt-3">
      <Button aria-pressed={mode === "category"} onClick={() => onChange("category")}>分类</Button>
      <Button aria-pressed={mode === "tvbox"} onClick={() => onChange("tvbox")}>TVBox 源</Button>
    </SegmentedControl>
  );
}
