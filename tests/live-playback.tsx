import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import LivePlayer from "../src/components/LivePlayer";
import type { LiveChannel } from "../src/live";
import { AppProvider } from "../src/store";
import "../src/index.css";

const media = new URLSearchParams(location.search).get("media") || "http://127.0.0.1:17779";
const makeChannel = (id: string, name: string, suffix: string): LiveChannel => ({
  id, name, group: "本地离线 fixture", url: `https://fixture.invalid/${suffix}.m3u8`,
});

const fixture = {
  events: [] as string[],
  videos: [] as HTMLVideoElement[],
  retryClicked: false,
  snapshot: () => {
    const current = document.querySelector("video") as HTMLVideoElement | null;
    const old = fixture.videos[0];
    return {
      currentTime: current?.currentTime || 0,
      playing: Boolean(current && !current.paused),
      channel: document.querySelector("[data-testid=live-channel-name]")?.textContent || "",
      hasVodSlider: Boolean(document.querySelector('input[aria-label="播放进度"], [role="slider"]')),
      oldVideoPaused: old ? old.paused : true,
      oldVideoDestroyed: old ? !old.isConnected : false,
      retryClicked: fixture.retryClicked,
    };
  },
};
Object.assign(window, { livePlaybackFixture: fixture });

function Fixture() {
  const [index, setIndex] = useState(0);
  const [retry, setRetry] = useState(0);
  const [favorite, setFavorite] = useState(false);
  const previousVideo = useRef<HTMLVideoElement | null>(null);
  const channels = [makeChannel("local-1", "本地演示 1", "live-retry"), makeChannel("local-2", "本地演示 2", "live-channel-2")];
  const channel = channels[index];
  useEffect(() => {
    const video = document.querySelector("video");
    if (video) {
      fixture.videos.push(video);
      video.addEventListener("playing", () => fixture.events.push("playing"), { once: true });
    }
  });
  const switchChannel = () => { previousVideo.current = document.querySelector("video"); fixture.events.push("switch-request"); setIndex(v => (v + 1) % channels.length); fixture.events.push("channel-switched"); };
  const reconnect = () => { fixture.retryClicked = true; fixture.events.push("retry-clicked"); setRetry(v => v + 1); };
  return <AppProvider>
    <main style={{ width: 960, margin: "24px auto", color: "white", background: "#111", padding: 24 }}>
      <h1>本地离线真实 Live HLS 播放测试</h1>
      <p data-testid="fixture-label">LOCAL FIXTURE · Chromium browser test only · not Tauri/iOS device validation</p>
      <div style={{ width: 900 }}>
        <LivePlayer key={`${channel.id}-${retry}`} src={`${media}/hls?u=${encodeURIComponent(channel.url)}`} channel={channel} active isFavorite={favorite} canSwitchChannel onToggleFavorite={() => setFavorite(v => !v)} onPrevChannel={switchChannel} onNextChannel={switchChannel} channelPositionText={`${index + 1}/2`} />
      </div>
      <span data-testid="live-channel-name" style={{ display: "none" }}>{channel.name}</span>
      <button type="button" onClick={reconnect}>测试重连</button>
      <p>测试画面由本地 ffmpeg HLS fixture 生成，不请求任何第三方源。</p>
    </main>
  </AppProvider>;
}

createRoot(document.querySelector("#root")!).render(<Fixture />);
