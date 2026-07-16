import fs from 'node:fs';
import path from 'node:path';
import { listBadgeDefinitions, type BadgeDefinition } from './store/gamification.js';
import {
  appendDocxContent,
  fetchDocxRawContent,
  insertDocxImageBlock,
  moveDocxBlocksAfter,
} from './lark.js';
import { loadConfigs } from './configs.js';

// Deterministic renderer + push for the "徽章列表（自动更新）" wiki page. The page is a pure
// projection of the badges catalogue: every badge create / update / delete calls refreshBadgeWiki,
// which overwrites the whole page from the current DB snapshot (same pattern as the "SeeDAO 活动日历"
// and "访客里程碑" wikis). No LLM is involved; the output is a fixed template.
//
// The columns are 徽章 · 名称 · 类型 · 有效期 · 说明 · 效果:
//   徽章    — badge image (empty until per-badge artwork exists in the `file` field)
//   名称    — badge_name on the first line, badge_id (gray) on the second
//   类型    — `type`, mapped to a Chinese label (role → 身份)
//   事件    — award-time `event` id, mapped to a Chinese name on the first line, event_id (gray) below
//   说明    — `description`
//   效果    — reserved (empty for now)
//   期限    — `duration` (起始/结束 YYYYMMDD), empty / fully-unbounded → 永久
//
// Rendered as the doc XML subset (not Markdown) because the 名称/事件 cells need an in-cell line break
// and the id needs gray styling — neither survives a Markdown table cell.

/** Chinese label for a badge `type`. Extend as new types appear; unknown non-empty types show raw. */
const TYPE_LABELS: Record<string, string> = { role: '身份' };

function typeLabel(type: string): string {
  const t = type.trim();
  if (!t) return '';
  return TYPE_LABELS[t] ?? t;
}

/**
 * Human-readable Chinese names for award-time event ids (the `event` field's first "/"-segment).
 * Keep in sync with the events registered in events.ts; an unmapped id degrades to just the raw id.
 */
const EVENT_LABELS: Record<string, string> = {
  'morning_greeting': '早安问候',
  'lurker-discovered': '潜水被发现',
  'badge-awarded': '徽章获得（私信恭喜）',
  'badge-awarded-default': '徽章发放公告',
  'badge-awarded-group': '徽章群发公告',
  'class-event-notify': '活动报名进度',
  'visitor-num-notify': '访客人数里程碑',
  'cityhall-proposal-voted-notify': '市政厅提案决议',
  'like-maniac-notify': '点赞狂魔出现',
  'first-try-notify': '首次体验新功能',
};

/**
 * Render the 事件 cell for a badge. The award event is the first "/"-segment of `event`. When it maps
 * to a Chinese name, show that on the first line and the raw event_id (gray) below; an unmapped id
 * shows the id alone (gray); an empty `event` renders an empty cell.
 */
function eventCell(rawEvent: string): string {
  const id = (rawEvent.split('/')[0] ?? '').trim();
  if (!id) return '';
  const label = EVENT_LABELS[id];
  if (label && label !== id) {
    return `${esc(label)}<br/><span text-color="gray">${esc(id)}</span>`;
  }
  return `<span text-color="gray">${esc(id)}</span>`;
}

/** Format a YYYYMMDD token as YYYY-MM-DD; return the raw token if it is not 8 digits. */
function fmtYmd(ymd: string): string {
  return /^\d{8}$/.test(ymd) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : ymd;
}

/**
 * Human label for a `duration` string ("起始/结束", YYYYMMDD; 00000000 = no start, 99999999 = no end).
 * Empty or fully-unbounded both render as 永久; a one-sided bound shows 不限 / 长期 for the open end.
 */
function durationLabel(duration: string): string {
  const d = duration.trim();
  if (!d) return '永久';
  const [rawStart = '', rawEnd = ''] = d.split('/');
  const start = rawStart.trim();
  const end = rawEnd.trim();
  const unboundedStart = !start || start === '00000000';
  const unboundedEnd = !end || end === '99999999';
  if (unboundedStart && unboundedEnd) return '永久';
  return `${unboundedStart ? '不限' : fmtYmd(start)} ~ ${unboundedEnd ? '长期' : fmtYmd(end)}`;
}

/** Escape text for placement inside the doc XML (tags stay literal; only cell text is escaped). */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Format the current local time as "YYYY-MM-DD HH:mm". */
function nowLabel(): string {
  return new Date().toLocaleString('sv-SE', { hour12: false }).slice(0, 16).replace('T', ' ');
}

/**
 * Render the full "徽章列表" wiki page body (title + intro + table) from a badge snapshot.
 * The output is passed to an `overwrite` update, so it must include the `<title>`.
 */
export function renderBadgeWikiXml(badges: BadgeDefinition[]): string {
  const header =
    `<title>徽章列表（自动更新）</title>` +
    `<p>城邦目前已上线的徽章一览（效果一列待补充）。最后更新：${esc(nowLabel())}</p>`;

  const colgroup =
    `<colgroup><col width="56"/><col width="170"/><col width="64"/><col width="150"/><col width="240"/><col width="100"/><col width="120"/></colgroup>`;
  const thead =
    `<thead><tr>` +
    ['徽章', '名称', '类型', '事件', '说明', '效果', '期限']
      .map((h) => `<th background-color="light-gray">${h}</th>`)
      .join('') +
    `</tr></thead>`;

  const rows = badges.length === 0
    ? `<tr><td></td><td>（暂无徽章）</td><td></td><td></td><td></td><td></td><td></td></tr>`
    : badges
        .map((b) => {
          const name = `${esc(b.name)}<br/><span text-color="gray">${esc(b.badgeId)}</span>`;
          return (
            `<tr>` +
            `<td></td>` +
            `<td>${name}</td>` +
            `<td>${esc(typeLabel(b.type))}</td>` +
            `<td>${eventCell(b.event)}</td>` +
            `<td>${esc(b.description)}</td>` +
            `<td></td>` +
            `<td>${esc(durationLabel(b.duration))}</td>` +
            `</tr>`
          );
        })
        .join('');

  return `${header}<table>${colgroup}${thead}<tbody>${rows}</tbody></table>`;
}

/** Display width (px) of a badge icon inside the 徽章 cell; height auto-scales from the source. */
const BADGE_IMG_WIDTH = 36;

/**
 * Resolve a badge's image to a cwd-relative path usable by `docs +media-insert`, or '' when the badge
 * has no local artwork. `file` holds a repo-relative image path (e.g. assets/badges/<id>.png); a value
 * that looks like a URL or a bare Feishu token is ignored (those cannot be re-uploaded per refresh).
 * The path must exist and stay inside the repo — media-insert rejects absolute out-of-tree paths.
 */
function badgeImageRelPath(b: BadgeDefinition): string {
  const rel = b.file.trim();
  if (!rel || /^https?:\/\//i.test(rel) || !rel.includes('/')) return '';
  const abs = path.resolve(process.cwd(), rel);
  return abs.startsWith(process.cwd() + path.sep) && fs.existsSync(abs) ? rel : '';
}

/**
 * After the table is overwritten, locate the empty `<p>` block id inside each row's 徽章 (first) cell,
 * in row order. Feishu materializes an empty `<td>` as `<td><p id="…"></p></td>`, so the first
 * `<p id>` within each `<tr>` is that row's image-cell anchor. Returns [] when the table can't be
 * parsed. Row order mirrors listBadgeDefinitions(), so index i ↔ badge i.
 */
function imageCellAnchorIds(content: string): string[] {
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(content)?.[1] ?? '';
  const ids: string[] = [];
  const trRe = /<tr\b[\s\S]*?<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(tbody))) {
    ids.push(/<p id="([^"]+)"/.exec(m[0])?.[1] ?? '');
  }
  return ids;
}

/**
 * Rebuild and overwrite the "徽章列表" wiki page from the current DB snapshot. Deterministic and
 * idempotent: safe to call after any badge import / delete so the page always mirrors the catalogue.
 *
 * Feishu's docx overwrite drops all image blocks and cannot re-reference a stored image by url/token,
 * so per-badge artwork can't live in the overwritten body. Instead, after writing the text table this
 * re-uploads each badge's local image (media-insert appends it at the doc end) and moves it into that
 * badge's 徽章 cell. The image pass is best-effort: if it fails the text table still stands, and the
 * next refresh reconciles.
 *
 * Returns false when the wiki document id is not configured or the text overwrite fails; callers treat
 * that as a non-fatal no-op.
 */
export function refreshBadgeWiki(opts: { profile?: string } = {}): boolean {
  let docId: string | undefined;
  try {
    docId = loadConfigs().lark.badgeWikiDocId;
  } catch {
    return false;
  }
  if (!docId) return false;

  const badges = listBadgeDefinitions();
  const ok = appendDocxContent(docId, renderBadgeWikiXml(badges), {
    profile: opts.profile,
    overwrite: true,
    format: 'xml',
  });
  if (!ok) return false;

  // In-cell image pass (best-effort). The overwrite above just wiped any prior images.
  const withArt = badges
    .map((b, i) => ({ index: i, rel: badgeImageRelPath(b) }))
    .filter((x) => x.rel);
  if (withArt.length === 0) return true;

  const anchors = imageCellAnchorIds(fetchDocxRawContent(docId, { profile: opts.profile }));
  for (const { index, rel } of withArt) {
    const anchor = anchors[index];
    if (!anchor) continue;
    const inserted = insertDocxImageBlock(docId, rel, { profile: opts.profile, width: BADGE_IMG_WIDTH });
    if (inserted) moveDocxBlocksAfter(docId, anchor, [inserted.blockId], { profile: opts.profile });
  }
  return true;
}
