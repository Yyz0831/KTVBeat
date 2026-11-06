export const ROLES = ['instrumental', 'lead', 'backing'];
export const LABELS = { instrumental: '伴奏', lead: '主唱', backing: '和声' };
export const DEFAULT_VOLUMES = { instrumental: 1, lead: 0, backing: 1, master: 0.5 };
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function createAudioGraph(context, volumes = DEFAULT_VOLUMES) {
  const headroom = context.createGain();
  headroom.gain.value = 0.7;
  const master = context.createGain();
  master.gain.value = volumes.master;
  headroom.connect(master);
  master.connect(context.destination);
  const tracks = Object.fromEntries(ROLES.map((role) => {
    const node = context.createGain();
    node.gain.value = volumes[role];
    node.connect(headroom);
    return [role, node];
  }));
  return { tracks, headroom, master };
}

export function scheduleTracks(context, buffers, graph, when, offset, onEnded = () => {}) {
  const nodes = [];
  try {
    for (const role of ROLES) {
      const node = context.createBufferSource();
      node.buffer = buffers[role];
      node.connect(graph.tracks[role]);
      node.onended = onEnded;
      nodes.push(node);
    }
    // The audio clock starts all three tracks at exactly the same scheduled time.
    for (const node of nodes) node.start(when, offset);
    return nodes;
  } catch (error) {
    for (const node of nodes) { try { node.stop(); } catch {} node.disconnect(); }
    throw error;
  }
}

export class AudioEngine extends EventTarget {
  constructor({ contextFactory, fetcher } = {}) {
    super();
    this.contextFactory = contextFactory || (() => new AudioContext({ latencyHint: 'interactive' }));
    this.fetcher = fetcher || globalThis.fetch.bind(globalThis);
    this.volumes = { ...DEFAULT_VOLUMES };
    this.context = null;
    this.graph = null;
    this.buffers = null;
    this.sources = [];
    this.song = null;
    this.status = 'idle';
    this.error = '';
    this.loadingLabel = '';
    this.playing = false;
    this.offset = 0;
    this.duration = 0;
    this.startedAt = 0;
    this.loadVersion = 0;
    this.transportVersion = 0;
    this.loadQueue = Promise.resolve();
    this.abortController = null;
  }

  emit() { this.dispatchEvent(new Event('change')); }

  ensureContext() {
    if (!this.context) {
      this.context = this.contextFactory();
      this.graph = createAudioGraph(this.context, this.volumes);
      this.context.addEventListener?.('statechange', () => {
        if (this.playing && this.context.state !== 'running') this.pause();
      });
    }
    return this.context;
  }

  get position() {
    const elapsed = this.playing ? Math.max(0, this.context.currentTime - this.startedAt) : 0;
    return clamp(this.offset + elapsed, 0, this.duration);
  }

  stopSources() {
    for (const source of this.sources) {
      source.onended = null;
      try { source.stop(); } catch {}
      source.disconnect();
      source.buffer = null;
    }
    this.sources = [];
  }

  async load(song) {
    const version = ++this.loadVersion;
    ++this.transportVersion;
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    this.stopSources();
    this.playing = false;
    this.buffers = null;
    this.song = song;
    this.offset = 0;
    this.duration = song.duration;
    this.status = 'loading';
    this.error = '';
    this.loadingLabel = '准备加载';
    this.emit();
    const current = () => version === this.loadVersion && !controller.signal.aborted;
    // decodeAudioData cannot be cancelled. Serialize loads so an obsolete decode
    // finishes and releases its buffers before the newest song begins decoding.
    const job = this.loadQueue.then(async () => {
      if (!current()) return;
      const buffers = {};
      let role = ROLES[0];
      try {
        const context = this.ensureContext();
        for (role of ROLES) {
          this.loadingLabel = `正在加载${LABELS[role]} · ${ROLES.indexOf(role) + 1}/3`;
          this.emit();
          const response = await this.fetcher(song.tracks[role], { signal: controller.signal });
          if (!response.ok) throw new Error(response.status === 404 ? '文件不存在或已移动' : `读取失败（${response.status}）`);
          const bytes = await response.arrayBuffer();
          if (!current()) return;
          buffers[role] = await context.decodeAudioData(bytes);
          if (!current()) return;
        }
        const lengths = ROLES.map((key) => buffers[key].length);
        if (Math.max(...lengths) - Math.min(...lengths) > 1) throw new Error('三轨长度不一致，无法同步播放');
        this.buffers = buffers;
        this.duration = Math.min(...ROLES.map((key) => buffers[key].duration));
        this.status = 'ready';
        this.loadingLabel = '';
        this.emit();
      } catch (error) {
        if (!current()) return;
        this.buffers = null;
        this.status = 'error';
        this.error = `${LABELS[role]}加载失败：${error.message || '浏览器无法解码该音频'}`;
        this.emit();
      }
    });
    this.loadQueue = job.catch(() => {});
    return job;
  }

  async play() {
    if (this.status !== 'ready' || this.playing) return;
    const version = ++this.transportVersion;
    try {
      await this.ensureContext().resume();
      if (version !== this.transportVersion || this.status !== 'ready') return;
      if (this.offset >= this.duration) this.offset = 0;
      this.startedAt = this.context.currentTime + 0.05;
      this.sources = scheduleTracks(this.context, this.buffers, this.graph, this.startedAt, this.offset, () => {
        if (version !== this.transportVersion || !this.playing) return;
        this.offset = this.duration;
        this.playing = false;
        this.stopSources();
        this.emit();
      });
      this.playing = true;
      this.error = '';
      this.emit();
    } catch (error) {
      if (version !== this.transportVersion) return;
      this.playing = false;
      this.error = `播放失败：${error.message}`;
      this.emit();
    }
  }

  pause() {
    ++this.transportVersion;
    this.offset = this.position;
    this.playing = false;
    this.stopSources();
    this.emit();
  }

  async seek(seconds) {
    if (this.status !== 'ready') return;
    const wasPlaying = this.playing;
    this.pause();
    this.offset = clamp(Number(seconds) || 0, 0, this.duration);
    this.emit();
    if (wasPlaying && this.offset < this.duration) await this.play();
  }

  setVolume(role, value) {
    if (!(role in this.volumes)) return;
    this.volumes[role] = clamp(Number(value) || 0, 0, 1);
    if (this.graph) {
      const param = role === 'master' ? this.graph.master.gain : this.graph.tracks[role].gain;
      const now = this.context.currentTime;
      param.cancelAndHoldAtTime(now);
      param.linearRampToValueAtTime(this.volumes[role], now + 0.02);
    }
    this.emit();
  }

  async dispose() {
    ++this.loadVersion;
    this.abortController?.abort();
    this.pause();
    this.buffers = null;
    this.status = 'idle';
    await this.context?.close();
  }
}
