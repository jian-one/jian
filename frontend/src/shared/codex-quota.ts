type Window = { usedPercent: number; windowDurationMins: number | null };
type Limits = { primary?: Window | null; secondary?: Window | null };
export type CodexQuota = {
  rateLimits?: Limits | null;
  rateLimitsByLimitId?: Record<string, Limits> | null;
  rateLimitResetCredits?: { availableCount: number } | null;
};

export function formatCodexQuota(value: CodexQuota): string {
  const limits = value.rateLimitsByLimitId?.codex ?? value.rateLimits;
  const windows = [limits?.primary, limits?.secondary];
  const remaining = (minutes: number) => {
    const window = windows.find(item => item?.windowDurationMins === minutes);
    return window && Number.isFinite(window.usedPercent)
      ? `${Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)))}%` : '—';
  };
  const count = value.rateLimitResetCredits?.availableCount;
  return `5h: ${remaining(300)} | weekly: ${remaining(10080)} | Reset: ${typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : '—'}`;
}
