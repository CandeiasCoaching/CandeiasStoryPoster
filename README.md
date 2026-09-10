# Candeias Coaching — scheduled story posting

Posts still-frame ads to the Candeias Coaching Instagram Story at set times, via
Meta's Content Publishing API, running on Vercel cron.

## How it works

A cron hits `/api/post-story` every 15 minutes. It reads `schedule.json`, works
out the current time **in Europe/Amsterdam**, and publishes anything whose slot
matches. Images are served from `/public` on your own Vercel domain, which
satisfies Meta's requirement that `image_url` be a publicly reachable HTTPS JPEG.

A second weekly cron refreshes the access token so the whole thing doesn't die
after 60 days.

```
schedule.json   ← what posts when (edit this)
public/ads/     ← your JPEGs (add these)
api/post-story  ← cron: every 15 min, posts what's due
api/refresh-token ← cron: weekly, keeps the token alive
api/status      ← open in a browser to check everything is wired up
```

## Setup

**1. Add your images**

Drop JPEGs into `public/ads/`. Requirements:

- **JPEG only.** PNG and WebP are rejected by the API.
- 1080 × 1920 (9:16). Other ratios get cropped unpredictably.
- Under 8 MB.

**2. Fill in `schedule.json`**

```json
{
  "id": "mon-pre-reel",
  "image": "ads/abc-hook-01.jpg",
  "days": ["mon"],
  "time": "18:30",
  "enabled": true
}
```

Times are local Amsterdam time — the code handles the UTC conversion and the
winter/summer clock change. Use `:00 :15 :30 :45` for exact firing.

`days` takes short weekday names (`mon`, `tue`, …) or `"daily"`.
`enabled: false` parks a post without deleting it.

**3. Deploy and set env vars**

Push to GitHub, import into Vercel, then set the variables from `.env.example`
under Project → Settings → Environment Variables. Redeploy after setting them.

**4. Set up token refresh (do this, don't skip it)**

Vercel → Storage → add the **Upstash Redis** integration to this project. It
sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.

Without it, the weekly refresh runs, succeeds, and then throws the new token
away because there's nowhere to put it — and posting stops dead 60 days after
setup with no warning.

**5. Verify**

Open `https://your-domain.vercel.app/api/status` in a browser. You want
`"healthy": true` and a publishing quota back from Instagram.

Then dry-run the scheduler without posting anything:

```
https://your-domain.vercel.app/api/post-story?dryRun=1
```

It reports the current local time, what's due this instant, and everything
queued for today.

## Testing a real post

Set one entry to the next quarter-hour, `enabled: true`, redeploy, and wait.
Check Vercel → Deployments → Functions logs for the result.

Your account allows 100 API-published posts per rolling 24 hours, so testing
costs you nothing meaningful.

## When something breaks

Check `/api/status` first — it catches most of it.

| Symptom | Usual cause |
|---|---|
| `The image url is not accessible` | Not a real public JPEG, or `PUBLIC_BASE_URL` points at a preview deployment |
| `Invalid OAuth access token` | Token expired — check whether the KV store is actually configured |
| `Media type not supported` | File isn't genuinely JPEG (a renamed `.png` still fails) |
| Nothing fires | Cron secret mismatch, or `enabled: false`, or the time doesn't land on a quarter hour |
| Posts an hour early/late | Someone put UTC times in `schedule.json` instead of local ones |

## Security

`IG_ACCESS_TOKEN`, `CRON_SECRET` and the KV credentials are passwords. Anyone
holding the access token can post to the Instagram account. Keep them in Vercel
env vars, never in the repo, and never paste them into a chat or screenshot.

If a token leaks: Meta app dashboard → Instagram → API setup → regenerate, then
update the env var (or KV) and redeploy. The old one dies immediately.
