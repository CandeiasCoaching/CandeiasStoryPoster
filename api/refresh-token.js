import { refreshLongLivedToken } from '../lib/instagram.js';
import { getToken, setToken } from '../lib/token-store.js';

export const config = { runtime: 'nodejs' };

/**
 * Runs weekly. Instagram long-lived tokens last 60 days and can be refreshed
 * any time after they are 24 hours old, so a weekly refresh means the token is
 * never more than a week from freshly renewed - and a couple of failed runs in
 * a row still leave weeks of headroom to notice and fix it.
 */
export default async function handler(req, res) {
  if (!authorised(req)) {
    return res.status(401).json({ error: 'unauthorised' });
  }

  const current = await getToken();
  if (!current) {
    return res.status(500).json({ error: 'No token found in KV or IG_ACCESS_TOKEN' });
  }

  try {
    const { token, expiresInSeconds } = await refreshLongLivedToken(current);
    const days = Math.round(expiresInSeconds / 86400);

    const stored = await setToken(token);

    if (stored) {
      console.log(`Token refreshed, valid ~${days} more days.`);
      return res.status(200).json({ refreshed: true, storedInKv: true, validForDays: days });
    }

    // No KV configured - the refresh worked but there is nowhere to put it.
    console.warn(
      `Token refreshed (valid ~${days} days) but no KV store is configured, ` +
        `so it was NOT saved. Set up the Upstash/KV integration, or rotate ` +
        `IG_ACCESS_TOKEN by hand before it expires.`
    );
    return res.status(200).json({
      refreshed: true,
      storedInKv: false,
      validForDays: days,
      warning:
        'No KV store configured - refreshed token was discarded. ' +
        'Add the Vercel Upstash Redis integration so this can persist, ' +
        'or rotate IG_ACCESS_TOKEN manually.',
    });
  } catch (err) {
    console.error(`Token refresh failed: ${err.message}`);
    return res.status(500).json({ refreshed: false, error: err.message });
  }
}

function authorised(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.authorization === `Bearer ${secret}`;
}

