import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readdir,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "../server.mjs";
import { JobQueue, config, atomic } from "../jobs.mjs";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let n = 0; n < 500; n++) {
    if (await fn()) return;
    await delay(10);
  }
  throw new Error("timeout");
}
function form(marker = "a") {
  const f = new FormData();
  f.append("audio", new Blob([marker]), "音频.mp3");
  f.append("lyrics", new Blob(["[00:00.0]歌词"]), "歌词.lyc");
  f.append("title", "测试");
  f.append("artist", "歌手");
  return f;
}
async function setup(t, options = {}) {
  const data = await mkdtemp(path.join(tmpdir(), "ktv-jobs-"));
  const q = new JobQueue({ data, ...options });
  const server = createServer({ data, queue: q });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await server.ready;
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await q.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(data, { recursive: true, force: true });
  });
  return {
    data,
    q,
    server,
    base,
    post: async (route, body) =>
      fetch(base + route, { method: "POST", headers: { Origin: base }, body }),
  };
}
test("writes require same origin; malformed and oversized streaming uploads leave no files", async (t) => {
  const { base, post, data } = await setup(t, {
    settings: { ...config, audioMaxBytes: 32, lyricsMaxBytes: 10 },
    runner: async () => {
      throw new Error("validation");
    },
  });
  assert.equal(
    (await fetch(base + "/api/jobs", { method: "POST", body: form() })).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/jobs", {
        method: "POST",
        headers: { Origin: "http://evil.test" },
        body: form(),
      })
    ).status,
    403,
  );
  let r = await post("/api/jobs", form("x".repeat(100)));
  assert.equal(r.status, 400);
  r = await post("/api/jobs", form());
  assert.equal(r.status, 400);
  assert.deepEqual(await readdir(path.join(data, "staging")), []);
  assert.equal((await (await fetch(base + "/api/jobs")).json()).length, 0);
});
test("disk shortage is actionable and rejects before consuming uploads", async (t) => {
  const { post } = await setup(t, {
    settings: { ...config, minFreeBytes: Number.MAX_SAFE_INTEGER },
  });
  const r = await post("/api/jobs", form());
  assert.equal(r.status, 507);
  assert.match((await r.json()).error, /磁盘/);
});
test("two jobs run serially, persist through refresh, deduplicate, fail/retry and commit atomically", async (t) => {
  let running = 0,
    max = 0,
    fail = true,
    visBefore = [];
  const { post, base, q, data } = await setup(t, {
    runner: async (job, stage) => {
      running++;
      max = Math.max(max, running);
      try {
        await delay(15);
        visBefore.push((await fetch(base + "/api/songs")).status);
        if (stage === "vocals" && fail) {
          fail = false;
          throw new Error("故障注入");
        }
        if (stage === "finalize") {
          const dest = path.join(q.dir(job.id), "result");
          await mkdir(dest);
          await atomic(path.join(dest, "song.json"), {
            id: job.id,
            title: job.title,
            artist: job.artist,
            frames: 44100,
            duration: 1,
            order: 1,
            sourceKey: job.sourceKey,
            fallbackCount: 0,
          });
        }
      } finally {
        running--;
      }
    },
  });
  const a = await (await post("/api/jobs", form("a"))).json();
  const b = await (await post("/api/jobs", form("b"))).json();
  assert.notEqual(a.jobId, b.jobId);
  const dup = await (await post("/api/jobs", form("a"))).json();
  assert.equal(dup.duplicate, true);
  assert.equal((await (await fetch(base + "/api/jobs")).json()).length, 2);
  await until(() => !q.active);
  assert.equal(max, 1);
  assert.equal(q.jobs.get(a.jobId).state, "failed");
  assert.equal(q.jobs.get(b.jobId).state, "completed");
  assert.equal((await (await fetch(base + "/api/songs")).json()).length, 1);
  assert.equal((await post(`/api/jobs/${a.jobId}/retry`)).status, 200);
  await until(() => !q.active);
  assert.equal(q.jobs.get(a.jobId).state, "completed");
  assert.deepEqual(await readdir(q.dir(a.jobId)), ["job.json"]);
  assert.equal((await (await fetch(base + "/api/songs")).json()).length, 2);
  const prior = await (await post("/api/jobs", form("a"))).json();
  assert.equal(prior.songId, a.jobId);
  await post(`/api/jobs/${a.jobId}/clear`);
  assert.equal((await (await fetch(base + "/api/songs")).json()).length, 2);
  assert.ok(visBefore.every((n) => n === 200));
});
test("cancel, clear, service interruption and explicit retry preserve queue semantics", async (t) => {
  let unblock = false;
  const { post, q, data } = await setup(t, {
    runner: async () => {
      while (!unblock && !q.active.stop) await delay(5);
    },
  });
  const a = await (await post("/api/jobs", form())).json();
  const b = await (await post("/api/jobs", form("b"))).json();
  await post(`/api/jobs/${b.jobId}/cancel`);
  assert.equal(q.jobs.get(b.jobId).state, "cancelled");
  await post(`/api/jobs/${a.jobId}/cancel`);
  assert.equal(q.jobs.get(a.jobId).state, "cancelled");
  await post(`/api/jobs/${a.jobId}/clear`);
  assert.equal(q.jobs.has(a.jobId), false);
  const job = q.jobs.get(b.jobId);
  job.state = "running";
  await q.save(job);
  q.closed = true;
  const restored = new JobQueue({
    data,
    runner: async () => {
      throw new Error("retry test");
    },
  });
  await restored.init();
  assert.equal(restored.jobs.get(b.jobId).state, "interrupted");
  assert.equal(restored.active, null);
  await restored.action(b.jobId, "retry");
  await until(() => !restored.active);
  assert.equal(restored.jobs.get(b.jobId).state, "failed");
  await restored.close();
});

test("occupied port never initializes or interrupts another instance queue", async (t) => {
  const first = await setup(t, {
    runner: async () => {
      throw new Error("unused");
    },
  });
  let initialized = false;
  const other = createServer({
    queue: {
      init() {
        initialized = true;
        return Promise.resolve();
      },
    },
  });
  const error = await new Promise((resolve) => {
    other.on("error", resolve);
    other.listen(first.server.address().port, "127.0.0.1");
  });
  assert.equal(error.code, "EADDRINUSE");
  assert.equal(initialized, false);
});

test("aborted multipart upload removes its partial staging files", async (t) => {
  const { base, data } = await setup(t);
  const { request } = await import("node:http");
  const req = request(base + "/api/jobs", {
    method: "POST",
    headers: {
      Origin: base,
      "Content-Type": "multipart/form-data; boundary=ktvtest",
    },
  });
  req.on("error", () => {});
  req.write(
    '--ktvtest\r\nContent-Disposition: form-data; name="audio"; filename="partial.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n',
  );
  req.write(Buffer.alloc(65536));
  await until(
    async () => (await readdir(path.join(data, "staging"))).length === 1,
  );
  req.destroy();
  await until(
    async () => (await readdir(path.join(data, "staging"))).length === 0,
  );
  assert.deepEqual(await readdir(path.join(data, "jobs")), []);
});

test("processing percentage uses real completed chunks, including carriage-return progress output", async () => {
  const { parseSeparationProgress } = await import("../jobs.mjs");
  assert.equal(parseSeparationProgress("Loading model..."), null);
  assert.equal(parseSeparationProgress(" 51%|█████"), null);
  assert.deepEqual(
    parseSeparationProgress(
      "\r 50%|█████ | 46/91 [00:03<00:04]\r 51%|█████ | 47/91 [00:04<00:04]",
    ),
    { kind: "chunks", completed: 47, total: 91, percent: 51 },
  );
  assert.equal(
    parseSeparationProgress("100%|████| 91/91 [00:00]")?.percent,
    100,
  );
  assert.equal(parseSeparationProgress("99%|████| 9/0 [00:00]"), null);
});
