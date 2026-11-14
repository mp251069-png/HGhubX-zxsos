import { useEffect, useState } from "react";
import Category from "./Category";
import TVBoxPage from "./TVBox";
import LivePage from "./Live";
import { TVBOX_SOURCE_EVENT } from "../tvbox";
import { LIVE_SOURCE_EVENT } from "../live";
import type { BrowseMode } from "../components/BrowseModeSwitch";

export default function BrowsePage({ active, wide }: { active: boolean; wide: boolean }) {
  const [mode, setMode] = useState<BrowseMode>("category");
  const [lastVodMode, setLastVodMode] = useState<"category" | "tvbox">("category");

  const handleModeChange = (next: BrowseMode) => {
    if (next === "category" || next === "tvbox") {
      setLastVodMode(next);
    }
    setMode(next);
  };

  useEffect(() => {
    const onTvboxChange = (event: Event) => {
      if ((event as CustomEvent<unknown>).detail) {
        setLastVodMode("tvbox");
        setMode("tvbox");
      }
    };
    const onLiveChange = (event: Event) => {
      if ((event as CustomEvent<unknown>).detail) {
        setMode("live");
      }
    };
    window.addEventListener(TVBOX_SOURCE_EVENT, onTvboxChange);
    window.addEventListener(LIVE_SOURCE_EVENT, onLiveChange);
    return () => {
      window.removeEventListener(TVBOX_SOURCE_EVENT, onTvboxChange);
      window.removeEventListener(LIVE_SOURCE_EVENT, onLiveChange);
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
      <div className={mode === "live" ? "absolute inset-0" : "hidden"} inert={mode !== "live"} aria-hidden={mode !== "live"}>
        <LivePage wide={wide} active={active && mode === "live"} lastVodMode={lastVodMode} onBrowseModeChange={handleModeChange} />
      </div>
    </>
  );
}
