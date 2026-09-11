import { publishStory, isVideoUrl } from '../lib/instagram.js';
import { loadSchedule, postsDueNow, nowInZone, postsForDay, cycleWeek } from '../lib/schedule.js';
import { getToken } from '../lib/token-store.js';
 
// Pro allows up to 300s. Video containers transcode server-side at Meta and a
// large clip can take minutes, so give it real room rather than the 60s the
// Hobby plan would cap us at.
export const config = { runtime: 'nodejs', maxDuration: 300 };
 
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
  const week = cycleWeek(schedule);
  const stamp = `${now.weekday} ${now.clock} (${tz})${week ? ` · rotation week ${week}` : ''}`;
 
  // ?dryRun=1 reports what would happen without posting anything.
  if (req.query?.dryRun) {
    return res.status(200).json({
      dryRun: true,
      localTime: stamp,
      rotationWeek: week,
      dueNow: postsDueNow(schedule, now, week).map(summarise(baseUrl)),
      everythingToday: postsForDay(schedule, now.weekday, week).map(summarise(baseUrl)),
    });
  }
 
  const due = postsDueNow(schedule, now, week);
 
  if (due.length === 0) {
    return res.status(200).json({
      posted: [],
      note: `Nothing scheduled for ${stamp}`,
    });
  }
 
  const results = [];
  for (const post of due) {
    const mediaUrl = resolveMedia(post, baseUrl);
    const kind = isVideoUrl(mediaUrl) ? 'video' : 'image';
    try {
      const mediaId = await publishStory({ igUserId, token, mediaUrl });
      results.push({ id: post.id, mediaUrl, kind, status: 'published', mediaId });
      console.log(`Published ${kind} story "${post.id}" -> ${mediaId}`);
    } catch (err) {
      results.push({ id: post.id, mediaUrl, kind, status: 'failed', error: err.message });
      console.error(`Failed ${kind} story "${post.id}": ${err.message}`);
    }
  }
 
  const anyFailed = results.some((r) => r.status === 'failed');
  return res.status(anyFailed ? 207 : 200).json({
    localTime: stamp,
    posted: results,
  });
}
 
const summarise = (baseUrl) => (post) => {
  const mediaUrl = resolveMedia(post, baseUrl);
  return {
    id: post.id,
    time: post.time,
    days: post.days,
    week: post.week,
    kind: isVideoUrl(mediaUrl) ? 'video' : 'image',
    mediaUrl,
    note: post.note,
  };
};
 
/**
 * `media` (or legacy `image`) is either a path inside /public, or a full
 * https:// URL when the file is hosted elsewhere - which is what you need for
 * video, since a folder of MP4s blows past Vercel's deployment size limit.
 */
export function resolveMedia(post, baseUrl) {
  const ref = String(post.media || post.image || '');
  if (/^https?:\/\//i.test(ref)) return ref;
  return `${baseUrl}/${ref.replace(/^\//, '')}`;
}
 
/**
 * Vercel sends `Authorization: Bearer $CRON_SECRET` on cron invocations.
 * Without this check anyone who finds the URL can fire your stories.
 */
function authorised(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // not configured yet - allow, but set one before going live
  return req.headers.authorization === `Bearer ${secret}`;
}
