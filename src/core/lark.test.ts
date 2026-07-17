import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRateLimited, replyLinkageFromEvent } from './lark.js';

// Verbatim production envelope (2026-07-17): 白鱼 replied to 阿坚's post and @-mentioned the bot with
// "你怎么看这个发言". The bot answered about an unrelated self-intro because the code read `parent_id`
// — an OpenAPI field name that does not exist on this envelope — so the referent resolved to ''.
// The linkage is right there under `reply_to`/`root_id`. Pin the names: reading the API name here is
// silent (no throw, no log), and the only symptom is the bot confidently answering the wrong message.
const REPLY_ENVELOPE = {
  type: 'im.message.receive_v1',
  message_id: 'om_x100b6aaaeb6ae4a8ddb573cbc6ba672',
  chat_id: 'oc_476ce1581810c2b7eb6aa06bdffa4bb2',
  chat_type: 'group',
  message_type: 'text',
  sender_id: 'ou_f756e06593f8cc65582fe9058b2f732a',
  sender_type: 'user',
  root_id: 'om_x100b6aafcc9adcb8b0402abefb51c92',
  reply_to: 'om_x100b6aafcc9adcb8b0402abefb51c92',
  content: '@_user_1 @_user_2 你怎么看这个发言',
};

test('replyLinkageFromEvent: reads reply_to/root_id off the real envelope', () => {
  const { replyToId, rootId } = replyLinkageFromEvent(REPLY_ENVELOPE);
  assert.equal(replyToId, 'om_x100b6aafcc9adcb8b0402abefb51c92');
  assert.equal(rootId, 'om_x100b6aafcc9adcb8b0402abefb51c92');
});

test('replyLinkageFromEvent: this envelope shape has no parent_id — do not reintroduce it', () => {
  assert.ok(!('parent_id' in REPLY_ENVELOPE), 'event envelopes carry reply_to, never parent_id');
});

test('replyLinkageFromEvent: prefers the direct parent over the chain root', () => {
  const deep = { reply_to: 'om_direct_parent', root_id: 'om_chain_root' };
  assert.equal(replyLinkageFromEvent(deep).replyToId, 'om_direct_parent');
  assert.equal(replyLinkageFromEvent(deep).rootId, 'om_chain_root');
});

// Guards the field name on its own. The root_id fallback would otherwise mask a wrong name whenever
// reply_to === root_id (which is the common case, including the incident envelope above), so read
// reply_to with no root_id present: only the correct field name can resolve this one.
test('replyLinkageFromEvent: resolves from reply_to with no root_id to fall back on', () => {
  assert.equal(replyLinkageFromEvent({ reply_to: 'om_parent' }).replyToId, 'om_parent');
});

test('replyLinkageFromEvent: falls back to root_id, and is empty on an original post', () => {
  assert.equal(replyLinkageFromEvent({ root_id: 'om_root' }).replyToId, 'om_root');
  assert.deepEqual(replyLinkageFromEvent({ message_id: 'om_a' }), { replyToId: '', rootId: '' });
  assert.deepEqual(replyLinkageFromEvent({}), { replyToId: '', rootId: '' });
});

// The bet reply that failed in the field: the CLI could not parse Feishu's throttle page and
// surfaced the raw text (HTTP 429) in `raw`.
test('isRateLimited: detects the CLI non-JSON 429 crash text', () => {
  const res = { ok: false, raw: "SDK returned an invalid JSON response: failed to parse TAT response (HTTP 429): invalid character 'r' looking for beginning of value" };
  assert.equal(isRateLimited(res), true);
});

test('isRateLimited: detects the structured frequency-limit code', () => {
  assert.equal(isRateLimited({ ok: false, error: { code: 99991400, message: 'too many request' } }), true);
});

test('isRateLimited: detects rate-limit wording in the error message', () => {
  assert.equal(isRateLimited({ ok: false, error: { message: 'Rate limit exceeded' } }), true);
  assert.equal(isRateLimited({ ok: false, error: { message: 'Too Many Requests' } }), true);
});

test('isRateLimited: ignores successes and non-rate-limit failures', () => {
  assert.equal(isRateLimited({ ok: true, data: {} }), false);
  assert.equal(isRateLimited({ ok: false, error: { code: 232009, message: 'chat dissolved' } }), false);
  assert.equal(isRateLimited({ ok: false, raw: 'some unrelated parser error' }), false);
  assert.equal(isRateLimited(null), false);
  assert.equal(isRateLimited(undefined), false);
});
