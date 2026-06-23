import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_DIR } from './paths.js';

// Channel cursor persistence (avoids duplicate replies after a restart). Stored at .agent/state/<key>.json.
// The cursor key is a string carrying profile/identity/chatId provided by the caller; this module stays generic.

export interface Cursor {
  lastPosition: number | null;
  lastMessageId: string | null;
}

function stateFile(key: string): string {
  return path.join(RUNTIME_DIR, 'state', `${key}.json`);
}

export function loadCursor(key: string): Cursor {
  const f = stateFile(key);
  if (!fs.existsSync(f)) return { lastPosition: null, lastMessageId: null };
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return { lastPosition: null, lastMessageId: null };
  }
}

export function saveCursor(key: string, cursor: Cursor): void {
  const f = stateFile(key);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(cursor, null, 2), 'utf8');
}
