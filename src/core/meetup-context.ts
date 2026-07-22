import { listActiveMeetupsForContext } from './store/meetups.js';
import { loadConfigs } from './configs.js';

// Background block describing current / upcoming community activities, injected into the serve
// prompt so the agent answers "what activities / meetings are coming up (or today)" from the
// activity_meetups DB — with real times, tags, VC links and calendar links — instead of guessing.
// Deterministic and read-only; the persona decides what to say, the data comes from here.

/** Format unix seconds as "YYYY-MM-DD HH:mm" (local time). */
function fmt(sec: number): string {
  return new Date(sec * 1000).toLocaleString('sv-SE', { hour12: false }).slice(0, 16).replace('T', ' ');
}

const FREQ_ZH: Record<string, string> = { DAILY: '每天', WEEKLY: '每周', MONTHLY: '每月' };

/** Compact human label for a recurrence rule; '单次' for a one-off event. */
function recurLabel(rrule: string): string {
  if (!rrule) return '单次';
  const freq = /FREQ=(\w+)/.exec(rrule)?.[1] ?? '';
  const count = /COUNT=(\d+)/.exec(rrule)?.[1] ?? '';
  const label = FREQ_ZH[freq] ?? freq;
  return count ? `${label}×${count}次` : label || '循环';
}

/** Number of activities listed inline before deferring the rest to the wiki page. */
const MAX_INLINE = 15;

/**
 * Build the 【近期活动】 background block for the serve prompt. Returns '' when there are no active
 * activities or the activity module is absent for this soul, so it self-gates to the soul that
 * actually runs the module (others simply get no block).
 */
export async function buildMeetupContextBlock(): Promise<string> {
  let meetups: Awaited<ReturnType<typeof listActiveMeetupsForContext>>;
  try {
    meetups = await listActiveMeetupsForContext();
  } catch {
    return ''; // activity module table not present for this soul
  }
  if (meetups.length === 0) return '';

  let wikiUrl = '';
  try {
    const token = loadConfigs().lark.activityWikiNodeToken;
    if (token) wikiUrl = `https://seedao2049.feishu.cn/wiki/${token}`;
  } catch { /* config unavailable */ }

  const lines = meetups.slice(0, MAX_INLINE).map((m) => {
    const cal = m.shareLink || m.appLink;
    const tagPart = m.tags.length ? `｜标签：${m.tags.join('、')}` : '';
    const parts = [`- ${fmt(m.startTime)} ${m.title}（${recurLabel(m.recurrence)}${tagPart}）`];
    if (m.meetupUrl) parts.push(`视频 ${m.meetupUrl}`);
    if (cal) parts.push(`日历 ${cal}`);
    return parts.join('｜');
  });

  const more = meetups.length > MAX_INLINE ? `\n（另有 ${meetups.length - MAX_INLINE} 场，完整见知识库）` : '';
  const wikiLine = wikiUrl ? `\n完整活动日历（知识库【SeeDAO 活动日历】）：${wikiUrl}` : '';

  return (
    '【近期活动】以下是活动模块数据库里的当前 / 近期社区活动，回答"最近 / 今天 / 近期有什么活动 / 会议"之类问题时【以此为准】，' +
    '不要自己编造标题、时间或链接；需要时把视频 / 日历链接给对方（循环活动按标注的每周几 / 频率推算今天有没有）：\n' +
    lines.join('\n') + more + wikiLine + '\n\n'
  );
}
