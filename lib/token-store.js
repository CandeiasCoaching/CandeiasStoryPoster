/**
 * Where the access token lives.
 *
 * The problem this solves: Instagram long-lived tokens expire after 60 days and
 * must be refreshed. Vercel env vars are read-only at runtime, so a refreshed
 * token has nowhere to go - which is why unattended posting setups tend to die
 * quietly about two months after they are built.
 *
 * If a KV store is configured (Vercel's Upstash Redis integration sets
 * KV_REST_API_URL and KV_REST_API_TOKEN automatically), the refreshed token is
 * written there and read from there. If not, we fall back to the env var and
 * the refresh job just tells you to rotate it by hand.
 *
 * Plain fetch against the Upstash REST API - no package to install.
 */

const KEY = 'ig_access_token';

export function kvConfigured() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

export async function getToken() {
  return (await getTokenWithSource()).token;
}

/**
 * Also reports WHERE the token came from. The status page used to say "KV
 * store" whenever KV was merely configured, so when the weekly refresh silently
 * switched the live token from the env var to a corrupted KV value, nothing on
 * the dashboard changed. Reporting the real source makes that switch visible.
 */
export async function getTokenWithSource() {
  if (kvConfigured()) {
    const stored = await kvGet(KEY);
    if (stored) return { token: stored, source: 'KV store' };
  }
  const env = clean(process.env.IG_ACCESS_TOKEN);
  if (env) return { token: env, source: kvConfigured() ? 'env var (KV empty)' : 'env var only (no auto-refresh)' };
  return { token: null, source: 'none' };
}

export async function setToken(token) {
  if (!kvConfigured()) return false;
  await kvSet(KEY, token);
  return true;
}

async function kvGet(key) {
  const res = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => ({}));
  return clean(body?.result);
}

async function kvSet(key, value) {
  const res = await fetch(`${process.env.KV_REST_API_URL}/set/${key}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      // Send the token as raw text. JSON.stringify() on a string wraps it in
      // literal double quotes, Upstash stores the body verbatim, and the token
      // comes back as "IGAA..." - which Meta rejects with "Cannot parse access
      // token". That bug sat dormant until the first weekly refresh wrote to KV.
      'Content-Type': 'text/plain',
    },
    body: String(value),
  });
  if (!res.ok) {
    throw new Error(`KV write failed (${res.status})`);
  }
}

/**
 * Strip whitespace and any surrounding quotes. This also repairs a value that
 * an older build already quoted, so a corrupted store heals on the next read
 * rather than staying broken until someone clears it by hand.
 */
function clean(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1').trim();
  return trimmed || null;
}
