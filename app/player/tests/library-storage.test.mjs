import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { songDirectoryName, commitLibrarySong } from "../library-storage.mjs";
import { loadCatalog, publicCatalog } from "../catalog.mjs";
import { JobQueue, atomic } from "../jobs.mjs";

test("song folders preserve artist spaces, separate multiple artists and stay safe for filesystem paths", () => {
  assert.equal(
    songDirectoryName({ title: "周旋", artist: "王以太,艾热 AIR" }),
    "周旋_王以太_艾热 AIR",
  );
  assert.equal(
    songDirectoryName({ title: "中间人", artist: "Ice Paper" }),
    "中间人_Ice Paper",
  );
  assert.equal(
    songDirectoryName({ title: "1 AM", artist: "THOME" }),
    "1 AM_THOME",
  );
  assert.equal(
    songDirectoryName({ title: "合唱", artist: "甲，乙 / 丙、丁 & 戊_己" }),
    "合唱_甲_乙_丙_丁_戊_己",
  );
  const bad = songDirectoryName({
    title: "../../坏\\名字\0",
    artist: "../作者",
  });
  assert.equal(path.basename(bad), bad);
  assert.ok(!bad.startsWith("."));
  assert.doesNotMatch(bad, /[\\/\0]/);
  assert.ok(
    Buffer.byteLength(
      songDirectoryName({ title: "歌".repeat(200), artist: "人".repeat(200) }),
    ) <= 240,
  );
});

test("same title and artists get distinct folders while catalog URLs retain stable IDs", async (t) => {
  const data = await mkdtemp(path.join(tmpdir(), "ktv-folders-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const library = path.join(data, "library");
  for (const [id, marker] of [
    ["first-id", "first bytes"],
    ["second-id", "second bytes"],
  ]) {
    const source = path.join(data, id);
    await mkdir(source);
    const song = {
      id,
      title: "合唱",
      artist: "甲,乙",
      order: id === "first-id" ? 0 : 1,
    };
    await atomic(path.join(source, "song.json"), song);
    await writeFile(path.join(source, "lead.flac"), marker);
    await commitLibrarySong(source, library, song);
  }
  assert.deepEqual(
    (await readdir(library)).sort(),
    ["合唱_甲_乙", "合唱_甲_乙 (2)"].sort(),
  );
  const songs = loadCatalog(data);
  assert.deepEqual(
    songs.map((s) => s.id),
    ["first-id", "second-id"],
  );
  assert.equal(await readFile(songs[0].files.lead, "utf8"), "first bytes");
  assert.equal(await readFile(songs[1].files.lead, "utf8"), "second bytes");
  assert.equal(publicCatalog(data)[0].tracks.lead, "/audio/first-id/lead");
  assert.equal(publicCatalog(data)[1].lyricsUrl, "/api/lyrics/second-id");
});

test("restart recognizes a committed named folder by metadata ID and only cleans its completed task", async (t) => {
  const data = await mkdtemp(path.join(tmpdir(), "ktv-recover-folder-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const id = "committed-id",
    job = path.join(data, "jobs", id),
    result = path.join(job, "result");
  await mkdir(result, { recursive: true });
  const song = { id, title: "已入库", artist: "甲/乙", order: 0 };
  await atomic(path.join(result, "song.json"), song);
  await writeFile(path.join(result, "lead.flac"), "keep");
  await atomic(path.join(job, "job.json"), {
    id,
    state: "running",
    stage: "finalize",
    createdAt: new Date().toISOString(),
  });
  await writeFile(path.join(job, "source.audio"), "temporary");
  await commitLibrarySong(result, path.join(data, "library"), song);
  const queue = await new JobQueue({
    data,
    runner: () => {
      throw new Error("must not rerun models");
    },
  }).init();
  t.after(() => queue.close());
  assert.equal(queue.jobs.get(id).state, "completed");
  assert.equal(queue.active, null);
  assert.deepEqual(await readdir(job), ["job.json"]);
  assert.equal(await readFile(loadCatalog(data)[0].files.lead, "utf8"), "keep");
});
