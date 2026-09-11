const GRAPH = 'https://graph.instagram.com';
 
const VIDEO_EXT = /\.(mp4|mov|m4v)$/i;
 
export function isVideoUrl(url) {
  try {
    return VIDEO_EXT.test(new URL(url).pathname);
  } catch {
    return VIDEO_EXT.test(String(url));
  }
}
 
/**
 * Publish a still image or a video to the Instagram Story.
 *
 * Two-step flow required by Meta:
 *   1. POST /{ig-user-id}/media          -> creates a container, returns creation_id
 *   2. POST /{ig-user-id}/media_publish  -> publishes that container
 *
 * Images are ready almost immediately. Video has to transcode server-side, so
 * the container must be polled until status_code is FINISHED. Meta suggests
 * polling for up to 5 minutes; on Vercel Pro a function may run 300s, so the
 * default budget is 4 minutes - comfortably inside both. If a clip still is
 * not ready we report that honestly rather than publishing a half-baked
 * container, which fails with a misleading error.
 *
 * mediaUrl MUST be publicly reachable over HTTPS. Meta fetches it server-side.
 */
export async function publishStory({ igUserId, token, mediaUrl, budgetMs = 240000 }) {
  const video = isVideoUrl(mediaUrl);
  const creationId = await createContainer({ igUserId, token, mediaUrl, video });
 
  await waitForContainer({
    creationId,
    token,
    // Images normally report FINISHED at once; do not burn the budget on them.
    budgetMs: video ? budgetMs : 8000,
    intervalMs: video ? 3000 : 1500,
    required: video,
  });
 
  return publishContainer({ igUserId, token, creationId });
}
 
async function createContainer({ igUserId, token, mediaUrl, video }) {
  const url = new URL(`${GRAPH}/${igUserId}/media`);
  url.searchParams.set('media_type', 'STORIES');
  url.searchParams.set(video ? 'video_url' : 'image_url', mediaUrl);
  url.searchParams.set('access_token', token);
 
  const res = await fetch(url, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
 
  if (!res.ok || !body.id) {
    throw new Error(`Container creation failed (${res.status}): ${describeError(body)}`);
  }
  return body.id;
}
 
/**
 * Poll until the container reports FINISHED.
 *
 * `required: true` (video) throws if the budget runs out, because publishing an
 * unfinished video container fails with a misleading error. `required: false`
 * (image) returns quietly - some accounts never report FINISHED for stills.
 */
async function waitForContainer({ creationId, token, budgetMs, intervalMs, required }) {
  const deadline = Date.now() + budgetMs;
  let last = 'unknown';
 
  while (Date.now() < deadline) {
    const url = new URL(`${GRAPH}/${creationId}`);
    url.searchParams.set('fields', 'status_code,status');
    url.searchParams.set('access_token', token);
 
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    last = body.status_code || last;
 
    if (body.status_code === 'FINISHED') return;
    if (body.status_code === 'ERROR') {
      throw new Error(`Container errored: ${body.status || 'no detail given'}`);
    }
    await sleep(intervalMs);
  }
 
  if (required) {
    throw new Error(
      `Video still ${last} after ${Math.round(budgetMs / 1000)}s. ` +
        `The clip is probably too long or too large to transcode inside the ` +
        `function timeout - shorten it or compress it.`
    );
  }
}
 
async function publishContainer({ igUserId, token, creationId }) {
  const url = new URL(`${GRAPH}/${igUserId}/media_publish`);
  url.searchParams.set('creation_id', creationId);
  url.searchParams.set('access_token', token);
 
  const res = await fetch(url, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
 
  if (!res.ok || !body.id) {
    throw new Error(`Publish failed (${res.status}): ${describeError(body)}`);
  }
  return body.id;
}
 
/** Exchange or refresh the 60-day long-lived token. */
export async function refreshLongLivedToken(token) {
  const url = new URL(`${GRAPH}/refresh_access_token`);
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', token);
 
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
 
  if (!res.ok || !body.access_token) {
    throw new Error(`Token refresh failed (${res.status}): ${describeError(body)}`);
  }
  return { token: body.access_token, expiresInSeconds: body.expires_in };
}
 
/** How many API posts are left in the rolling 24h window (limit is 100). */
export async function contentPublishingLimit({ igUserId, token }) {
  const url = new URL(`${GRAPH}/${igUserId}/content_publishing_limit`);
  url.searchParams.set('fields', 'config,quota_usage');
  url.searchParams.set('access_token', token);
 
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
 
  if (!res.ok) throw new Error(`Limit check failed: ${describeError(body)}`);
  return body;
}
 
function describeError(body) {
  const e = body?.error;
  if (!e) return JSON.stringify(body);
  return `${e.message}${e.error_user_msg ? ` | ${e.error_user_msg}` : ''} (code ${e.code})`;
}
 
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
 
