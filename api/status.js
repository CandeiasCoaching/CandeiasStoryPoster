import { access } from 'node:fs/promises';
import path from 'node:path';
import { contentPublishingLimit } from '../lib/instagram.js';
import { getToken, kvConfigured } from '../lib/token-store.js';
import {
  loadSchedule,
  nowInZone,
  postsForDay,
  cycleWeek,
  referencedImages,
  localMediaPaths,
} from '../lib/schedule.js';
 
export const config = { runtime: 'nodejs', maxDuration: 60 };
 
/**
 * HEAD every remote media URL so a missed upload or a typo shows up here rather
 * than as a silently skipped story days later. Also reports the content type,
 * which catches the classic "renamed a PNG to .jpg" mistake - Meta reads the
 * real type and rejects image/png outright.
 */
async function checkRemote(urls) {
  const bad = [];
  await Promise.all(
    urls.map(async (u) => {
      const label = decodeURIComponent(new URL(u).pathname.slice(1));
      try {
        let res = await fetch(u, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
 
        // Not every CDN answers HEAD. Fall back to asking for a single byte
        // before believing the file is missing.
        if (res.status === 405 || res.status === 501) {
          res = await fetch(u, {
            method: 'GET',
            headers: { Range: 'bytes=0-0' },
            signal: AbortSignal.timeout(8000),
          });
        }
 
        if (!res.ok && res.status !== 206) {
          bad.push(`${res.status} ${label}`);
          return;
        }
        const type = res.headers.get('content-type') || '';
        const okType = /^(image\/jpeg|video\/(mp4|quicktime))/i.test(type);
        if (type && !okType) {
          bad.push(`wrong type ${type} - ${label}`);
        }
      } catch {
        bad.push(`unreachable - ${label}`);
      }
    })
  );
  return bad.sort();
}
 
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
 
  let missingImages = [];
 
  try {
    const schedule = await loadSchedule();
    const tz = schedule.timezone || 'Europe/Amsterdam';
    const now = nowInZone(tz);
    const week = cycleWeek(schedule);
    const active = (schedule.posts || []).filter((p) => p.enabled !== false);
 
    checks.schedule = 'loaded';
    checks.localTime = `${now.weekday} ${now.clock} (${tz})`;
    checks.rotationWeek = week
      ? `week ${week} of ${schedule.cycle.weeks}`
      : 'no rotation (every post runs weekly)';
    checks.activePosts = active.length;
    checks.today = postsForDay(schedule, now.weekday).map(
      (p) => `${p.time} — ${p.note || p.id}`
    );
    checks.thisWeek = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].flatMap((d) =>
      postsForDay(schedule, d).map((p) => `${d} ${p.time} — ${p.note || p.id}`)
    );
 
    // Which referenced images are not actually on disk yet.
    missingImages = (
      await Promise.all(
        localMediaPaths(schedule).map(async (rel) => {
          const file = path.join(process.cwd(), 'public', rel);
          try {
            await access(file);
            return null;
          } catch {
            return rel;
          }
        })
      )
    ).filter(Boolean);
 
    const total = localMediaPaths(schedule).length;
    const remoteUrls = referencedImages(schedule).filter((r) => /^https?:\/\//i.test(r));
 
    const badRemote = remoteUrls.length ? await checkRemote(remoteUrls) : [];
    missingImages = [...missingImages, ...badRemote];
 
    const parts = [];
    if (total) parts.push(`${total} local present`);
    if (remoteUrls.length) {
      parts.push(
        badRemote.length
          ? `MISSING ${badRemote.length} of ${remoteUrls.length} hosted`
          : `all ${remoteUrls.length} hosted files reachable`
      );
    }
    checks.images = parts.join(', ') || 'none referenced';
    if (missingImages.length) checks.missingImages = missingImages;
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
 
  const blob = JSON.stringify({ ...checks, missingImages: undefined });
  const healthy = !blob.includes('MISSING') && !blob.includes('FAILED');
 
  return res.status(healthy ? 200 : 500).json({ healthy, checks });
}
