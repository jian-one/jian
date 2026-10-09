import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCodexQuota } from '../src/shared/codex-quota.ts';

test('remaining percentages and authoritative available reset count', () => {
  assert.equal(formatCodexQuota({
    rateLimits: { primary: { usedPercent: 99, windowDurationMins: 300 } },
    rateLimitsByLimitId: { codex: {
      primary: { usedPercent: 75, windowDurationMins: 300 },
      secondary: { usedPercent: 85, windowDurationMins: 10080 },
    } },
    rateLimitResetCredits: { availableCount: 3 },
  }), '5h: 25% | weekly: 15% | Reset: 3');
});

test('missing data is unknown, zero is preserved, other durations are not mislabeled', () => {
  assert.equal(formatCodexQuota({}), '5h: — | weekly: — | Reset: —');
  assert.equal(formatCodexQuota({ rateLimits: {
    primary: { usedPercent: 10, windowDurationMins: 15 },
    secondary: { usedPercent: 100, windowDurationMins: 10080 },
  }, rateLimitResetCredits: { availableCount: 0 } }), '5h: — | weekly: 0% | Reset: 0');
});

test('matches windows by duration and bounds remaining percentages', () => {
  assert.equal(formatCodexQuota({ rateLimits: {
    primary: { usedPercent: -1, windowDurationMins: 10080 },
    secondary: { usedPercent: 101, windowDurationMins: 300 },
  } }), '5h: 0% | weekly: 100% | Reset: —');
});
