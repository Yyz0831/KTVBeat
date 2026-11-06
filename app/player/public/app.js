import { AudioEngine, ROLES } from './audio-engine.js';
import { LyricsView } from './lyrics-view.js';

const engine = new AudioEngine();
const $ = (id) => document.getElementById(id);
let songs = [];
let selected = null;
let seeking = false;
let lastDetail = '';
let animation = 0;
const lyrics = new LyricsView({
  getPosition: () => seeking ? Number($('progress').value) : engine.position,
  seek: (position) => { seeking = false; if (engine.status === 'ready') engine.seek(position); },
});
const time = (seconds) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const fill = (input) => input.style.setProperty('--fill', `${Math.max(0, Math.min(100, Number(input.value) / Number(input.max) * 100))}%`);

function updateProgress() {
  const position = engine.position;
  if (!seeking) {
    $('progress').value = position;
    $('current-time').textContent = time(position);
    fill($('progress'));
  }
  $('progress').setAttribute('aria-valuetext', `${time(Number($('progress').value))}，共 ${time(engine.duration)}`);
  lyrics.update(seeking ? Number($('progress').value) : position);
}

function animate() {
  updateProgress();
  animation = engine.playing ? requestAnimationFrame(animate) : 0;
}

function render() {
  const ready = engine.status === 'ready';
  $('play').disabled = !ready;
  $('progress').disabled = !ready;
  $('progress').max = engine.duration || 1;
  $('total-time').textContent = time(engine.duration);
  $('song-duration-tag').textContent = time(engine.duration);
  $('play').setAttribute('aria-label', engine.playing ? '暂停' : engine.position >= engine.duration && ready ? '重新播放' : '播放');
  $('play-icon').setAttribute('href', engine.playing ? '#icon-pause' : '#icon-play');
  $('status-title').textContent = engine.status === 'loading' ? '准备音乐' : engine.status === 'error' ? '加载未完成' : engine.playing ? '正在播放' : ready && engine.position >= engine.duration ? '播放结束' : ready && engine.position > 0 ? '已暂停' : '准备就绪';
  const detail = engine.status === 'loading' ? engine.loadingLabel : engine.status === 'error' ? '请检查音频文件后重试' : engine.playing ? '伴奏 · 主唱 · 和声，同步进行' : '三轨共用一个播放进度';
  if (detail !== lastDetail) { $('status-detail').textContent = detail; lastDetail = detail; }
  $('error-panel').hidden = !engine.error;
  $('error-text').textContent = engine.error;
  for (const role of [...ROLES, 'master']) {
    const percentage = Math.round(engine.volumes[role] * 100);
    $(`volume-${role}`).value = percentage;
    $(`value-${role}`).replaceChildren(document.createTextNode(String(percentage)), Object.assign(document.createElement('span'), { textContent: '%' }));
    fill($(`volume-${role}`));
    $(`volume-${role}`).setAttribute('aria-valuetext', `${percentage}%${percentage === 0 ? '，静音' : ''}`);
    if (role !== 'master') {
      $(`state-${role}`).textContent = percentage === 0 ? '已静音' : '已开启';
      $(`volume-${role}`).closest('article').classList.toggle('is-muted', percentage === 0);
    }
  }
  updateProgress();
  if (engine.playing && !animation) animation = requestAnimationFrame(animate);
  if (!engine.playing && animation) { cancelAnimationFrame(animation); animation = 0; }
}

function selectSong(song) {
  selected = song;
  seeking = false;
  $('song-title').textContent = song.title;
  $('song-artist').textContent = song.artist;
  $('cover-title').textContent = song.title;
  $('cover').className = `cover ${song.color}`;
  document.title = `${song.title} · KTVBeat`;
  document.querySelectorAll('.song-option').forEach((button) => button.setAttribute('aria-current', String(button.dataset.song === song.id)));
  engine.load(song);
  lyrics.load(song);
}

function buildLibrary() {
  $('song-count').textContent=String(songs.length).padStart(2,'0');
  $('song-list').replaceChildren(...songs.map((song) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'song-option';
    button.dataset.song = song.id;
    button.setAttribute('aria-current',String(selected?.id===song.id));
    button.setAttribute('aria-label', `${song.title}，${song.artist}`);
    const cover = Object.assign(document.createElement('span'), { className: `mini-cover ${song.color}`, textContent: song.title === '1 AM' ? '1' : song.title[0] });
    cover.setAttribute('aria-hidden', 'true');
    const text = Object.assign(document.createElement('span'), { className: 'song-text' });
    text.append(Object.assign(document.createElement('strong'), { textContent: song.title }), Object.assign(document.createElement('small'), { textContent: song.artist }));
    button.append(cover, text, Object.assign(document.createElement('span'), { className: 'song-dot' }));
    button.addEventListener('click', () => { if (selected?.id !== song.id) selectSong(song); });
    return button;
  }));
}

engine.addEventListener('change', render);
$('play').addEventListener('click', () => engine.playing ? engine.pause() : engine.play());
$('progress').addEventListener('input', () => {
  seeking = true;
  $('current-time').textContent = time(Number($('progress').value));
  fill($('progress'));
  lyrics.update(Number($('progress').value), true);
});
$('progress').addEventListener('change', () => {
  const value = Number($('progress').value);
  // HTML ranges quantize to 10 ms, while FLAC durations end on sample frames.
  // Reaching the final slider step must reach the actual end of the song.
  const position = value >= engine.duration - .01 ? engine.duration : value;
  seeking = false;
  engine.seek(position);
});
$('progress').addEventListener('pointercancel', () => { seeking = false; updateProgress(); });
document.querySelectorAll('[data-volume]').forEach((input) => input.addEventListener('input', () => engine.setVolume(input.dataset.volume, Number(input.value) / 100)));
$('retry').addEventListener('click', () => selected ? engine.load(selected) : start());
document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat || /INPUT|BUTTON|A|TEXTAREA|SELECT/.test(event.target.tagName)) return;
  event.preventDefault();
  if (engine.status === 'ready') engine.playing ? engine.pause() : engine.play();
});
window.addEventListener('pagehide', () => { lyrics.dispose(); engine.dispose(); });

async function start() {
  try {
    const response = await fetch('/api/songs');
    if (!response.ok) throw new Error('无法读取歌曲列表');
    songs = await response.json();
    buildLibrary();
    if(songs.length && !selected) selectSong(songs[0]);
  } catch (error) {
    engine.status = 'error';
    engine.error = `连接失败：${error.message}。请确认播放器的启动终端仍然打开。`;
    render();
  }
}
start();

window.addEventListener("library-updated", async () => { try { const response=await fetch("/api/songs");if(!response.ok)return;songs=await response.json();buildLibrary();if(!selected && songs.length)selectSong(songs[0]); } catch {} });
