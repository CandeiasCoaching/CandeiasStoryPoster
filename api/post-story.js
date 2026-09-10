import { publishStory } from '../lib/instagram.js';
import { loadSchedule, postsDueNow, nowInZone, postsForDay } from '../lib/schedule.js';
import { getToken } from '../lib/token-store.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  if (!authorised(req)) {
    return res.status(401).json({ error: 'unauthorised' });
  }

  const igUserId = process.env.IG_USER_ID;
  const token = await getToken();
  const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

  const missing = [
    !igUserId && 'IG_USER_ID',
    !token && 'IG_ACCESS_TOKEN',
    !baseUrl && 'PUBLIC_BASE_URL',
  ].filter(Boolean);

  if (missing.length) {
    return res.status(500).json({ error: `Missing env vars: ${missing.join(', ')}` });
  }

  let schedule;
  try {
    schedule = await loadSchedule();
  } catch (err) {
    return res.status(500).json({ error: `Could not read schedule.json: ${err.message}` });
  }

  const tz = schedule.timezone || 'Europe/Amsterdam';
  const now = nowInZone(tz);

  // ?dryRun=1 reports what would happen without posting anything.
  if (req.query?.dryRun) {
    return res.status(200).json({
      dryRun: true,
      localTime: `${now.weekday} ${now.clock} (${tz})`,
      dueNow: postsDueNow(schedule, now).map(summarise(baseUrl)),
      everythingToday: postsForDay(schedule, now.weekday).map(summarise(baseUrl)),
    });
  }

  const due = postsDueNow(schedule, now);

  if (due.length === 0) {
    return res.status(200).json({
      posted: [],
      note: `Nothing scheduled for ${now.weekday} ${now.clock} ${tz}`,
    });
  }

  const results = [];
  for (const post of due) {
    const imageUrl = `${baseUrl}/${String(post.image).replace(/^\//, '')}`;
    try {
      const mediaId = await publishStory({ igUserId, token, imageUrl });
      results.push({ id: post.id, imageUrl, status: 'published', mediaId });
      console.log(`Published story "${post.id}" -> ${mediaId}`);
    } catch (err) {
      results.push({ id: post.id, imageUrl, status: 'failed', error: err.message });
      console.error(`Failed story "${post.id}": ${err.message}`);
    }
  }

  const anyFailed = results.some((r) => r.status === 'failed');
  return res.status(anyFailed ? 207 : 200).json({
    localTime: `${now.weekday} ${now.clock} (${tz})`,
    posted: results,
  });
}

const summarise = (baseUrl) => (post) => ({
  id: post.id,
  time: post.time,
  days: post.days,
  imageUrl: `${baseUrl}/${String(post.image).replace(/^\//, '')}`,
  note: post.note,
});

/**
 * Vercel sends `Authorization: Bearer $CRON_SECRET` on cron invocations.
 * Without this check anyone who finds the URL can fire your stories.
 */
function authorised(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // not configured yet - allow, but set one before going live
  return req.headers.authorization === `Bearer ${secret}`;
}
