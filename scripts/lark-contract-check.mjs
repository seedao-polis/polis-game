#!/usr/bin/env node
/**
 * lark-cli output contract check.
 *
 * Why this exists: lark-cli ships breaking output changes silently. 1.0.69 rewrote the success
 * envelope ({code:0} -> {ok:true}) AND humanised `create_time` on the `+` shortcut commands
 * ("1784271118149" -> "2026-07-17 14:51"). Neither is a compile error. The second one disabled
 * auto-pinning for two weeks with no log line, because the parse produced NaN and the gate that
 * consumed it simply never fired.
 *
 * What it checks: not field *shape* (a snapshot would just freeze today's format, including a bad
 * one) but whether the parsers we actually ship can still make sense of the live output. Every
 * timestamp assertion runs the real larkTimeToMs() from dist/ and demands a plausible epoch. A
 * format we already tolerate passes; a format we do not, fails — which is exactly the question
 * worth asking after `lark-cli update`.
 *
 * Two lark-cli command families behave differently and both are probed:
 *   - `+` shortcuts   -> a presentation layer that humanises SOME fields, inconsistently
 *                        (top-level create_time yes; nested reactions[].action_time no)
 *   - native / api    -> raw API passthrough (units vary per endpoint: pins ms, drive seconds)
 *
 * Read-only: every probe here is a list/get. Never add a write command to this file.
 *
 * Usage:  node scripts/lark-contract-check.mjs [--verbose]
 * Exit:   0 = every contract holds, 1 = at least one broke (or no data to judge), 2 = probe error.
 */

import { execFileSync } from 'node:child_process';
import { larkTimeToMs } from '../dist/core/lark.js';

const VERBOSE = process.argv.includes('--verbose');

// A parsed timestamp is credible only inside this window; it catches both NaN->0 and a
// seconds/milliseconds mix-up (which would land in 1970 or the year 58000).
const SANE_FROM = Date.UTC(2020, 0, 1);
const SANE_TO = Date.UTC(2100, 0, 1);

const results = [];
const record = (status, probe, field, detail, sample) =>
  results.push({ status, probe, field, detail, sample });

/** Run a read-only lark-cli command and return its parsed envelope, or null on failure. */
function probe(args) {
  let out;
  try {
    out = execFileSync('lark-cli', [...args, '--format', 'json'], {
      encoding: 'utf-8',
      timeout: 90_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    return { error: `exec failed: ${e.message?.slice(0, 200)}` };
  }
  const start = out.indexOf('{'); // lark-cli may emit warning lines before the JSON
  if (start < 0) return { error: `no JSON in output: ${out.slice(0, 120)}` };
  try {
    return { env: JSON.parse(out.slice(start)) };
  } catch (e) {
    return { error: `JSON parse failed: ${e.message?.slice(0, 120)}` };
  }
}

/** Read a dotted path ("data.messages[].create_time" uses [] to mean "first element"). */
function pick(obj, path) {
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    if (seg.endsWith('[]')) {
      cur = cur[seg.slice(0, -2)];
      if (!Array.isArray(cur) || cur.length === 0) return undefined;
      cur = cur[0];
    } else {
      cur = cur[seg];
    }
  }
  return cur;
}

/** Describe a value's format class — for the human reading the report, not for the assertion. */
function classify(v) {
  if (v === undefined) return 'MISSING';
  if (v === null) return 'null';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return 'number';
  if (typeof v !== 'string') return typeof v;
  if (/^\d{13}$/.test(v)) return 'epoch_ms_string';
  if (/^\d{10}$/.test(v)) return 'epoch_sec_string';
  if (/^\d+$/.test(v)) return 'numeric_string';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) return 'iso8601';
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v)) return 'humanised_datetime';
  return 'string';
}

/** The timestamp assertion: our shipped parser must turn the live value into a credible epoch. */
function checkTime(probeName, field, value) {
  if (value === undefined) return record('SKIP', probeName, field, 'no sample in this run', '');
  const ms = larkTimeToMs(value);
  const cls = classify(value);
  if (ms === 0) {
    return record('FAIL', probeName, field, `larkTimeToMs() cannot parse this (-> 0); class=${cls}`, value);
  }
  if (ms < SANE_FROM || ms > SANE_TO) {
    return record('FAIL', probeName, field, `parsed to ${new Date(ms).toISOString()} — implausible, suspect a seconds/ms mix-up`, value);
  }
  record('OK', probeName, field, `${cls} -> ${new Date(ms).toISOString()}`, value);
}

/** A non-time field: assert it is present and, when given, matches an allowed set. */
function checkField(probeName, field, value, { allowed } = {}) {
  if (value === undefined || value === '') {
    return record('FAIL', probeName, field, 'missing or empty — a rename here fails silently in our code', '');
  }
  if (allowed && !allowed.includes(value)) {
    return record('FAIL', probeName, field, `value ${JSON.stringify(value)} outside expected set ${JSON.stringify(allowed)}`, value);
  }
  record('OK', probeName, field, classify(value), value);
}

// ── probes ──────────────────────────────────────────────────────────────────
// Chat ids are discovered at runtime rather than hardcoded, so this stays valid as groups change.

console.log('lark-cli output contract check\n');
const version = (() => {
  try {
    return execFileSync('lark-cli', ['--version'], { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
})();
console.log(`  ${version}`);

// 1. `im +chat-list` (+ shortcut) — also our source of a chat to probe messages in.
const chatList = probe(['im', '+chat-list']);
if (chatList.error) {
  console.error(`\nFATAL: im +chat-list — ${chatList.error}`);
  process.exit(2);
}
checkField('im +chat-list', 'ok', chatList.env?.ok === true ? 'true' : undefined);
checkField('im +chat-list', 'data.chats[].chat_id', pick(chatList.env, 'data.chats[].chat_id'));

const chats = chatList.env?.data?.chats ?? [];
if (chats.length === 0) {
  console.error('\nFATAL: no chats visible — cannot judge the message contract.');
  process.exit(2);
}

// 2. `im +chat-messages-list` (+ shortcut) — the command that broke. Walk chats until one yields a
//    message carrying reactions, so the nested action_time contract gets a real sample.
let msgProbeChat = null;
let messages = [];
let reactionSample;
for (const c of chats.slice(0, 6)) {
  const r = probe(['im', '+chat-messages-list', '--chat-id', c.chat_id, '--page-size', '18']);
  if (r.error) continue;
  const list = r.env?.data?.messages ?? [];
  if (list.length === 0) continue;
  if (!msgProbeChat) {
    msgProbeChat = c;
    messages = list;
  }
  const withRx = list.find((m) => m?.reactions?.details?.length);
  if (withRx) {
    msgProbeChat = c;
    messages = list;
    reactionSample = withRx.reactions.details[0];
    break;
  }
}

if (!msgProbeChat) {
  console.error('\nFATAL: no chat returned messages — cannot judge the message contract.');
  process.exit(2);
}

const P = 'im +chat-messages-list';
const m0 = messages[0];
checkField(P, 'data.messages[] (not data.items[])', messages.length ? 'present' : undefined);
checkField(P, 'data.messages[].message_id', m0?.message_id);
checkField(P, 'data.messages[].msg_type', m0?.msg_type);
// message_position: parseInt'd with no fallback; NaN silently empties the whole poll loop.
checkField(P, 'data.messages[].message_position', m0?.message_position);
if (m0?.message_position !== undefined && !/^\d+$/.test(String(m0.message_position))) {
  record('FAIL', P, 'data.messages[].message_position', 'not an integer string — Number.parseInt would yield NaN and the user-channel poll would deliver nothing', m0.message_position);
}
// The field that broke: humanised on this command, raw epoch on the event stream and native api.
checkTime(P, 'data.messages[].create_time', m0?.create_time);
checkTime(P, 'data.messages[].update_time', m0?.update_time);
// Nested, and NOT humanised — proof the presentation layer is applied per-field, not per-command.
if (reactionSample) {
  checkTime(P, 'data.messages[].reactions.details[].action_time', reactionSample.action_time);
  checkField(P, 'data.messages[].reactions.details[].operator.operator_type', reactionSample.operator?.operator_type, { allowed: ['user', 'app'] });
  checkField(P, 'data.messages[].reactions.details[].operator.operator_id', reactionSample.operator?.operator_id);
  checkField(P, 'data.messages[].reactions.details[].emoji_type', reactionSample.emoji_type);
} else {
  record('SKIP', P, 'reactions.details[].*', 'no reacted message in the sampled chats', '');
}

// 3. `calendar +agenda` (+ shortcut) — ISO 8601 under .datetime, while the native write API takes
//    .timestamp. The two shapes already disagree; a convergence would silently zero our event times.
const agenda = probe(['calendar', '+agenda', '--as', 'user']);
if (agenda.error) {
  record('SKIP', 'calendar +agenda', '*', agenda.error, '');
} else {
  checkField('calendar +agenda', 'data[] is a top-level array', Array.isArray(agenda.env?.data) ? 'array' : undefined);
  const ev0 = pick(agenda.env, 'data[]');
  if (!ev0) {
    record('SKIP', 'calendar +agenda', 'data[].start_time.datetime', 'no upcoming event to sample', '');
  } else {
    checkTime('calendar +agenda', 'data[].start_time.datetime', ev0?.start_time?.datetime);
    checkField('calendar +agenda', 'data[].event_id', ev0?.event_id);
    // A bare "YYYY-MM-DD HH:MM" here would NOT throw — new Date() reads it as local time. That is a
    // silent timezone shift rather than a detectable failure, so pin the offset explicitly.
    if (ev0?.start_time?.datetime && !/[+-]\d{2}:\d{2}$|Z$/.test(ev0.start_time.datetime)) {
      record('FAIL', 'calendar +agenda', 'data[].start_time.datetime', 'lost its UTC offset — new Date() would silently reinterpret this as local time', ev0.start_time.datetime);
    }
  }
}

// 4. `im pins list` (native) — same field name as #2, raw epoch ms. The contrast is the point.
const pins = probe(['im', 'pins', 'list', '--params', JSON.stringify({ chat_id: msgProbeChat.chat_id })]);
if (pins.error) {
  record('SKIP', 'im pins list', '*', pins.error, '');
} else {
  checkField('im pins list', 'ok', pins.env?.ok === true ? 'true' : undefined);
  const pin0 = pick(pins.env, 'data.items[].create_time');
  if (pin0 === undefined) record('SKIP', 'im pins list', 'data.items[].create_time', 'no pinned message to sample', '');
  else checkTime('im pins list', 'data.items[].create_time', pin0);
}

// 5. `drive files list` (native) — raw epoch SECONDS, where pins gives ms. Units vary per endpoint.
const drive = probe(['drive', 'files', 'list']);
if (drive.error) {
  record('SKIP', 'drive files list', '*', drive.error, '');
} else {
  checkField('drive files list', 'ok', drive.env?.ok === true ? 'true' : undefined);
  checkTime('drive files list', 'data.files[].created_time', pick(drive.env, 'data.files[].created_time'));
  checkField('drive files list', 'data.files[].type', pick(drive.env, 'data.files[].type'));
}

// ── report ──────────────────────────────────────────────────────────────────
const fails = results.filter((r) => r.status === 'FAIL');
const skips = results.filter((r) => r.status === 'SKIP');

console.log();
for (const r of results) {
  if (r.status === 'OK' && !VERBOSE) continue;
  const icon = r.status === 'OK' ? '  ok  ' : r.status === 'SKIP' ? ' skip ' : ' FAIL ';
  console.log(`${icon} ${r.probe}`);
  console.log(`        ${r.field}`);
  console.log(`        ${r.detail}`);
  if (r.sample !== '') console.log(`        sample: ${JSON.stringify(r.sample)}`);
}

console.log(
  `\n${results.filter((r) => r.status === 'OK').length} ok, ${fails.length} failed, ${skips.length} skipped` +
    (VERBOSE ? '' : '   (--verbose to list the passing ones)')
);

if (fails.length > 0) {
  console.log(
    '\nlark-cli changed its output in a way our parsers do not handle.\n' +
      'Do not "fix" the assertion — find every consumer of that field first.\n' +
      'Timestamps must go through larkTimeToMs(); mind that chat_reactions stores action_time in\n' +
      'SECONDS while createTime is milliseconds, so a blind swap there introduces a unit bug.\n' +
      'Background: workspaces/tudigong/memory/lark-cli-playbook.md §11.'
  );
  process.exit(1);
}
console.log('\nEvery field our code consumes is still parseable.');
