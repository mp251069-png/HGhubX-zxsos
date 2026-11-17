import { useEffect, useState } from "react";
import Category from "./Category";
import TVBoxPage from "./TVBox";
import { TVBOX_SOURCE_EVENT } from "../tvbox";
import type { BrowseMode } from "../components/BrowseModeSwitch";
import { currentBrowseMode, setBrowseMode } from "../browseMode";

export default function BrowsePage({ active, wide }: { active: boolean; wide: boolean }) {
  const [mode, setMode] = useState<BrowseMode>(currentBrowseMode);

  const handleModeChange = (next: BrowseMode) => {
    setMode(next);
    setBrowseMode(next);
  };

  useEffect(() => {
    const onTvboxChange = (event: Event) => {
      if ((event as CustomEvent<unknown>).detail) {
        setMode("tvbox");
        setBrowseMode("tvbox");
      }
    };
    window.addEventListener(TVBOX_SOURCE_EVENT, onTvboxChange);
    return () => {
      window.removeEventListener(TVBOX_SOURCE_EVENT, onTvboxChange);
    };
  }, []);

  return (
    <>
      <div className={mode === "category" ? "absolute inset-0" : "hidden"} inert={mode !== "category"} aria-hidden={mode !== "category"}>
        <Category wide={wide} active={active && mode === "category"} onBrowseModeChange={handleModeChange} />
      </div>
      <div className={mode === "tvbox" ? "absolute inset-0" : "hidden"} inert={mode !== "tvbox"} aria-hidden={mode !== "tvbox"}>
        <TVBoxPage wide={wide} active={active && mode === "tvbox"} onBrowseModeChange={handleModeChange} />
      </div>
    </>
  );
}
