import { ROLES, createAudioGraph, scheduleTracks } from '/audio-engine.js';
const results = [];
const summary = document.getElementById('summary');
const output = document.getElementById('results');
function report(name, data) { results.push({ name, ...data }); output.textContent = JSON.stringify(results, null, 2); }
function assert(condition, message) { if (!condition) throw new Error(message); }

async function impulses(name, volumes, offset, expected) {
  const context = new OfflineAudioContext(2, 4800, 48000);
  const graph = createAudioGraph(context, volumes);
  const buffers = Object.fromEntries(ROLES.map((role) => {
    const buffer = context.createBuffer(2, 4800, 48000);
    buffer.getChannelData(0)[1500] = 1;
    buffer.getChannelData(1)[1500] = -0.5;
    return [role, buffer];
  }));
  scheduleTracks(context, buffers, graph, 0.01, offset);
  const audio = await context.startRendering();
  const index = 1500 + 480 - Math.round(offset * 48000);
  assert(Math.abs(audio.getChannelData(0)[index] - expected) < 1e-6, '左声道音量或时间不匹配');
  assert(Math.abs(audio.getChannelData(1)[index] + expected / 2) < 1e-6, '右声道音量或时间不匹配');
  for (let i = 0; i < audio.length; i++) if (i !== index) assert(Math.abs(audio.getChannelData(0)[i]) < 1e-7, '发现错位的轨道');
  report(name, { pass: true, impulseFrame: index, amplitude: audio.getChannelData(0)[index] });
}

async function checkSongs() {
  const songs = await (await fetch('/api/songs')).json();
  for (const song of songs) {
    const context = new OfflineAudioContext(2, 1, 48000);
    const tracks = [];
    for (const role of ROLES) {
      const response = await fetch(song.tracks[role]);
      assert(response.ok, `${song.title} ${role} 文件不存在`);
      tracks.push(await context.decodeAudioData(await response.arrayBuffer()));
    }
    assert(tracks.every((track) => track.length === tracks[0].length), '解码后三轨长度不一致');
    assert(tracks.every((track) => track.numberOfChannels === 2), '声道数量不一致');
    let worstBound = 0;
    for (let channel = 0; channel < 2; channel++) {
      const data = tracks.map((track) => track.getChannelData(channel));
      for (let i = 0; i < data[0].length; i++) worstBound = Math.max(worstBound, (Math.abs(data[0][i]) + Math.abs(data[1][i]) + Math.abs(data[2][i])) * 0.7);
    }
    assert(Number.isFinite(worstBound) && worstBound > 0 && worstBound < 1, '满音量混音可能削波或音频无效');
    report(`${song.title}：真实 FLAC 解码、长度、立体声、混音峰值`, { pass: true, frames: tracks[0].length, sampleRate: 48000, worstPeakBound: worstBound });
  }
}

try {
  await impulses('三轨共同起点与独立音量比例', { instrumental: .2, lead: .3, backing: .4, master: .5 }, 0, .315);
  await impulses('三轨共同跳转偏移', { instrumental: .2, lead: .3, backing: .4, master: .5 }, .02, .315);
  await impulses('主唱、和声静音', { instrumental: 1, lead: 0, backing: 0, master: 1 }, 0, .7);
  await impulses('伴奏、和声静音', { instrumental: 0, lead: 1, backing: 0, master: 1 }, 0, .7);
  await impulses('伴奏、主唱静音', { instrumental: 0, lead: 0, backing: 1, master: 1 }, 0, .7);
  await impulses('总音量为零时全部静音', { instrumental: 1, lead: 1, backing: 1, master: 0 }, 0, 0);
  await checkSongs();
  summary.textContent = `PASS · ${results.length} 项音频验证全部通过`;
  document.documentElement.dataset.result = 'pass';
} catch (error) {
  report('失败', { pass: false, error: error.stack });
  summary.textContent = `FAIL · ${error.message}`;
  document.documentElement.dataset.result = 'fail';
}
