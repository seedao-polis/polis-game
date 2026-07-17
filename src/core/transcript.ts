import { insertMessage, upsertChat, type MessageRow } from './store.js';
import { larkTimeToMs } from './lark.js';

// Persistence layer for incoming messages: every message is written to the embedded
// SQLite database for full-text search, gamification, and knowledge-base preprocessing.
// Collection is universal (precedes self-identification and trigger checks) so the
// full conversation context is preserved regardless of whether the agent replies.

/** Fields carried per message; snake_case matches the existing message schema. */
export interface TranscriptMessage {
  message_id: string;
  create_time: string;
  sender_open_id: string;
  sender_name: string;
  msg_type: string;
  text: string;
  mentions: string[];
  // Optional extended fields populated when the source provides them.
  sender_id_type?: string;
  sender_type?: string;
  sender_tenant_key?: string;
  thread_id?: string;
  /** Message this one replies to: `parent_id` on the OpenAPI shape, `reply_to` on the event envelope. */
  reply_to_id?: string;
  /** First message of the reply chain (`root_id` in both shapes). */
  root_id?: string;
  thread_message_position?: number;
  message_position?: number;
  updated?: boolean;
  deleted?: boolean;
  raw?: string;
}

/**
 * Persist a message to the database, deduplicating by message_id.
 * Returns true when the row was newly inserted, false when already present.
 */
export function append(chatId: string, msg: TranscriptMessage): boolean {
  if (!chatId || !msg.message_id) return false;
  const row: MessageRow = {
    messageId: msg.message_id,
    chatId,
    senderOpenId: msg.sender_open_id,
    senderIdType: msg.sender_id_type,
    senderType: msg.sender_type,
    senderTenantKey: msg.sender_tenant_key,
    senderName: msg.sender_name,
    msgType: msg.msg_type,
    text: msg.text,
    mentions: msg.mentions,
    threadId: msg.thread_id,
    replyToId: msg.reply_to_id,
    rootId: msg.root_id,
    threadMessagePosition: msg.thread_message_position,
    messagePosition: msg.message_position,
    createTime: larkTimeToMs(msg.create_time),
    updated: msg.updated,
    deleted: msg.deleted,
    raw: msg.raw,
  };
  return insertMessage(row);
}

// Re-export upsertChat so channel code can reach it through a single import.
export { upsertChat };
