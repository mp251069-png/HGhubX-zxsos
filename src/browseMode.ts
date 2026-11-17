export type BrowseMode = "category" | "tvbox";

export const BROWSE_MODE_KEY = "hghubx_browse_mode_v1";
export const BROWSE_MODE_EVENT = "hghubx:browse-mode-changed";

export function currentBrowseMode(): BrowseMode {
  try {
    return localStorage.getItem(BROWSE_MODE_KEY) === "tvbox" ? "tvbox" : "category";
  } catch {
    return "category";
  }
}

export function setBrowseMode(mode: BrowseMode): void {
  try { localStorage.setItem(BROWSE_MODE_KEY, mode); } catch { /* storage may be unavailable */ }
  window.dispatchEvent(new CustomEvent(BROWSE_MODE_EVENT, { detail: mode }));
}
