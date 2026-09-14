import { contentPublishingLimit } from '../lib/instagram.js';
import { getTokenWithSource, kvConfigured } from '../lib/token-store.js';
import {
  loadSchedule,
  nowInZone,
  postsForDay,
  cycleWeek,
  referencedImages,
} from '../lib/schedule.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

/**
 * Diagnostic endpoint.
 *
 * Design rule: this must ALWAYS return JSON, even when something inside it
 * explodes. A status page that 500s tells you nothing except that it 500'd, so
 * every section below is individually guarded and the whole handler is wrapped.
 *
 * The media reachability check is the slowest and most failure-prone part, so
 * it is opt-in: add ?media=1 to run it. The base page stays fast and boring.
 */
export default async function handler(req, res) {
  const checks = {};

  try {
    await buildChecks(checks, req);
  } catch (err) {
    checks.fatal = `FAILED: ${err?.message || String(err)}`;
  }

  const scan = JSON.stringify({ ...checks, missingMedia: undefined });
  const healthy = !scan.includes('MISSING') && !scan.includes('FAILED');

  return res.status(200).json({ healthy, checks });
}

async function buildChecks(checks, req) {
  const igUserId = process.env.IG_USER_ID;
  const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

  checks.igUserId = igUserId ? 'set' : 'MISSING';
  checks.publicBaseUrl = baseUrl || 'MISSING';
  checks.cronSecret = process.env.CRON_SECRET ? 'set' : 'NOT SET - endpoints are public';

  let token = null;
  try {
    const got = await getTokenWithSource();
    token = got.token;
    checks.accessToken = token ? `set (${token.length} chars)` : 'MISSING';
    checks.tokenSource = got.source;
    if (token && !/^[A-Za-z0-9._-]+$/.test(token)) {
      checks.accessToken = `MISSING - token contains unexpected characters (${token.length} chars)`;
    }
  } catch (err) {
    checks.accessToken = `FAILED reading token: ${err.message}`;
  }

  let schedule = null;
  try {
    schedule = await loadSchedule();
    const tz = schedule.timezone || 'Europe/Amsterdam';
    const now = nowInZone(tz);
    const week = cycleWeek(schedule);

    checks.schedule = 'loaded';
    checks.localTime = `${now.weekday} ${now.clock} (${tz})`;
    checks.rotationWeek = week
      ? `week ${week} of ${schedule.cycle.weeks}`
      : 'no rotation (every post runs weekly)';
    checks.activePosts = (schedule.posts || []).filter((p) => p.enabled !== false).length;
    checks.today = postsForDay(schedule, now.weekday).map((p) => `${p.time} — ${p.note || p.id}`);
    checks.thisWeek = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].flatMap((d) =>
      postsForDay(schedule, d).map((p) => `${d} ${p.time} — ${p.note || p.id}`)
    );
    checks.mediaFiles = referencedImages(schedule).length;
  } catch (err) {
    checks.schedule = `FAILED: ${err.message}`;
  }

  if (schedule && hasFlag(req, 'media')) {
    try {
      const urls = referencedImages(schedule).filter((r) => /^https?:\/\//i.test(r));
      const bad = await checkRemote(urls);
      checks.mediaCheck = bad.length
        ? `MISSING ${bad.length} of ${urls.length}`
        : `all ${urls.length} reachable`;
      if (bad.length) checks.missingMedia = bad;
    } catch (err) {
      checks.mediaCheck = `FAILED: ${err.message}`;
    }
  } else if (schedule) {
    checks.mediaCheck = 'not run - add ?media=1 to verify every file';
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
}

/**
 * Check each media URL is fetchable. Runs in small batches with a hard overall
 * deadline so it cannot hang the function, and never throws - anything it
 * cannot verify is simply reported.
 */
async function checkRemote(urls, { batch = 8, perRequestMs = 6000, totalMs = 35000 } = {}) {
  const bad = [];
  const deadline = Date.now() + totalMs;

  for (let i = 0; i < urls.length; i += batch) {
    if (Date.now() > deadline) {
      bad.push(`not checked - ran out of time after ${i} of ${urls.length}`);
      break;
    }
    await Promise.all(urls.slice(i, i + batch).map((u) => checkOne(u, perRequestMs, bad)));
  }
  return bad.sort();
}

async function checkOne(url, timeoutMs, bad) {
  let label = url;
  try {
    label = decodeURIComponent(new URL(url).pathname.slice(1));
  } catch {
    /* keep the raw url as the label */
  }

  try {
    let res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });

    // Not every CDN answers HEAD. Ask for one byte before calling it missing.
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    }

    if (!res.ok && res.status !== 206) {
      bad.push(`${res.status} - ${label}`);
      return;
    }

    // Catches a PNG renamed to .jpg, which Meta rejects on content, not name.
    const type = res.headers.get('content-type') || '';
    if (type && !/^(image\/jpeg|video\/(mp4|quicktime))/i.test(type)) {
      bad.push(`wrong type ${type} - ${label}`);
    }
  } catch (err) {
    bad.push(`unreachable (${err?.name || 'error'}) - ${label}`);
  }
}

/**
 * Read a query flag without relying on req.query, which is not reliably
 * populated across runtimes. Falls back to parsing req.url directly.
 */
function hasFlag(req, name) {
  if (req?.query && req.query[name] != null && req.query[name] !== '') return true;
  try {
    return new URL(req?.url || '', 'http://localhost').searchParams.has(name);
  } catch {
    return false;
  }
}
