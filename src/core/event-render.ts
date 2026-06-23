import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';

// ── event image rendering ─────────────────────────────────────
// An event = a base image + some "text overlay blocks". Each block is positioned with percentages
// (relative to the base image's real pixel size): fill a background color + draw text inside that
// rectangle, auto-picking a font size that fits. The image ratio is fixed at 9:25, but this module
// makes no pixel assumption: it reads the base image's real width/height to convert percentages, so
// swapping the base image needs no coordinate changes.

/** A text overlay block. left/top/width/height are 0-100 percentages (relative to image w/h). */
export interface TextOverlay {
  /** percentage from the left edge */
  left: number;
  /** percentage from the top edge */
  top: number;
  /** width as a percentage of image width */
  width: number;
  /** height as a percentage of image height */
  height: number;
  /** the text to render; may contain placeholders like {{date}} {{pt}} {{level}} {{name}} */
  text: string;
  /** text color, default white */
  color?: string;
  /** rectangle background fill (CSS color, alpha ok e.g. rgba(0,0,0,.5)); omit = transparent */
  bgColor?: string;
  /** font family; defaults to an auto-picked CJK-capable font */
  fontFamily?: string;
  /** bold weight */
  bold?: boolean;
  /** horizontal alignment, default center */
  align?: 'left' | 'center' | 'right';
  /** vertical alignment, default middle */
  valign?: 'top' | 'middle' | 'bottom';
  /** max font size in px; defaults to the rectangle's inner height */
  maxFontPx?: number;
  /** inner padding as a percentage of the rectangle, default 6 */
  padding?: number;
}

export interface RenderEventOptions {
  /** base image path */
  baseImage: string;
  /** list of text overlay blocks */
  overlays: TextOverlay[];
  /** output PNG path (parent dir is created automatically) */
  outPath: string;
  /** placeholder values ({{key}} -> vars[key]) */
  vars?: Record<string, string | number>;
  /**
   * When set, scale the final image to this pixel height (keeping aspect ratio). Overlays are drawn at
   * the base image's full size first, so layout is preserved; this just resizes the result for sending.
   */
  outHeight?: number;
}

// best-effort: register a CJK-capable font; fall back to sans-serif (Latin/digits still render).
let _fontFamily = 'sans-serif';
let _fontReady = false;
function ensureFont(): string {
  if (_fontReady) return _fontFamily;
  _fontReady = true;
  const candidates = [
    '/System/Library/Fonts/PingFang.ttc', // macOS
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', // Linux (Noto)
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', // Linux (WenQuanYi)
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && GlobalFonts.registerFromPath(p, 'EventCJK')) {
        _fontFamily = 'EventCJK';
        break;
      }
    } catch {
      /* ignore unreadable font */
    }
  }
  return _fontFamily;
}

/** Replace {{key}} with vars[key]; unknown placeholders become '' (so no literal {{x}} is drawn). */
function applyVars(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => {
    const v = vars[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

/**
 * Render all text overlays onto the base image and write a PNG.
 * Returns the output path and the base image's real pixel dimensions.
 */
export async function renderEventImage(
  opts: RenderEventOptions
): Promise<{ outPath: string; width: number; height: number }> {
  const fallbackFamily = ensureFont();
  const img = await loadImage(opts.baseImage);
  const W = img.width;
  const H = img.height;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);

  for (const ov of opts.overlays) {
    const rect = {
      x: (W * ov.left) / 100,
      y: (H * ov.top) / 100,
      w: (W * ov.width) / 100,
      h: (H * ov.height) / 100,
    };
    // Fill the background first (even with no text it can be used as a solid color block).
    if (ov.bgColor) {
      ctx.fillStyle = ov.bgColor;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
    const text = applyVars(ov.text ?? '', opts.vars ?? {});
    if (!text) continue;

    const padPct = ov.padding ?? 6;
    const padX = (rect.w * padPct) / 100;
    const padY = (rect.h * padPct) / 100;
    const innerW = Math.max(1, rect.w - 2 * padX);
    const innerH = Math.max(1, rect.h - 2 * padY);
    const family = ov.fontFamily ?? fallbackFamily;
    const weight = ov.bold ? 'bold ' : '';
    const lines = text.split(/\r?\n/);
    const lineRatio = 1.25; // line height = fontSize * 1.25

    // Auto font size: search downward from the cap until the widest line fits the inner width and
    // the total block height fits the inner height.
    const maxF = Math.min(Math.floor(innerH), ov.maxFontPx ?? Math.floor(innerH), 1000);
    let fontSize = 8;
    for (let s = Math.max(8, maxF); s >= 8; s--) {
      ctx.font = `${weight}${s}px ${family}`;
      const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
      const totalH = s * lineRatio * lines.length;
      if (widest <= innerW && totalH <= innerH) {
        fontSize = s;
        break;
      }
      fontSize = 8; // if nothing fits, use the smallest size
    }

    ctx.font = `${weight}${fontSize}px ${family}`;
    ctx.fillStyle = ov.color ?? '#ffffff';
    ctx.textBaseline = 'top';
    const lineH = fontSize * lineRatio;
    const totalH = lineH * lines.length;
    const align = ov.align ?? 'center';
    const valign = ov.valign ?? 'middle';

    let startY = rect.y + padY;
    if (valign === 'middle') startY = rect.y + (rect.h - totalH) / 2;
    else if (valign === 'bottom') startY = rect.y + rect.h - padY - totalH;

    lines.forEach((line, i) => {
      const m = ctx.measureText(line);
      let x = rect.x + padX;
      if (align === 'center') x = rect.x + (rect.w - m.width) / 2;
      else if (align === 'right') x = rect.x + rect.w - padX - m.width;
      ctx.fillText(line, x, startY + i * lineH);
    });
  }

  // Optionally scale the rendered result to a fixed output height (keep aspect ratio). Overlays were
  // drawn at full size above, so they scale proportionally and the layout is preserved.
  let outCanvas = canvas;
  let outW = W;
  let outH = H;
  if (opts.outHeight && opts.outHeight > 0 && Math.round(opts.outHeight) !== H) {
    outH = Math.round(opts.outHeight);
    outW = Math.max(1, Math.round(W * (outH / H)));
    const scaled = createCanvas(outW, outH);
    const sctx = scaled.getContext('2d');
    sctx.drawImage(canvas, 0, 0, W, H, 0, 0, outW, outH);
    outCanvas = scaled;
  }

  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  fs.writeFileSync(opts.outPath, outCanvas.toBuffer('image/png'));
  return { outPath: opts.outPath, width: outW, height: outH };
}
