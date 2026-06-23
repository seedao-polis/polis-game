// ── Memory access policy filter ──────────────────────────────────────────────
// Enforces namespace-based isolation and visibility gates in code — the LLM never
// decides which memories a caller is allowed to read. Two layers of enforcement:
//
//   1. Namespace whitelist: only namespaces that logically belong to the caller
//      (global, group:{caller_chat}, user:{caller_open_id}, group_user:{chat}:{open_id})
//      are ever handed to the SQL query. Other users' namespaces are not returned.
//      Personal memories (user:{open_id}) are always included regardless of chat tier;
//      confidentiality is enforced via the tier prompt policy, not by namespace gating.
//
//   2. Visibility gate: after namespace filtering, 'admin_only' rows are removed
//      unless ctx.isAdmin is true; 'private' rows are only kept when the namespace
//      encodes the caller's own open_id (which the whitelist already guarantees).
//
// Sensitivity is advisory only (affects log redaction) and does not gate LLM access.

import type { MemoryItem, MemoryVisibility } from './store/memory.js';

export interface PolicyContext {
  /** chat_id of the group in which the current conversation is taking place. */
  chatId: string;
  /** open_id of the user whose request triggered the memory lookup. */
  userOpenId: string;
  /**
   * When true, admin_only memories are surfaced to this caller.
   * Defaults to false — existing callers that do not set this flag are unaffected.
   */
  isAdmin?: boolean;
}

/**
 * Compute the set of namespace strings the caller is permitted to read.
 * This list is used both to restrict the SQL query and as the authoritative
 * reference in filterByPolicy. It never includes other users' namespaces.
 *
 * Personal memories (user:{openId}) are always included for every chat tier so that
 * the caller's cross-context history is available. Confidentiality between tiers is
 * expressed solely through the tier prompt policy injected into the system prompt.
 */
export function allowedNamespaces(ctx: PolicyContext): string[] {
  return [
    'global',
    `group:${ctx.chatId}`,
    `user:${ctx.userOpenId}`,
    `group_user:${ctx.chatId}:${ctx.userOpenId}`,
  ];
}

/**
 * Remove rows the caller is not permitted to read, given a pre-fetched item list.
 * Callers must have already restricted the SQL query to allowedNamespaces(ctx).
 * This function is a second defensive pass that enforces the visibility gate and
 * confirms every namespace is on the whitelist.
 */
export function filterByPolicy(items: MemoryItem[], ctx: PolicyContext): MemoryItem[] {
  const allowed = new Set(allowedNamespaces(ctx));
  const adminGranted = ctx.isAdmin === true;

  return items.filter((m) => {
    // Namespace gate: reject anything not in the whitelist (defence-in-depth check).
    if (!allowed.has(m.namespace)) return false;

    // admin_only rows are only surfaced when the caller holds the admin flag.
    if (m.visibility === 'admin_only') return adminGranted;

    // private rows are only visible to the owner. The namespace whitelist already
    // guarantees this (only user:{caller} and group_user:{chat}:{caller} are included),
    // so any 'private' row that survived namespace filtering belongs to the caller.
    if (m.visibility === 'private') {
      return (
        m.namespace === `user:${ctx.userOpenId}` ||
        m.namespace === `group_user:${ctx.chatId}:${ctx.userOpenId}`
      );
    }

    return true;
  });
}

/**
 * Determine the namespace and visibility for writing a memory entry on behalf of a caller.
 *
 * Personal memories always go into the caller's user: namespace and are marked private
 * so they are available across all chat contexts. The write destination is independent
 * of the chat tier — tier-based confidentiality is handled exclusively by the prompt policy.
 */
export function resolveWriteScope(
  _chatId: string,
  userOpenId: string,
): { namespace: string; visibility: MemoryVisibility } {
  return {
    namespace: `user:${userOpenId}`,
    visibility: 'private',
  };
}
