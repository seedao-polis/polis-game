import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMeaninglessMessage,
  isFanoutFlood,
  newFanoutState,
} from './outbound-guard.js';

test('blocks bare test / placeholder content', () => {
  for (const t of ['测试', '測試', 'test', 'Test', 'TESTING', 'ping', '测试！', ' 测试 ', '测试。', '123', 'aaaa', '。。。', '', '   ']) {
    assert.equal(isMeaninglessMessage(t), true, `should block: ${JSON.stringify(t)}`);
  }
});

test('allows real messages', () => {
  for (const t of [
    '今晚 20:00【城邦游戏中！交流会 #1】开始，欢迎报名',
    '你好，欢迎加入数字城邦',
    '哈哈哈',
    '4034.4 现价顶在日高门口',
    '签到成功，LP +1',
  ]) {
    assert.equal(isMeaninglessMessage(t), false, `should allow: ${JSON.stringify(t)}`);
  }
});

test('blocks identical content fanned to many chats in the window', () => {
  const s = newFanoutState();
  const now = 1_000_000;
  const msg = '大家好，来看看这个活动';
  assert.equal(isFanoutFlood(s, msg, 'oc_1', now), false); // 1st chat
  assert.equal(isFanoutFlood(s, msg, 'oc_2', now + 1000), false); // 2nd
  assert.equal(isFanoutFlood(s, msg, 'oc_3', now + 2000), false); // 3rd
  assert.equal(isFanoutFlood(s, msg, 'oc_4', now + 3000), true); // 4th blocked
  assert.equal(isFanoutFlood(s, msg, 'oc_5', now + 4000), true); // 5th blocked
});

test('re-sending to the same chat is not fan-out', () => {
  const s = newFanoutState();
  const now = 1_000_000;
  const msg = '重要通知';
  assert.equal(isFanoutFlood(s, msg, 'oc_1', now), false);
  assert.equal(isFanoutFlood(s, msg, 'oc_1', now + 1000), false);
  assert.equal(isFanoutFlood(s, msg, 'oc_1', now + 2000), false);
});

test('window resets after it elapses', () => {
  const s = newFanoutState();
  const now = 1_000_000;
  const msg = '同一句话';
  isFanoutFlood(s, msg, 'oc_1', now);
  isFanoutFlood(s, msg, 'oc_2', now + 1000);
  isFanoutFlood(s, msg, 'oc_3', now + 2000);
  // Beyond the 120s window the counter starts fresh, so a new chat is allowed.
  assert.equal(isFanoutFlood(s, msg, 'oc_4', now + 200_000), false);
});
