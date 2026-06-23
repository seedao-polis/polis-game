import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preview, newCorrId } from './log.js';

test('preview collapses whitespace into single spaces', () => {
  assert.equal(preview('hello   world'), 'hello world');
  assert.equal(preview('line1\nline2\tline3'), 'line1 line2 line3');
  assert.equal(preview('  trimmed  '), 'trimmed');
});

test('preview elides the middle of long strings, keeping head and tail', () => {
  const long = 'abcdefghijklmnopqrstuvwxyz';
  // head=10, tail=10 by default → keep first 10 + … + last 10
  assert.equal(preview(long), 'abcdefghij…qrstuvwxyz');
});

test('preview honours custom head/tail and leaves short strings intact', () => {
  assert.equal(preview('abcdef', 2, 2), 'ab…ef');
  assert.equal(preview('abcd', 2, 2), 'abcd'); // length === head + tail → untouched
});

test('preview tolerates null and undefined input', () => {
  assert.equal(preview(undefined as unknown as string), '');
  assert.equal(preview(null as unknown as string), '');
});

test('newCorrId returns short, non-empty, unique-enough ids', () => {
  const a = newCorrId();
  const b = newCorrId();
  assert.match(a, /^[a-z0-9]+$/);
  assert.ok(a.length >= 4 && a.length <= 8, `unexpected length: ${a}`);
  assert.notEqual(a, b);
});
