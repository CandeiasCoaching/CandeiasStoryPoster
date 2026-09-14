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

**1. Add your media**

Stills and video both work. Reference either with `media` in `schedule.json`.

Stills - drop into `public/ads/`:

- **JPEG only.** PNG and WebP are rejected by the API.
- 1080 × 1920 (9:16). Other ratios get cropped unpredictably.
- Under 8 MB.

Video - **host these outside the repo**:

- MP4 or MOV, H.264 video + AAC audio, 1080 × 1920.
- Keep clips short. Meta transcodes server-side before the story can publish,
  so allow time for it. This project runs on Vercel **Pro**, where a function
  may run 300 seconds; the code waits up to 4 minutes for a clip.
- Deployment source limit on Pro is **1 GB** (100 MB on Hobby). The 38-file
  library lives in Vercel Blob rather than the repo - not because it would not
  fit, but because git keeps every version of every binary forever. Reference
  hosted files with their full https:// URL as `media`:

```json
{ "media": "https://your-bucket.r2.dev/ov05-joep-shoulder-warmup.mp4" }
```

Anything starting `http://` or `https://` is used as-is. Anything else is
treated as a path inside `public/`. The two mix freely, so a new ad can simply
be dropped into `public/ads/` and referenced by path while the existing library
stays in Blob.

**2. `schedule.json` — the 8-week rotation**

```json
{
  "cycle": { "weeks": 8, "anchorDate": "2026-09-07" },
  "posts": [
    {
      "id": "w1-tue",
      "week": 1,
      "days": ["tue"],
      "time": "18:30",
      "image": "ads/ov18-emmely-hip-thrust.jpg",
      "note": "#18 Emmely - hip thrust",
      "enabled": true
    }
  ]
}
```

`anchorDate` is the **Monday that starts rotation week 1**. After week 8 it
loops back to week 1 on its own, forever.

`week` pins a post to one rotation week. Leave `week` out and the post runs
every week regardless of the cycle.

Times are local Amsterdam time — the code handles the UTC conversion and the
clock change. Use `:00 :15 :30 :45` for exact firing.

`days` takes short weekday names (`mon`, `tue`, …) or `"daily"`.
`enabled: false` parks a post without deleting it.

**Mon / Wed / Fri are deliberately empty.** Those are reel days, and the API
cannot reshare a reel to your story the way the app does — it would post a flat
still with no reel link. Those four seconds stay manual.

**2b. Move your media to Vercel Blob**

180 MB of story files cannot live in the repo (Hobby allows 100 MB of source
files per deployment). Put them in Blob instead:

```bash
npm i -g vercel
vercel login
vercel link                                    # inside this project folder

# The store MUST be public - Meta fetches your media anonymously,
# and access mode cannot be changed after the store is created.
vercel blob create-store candeias-media --access public --yes

node scripts/upload-media.mjs "C:\path\to\your story folder" --dry
node scripts/upload-media.mjs "C:\path\to\your story folder"
```

The script uploads every file and rewrites `schedule.json` to point at the
resulting public URLs. Matching is by filename, ignoring extension - so a local
`ov18-emmely-hip-thrust.mp4` satisfies a schedule entry pointing at
`ads/ov18-emmely-hip-thrust.jpg`. Run `--dry` first: it reports files the
schedule does not reference and schedule entries with no matching file, without
uploading anything.

Commit the rewritten `schedule.json` afterwards.

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

## Token storage

The access token is refreshed weekly and kept in the KV store. Two things that
bit us and are worth not repeating:

- **Write it as plain text.** `JSON.stringify()` on a string wraps it in literal
  double quotes, Upstash stores the body verbatim, and Meta then rejects the
  token with "Cannot parse access token". `getToken()` now strips stray quotes
  on read, so a store corrupted this way repairs itself.
- **The status page reports where the token actually came from**, not merely
  whether KV is configured. When the weekly refresh silently switched the live
  token from the environment variable to a corrupted KV value, nothing on the
  dashboard changed - which is why it took a failed morning to notice.

## Security

`IG_ACCESS_TOKEN`, `CRON_SECRET` and the KV credentials are passwords. Anyone
holding the access token can post to the Instagram account. Keep them in Vercel
env vars, never in the repo, and never paste them into a chat or screenshot.

If a token leaks: Meta app dashboard → Instagram → API setup → regenerate, then
update the env var (or KV) and redeploy. The old one dies immediately.
