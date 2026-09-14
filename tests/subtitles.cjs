const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const code = fs.readFileSync(path.join(__dirname, '../static/core/subtitles.js'), 'utf8');
  const { parseSubtitles, normalizeCues, cueAt } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const cues = parseSubtitles('1\n00:00:01,000 --> 00:00:03,000\nこんにちは\n\n2\n00:00:03,000 --> 00:00:06,000\n<b>次の声</b>');
  assert.equal(cues[1].text, '次の声');
  assert.equal(cueAt(cues, 2), 0); assert.equal(cueAt(cues, 3), 1); assert.equal(cueAt(cues, 6), -1);
  assert.equal(parseSubtitles('WEBVTT\n\n00:01.000 --> 00:02.000 align:start\nHello')[0].start, 1);
  assert.equal(normalizeCues([{ start: 0, end: 2, text: 'a' }, { start: 1, end: 3, text: 'a' }])[0].end, 3);
  assert.throws(() => normalizeCues([{ start: -1, end: 2, text: 'a' }]));
  assert.throws(() => parseSubtitles('not subtitles'));
  console.log('PASS: subtitle parsing, overlap normalization, validation and seek lookup');
})().catch(error => { console.error(error); process.exitCode = 1; });
