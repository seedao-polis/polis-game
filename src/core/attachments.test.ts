import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFileTag,
  parseVideoTag,
  extractFileRef,
  extractVideoRef,
  attachmentMarker,
  isTextExtractable,
  extractText,
  renderMessageBody,
} from './attachments.js';

// ── tag parsing ───────────────────────────────────────────────────────────────
test('parseFileTag extracts key and name from a file tag', () => {
  const tag = parseFileTag('<file key="file_v3_0012p_abc" name="report (v2).html"/>');
  assert.deepEqual(tag, { key: 'file_v3_0012p_abc', name: 'report (v2).html' });
});

test('parseFileTag returns null for non-file content', () => {
  assert.equal(parseFileTag('just some text'), null);
  assert.equal(parseFileTag('[Image: img_v3_xyz]'), null);
});

test('parseVideoTag extracts key and name from a video tag', () => {
  const tag = parseVideoTag('<video key="file_v3_u1" name="clip.mp4" duration="58s" cover_image_key="img_v3_c1"/>');
  assert.deepEqual(tag, { key: 'file_v3_u1', name: 'clip.mp4' });
});

test('extractFileRef handles both the tag form and the raw event JSON form', () => {
  assert.deepEqual(
    extractFileRef('<file key="file_k1" name="a.md"/>'),
    { key: 'file_k1', name: 'a.md' }
  );
  assert.deepEqual(
    extractFileRef('{"file_key":"file_k2","file_name":"b.html"}'),
    { key: 'file_k2', name: 'b.html' }
  );
  assert.equal(extractFileRef('plain text'), null);
});

test('extractVideoRef handles the tag form and raw event JSON form', () => {
  assert.deepEqual(extractVideoRef('<video key="k" name="v.mp4"/>'), { key: 'k', name: 'v.mp4' });
  assert.deepEqual(extractVideoRef('{"file_key":"k2","file_name":"m.mov"}'), { key: 'k2', name: 'm.mov' });
});

test('attachmentMarker returns a compact label per attachment type', () => {
  assert.equal(attachmentMarker('file', '<file key="k" name="report.html"/>'), '[文件：report.html]');
  assert.equal(attachmentMarker('file', '{"file_key":"k","file_name":"n.pdf"}'), '[文件：n.pdf]');
  assert.equal(attachmentMarker('image', '[Image: img_v3_z]'), '[图片]');
  assert.equal(attachmentMarker('media', '<video key="k" name="v.mp4"/>'), '[视频：v.mp4]');
  assert.equal(attachmentMarker('text', 'hello'), '');
});

test('renderMessageBody inlines a text file from the raw event JSON content form', () => {
  const body = renderMessageBody(
    { msgType: 'file', content: '{"file_key":"fk","file_name":"brief.md"}', messageId: 'om_9' },
    { fetchFile: () => '/tmp/brief.md', readFile: () => 'raw markdown body' }
  );
  assert.match(body, /\[文件：brief\.md\]/);
  assert.match(body, /raw markdown body/);
});

// ── extension gating ────────────────────────────────────────────────────────────
test('isTextExtractable recognizes text formats and rejects binaries', () => {
  for (const n of ['a.html', 'a.HTM', 'notes.md', 'data.json', 'x.csv', 'log.txt']) {
    assert.equal(isTextExtractable(n), true, n);
  }
  for (const n of ['a.pdf', 'b.png', 'c.mp4', 'd.docx', 'noext']) {
    assert.equal(isTextExtractable(n), false, n);
  }
});

// ── html extraction ─────────────────────────────────────────────────────────────
test('extractText strips html tags, scripts, styles and decodes entities', () => {
  const html =
    '<html><head><style>.x{color:red}</style><script>alert(1)</script></head>' +
    '<body><h1>Title</h1><p>A &amp; B &lt;ok&gt;</p></body></html>';
  const out = extractText(html, 'doc.html', 2000);
  assert.match(out, /Title/);
  assert.match(out, /A & B <ok>/); // decoded &lt;ok&gt; is real content, not a tag
  assert.doesNotMatch(out, /alert/);
  assert.doesNotMatch(out, /color:red/);
  assert.doesNotMatch(out, /<h1>|<\/h1>|<body>|<p>/); // structural tags stripped
});

test('extractText passes plain-text formats through and truncates past the cap', () => {
  const long = 'x'.repeat(5000);
  const out = extractText(long, 'notes.md', 100);
  assert.ok(out.length < 200);
  assert.match(out, /已截断/);
});

// ── message rendering ────────────────────────────────────────────────────────────
test('renderMessageBody inlines a downloaded text file', () => {
  const body = renderMessageBody(
    { msgType: 'file', content: '<file key="file_k1" name="brief.md"/>', messageId: 'om_1' },
    {
      fetchFile: (mid, key, name) => {
        assert.equal(mid, 'om_1');
        assert.equal(key, 'file_k1');
        assert.equal(name, 'brief.md');
        return '/tmp/brief.md';
      },
      readFile: () => '# Heading\nsome content here',
    }
  );
  assert.match(body, /\[文件：brief\.md\]/);
  assert.match(body, /文件内容摘录/);
  assert.match(body, /some content here/);
});

test('renderMessageBody marks a binary file without downloading', () => {
  let fetched = false;
  const body = renderMessageBody(
    { msgType: 'file', content: '<file key="k" name="slides.pdf"/>', messageId: 'om_2' },
    { fetchFile: () => { fetched = true; return '/tmp/x'; } }
  );
  assert.equal(fetched, false);
  assert.match(body, /\[文件：slides\.pdf\]/);
  assert.match(body, /二进制/);
});

test('renderMessageBody reports a failed download for a text file', () => {
  const body = renderMessageBody(
    { msgType: 'file', content: '<file key="k" name="a.html"/>', messageId: 'om_3' },
    { fetchFile: () => null }
  );
  assert.match(body, /未能读取内容/);
});

test('renderMessageBody renders image and video markers', () => {
  assert.equal(renderMessageBody({ msgType: 'image', content: '[Image: img_v3_z]' }), '[图片]');
  assert.equal(
    renderMessageBody({ msgType: 'media', content: '<video key="k" name="v.mp4"/>' }),
    '[视频：v.mp4]'
  );
});

test('renderMessageBody returns empty for types it does not surface', () => {
  assert.equal(renderMessageBody({ msgType: 'text', content: 'hello' }), '');
  assert.equal(renderMessageBody({ msgType: 'system', content: 'x' }), '');
});
