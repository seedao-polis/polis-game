import { DatabaseSync } from 'node:sqlite';
import { listEventAttendees } from './dist/core/lark.js';

const PROFILE = 'jcnhe1etwt45';
const DB_PATH = '.agent/tudigong.db';

const db = new DatabaseSync(DB_PATH);
const events = db.prepare(`
  SELECT DISTINCT event_id, calendar_id, title, start_time
  FROM calendar_event_rsvp_rounds
  WHERE title LIKE '%AI%'
  ORDER BY start_time
`).all();

console.log(`Found ${events.length} AI events`);

const acceptedByEvent = [];
for (const ev of events) {
  const title = ev.title.trim();
  console.log(`\nFetching attendees for: ${title}`);
  const attendees = listEventAttendees(ev.calendar_id, ev.event_id, { profile: PROFILE });
  const accepted = attendees.filter(a => a.rsvpStatus === 'accept');
  console.log(`  total attendees: ${attendees.length}, accepted: ${accepted.length}`);
  acceptedByEvent.push({ title, eventId: ev.event_id, accepted });
}

if (acceptedByEvent.length < 3) {
  console.log('\nNot enough AI events to compute intersection.');
  process.exit(0);
}

const [first, second, third] = acceptedByEvent;
const mapById = new Map();
for (const a of first.accepted) mapById.set(a.userId, a.displayName);
for (const a of second.accepted) mapById.set(a.userId, a.displayName);
for (const a of third.accepted) mapById.set(a.userId, a.displayName);

const set1 = new Set(first.accepted.map(a => a.userId));
const set2 = new Set(second.accepted.map(a => a.userId));
const set3 = new Set(third.accepted.map(a => a.userId));

const intersection = [...set1].filter(id => set2.has(id) && set3.has(id));

console.log(`\n=== 三场 AI 共学都报名（接受）的人：${intersection.length} 位 ===`);
for (const id of intersection) {
  console.log(`- ${mapById.get(id) || '(unknown)'} (${id})`);
}

console.log('\n=== 各场明细 ===');
for (const ev of acceptedByEvent) {
  console.log(`\n${ev.title} (${ev.eventId})`);
  for (const a of ev.accepted) {
    console.log(`  [accept] ${a.displayName} (${a.userId})`);
  }
}
