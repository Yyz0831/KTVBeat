import { LyricsLoader, timelineState, wordProgress } from './lyrics-timing.js';

const $ = (id) => document.getElementById(id);
const modeKey = 'ktvbeat.lyrics-mode';
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export class LyricsView {
  constructor({ getPosition, seek }) {
    this.getPosition = getPosition;
    this.seek = seek;
    this.loader = new LyricsLoader();
    this.mode = 'scroll';
    try { if (localStorage.getItem(modeKey) === 'ktv') this.mode = 'ktv'; } catch { /* Private storage may be unavailable. */ }
    this.data = null;
    this.scrollRefs = [];
    this.slotRefs = [];
    this.manualUntil = 0;
    this.previousTime = null;
    this.focus = -1;
    this.slotIndices = [-1, -1];
    this.message = '';
    document.querySelectorAll('[data-lyrics-mode]').forEach((button) => button.addEventListener('click', () => this.setMode(button.dataset.lyricsMode)));
    $('lyrics-retry').addEventListener('click', () => this.song && this.load(this.song));
    $('lyrics-follow').addEventListener('click', () => this.follow());
    const scroll = $('lyrics-scroll');
    scroll.addEventListener('wheel', () => this.browse(), { passive: true });
    scroll.addEventListener('touchstart', () => this.browse(), { passive: true });
    scroll.addEventListener('pointerdown', (event) => { if (event.target === scroll) this.browse(); });
    scroll.addEventListener('keydown', (event) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) this.browse();
    });
    this.observer = new ResizeObserver(() => { this.fitSlots(); if (!this.manualUntil) this.center(false); });
    this.observer.observe($('lyrics-stage'));
    this.setMode(this.mode, false);
  }

  setMode(mode, persist = true) {
    this.mode = mode === 'ktv' ? 'ktv' : 'scroll';
    if (persist) try { localStorage.setItem(modeKey, this.mode); } catch { /* Nonessential preference. */ }
    document.querySelectorAll('[data-lyrics-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.lyricsMode === this.mode)));
    $('lyrics-scroll').hidden = this.mode !== 'scroll' || !this.data;
    $('lyrics-ktv').hidden = this.mode !== 'ktv' || !this.data;
    this.manualUntil = 0;
    clearTimeout(this.followTimer);
    $('lyrics-follow').hidden = true;
    this.update(this.getPosition(), true);
    this.fitSlots();
    this.center(false);
  }

  setMessage(text) {
    if (text !== this.message) { $('lyrics-status').textContent = text; this.message = text; }
  }

  async load(song) {
    this.song = song;
    this.data = null;
    this.scrollRefs = [];
    this.slotRefs = [];
    this.slotIndices = [-1, -1];
    this.focus = -1;
    this.previousTime = null;
    this.manualUntil = 0;
    clearTimeout(this.followTimer);
    $('lyrics-lines').replaceChildren();
    $('lyrics-top').replaceChildren();
    $('lyrics-bottom').replaceChildren();
    $('lyrics-scroll').hidden = true;
    $('lyrics-ktv').hidden = true;
    $('lyrics-follow').hidden = true;
    $('lyrics-empty').hidden = false;
    $('lyrics-empty-title').textContent = '正在加载歌词';
    $('lyrics-empty-detail').textContent = '准备好后，歌词会跟随音乐同步显示。';
    $('lyrics-retry').hidden = true;
    this.setMessage('准备歌词');
    try {
      const data = await this.loader.load(song);
      if (!data) return;
      this.data = data;
      this.scrollRefs = data.lines.map((line) => this.createLine(line, true));
      $('lyrics-lines').replaceChildren(...this.scrollRefs.map((ref) => ref.element));
      $('lyrics-empty').hidden = true;
      this.setMode(this.mode, false);
    } catch (error) {
      $('lyrics-empty-title').textContent = '歌词暂时无法显示';
      $('lyrics-empty-detail').textContent = `${error.message}。音频仍可正常播放。`;
      $('lyrics-retry').hidden = false;
      this.setMessage('歌词加载失败');
    }
  }

  createLine(line, interactive = false) {
    const element = document.createElement(interactive ? 'button' : 'div');
    element.className = 'lyric-line';
    element.dataset.lineId = line.id;
    element.setAttribute('aria-label', line.text);
    if (interactive) {
      element.type = 'button';
      element.title = '跳到这一句';
      element.addEventListener('click', () => { this.seek(line.start); this.follow(); });
    }
    const content = document.createElement('span');
    content.className = 'lyric-content';
    content.setAttribute('aria-hidden', 'true');
    const chars = Array.from(line.text), words = [];
    let cursor = 0;
    for (const word of line.words) {
      content.append(document.createTextNode(chars.slice(cursor, word.from).join('')));
      const span = document.createElement('span');
      span.className = 'lyric-word';
      span.textContent = word.text;
      content.append(span);
      words.push({ word, span, value: null });
      cursor = word.to;
    }
    content.append(document.createTextNode(chars.slice(cursor).join('')));
    element.append(content);
    if (line.timing === 'line') element.dataset.timing = 'line';
    return { element, content, line, words };
  }

  paint(ref, time, active, focused) {
    ref.element.classList.toggle('is-active', active);
    ref.element.classList.toggle('is-current', focused);
    ref.element.classList.toggle('is-complete', time >= ref.line.end);
    ref.element.setAttribute('aria-current', String(focused));
    for (const token of ref.words) {
      const value = (wordProgress(token.word, time) * 100).toFixed(2);
      if (token.value !== value) { token.span.style.setProperty('--sweep', `${value}%`); token.value = value; }
    }
  }

  update(time, force = false) {
    if (!this.data) return;
    const { lines } = this.data;
    const state = timelineState(lines, time);
    const jump = force || this.previousTime === null || time < this.previousTime || Math.abs(time - this.previousTime) > .5;
    const changed = state.focus !== this.focus;
    this.focus = state.focus;
    const active = new Set(state.active);
    if (this.mode === 'scroll') {
      this.scrollRefs.forEach((ref, i) => {
        const wasActive = this.previousTime >= ref.line.start && this.previousTime < ref.line.end;
        if (jump || changed || active.has(i) || wasActive) this.paint(ref, time, active.has(i), i === state.focus);
      });
      if ((changed || force) && !this.manualUntil) this.center(!jump);
    } else {
      state.slots.forEach((index, side) => {
        if (index !== this.slotIndices[side]) {
          this.slotIndices[side] = index;
          this.slotRefs[side] = index < 0 ? null : this.createLine(lines[index]);
          $(side ? 'lyrics-bottom' : 'lyrics-top').replaceChildren(...(this.slotRefs[side] ? [this.slotRefs[side].element] : []));
          this.fitSlots();
        }
        if (this.slotRefs[side]) this.paint(this.slotRefs[side], time, active.has(index), index === state.focus);
      });
    }
    const phase = { intro: '前奏 · 准备开唱', gap: '间奏 · 等待下一句', outro: time >= this.data.duration ? '播放结束' : '尾奏', singing: '跟随音乐，唱出这一句' }[state.phase];
    this.setMessage(lines[state.focus]?.timing === 'line' && state.phase === 'singing' ? '这一句使用逐句高亮' : phase);
    this.previousTime = time;
  }

  fitSlots() {
    if (this.mode !== 'ktv' || !this.data) return;
    for (const ref of this.slotRefs) {
      if (!ref) continue;
      ref.element.style.fontSize = '44px';
      const available = ref.element.clientWidth;
      const natural = ref.content.getBoundingClientRect().width;
      if (natural > available && available > 0) ref.element.style.fontSize = `${Math.floor(44 * available / natural * 100) / 100}px`;
    }
  }

  center(smooth = true) {
    if (this.mode !== 'scroll' || !this.data || this.focus < 0) return;
    const scroll = $('lyrics-scroll'), line = this.scrollRefs[this.focus]?.element;
    if (!line) return;
    const top = line.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - (scroll.clientHeight - line.offsetHeight) / 2;
    scroll.scrollTo({ top, behavior: smooth && !reducedMotion() ? 'smooth' : 'instant' });
  }

  browse() {
    if (!this.data || this.mode !== 'scroll') return;
    this.manualUntil = performance.now() + 5000;
    $('lyrics-follow').hidden = false;
    clearTimeout(this.followTimer);
    this.followTimer = setTimeout(() => this.follow(), 5000);
  }

  follow() {
    clearTimeout(this.followTimer);
    this.manualUntil = 0;
    $('lyrics-follow').hidden = true;
    this.update(this.getPosition(), true);
    this.center(true);
  }

  dispose() { this.loader.cancel(); clearTimeout(this.followTimer); this.observer.disconnect(); }
}
