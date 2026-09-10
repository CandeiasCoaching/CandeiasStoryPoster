import { contentPublishingLimit } from '../lib/instagram.js';
import { getToken, kvConfigured } from '../lib/token-store.js';
import { loadSchedule, nowInZone, postsForDay } from '../lib/schedule.js';

export const config = { runtime: 'nodejs' };

/**
 * Diagnostic endpoint. Open it in a browser to confirm everything is wired up
 * without waiting for a cron to fire. Never returns the token itself.
 */
export default async function handler(req, res) {
  const checks = {};

  const igUserId = process.env.IG_USER_ID;
  const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const token = await getToken();

  checks.igUserId = igUserId ? 'set' : 'MISSING';
  checks.publicBaseUrl = baseUrl || 'MISSING';
  checks.accessToken = token ? `set (${token.length} chars)` : 'MISSING';
  checks.tokenSource = kvConfigured() ? 'KV store' : 'env var only (no auto-refresh)';
  checks.cronSecret = process.env.CRON_SECRET ? 'set' : 'NOT SET - endpoints are public';

  try {
    const schedule = await loadSchedule();
    const tz = schedule.timezone || 'Europe/Amsterdam';
    const now = nowInZone(tz);
    const active = (schedule.posts || []).filter((p) => p.enabled !== false);

    checks.schedule = 'loaded';
    checks.localTime = `${now.weekday} ${now.clock} (${tz})`;
    checks.activePosts = active.length;
    checks.today = postsForDay(schedule, now.weekday).map((p) => `${p.time} ${p.id}`);
  } catch (err) {
    checks.schedule = `FAILED: ${err.message}`;
  }

  if (igUserId && token) {
    try {
      const limit = await contentPublishingLimit({ igUserId, token });
      checks.instagramApi = 'reachable';
      checks.publishingQuota = limit?.data?.[0] ?? limit;
    } catch (err) {
      checks.instagramApi = `FAILED: ${err.message}`;
    }
  }

  const healthy = !JSON.stringify(checks).includes('MISSING') &&
    !JSON.stringify(checks).includes('FAILED');

  return res.status(healthy ? 200 : 500).json({ healthy, checks });
}
