const GRAPH = 'https://graph.instagram.com';

/**
 * Publish a still image to the Instagram Story of the given account.
 *
 * Two-step flow required by Meta:
 *   1. POST /{ig-user-id}/media          -> creates a container, returns creation_id
 *   2. POST /{ig-user-id}/media_publish  -> publishes that container
 *
 * imageUrl MUST be a publicly reachable HTTPS JPEG. Meta fetches it server-side;
 * it never sees your Vercel env, so the file has to be genuinely public.
 */
export async function publishStory({ igUserId, token, imageUrl }) {
  const creationId = await createContainer({ igUserId, token, imageUrl });
  await waitForContainer({ creationId, token });
  return publishContainer({ igUserId, token, creationId });
}

async function createContainer({ igUserId, token, imageUrl }) {
  const url = new URL(`${GRAPH}/${igUserId}/media`);
  url.searchParams.set('media_type', 'STORIES');
  url.searchParams.set('image_url', imageUrl);
  url.searchParams.set('access_token', token);

  const res = await fetch(url, { method: 'POST' });
  const body = await res.json().catch(() => ({}));

  if (!res.ok || !body.id) {
    throw new Error(
      `Container creation failed (${res.status}): ${describeError(body)}`
    );
  }
  return body.id;
}

/**
 * Image containers are usually ready instantly, but Meta does not guarantee it.
 * Publishing an unfinished container throws a confusing error, so poll briefly.
 */
async function waitForContainer({ creationId, token, attempts = 6, delayMs = 2000 }) {
  for (let i = 0; i < attempts; i++) {
    const url = new URL(`${GRAPH}/${creationId}`);
    url.searchParams.set('fields', 'status_code,status');
    url.searchParams.set('access_token', token);

    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));

    if (body.status_code === 'FINISHED') return;
    if (body.status_code === 'ERROR') {
      throw new Error(`Container errored: ${body.status || 'no detail given'}`);
    }
    await sleep(delayMs);
  }
  // Not fatal - some accounts never report FINISHED for images. Try publishing anyway.
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
