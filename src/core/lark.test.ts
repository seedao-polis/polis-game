import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRateLimited } from './lark.js';

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
