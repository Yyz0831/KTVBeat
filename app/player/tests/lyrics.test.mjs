import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { catalog } from '../catalog.mjs';
import { LyricsLoader, timelineState, validateLyrics, wordProgress } from '../public/lyrics-timing.js';

const line = (id, start, end) => ({ id, start, end, text: '唱', timing: 'word', engine: 'sofa', words: [{ text: '唱', from: 0, to: 1, start, end }] });
const lines = [line('1', 1, 3), line('2', 2, 5), line('3', 6, 8), line('4', 7, 9)];
const song = (id) => ({ id, duration: 10, lyricsUrl: `/api/lyrics/${id}` });
const data = (id) => ({ version: 1, songId: id, timeUnit: 'seconds', duration: 10, lines });

test('continuous word sweep freezes at supplied position and clamps before/after the word', () => {
  const word = { start: 2, end: 4 };
  assert.deepEqual([0, 2, 2.5, 3, 4, 10].map((t) => wordProgress(word, t)), [0, 0, .25, .5, 1, 1]);
});

test('KTV slots alternate only when their occupant has ended, retaining real overlaps', () => {
  assert.deepEqual(timelineState(lines, 0), { focus: 0, active: [], slots: [0, 1], phase: 'intro' });
  assert.deepEqual(timelineState(lines, 2.5), { focus: 1, active: [0, 1], slots: [0, 1], phase: 'singing' });
  assert.deepEqual(timelineState(lines, 3).slots, [2, 1]);
  assert.deepEqual(timelineState(lines, 5.5), { focus: 2, active: [], slots: [2, 1], phase: 'gap' });
  assert.deepEqual(timelineState(lines, 6).slots, [2, 3]);
  assert.deepEqual(timelineState(lines, 9), { focus: 3, active: [], slots: [2, 3], phase: 'outro' });
  // Random-access and replay do not need previous rendering events.
  assert.deepEqual([8, 1.5, 6.5, 0, 3.5].map((t) => timelineState(lines, t).slots),
    [[2, 3], [0, 1], [2, 3], [0, 1], [2, 1]]);
  assert.deepEqual(timelineState([lines[0]], 0).slots, [0, -1]);
});

test('rejects malformed timing, wrong songs, duplicate IDs and slot conflicts', () => {
  assert.equal(validateLyrics(data('a'), song('a')).lines.length, 4);
  const corruptions = [
    (d) => d.songId = 'b', (d) => d.duration = 100,
    (d) => d.lines[0].words[0].end = NaN,
    (d) => d.lines[1].id = '1', (d) => d.lines[0].words[0].to = 2,
    (d) => d.lines[2].start = 2.5, (d) => d.lines[1].start = .5,
    (d) => d.lines[0].words = [], (d) => d.lines[0].words[0].end = 1,
  ];
  for (const corrupt of corruptions) {
    const d = structuredClone(data('a')); corrupt(d);
    assert.throws(() => validateLyrics(d, song('a')));
  }
});

test('quick song changes ignore late success and errors, even if fetch ignores abort', async () => {
  const pending = [];
  const loader = new LyricsLoader((url, options) => new Promise((resolve, reject) => pending.push({ resolve, reject, options })));
  const first = loader.load(song('first'));
  const second = loader.load(song('second'));
  assert.equal(pending[0].options.signal.aborted, true);
  pending[1].resolve({ ok: true, json: async () => data('second') });
  assert.equal((await second).songId, 'second');
  pending[0].resolve({ ok: true, json: async () => data('first') });
  assert.equal(await first, null);
  const third = loader.load(song('third'));
  loader.cancel();
  pending[2].reject(new Error('late error'));
  assert.equal(await third, null);
});

test('lyric errors are actionable and a later retry recovers', async () => {
  let failure = true;
  const loader = new LyricsLoader(async () => failure ? { ok: false, status: 404 } : { ok: true, json: async () => data('a') });
  await assert.rejects(loader.load(song('a')), /歌词文件不存在/);
  failure = false;
  assert.equal((await loader.load(song('a'))).songId, 'a');
});

const referenceSongs = catalog.filter((item) => ['zhouxuan', 'zhongjianren', 'one-am'].includes(item.id));
test('the three imported reference artifacts have complete display text, valid times and deterministic KTV slots', { skip: referenceSongs.length === 0 ? 'Optional local reference songs are not included in the repository' : false }, async () => {
  for (const song of referenceSongs) {
    const data = validateLyrics(JSON.parse(await readFile(song.lyricsFile, 'utf8')), song);
    const report = JSON.parse(await readFile(song.lyricsFile.replace('lyrics.json', 'processing.json'), 'utf8')).validation;
    assert.equal(data.lines.length, report.lines);
    assert.deepEqual(report.remaining_conflicts, []);
    for (const [index, line] of data.lines.entries()) {
      if (line.timing === 'word') {
        const normalize = (s) => s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
        assert.equal(normalize(line.words.map((w) => w.text).join('')), normalize(line.text));
        if (/[a-z]/i.test(line.text)) assert.equal(line.engine, 'tifa');
      } else assert.ok(report.fallback_ids.includes(line.id));
      for (const t of [line.start, (line.start + line.end) / 2, line.end - .000001]) {
        const state = timelineState(data.lines, t);
        assert.ok(state.active.includes(index));
        assert.equal(state.slots[index % 2], index, `${song.id} ${line.id} at ${t}`);
      }
    }
  }
});
