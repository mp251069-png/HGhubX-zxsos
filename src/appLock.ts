export const APP_LOCK_INTERVALS_MINUTES = [1, 5, 15, 30, 60] as const;
export type AppLockIntervalMinutes = typeof APP_LOCK_INTERVALS_MINUTES[number];

export const DEFAULT_APP_LOCK_INTERVAL_MINUTES: AppLockIntervalMinutes = 15;

export function normalizeAppLockIntervalMinutes(value: string | null): AppLockIntervalMinutes {
  const minutes = Number(value);
  return APP_LOCK_INTERVALS_MINUTES.find(option => option === minutes) ?? DEFAULT_APP_LOCK_INTERVAL_MINUTES;
}

export function normalizeLastAuthenticatedAt(value: string | null): number {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

export function shouldRequireReauthenticationOnLaunch(appLockEnabled: boolean): boolean {
  return appLockEnabled;
}

export function shouldRequireReauthentication(
  lastAuthenticatedAt: number,
  now: number,
  intervalMinutes: AppLockIntervalMinutes,
): boolean {
  return lastAuthenticatedAt <= 0 || now < lastAuthenticatedAt || now - lastAuthenticatedAt >= intervalMinutes * 60_000;
}
