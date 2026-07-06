import fs from 'node:fs';
import path from 'node:path';

// ── Message attachment rendering for the conversation context ──────────────
// lark-cli's message list renders non-text messages into compact tags in the content field:
//   file  → <file key="file_v3_..." name="report.html"/>
//   image → [Image: img_v3_...]
//   media → <video key="file_v3_..." name="clip.mp4" duration="58s" cover_image_key="img_..."/>
//   post  → already flattened to readable text
// The conversation-context builder used to surface ONLY text messages, so a shared document was
// invisible to the model — it never knew a file had been sent and would hallucinate it as an
// un-openable link. This module makes attachments visible and, for text-extractable files, inlines a
// bounded excerpt of the actual content so the model can read the material the member sent.

/** Extensions we treat as plain-text-extractable (inline a content excerpt). */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.html', '.htm', '.json', '.csv', '.tsv', '.log', '.xml', '.yaml', '.yml',
]);

/** Default cap on inlined characters per file. */
const DEFAULT_MAX_INLINE_CHARS = 2000;

/** Default cap on bytes read from any attachment (bounds memory for a large file). */
const DEFAULT_MAX_READ_BYTES = 512 * 1024;

export interface AttachmentMessage {
  /** The rendered content field from lark-cli (a tag for non-text messages). */
  content: string;
  /** Feishu msg_type (text / file / image / media / post / ...). */
  msgType: string;
  /** Message id (needed to download the resource). */
  messageId?: string;
}

export interface RenderOptions {
  /**
   * Download a message's file resource to a local path (absolute), or null on failure. Injected so the
   * pure rendering/extraction logic stays testable without spawning the lark-cli subprocess.
   */
  fetchFile?: (messageId: string, fileKey: string, fileName: string) => string | null;
  /** Read a downloaded file's text. Defaults to a bounded fs reader; injectable for tests. */
  readFile?: (localPath: string) => string;
  /** Cap on inlined characters per file (default {@link DEFAULT_MAX_INLINE_CHARS}). */
  maxInlineChars?: number;
}

/** Parse a `<file key="..." name="..."/>` tag into its key and name; null when not a file tag. */
export function parseFileTag(content: string): { key: string; name: string } | null {
  if (!content.startsWith('<file')) return null;
  const key = content.match(/key="([^"]+)"/)?.[1];
  if (!key) return null;
  const name = content.match(/name="([^"]*)"/)?.[1] ?? '';
  return { key, name };
}

/** Parse a `<video key="..." name="..."/>` tag into its key and name; null when not a video tag. */
export function parseVideoTag(content: string): { key: string; name: string } | null {
  if (!content.startsWith('<video')) return null;
  const key = content.match(/key="([^"]+)"/)?.[1];
  if (!key) return null;
  const name = content.match(/name="([^"]*)"/)?.[1] ?? '';
  return { key, name };
}

/**
 * Resolve a file reference from a message content field, robust to both representations we see:
 *   - the polling / message-list form   `<file key="..." name="..."/>`
 *   - the raw event form                `{"file_key":"...","file_name":"..."}`
 * Returns null when neither form yields a file key.
 */
export function extractFileRef(content: string): { key: string; name: string } | null {
  const tag = parseFileTag(content);
  if (tag) return tag;
  try {
    const o = JSON.parse(content) as { file_key?: unknown; file_name?: unknown };
    if (o && typeof o.file_key === 'string' && o.file_key) {
      return { key: o.file_key, name: typeof o.file_name === 'string' ? o.file_name : '' };
    }
  } catch { /* not JSON */ }
  return null;
}

/** Resolve a video reference, robust to the `<video .../>` tag and the raw `{"file_key":...}` event form. */
export function extractVideoRef(content: string): { key: string; name: string } | null {
  const tag = parseVideoTag(content);
  if (tag) return tag;
  try {
    const o = JSON.parse(content) as { file_key?: unknown; file_name?: unknown };
    if (o && typeof o.file_key === 'string' && o.file_key) {
      return { key: o.file_key, name: typeof o.file_name === 'string' ? o.file_name : '' };
    }
  } catch { /* not JSON */ }
  return null;
}

/**
 * A compact one-line marker for an attachment message, for the transcript/context (no download):
 *   file → "[文件：name]"   image → "[图片]"   media → "[视频：name]"
 * Returns '' for text and types we do not surface.
 */
export function attachmentMarker(msgType: string, content: string): string {
  if (msgType === 'file') {
    const ref = extractFileRef(content);
    return ref?.name ? `[文件：${ref.name}]` : '[文件]';
  }
  if (msgType === 'image') return '[图片]';
  if (msgType === 'media') {
    const ref = extractVideoRef(content);
    return ref?.name ? `[视频：${ref.name}]` : '[视频]';
  }
  return '';
}

/** True when a filename's extension is one we inline as plain text. */
export function isTextExtractable(name: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
};

/**
 * Extract readable text from a raw file body and cap it to `maxChars`. For HTML/HTM the script/style
 * blocks and tags are stripped and a handful of entities decoded; all other text formats are passed
 * through as-is. Whitespace is collapsed. A truncation marker is appended when the body was cut.
 */
export function extractText(raw: string, name: string, maxChars: number): string {
  const ext = path.extname(name).toLowerCase();
  let text = raw;
  if (ext === '.html' || ext === '.htm') {
    text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ');
    for (const [ent, ch] of Object.entries(HTML_ENTITIES)) text = text.split(ent).join(ch);
    text = text.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  }
  text = text.replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*\n\s*/g, '\n\n').replace(/[ \t]*\n[ \t]*/g, '\n').trim();
  if (text.length > maxChars) return text.slice(0, maxChars).trimEnd() + '…（内容过长，已截断）';
  return text;
}

/** Default bounded file reader: reads at most {@link DEFAULT_MAX_READ_BYTES} bytes as UTF-8. */
function defaultReadFile(p: string): string {
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(DEFAULT_MAX_READ_BYTES);
    const n = fs.readSync(fd, buf, 0, DEFAULT_MAX_READ_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Render the body text of a non-text message for the conversation context. Returns:
 *   file (text)   → "[文件：name]\n「文件内容摘录」\n<excerpt>"   (download + inline succeeded)
 *   file (binary) → "[文件：name]（二进制文件，未展开内容）"
 *   file (failed) → "[文件：name]（未能读取内容）"
 *   image         → "[图片]"
 *   media/video   → "[视频：name]"
 * and '' for message types that should not appear in the context (caller filters empties). Text and
 * post messages are handled by the caller and are NOT rendered here (returns '' for them).
 */
export function renderMessageBody(msg: AttachmentMessage, opts: RenderOptions = {}): string {
  const maxChars = opts.maxInlineChars ?? DEFAULT_MAX_INLINE_CHARS;
  const read = opts.readFile ?? defaultReadFile;

  if (msg.msgType === 'file') {
    const ref = extractFileRef(msg.content);
    if (!ref) return '';
    const label = ref.name ? `[文件：${ref.name}]` : '[文件]';
    if (!isTextExtractable(ref.name)) return `${label}（二进制文件，未展开内容）`;
    if (!opts.fetchFile || !msg.messageId) return `${label}（未能读取内容）`;
    const local = opts.fetchFile(msg.messageId, ref.key, ref.name);
    if (!local) return `${label}（未能读取内容）`;
    try {
      const excerpt = extractText(read(local), ref.name, maxChars);
      if (!excerpt) return `${label}（内容为空）`;
      return `${label}\n「文件内容摘录」\n${excerpt}`;
    } catch {
      return `${label}（未能读取内容）`;
    }
  }

  if (msg.msgType === 'image') {
    return '[图片]';
  }

  if (msg.msgType === 'media') {
    const ref = extractVideoRef(msg.content);
    return ref?.name ? `[视频：${ref.name}]` : '[视频]';
  }

  return '';
}
