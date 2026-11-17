import { useEffect, useState } from "react";
import Category from "./Category";
import TVBoxPage from "./TVBox";
import { TVBOX_SOURCE_EVENT } from "../tvbox";
import type { BrowseMode } from "../components/BrowseModeSwitch";

const BROWSE_MODE_KEY = "hghubx_browse_mode_v1";

function readBrowseMode(): BrowseMode {
  try {
    return localStorage.getItem(BROWSE_MODE_KEY) === "tvbox" ? "tvbox" : "category";
  } catch {
    return "category";
  }
}

export default function BrowsePage({ active, wide }: { active: boolean; wide: boolean }) {
  const [mode, setMode] = useState<BrowseMode>(readBrowseMode);

  const handleModeChange = (next: BrowseMode) => {
    setMode(next);
    try { localStorage.setItem(BROWSE_MODE_KEY, next); } catch { /* storage may be unavailable */ }
  };

  useEffect(() => {
    const onTvboxChange = (event: Event) => {
      if ((event as CustomEvent<unknown>).detail) {
        setMode("tvbox");
        try { localStorage.setItem(BROWSE_MODE_KEY, "tvbox"); } catch { /* ignore */ }
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
