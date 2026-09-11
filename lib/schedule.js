import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Slot width in minutes. Must match the cron interval in vercel.json.
 * A post scheduled at 18:30 fires during the 18:30-18:44 window.
 */
export const SLOT_MINUTES = 15;

export async function loadSchedule() {
  const file = path.join(process.cwd(), 'schedule.json');
  return JSON.parse(await readFile(file, 'utf8'));
}

/**
 * Current weekday + time in the schedule's own timezone.
 *
 * Vercel crons fire in UTC and the Netherlands shifts between UTC+1 and UTC+2.
 * Hard-coding UTC times would silently move every post by an hour twice a year.
 */
export function nowInZone(timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );

  return {
    weekday: parts.weekday.toLowerCase().slice(0, 3),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    clock: `${parts.hour}:${parts.minute}`,
  };
}

/** Today's calendar date in the given zone, as YYYY-MM-DD. */
export function localDateISO(timeZone, date = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Which week of the rotation we are in, 1..cycle.weeks.
 *
 * Counted in whole days from the anchor date rather than in milliseconds,
 * because a millisecond week is 168 hours and the clock change makes some
 * real weeks 167 or 169 - which would eventually slip the rotation by a week.
 *
 * Returns null when the schedule has no cycle, in which case every post runs
 * every week.
 */
export function cycleWeek(schedule, date = new Date()) {
  const cycle = schedule.cycle;
  if (!cycle?.anchorDate || !cycle?.weeks) return null;

  const tz = schedule.timezone || 'Europe/Amsterdam';
  const today = Date.parse(`${localDateISO(tz, date)}T00:00:00Z`);
  const anchor = Date.parse(`${cycle.anchorDate}T00:00:00Z`);

  if (Number.isNaN(anchor)) {
    throw new Error(`Bad cycle.anchorDate "${cycle.anchorDate}" - expected YYYY-MM-DD`);
  }

  const weeksElapsed = Math.floor((today - anchor) / 86400000 / 7);
  // Real modulo, so dates before the anchor still land in range.
  return (((weeksElapsed % cycle.weeks) + cycle.weeks) % cycle.weeks) + 1;
}

function slotOf(minutes) {
  return Math.floor(minutes / SLOT_MINUTES);
}

function parseClock(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) {
    throw new Error(`Bad time "${hhmm}" - expected 24h "HH:MM"`);
  }
  return h * 60 + m;
}

function matchesDay(post, weekday) {
  if (!post.days || post.days === 'daily') return true;
  const days = Array.isArray(post.days) ? post.days : [post.days];
  return days.map((d) => String(d).toLowerCase().slice(0, 3)).includes(weekday);
}

/** A post with no `week` runs every week; one with a `week` only in that week. */
function matchesWeek(post, week) {
  if (post.week == null) return true;
  if (week == null) return true;
  return Number(post.week) === Number(week);
}

/**
 * Which posts are due right now: right week, right day, right 15-minute slot.
 * The cron fires once per slot, so each post goes out exactly once.
 */
export function postsDueNow(schedule, now = null, week = undefined) {
  const tz = schedule.timezone || 'Europe/Amsterdam';
  const current = now || nowInZone(tz);
  const wk = week === undefined ? cycleWeek(schedule) : week;
  const currentSlot = slotOf(current.minutes);

  return (schedule.posts || [])
    .filter((post) => post.enabled !== false)
    .filter((post) => matchesWeek(post, wk))
    .filter((post) => matchesDay(post, current.weekday))
    .filter((post) => slotOf(parseClock(post.time)) === currentSlot);
}

/** Everything scheduled for a given weekday in a given rotation week. */
export function postsForDay(schedule, weekday, week = undefined) {
  const wk = week === undefined ? cycleWeek(schedule) : week;
  const day = weekday.toLowerCase().slice(0, 3);

  return (schedule.posts || [])
    .filter((p) => p.enabled !== false)
    .filter((p) => matchesWeek(p, wk))
    .filter((p) => matchesDay(p, day))
    .sort((a, b) => parseClock(a.time) - parseClock(b.time));
}

/** Every distinct media reference (path or absolute URL). */
export function referencedImages(schedule) {
  return [
    ...new Set((schedule.posts || []).map((p) => p.media || p.image).filter(Boolean)),
  ].sort();
}

/** Only the ones that are local files under /public, so we can check they exist. */
export function localMediaPaths(schedule) {
  return referencedImages(schedule).filter((r) => !/^https?:\/\//i.test(r));
}
