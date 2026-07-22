import type { ActivityMeetup } from './store/meetups.js';
import { listAllMeetupsForWiki } from './store/meetups.js';
import { appendDocxContent } from './lark.js';
import { loadConfigs } from './configs.js';

// Deterministic Markdown renderer for the "SeeDAO 活动日历" wiki page.
// Takes the full activity_meetups list and produces two sections:
//   即将举行  — confirmed meetups whose end_time is in the future, ascending
//   过去活动  — everything else (past or cancelled), descending
// No LLM is involved; the output is pure data formatting.

/** Format unix seconds as "YYYY-MM-DD HH:mm" (local time, sv-SE locale for ISO-like output). */
function fmt(sec: number): string {
  return new Date(sec * 1000).toLocaleString('sv-SE', { hour12: false }).slice(0, 16).replace('T', ' ');
}

/** Human-readable description of a recurrence rule string. Returns '' for one-off events. */
function describeRecurrence(rrule: string): string {
  if (!rrule) return '';
  // Extract COUNT from the RRULE for a compact label, e.g. "每周×10".
  const freqMatch = /FREQ=(\w+)/.exec(rrule);
  const countMatch = /COUNT=(\d+)/.exec(rrule);
  const freq = freqMatch ? freqMatch[1] : '';
  const count = countMatch ? countMatch[1] : '';
  const freqZh: Record<string, string> = { DAILY: '每天', WEEKLY: '每周', MONTHLY: '每月' };
  const label = freqZh[freq] ?? freq;
  return count ? `${label}×${count}次` : label;
}

/** Escape pipe characters inside a Markdown table cell. */
function esc(s: string): string {
  return s.replace(/\|/g, '\\|');
}

/**
 * Generate a Markdown page body for the "SeeDAO 活动日历" wiki document.
 * Overwrites the entire page each time it is called; all state comes from the DB snapshot.
 */
export function generateMeetupWikiMarkdown(meetups: ActivityMeetup[]): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const updateTime = fmt(nowSec);

  const upcoming = meetups
    .filter((m) => m.status === 'confirmed' && m.endTime > nowSec)
    .sort((a, b) => a.startTime - b.startTime);

  const past = meetups
    .filter((m) => m.status !== 'confirmed' || m.endTime <= nowSec)
    .sort((a, b) => b.startTime - a.startTime);

  const header = `# SeeDAO 活动日历 (自动更新)\n\n> 最后更新：${updateTime}\n`;

  const upcomingSection = buildUpcomingTable(upcoming);
  const pastSection = buildPastTable(past);

  return [header, upcomingSection, pastSection].join('\n');
}

function buildUpcomingTable(meetups: ActivityMeetup[]): string {
  const head = `## 即将举行\n\n| 标题 | 开始时间 | 结束时间 | 标签 | 循环 | 视频会议 | 日历链接 |\n|------|----------|----------|------|------|---------|----------|\n`;
  if (meetups.length === 0) return head + '| （暂无）| | | | | | |\n';

  const rows = meetups.map((m) => {
    const tags = esc(m.tags.length ? m.tags.join('、') : '-');
    const recur = esc(describeRecurrence(m.recurrence) || '单次');
    const vc = m.meetupUrl ? `[入会](${m.meetupUrl})` : '-';
    // Prefer the public share link; fall back to the in-app deep link.
    const calUrl = m.shareLink || m.appLink;
    const cal = calUrl ? `[日历](${calUrl})` : '-';
    return `| ${esc(m.title)} | ${fmt(m.startTime)} | ${fmt(m.endTime)} | ${tags} | ${recur} | ${vc} | ${cal} |`;
  });
  return head + rows.join('\n') + '\n';
}

function buildPastTable(meetups: ActivityMeetup[]): string {
  const head = `\n## 过去活动\n\n| 标题 | 开始时间 | 结束时间 | 标签 | 状态 |\n|------|----------|----------|------|------|\n`;
  if (meetups.length === 0) return head + '| （暂无）| | | | |\n';

  const rows = meetups.map((m) => {
    const tags = esc(m.tags.length ? m.tags.join('、') : '-');
    const status = m.status === 'cancelled' ? '已取消' : '已结束';
    return `| ${esc(m.title)} | ${fmt(m.startTime)} | ${fmt(m.endTime)} | ${tags} | ${status} |`;
  });
  return head + rows.join('\n') + '\n';
}

/**
 * Rebuild and overwrite the "SeeDAO 活动日历" wiki page from the current DB snapshot.
 * Deterministic and idempotent: safe to call after any meetup create / update / cancel so the
 * page always mirrors the live meetup list. Returns false when the wiki document id is not
 * configured or the overwrite fails; callers treat that as a non-fatal no-op.
 */
export async function refreshMeetupWiki(opts: { profile?: string } = {}): Promise<boolean> {
  let docId: string | undefined;
  try {
    docId = loadConfigs().lark.activityWikiDocId;
  } catch {
    return false;
  }
  if (!docId) return false;
  const markdown = generateMeetupWikiMarkdown(await listAllMeetupsForWiki());
  return appendDocxContent(docId, markdown, { profile: opts.profile, overwrite: true, format: 'markdown' });
}
