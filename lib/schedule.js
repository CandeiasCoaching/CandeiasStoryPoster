import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Slot width in minutes. Must match the cron interval in vercel.json.
 * A post scheduled at 08:30 fires during the 08:30-08:44 window.
 */
export const SLOT_MINUTES = 15;

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export async function loadSchedule() {
  const file = path.join(process.cwd(), 'schedule.json');
  return JSON.parse(await readFile(file, 'utf8'));
}

/**
 * Current weekday + time in the schedule's own timezone.
 *
 * This matters: Vercel crons fire in UTC, and the Netherlands shifts between
 * UTC+1 and UTC+2. Hard-coding UTC times would silently move every post by an
 * hour twice a year. Intl does the conversion with no dependency.
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

/**
 * Which posts are due right now.
 *
 * A post matches when today is one of its days AND its scheduled time falls in
 * the same slot as the current time. Because the cron fires once per slot, each
 * post goes out exactly once.
 */
export function postsDueNow(schedule, now = null) {
  const tz = schedule.timezone || 'Europe/Amsterdam';
  const current = now || nowInZone(tz);
  const currentSlot = slotOf(current.minutes);

  return (schedule.posts || [])
    .filter((post) => post.enabled !== false)
    .filter((post) => matchesDay(post, current.weekday))
    .filter((post) => slotOf(parseClock(post.time)) === currentSlot);
}

function matchesDay(post, weekday) {
  if (!post.days || post.days === 'daily') return true;
  const days = Array.isArray(post.days) ? post.days : [post.days];
  return days.map((d) => String(d).toLowerCase().slice(0, 3)).includes(weekday);
}

/** Everything scheduled for a given weekday, sorted - used by the dry run. */
export function postsForDay(schedule, weekday) {
  return (schedule.posts || [])
    .filter((p) => p.enabled !== false)
    .filter((p) => matchesDay(p, weekday.toLowerCase().slice(0, 3)))
    .sort((a, b) => parseClock(a.time) - parseClock(b.time));
}

export { DAYS };
