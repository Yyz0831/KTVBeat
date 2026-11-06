import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { stat, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JobQueue } from '../jobs.mjs';
import { createServer } from '../server.mjs';
import { loadCatalog, roles } from '../catalog.mjs';

let server, base, jobData, catalog;
before(async () => {
  jobData=await mkdtemp(path.join(tmpdir(),'ktv-server-'));
  // Synthetic HTTP fixtures: no private audio, models or existing library required.
  for (const [order, [id, title]] of [['zhouxuan', '周旋'], ['zhongjianren', '中间人'], ['one-am', '1 AM']].entries()) {
    const folder=path.join(jobData, 'library', `${title}_测试歌手`);
    await mkdir(folder,{recursive:true});
    await writeFile(path.join(folder,'song.json'),JSON.stringify({id,title,artist:'测试歌手',order,duration:10,frames:441000}));
    await writeFile(path.join(folder,'lyrics.json'),JSON.stringify({songId:id,lines:[{id:'line-1',text:'测试',start:1,end:2}]}));
    // The HTTP server streams bytes; real decoding is validated separately.
    for(const role of roles)await writeFile(path.join(folder,`${role}.flac`),Buffer.from('fLaCsynthetic-header'));
  }
  catalog=loadCatalog(jobData);
  server = createServer({data:jobData,queue:new JobQueue({data:jobData})});
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await server.queue.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)); await rm(jobData,{recursive:true,force:true}); });

test('catalog exposes the committed library with stable song IDs and approved track URLs', async () => {
  const response = await fetch(`${base}/api/songs`);
  const songs = await response.json();
  assert.deepEqual(songs.map((song) => song.id), catalog.map((song) => song.id));
  assert.deepEqual(songs.slice(0, 3).map((song) => song.title), ['周旋', '中间人', '1 AM']);
  for (const song of songs) {
    assert.deepEqual(Object.keys(song.tracks), roles);
    assert.equal(song.files, undefined);
    assert.equal(song.lyricsFile, undefined);
    assert.equal(song.lyricsUrl, `/api/lyrics/${song.id}`);
    for (const role of roles) {
      const metadata = await fetch(`${base}${song.tracks[role]}`, { method: 'HEAD' });
      assert.equal(metadata.status, 200);
      assert.equal(metadata.headers.get('content-type'), 'audio/flac');
      const actual = await stat(catalog.find((item) => item.id === song.id).files[role]);
      assert.equal(Number(metadata.headers.get('content-length')), actual.size);
      assert.doesNotMatch(catalog.find((item) => item.id === song.id).files[role], /Padded|\+BV/);
    }
  }
});

test('audio bytes are the original FLAC, not a transcoded response', async () => {
  const response = await fetch(`${base}/audio/zhouxuan/instrumental`);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value.subarray(0, 4)), 'fLaC');
  await reader.cancel();
});

test('only listed assets and tracks are served; writes are rejected', async () => {
  for (const route of ['/audio/zhouxuan/other', '/audio/unknown/lead', '/api/lyrics/unknown', '/api/lyrics/%2e%2e%2fmanifest', '/catalog.mjs', '/package.json', '/%2e%2e/%2e%2e/.ssh/id_rsa', '/audio/zhouxuan/%2e%2e%2fserver.mjs']) {
    assert.equal((await fetch(`${base}${route}`)).status, 404, route);
  }
  assert.equal((await fetch(`${base}/api/songs`, { method: 'POST', headers: {Origin:base} })).status, 405);
  assert.equal((await fetch(`${base}/%ZZ`)).status, 400);
});

test('lyric API serves the committed JSON artifacts and supports HEAD', async () => {
  for (const song of catalog) {
    const response = await fetch(`${base}/api/lyrics/${song.id}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const lyrics = await response.json();
    assert.equal(lyrics.songId, song.id);
    assert.ok(lyrics.lines.length);
    assert.doesNotMatch(JSON.stringify(lyrics), /\/Users\//);
    const head = await fetch(`${base}/api/lyrics/${song.id}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
  assert.equal((await fetch(`${base}/api/lyrics/zhouxuan`, { method: 'POST', headers: {Origin:base} })).status, 405);
});

test('page has exactly one shared progress range and four volume ranges', async () => {
  const response = await fetch(base);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.equal((html.match(/id="progress"/g) || []).length, 1);
  assert.equal((html.match(/data-volume=/g) || []).length, 4);
  assert.match(html, /三轨共同播放进度/);
});
