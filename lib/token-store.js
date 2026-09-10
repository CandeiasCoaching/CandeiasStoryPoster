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
  if (kvConfigured()) {
    const stored = await kvGet(KEY);
    if (stored) return stored;
  }
  return process.env.IG_ACCESS_TOKEN || null;
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
  return body?.result || null;
}

async function kvSet(key, value) {
  const res = await fetch(`${process.env.KV_REST_API_URL}/set/${key}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(value),
  });
  if (!res.ok) {
    throw new Error(`KV write failed (${res.status})`);
  }
}
