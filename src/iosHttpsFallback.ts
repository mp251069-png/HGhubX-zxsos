import { isLocalMedia, platform } from "./api";

type Activity = {
  isActive: () => boolean;
  isPlayWanted: () => boolean;
  play: (source: string, automatic?: boolean) => void;
};

type AttemptState = { src: string; attempted: boolean };

/**
 * WKWebView's AVFoundation player cannot reliably consume HLS through Tauri's
 * custom `hg:` scheme. Keep the Rust proxy as the primary path, but retry the
 * original HTTPS media URL once when the native player explicitly reports an
 * unsupported source. Never fall back to non-HTTPS or non-proxied sources.
 */
export function tryIosHttpsFallback(
  video: HTMLVideoElement,
  originalSrc: string,
  state: AttemptState,
  activity: Activity,
  trace: (event: string, data?: Record<string, unknown>) => void,
): boolean {
  if (state.src !== originalSrc) {
    state.src = originalSrc;
    state.attempted = false;
  }
  if (state.attempted || platform !== "ios" || video.error?.code !== 4) return false;

  let original: URL;
  try {
    original = new URL(originalSrc);
  } catch {
    return false;
  }
  if (original.protocol !== "https:") return false;

  const current = video.currentSrc || video.src;
  if (!current || !isLocalMedia(current)) return false;

  state.attempted = true;
  trace("ios.https_fallback", {
    from: "local_proxy",
    to_host: original.hostname,
    error_code: video.error.code,
  });
  video.pause();
  video.src = original.href;
  video.load();
  if (activity.isActive() && activity.isPlayWanted()) {
    activity.play("ios_https_fallback", true);
  }
  return true;
}
