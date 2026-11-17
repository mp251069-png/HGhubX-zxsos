import assert from "node:assert/strict";
import { createServer } from "vite";

const vite = await createServer({
  configFile: "vite.config.ts",
  server: { middlewareMode: true },
  appType: "custom",
});
try {
  const appLock = await vite.ssrLoadModule("/src/appLock.ts");

  assert.equal(appLock.shouldRequireReauthenticationOnLaunch(true), true,
    "An enabled app lock must require authentication on every fresh app launch");
  assert.equal(appLock.shouldRequireReauthenticationOnLaunch(false), false,
    "A disabled app lock must not require authentication on launch");

  const now = 1_000_000;
  assert.equal(appLock.shouldRequireReauthentication(now - 59_999, now, 1), false,
    "Returning within the one-minute interval must not prompt again");
  assert.equal(appLock.shouldRequireReauthentication(now - 60_000, now, 1), true,
    "Returning at the interval boundary must require authentication");
  assert.equal(appLock.shouldRequireReauthentication(now - 899_999, now, 15), false,
    "Returning within the configured 15-minute interval must not prompt");
  assert.equal(appLock.shouldRequireReauthentication(now - 900_000, now, 15), true,
    "Returning at the configured 15-minute interval must prompt");
  assert.equal(appLock.shouldRequireReauthentication(0, now, 15), true,
    "A missing authentication timestamp must require authentication");
  assert.equal(appLock.shouldRequireReauthentication(now + 1, now, 15), true,
    "A future authentication timestamp must fail closed");

  console.log("App lock checks passed: every enabled cold launch prompts; foreground returns obey the configured interval.");
} finally {
  await vite.close();
}
