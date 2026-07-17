// ── newcomer self-introduction welcome + 收录自介 reward ─────────────────────────
// Two deterministic (no-LLM) pieces of the newcomer flow live here:
//   1. buildNewcomerWelcomePost — the fixed copy that welcomes new members and invites them to
//      introduce themselves. The member-sync poll sends it to the visitor group when people join,
//      replacing the heartbeat LLM's ad-hoc (and often bland) group greetings.
//   2. handleRecordSelfIntro — an operator-only command: replying to a newcomer's self-intro with
//      "@bot 收录自介" grants that author a fixed LP reward, once per self-intro message.
// Keeping the copy and the reward in one module keeps the two halves of the flow in sync.

import { getMessageById, type PostElement } from './lark.js';
import { isAdmin } from './configs.js';
import * as store from './store.js';
import { log } from './log.js';

/** LP awarded to a newcomer once their self-intro is 收录 (recorded) by an operator. */
export const SELF_INTRO_REWARD_PT = 60;

/** Ledger reason for the self-intro reward; also the idempotency key (with the quoted message id). */
export const SELF_INTRO_GRANT_REASON = 'welcome:self-intro';

// The invitation copy, verbatim per the operator's request: address the newcomer, ask them to
// introduce themselves against a few prompts, then state the reward. One string per rendered line.
const SELF_INTRO_BODY_LINES: string[] = [
  '欢迎你自我介绍一下自己，最近在忙的项目或活动，关注的主题方向等，以及：',
  '怎么来到 SeeDAO：',
  '对参与 SeeDAO 的期待：',
  '可以给予 SeeDAO 的支持：',
  '',
  `只要自我介绍完成，就能获得 ${SELF_INTRO_REWARD_PT} LP 奖励（社区积分点数，可用于社区各项活动中）。`,
];

/** Default cap on how many joiners are @-mentioned in one welcome, so a bulk join doesn't @-storm. */
const DEFAULT_MAX_WELCOME_MENTIONS = 12;

export interface Joiner {
  openId: string;
  name?: string;
}

/**
 * Build the deterministic newcomer-welcome post: a greeting line that @-mentions the new joiners,
 * followed by the fixed self-intro invitation copy. The return value is ready for {@link sendPost}.
 * Returns null when none of the joiners has a usable open_id (nothing to welcome). `maxMentions` caps
 * how many are @-mentioned before the rest are summarized ("等 N 位新朋友") — the batched digest passes
 * a higher cap than a single poll round, since it deliberately gathers a whole window's arrivals.
 */
export function buildNewcomerWelcomePost(
  joiners: Joiner[],
  maxMentions: number = DEFAULT_MAX_WELCOME_MENTIONS,
): { title: string; content: PostElement[][] } | null {
  const valid = joiners.filter((j) => j.openId);
  if (valid.length === 0) return null;

  const shown = valid.slice(0, Math.max(1, maxMentions));
  const greeting: PostElement[] = [{ tag: 'text', text: '欢迎 ' }];
  shown.forEach((j, i) => {
    if (i > 0) greeting.push({ tag: 'text', text: '、' });
    greeting.push({ tag: 'at', user_id: j.openId, user_name: j.name || undefined });
  });
  // When the join batch exceeds the mention cap, name the count instead of @-ing everyone.
  const overflow = valid.length - shown.length;
  const tail = overflow > 0 ? ` 等 ${valid.length} 位新朋友` : '';
  greeting.push({ tag: 'text', text: `${tail} 加入 SeeDAO 数字城邦 🪐` });

  const content: PostElement[][] = [greeting, [{ tag: 'text', text: '' }]];
  for (const line of SELF_INTRO_BODY_LINES) content.push([{ tag: 'text', text: line }]);
  return { title: '', content };
}

// A leading @mention run (like "@tudigong " / "@_user_1 "); one or more may precede the body.
const LEADING_MENTION = /^@\S+\s+/;

/**
 * Whether a message is the 收录自介 command: after stripping leading @mentions and an optional / or !
 * prefix, the body is exactly "收录自介" (optionally followed by whitespace + an operator note).
 */
export function isRecordSelfIntroCommand(text: string): boolean {
  let s = (text ?? '').trim();
  while (LEADING_MENTION.test(s)) s = s.replace(LEADING_MENTION, '');
  s = s.replace(/^[/!]/, '').trim();
  return /^收录自介(\s|$)/.test(s);
}

export interface RecordSelfIntroCtx {
  /** id of the 收录自介 command message itself (om_xxx) — reliably present in the event envelope */
  commandMessageId: string;
  /** root_id off the event envelope: the first message of the reply chain — the self-intro itself */
  eventRootId?: string;
  /** the envelope's direct parent (`reply_to`); used when there is no root_id */
  eventParentId?: string;
  /** open_id of whoever issued the 收录自介 command (must be an operator) */
  senderOpenId: string;
  /** lark-cli profile for the API fetch */
  profile?: string;
}

/**
 * Resolve the self-intro message an operator's 收录自介 command targets. Prefer root_id — the FIRST
 * message of the reply chain, i.e. the self-intro that opened it — so writing 收录自介 anywhere in the
 * newcomer's self-intro topic traces back to that opening message; then the direct parent.
 *
 * Mind the field names, they differ by source: the event envelope carries `root_id` + `reply_to` (and
 * no parent_id at all), while the OpenAPI message resource calls the same two `root_id` + `parent_id`.
 * The envelope's own linkage is authoritative and free, so it is used first; the getMessageById fetch
 * is only a fallback for envelopes that carried none. Returns '' when nothing is resolvable (or it
 * points at the command itself).
 */
function resolveSelfIntroTarget(
  commandMessageId: string,
  eventRootId: string,
  eventParentId: string,
  profile?: string
): string {
  const fromEvent = eventRootId || eventParentId;
  if (fromEvent && fromEvent !== commandMessageId) return fromEvent;
  if (commandMessageId) {
    const cmd = getMessageById(commandMessageId, { as: 'bot', profile });
    const t = cmd?.rootId || cmd?.parentId || '';
    if (t) return t === commandMessageId ? '' : t;
  }
  return '';
}

/**
 * Handle an operator's 收录自介 command: grant {@link SELF_INTRO_REWARD_PT} LP to the author of the
 * self-intro that the command's topic/reply traces back to, at most once per that message. The caller
 * has already confirmed the text is the command (via {@link isRecordSelfIntroCommand}); this validates
 * permission, resolves the target, checks the author + idempotency, grants, and returns the reply text.
 */
export function handleRecordSelfIntro(ctx: RecordSelfIntroCtx): string {
  const { commandMessageId, eventRootId, eventParentId, senderOpenId, profile } = ctx;

  // 1) operator whitelist — only trusted operators may award the reward (prevents self-farming).
  if (!senderOpenId || !isAdmin(senderOpenId)) {
    return '「收录自介」仅限运营使用～';
  }
  // 2) trace back to the self-intro message (topic/reply root).
  const targetId = resolveSelfIntroTarget(commandMessageId, eventRootId ?? '', eventParentId ?? '', profile);
  if (!targetId) {
    return `请「回复 / 引用」该成员的自我介绍消息（或在其自我介绍所在的话题下），再 @我 写「收录自介」，即可为对方发放 ${SELF_INTRO_REWARD_PT} LP。`;
  }
  // 3) resolve the self-intro's author.
  const quoted = getMessageById(targetId, { as: 'bot', profile });
  if (!quoted || !quoted.senderOpenId) {
    return '没能读取到那条自我介绍消息，请确认是回复 / 引用群内成员的发言后重试。';
  }
  if (quoted.senderType === 'app') {
    return '追溯到的消息不是成员发言（像是机器人消息），无法收录；请回复 / 引用该成员本人的自我介绍。';
  }
  const name = store.memberName(quoted.senderOpenId) || quoted.senderName || '这位成员';
  // 4) idempotency — a given self-intro pays out only once, however many times 收录自介 is repeated.
  if (store.hasPtGrantForRef(SELF_INTRO_GRANT_REASON, targetId)) {
    return `${name} 的这条自我介绍已经收录过啦，不重复发放。`;
  }
  // 5) grant, keyed to the self-intro message id for the idempotency gate above.
  store.grantPt(quoted.senderOpenId, SELF_INTRO_REWARD_PT, SELF_INTRO_GRANT_REASON, targetId);
  try {
    store.recordActivity('welcome_self_intro', senderOpenId, null, targetId, {
      target: quoted.senderOpenId,
    });
  } catch {
    /* best-effort analytics */
  }
  log.info(
    `收录自介：为 ${name}（${quoted.senderOpenId}）发放 ${SELF_INTRO_REWARD_PT} LP，操作者 ${senderOpenId}`,
  );
  // Append the recipient's standard LP status footer (e.g. "\n\n[乔伊] 🌱 LP : 119.9 → 179.9 (+60.0)"),
  // computed AFTER the grant so it carries the before→after arrow. buildStatusFooter prepends a blank line.
  const footer = store.buildStatusFooter(quoted.senderOpenId, SELF_INTRO_REWARD_PT);
  return `已收录 ${name} 的自我介绍，发放 ${SELF_INTRO_REWARD_PT} LP 🎉${footer}`;
}
