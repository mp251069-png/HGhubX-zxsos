import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import Feed from "../src/components/Feed";
import { AppProvider } from "../src/store";
import { tvboxList, type TVBoxSource, type TVBoxVideo } from "../src/tvbox";
import "../src/index.css";

const jsMode = new URLSearchParams(location.search).get("js") === "1";
const sourceKind = new URLSearchParams(location.search).get("kind");
const source: TVBoxSource = {
  id: "tvbox-playback-fixture",
  name: "TVBox Playback Fixture",
  url: jsMode ? "http://media.fixture.invalid/js/spider.mjs" : new URLSearchParams(location.search).get("api") || "",
  ...(sourceKind === "xml" ? { kind: "xml" as const } : sourceKind === "remote" ? { kind: "remote" as const } : {}),
  ...(jsMode ? { kind: "js" as const, ext: { fixture: true } } : {}),
};

const fixture = {
  state: "booting" as "booting" | "ready" | "error",
  items: [] as TVBoxVideo[],
  error: "",
};
Object.assign(window, { tvboxPlaybackFixture: fixture });

function Fixture() {
  const [items, setItems] = useState<TVBoxVideo[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    tvboxList(source).then((page) => {
      fixture.items = page.items;
      fixture.state = "ready";
      setItems(page.items);
    }).catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      fixture.state = "error";
      fixture.error = message;
      setError(message);
    });
  }, []);
  return <AppProvider>
    <main style={{ position: "relative", width: 900, height: 700, background: "#111" }}>
      {error ? <p role="alert">{error}</p> : items.length ? <Feed
        videoIds={items.map(item => item.localId)}
        title="TVBox Playback Fixture"
        mode="context"
        active
        bottomInset={0}
        tvboxSource={source}
        tvboxItems={items}
      /> : <p>正在加载{jsMode ? " JS Spider" : sourceKind === "xml" ? " XML TVBox" : sourceKind === "remote" ? " Remote TVBox" : "标准 TVBox"} 详情…</p>}
    </main>
  </AppProvider>;
}

createRoot(document.querySelector("#root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
