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

  // Only the container creation is retried. Publishing is deliberately not:
  // if a publish succeeded but the response was lost, retrying would post the
  // story twice, and a duplicate is worse than a clear failure in the log.
  const creationId = await withRetry('Container creation', () =>
    createContainer({ igUserId, token, mediaUrl, video })
  );

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
    throw annotate(
      new Error(`Container creation failed (${res.status}): ${describeError(body)}`),
      res.status,
      body
    );
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

  if (!res.ok) throw annotate(new Error(`Limit check failed: ${describeError(body)}`), res.status, body);
  return body;
}

/** Hang the HTTP status and Meta's error code on the Error so retry logic can read them. */
function annotate(err, httpStatus, body) {
  err.httpStatus = httpStatus;
  err.metaCode = body?.error?.code;
  err.metaSubcode = body?.error?.error_subcode;
  return err;
}

function describeError(body) {
  const e = body?.error;
  if (!e) return JSON.stringify(body);
  return `${e.message}${e.error_user_msg ? ` | ${e.error_user_msg}` : ''} (code ${e.code})`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Meta fails transiently. We saw a live token return "API access blocked"
 * (code 200) for a few minutes and then start working again with nothing
 * changed. Without a retry, one bad moment at 18:30 costs the whole post,
 * because by the next cron run the time slot has passed.
 *
 * Retried: network failures, 5xx, and Meta's known transient codes.
 * NOT retried: a genuinely bad token (190) or a rejected file - those fail
 * the same way every time and retrying just wastes the window.
 */
const TRANSIENT_CODES = new Set([
  1,   // unknown/temporary
  2,   // service temporarily unavailable
  4,   // application request limit reached
  17,  // user request limit reached
  32,  // page request limit reached
  200, // seen as a temporary block in practice
  341, // temporarily blocked for policies violations
]);

function isTransient(err) {
  if (err?.metaCode != null) return TRANSIENT_CODES.has(Number(err.metaCode));
  if (err?.httpStatus >= 500) return true;
  // fetch() rejects with a TypeError on network failure
  return err?.name === 'TypeError' || /fetch failed|network|ECONN|ETIMEDOUT/i.test(err?.message || '');
}

async function withRetry(label, fn, { attempts = 3, waitsMs = [5000, 15000] } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (i === attempts - 1 || !isTransient(err)) break;
      const wait = waitsMs[i] ?? waitsMs[waitsMs.length - 1];
      console.warn(`${label} failed (${err.message}); retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw last;
}

