import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine, ROLES } from '../public/audio-engine.js';

class Context {
  currentTime = 0;
  state = 'suspended';
  destination = {};
  nodes = [];
  createGain() { return { connect() {}, gain: { value: 1, cancelAndHoldAtTime() {}, linearRampToValueAtTime(value) { this.value = value; } } }; }
  createBufferSource() {
    const node = { buffer: null, stopped: false, disconnected: false, connect() {}, disconnect() { this.disconnected = true; }, start(when, offset) { this.when = when; this.offset = offset; }, stop() { this.stopped = true; } };
    this.nodes.push(node);
    return node;
  }
  async decodeAudioData() { return { duration: 10, length: 480000 }; }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}
const song = (id) => ({ id, duration: 10, tracks: Object.fromEntries(ROLES.map((role) => [role, `${id}/${role}`])) });
const response = () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
const setup = (fetcher = async () => response()) => {
  const context = new Context();
  return { context, engine: new AudioEngine({ contextFactory: () => context, fetcher }) };
};
const tick = () => new Promise((done) => setImmediate(done));

test('pause, resume and seek preserve one common offset, including the muted lead', async () => {
  const { engine, context } = setup();
  await engine.load(song('first'));
  await engine.play();
  assert.equal(engine.sources.length, 3);
  assert.deepEqual(engine.sources.map((node) => [node.when, node.offset]), [[0.05, 0], [0.05, 0], [0.05, 0]]);
  assert.equal(engine.graph.tracks.lead.gain.value, 0);
  context.currentTime = 2.05;
  engine.pause();
  assert.ok(Math.abs(engine.position - 2) < 1e-9);
  assert.equal(engine.sources.length, 0);
  assert.ok(context.nodes.every((node) => node.stopped && node.disconnected && node.buffer === null));
  context.currentTime = 4;
  await engine.play();
  for (const node of engine.sources) assert.ok(Math.abs(node.offset - 2) < 1e-9);
  await engine.seek(7);
  assert.deepEqual(engine.sources.map((node) => [node.when, node.offset]), [[4.05, 7], [4.05, 7], [4.05, 7]]);
  engine.setVolume('lead', 0.6);
  assert.equal(engine.playing, true);
  assert.equal(engine.sources.length, 3);
  await engine.dispose();
});

test('pausing while browser audio activation is pending prevents delayed playback', async () => {
  const { engine, context } = setup();
  await engine.load(song('first'));
  let resume;
  context.resume = () => new Promise((done) => { resume = done; });
  const playing = engine.play();
  engine.pause();
  resume();
  await playing;
  assert.equal(engine.playing, false);
  assert.equal(engine.sources.length, 0);
  await engine.dispose();
});

test('rapid song changes serialize decoding and discard stale buffers', async () => {
  const requested = [];
  const { engine, context } = setup(async (url) => { requested.push(url); return response(); });
  let finishFirst;
  let activeDecodes = 0, maxDecodes = 0, calls = 0;
  context.decodeAudioData = async () => {
    activeDecodes++;
    maxDecodes = Math.max(maxDecodes, activeDecodes);
    if (++calls === 1) await new Promise((done) => { finishFirst = done; });
    activeDecodes--;
    return { duration: 10, length: 480000 };
  };
  const first = engine.load(song('first'));
  await tick();
  const second = engine.load(song('second'));
  const last = engine.load(song('last'));
  engine.setVolume('lead', 0.45);
  assert.deepEqual(requested, ['first/instrumental']);
  finishFirst();
  await Promise.all([first, second, last]);
  assert.deepEqual(requested, ['first/instrumental', 'last/instrumental', 'last/lead', 'last/backing']);
  assert.equal(maxDecodes, 1);
  assert.equal(engine.song.id, 'last');
  assert.equal(engine.status, 'ready');
  assert.equal(engine.volumes.lead, 0.45);
  assert.equal(Object.keys(engine.buffers).length, 3);
  await engine.dispose();
});

test('one missing track blocks all playback and a later retry can recover', async () => {
  let fail = true;
  const { engine } = setup(async (url) => url.endsWith('/lead') && fail ? { ok: false, status: 404 } : response());
  await engine.load(song('first'));
  assert.equal(engine.status, 'error');
  assert.match(engine.error, /主唱.*不存在/);
  assert.equal(engine.buffers, null);
  await engine.play();
  assert.equal(engine.sources.length, 0);
  fail = false;
  await engine.load(song('first'));
  assert.equal(engine.status, 'ready');
  await engine.dispose();
});

test('end and replay reset all three tracks; previous end events cannot stop a new song', async () => {
  const { engine } = setup();
  await engine.load(song('first'));
  await engine.play();
  const oldEnd = engine.sources[0].onended;
  oldEnd();
  assert.equal(engine.position, 10);
  assert.equal(engine.playing, false);
  await engine.play();
  assert.deepEqual(engine.sources.map((node) => node.offset), [0, 0, 0]);
  oldEnd();
  assert.equal(engine.playing, true);
  await engine.load(song('second'));
  assert.equal(engine.playing, false);
  assert.equal(engine.sources.length, 0);
  assert.equal(engine.offset, 0);
  await engine.dispose();
});
