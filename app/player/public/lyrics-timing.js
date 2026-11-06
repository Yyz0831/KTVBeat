// Pure time -> display functions. The caller supplies the shared audio position.
export function wordProgress(word, position) {
  return Math.max(0, Math.min(1, (position - word.start) / (word.end - word.start)));
}

export function timelineState(lines, position) {
  if (!lines.length) return { focus: -1, active: [], slots: [-1, -1], phase: 'empty' };
  const active = [];
  let latest = -1;
  for (let i = 0; i < lines.length; i++) {
    if (position >= lines[i].start) latest = i;
    if (position >= lines[i].start && position < lines[i].end) active.push(i);
  }
  const focus = active.length ? active.at(-1) : Math.min(latest + 1, lines.length - 1);
  const slots = [0, lines.length > 1 ? 1 : -1];
  for (let side = 0; side < 2; side++) {
    for (let i = side; i + 2 < lines.length; i += 2) {
      // Keep the previous occupant until both its end and the other slot's
      // next start. Calculated from time, not from a history of events.
      if (position >= Math.max(lines[i].end, lines[i + 1].start)) slots[side] = i + 2;
      else break;
    }
  }
  const phase = position < lines[0].start ? 'intro'
    : position >= lines.at(-1).end ? 'outro' : active.length ? 'singing' : 'gap';
  return { focus, active, slots, phase };
}

export function validateLyrics(data, song) {
  const fail = () => { throw new Error('歌词文件的文字或时间格式不正确'); };
  if (data?.version !== 1 || data.songId !== song.id || data.timeUnit !== 'seconds'
      || !Number.isFinite(data.duration) || Math.abs(data.duration - song.duration) > .1
      || !Array.isArray(data.lines) || !data.lines.length) fail();
  const ids = new Set();
  for (let i = 0; i < data.lines.length; i++) {
    const line = data.lines[i];
    if (typeof line.id !== 'string' || ids.has(line.id) || typeof line.text !== 'string' || !line.text.trim()
        || !['word', 'line'].includes(line.timing) || !Array.isArray(line.words)
        || !Number.isFinite(line.start) || !Number.isFinite(line.end)
        || line.start < 0 || line.end <= line.start || line.end > data.duration + .002) fail();
    ids.add(line.id);
    if (i && line.start < data.lines[i - 1].start) fail();
    if (i >= 2 && line.start < data.lines[i - 2].end) fail();
    if ((line.timing === 'word') !== Boolean(line.words.length)) fail();
    let previousEnd = line.start, previousOffset = 0;
    const chars = Array.from(line.text);
    for (const word of line.words) {
      if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end <= word.start
          || word.start < previousEnd - .002 || word.end > line.end + .002
          || !Number.isInteger(word.from) || !Number.isInteger(word.to)
          || word.from < previousOffset || word.to <= word.from || word.to > chars.length
          || chars.slice(word.from, word.to).join('') !== word.text) fail();
      previousEnd = word.end;
      previousOffset = word.to;
    }
  }
  return data;
}

export class LyricsLoader {
  constructor(fetcher = (...args) => fetch(...args)) { this.fetcher = fetcher; this.version = 0; }
  cancel() { this.version++; this.controller?.abort(); }
  async load(song) {
    this.cancel();
    const version = this.version;
    this.controller = new AbortController();
    try {
      if (!song.lyricsUrl) throw new Error('这首歌暂无歌词');
      const response = await this.fetcher(song.lyricsUrl, { signal: this.controller.signal });
      if (!response.ok) throw new Error(response.status === 404 ? '歌词文件不存在' : `无法读取歌词（${response.status}）`);
      const data = validateLyrics(await response.json(), song);
      return version === this.version ? data : null;
    } catch (error) {
      if (version !== this.version || error.name === 'AbortError') return null;
      throw error;
    }
  }
}
