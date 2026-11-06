import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  rm,
  stat,
  statfs,
  open,
} from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { spawn, execFileSync } from "node:child_process";
import Busboy from "busboy";
import { APP, DATA, loadCatalog } from "./catalog.mjs";
import { commitLibrarySong } from "./library-storage.mjs";
export const config = JSON.parse(
  await readFile(path.join(APP, "config.json"), "utf8"),
);
const stages = ["prepare", "instrumental", "vocals", "lyrics", "finalize"];
const labels = {
  queued: "排队中",
  prepare: "检查文件",
  instrumental: "分离伴奏",
  vocals: "分离主唱和声",
  lyrics: "对齐歌词",
  finalize: "保存",
  completed: "完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
export async function atomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file + ".tmp", JSON.stringify(value, null, 2) + "\n");
  await rename(file + ".tmp", file);
}
async function read(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
async function bytes(dir) {
  let sum = 0;
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, d.name);
    sum += d.isDirectory()
      ? await bytes(p)
      : (await stat(p).catch(() => ({ size: 0 }))).size;
  }
  return sum;
}
export function parseSeparationProgress(text) {
  const m = [
    ...text.matchAll(/(\d{1,3})%\|[^\r\n]*?\|\s*(\d+)\/(\d+)\s*\[/g),
  ].at(-1);
  if (!m) return null;
  const completed = Number(m[2]),
    total = Number(m[3]);
  if (!total || completed > total) return null;
  return {
    kind: "chunks",
    completed,
    total,
    percent: Math.floor((completed / total) * 100),
  };
}

export class JobQueue {
  constructor({ data = DATA, settings = config, runner } = {}) {
    this.data = data;
    this.settings = settings;
    this.jobs = new Map();
    this.active = null;
    this.runner = runner;
    this.closed = false;
    this.uploads = new Set();
    this.saves = new Map();
    this.actions = new Set();
  }
  dir(id) {
    return path.join(this.data, "jobs", id);
  }
  async save(job) {
    job.updatedAt = new Date().toISOString();
    const snapshot = structuredClone(job);
    const previous = this.saves.get(job.id) || Promise.resolve();
    const pending = previous
      .catch(() => {})
      .then(() => atomic(path.join(this.dir(job.id), "job.json"), snapshot));
    this.saves.set(job.id, pending);
    await pending;
    if (this.saves.get(job.id) === pending) this.saves.delete(job.id);
  }
  async init() {
    for (const dir of ["jobs", "library", "staging"])
      await mkdir(path.join(this.data, dir), { recursive: true });
    for (const d of await readdir(path.join(this.data, "staging")))
      await rm(path.join(this.data, "staging", d), {
        recursive: true,
        force: true,
      });
    const songs = loadCatalog(this.data);
    for (const d of await readdir(path.join(this.data, "jobs"))) {
      if (!/^[a-z0-9-]+$/.test(d)) continue;
      try {
        const job = await read(path.join(this.dir(d), "job.json"));
        if (job.id !== d) continue;
        if (songs.some((s) => s.id === d)) {
          job.state = "completed";
          job.stage = "completed";
          await this.cleanupInputs(job);
        } else if (job.state === "running") {
          await this.reapWorker(job);
          job.state = "interrupted";
          job.stage = "interrupted";
          job.error = "服务上次运行时中断，重试会检查并复用已完成阶段。";
        }
        this.jobs.set(d, job);
        await this.save(job);
      } catch (error) {
        // Preserve recoverable files when metadata is damaged; never erase an
        // existing processing attempt just because one JSON cannot be read.
        const request = await read(
          path.join(this.dir(d), "request.json"),
        ).catch(() => null);
        if (request) {
          const job = {
            id: d,
            title: request.title || request.audioName,
            artist: request.artist || "",
            sourceKey: request.sourceKey,
            state: "interrupted",
            stage: "interrupted",
            createdAt: new Date().toISOString(),
            error: "任务记录未完整写入，请重试：" + error.message,
          };
          this.jobs.set(d, job);
          await this.save(job);
        } else await rm(this.dir(d), { recursive: true, force: true });
      }
    }
    this.kick();
    return this;
  }
  async reapWorker(job) {
    if (!Number.isInteger(job.workerPid) || job.workerPid < 2) return;
    // Check both the recorded process group and exact app/job arguments before
    // terminating an orphan. A reused PID alone is never sufficient.
    const owned = () => {
      try {
        return execFileSync("/bin/ps", ["-axo", "pgid=,command="], {
          encoding: "utf8",
        })
          .split("\n")
          .some((line) => {
            const m = /^\s*(\d+)\s+(.*)$/.exec(line);
            return (
              m &&
              Number(m[1]) === job.workerPid &&
              m[2].includes(path.join(APP, "processing/")) &&
              m[2].includes(this.dir(job.id))
            );
          });
      } catch {
        return false;
      }
    };
    if (owned()) {
      try {
        process.kill(-job.workerPid, "SIGTERM");
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
      if (owned()) {
        try {
          process.kill(-job.workerPid, "SIGKILL");
        } catch {}
      }
    }
    delete job.workerPid;
  }
  async list() {
    return Promise.all(
      [...this.jobs.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(async (j) => ({
          ...j,
          label:
            j.state === "failed" && j.failedStage
              ? `${labels[j.failedStage]}失败`
              : labels[j.stage] || j.stage,
          bytes: await bytes(this.dir(j.id)),
        })),
    );
  }
  async capacity() {
    const s = await statfs(this.data);
    if (s.bavail * s.bsize < this.settings.minFreeBytes)
      throw Object.assign(new Error("磁盘空间不足，请先释放空间后重试。"), {
        status: 507,
      });
    if (
      [...this.jobs.values()].filter((j) =>
        ["queued", "running"].includes(j.state),
      ).length +
        this.uploads.size >=
      this.settings.maxQueuedJobs
    )
      throw Object.assign(new Error("队列已满，请等待已有任务完成。"), {
        status: 429,
      });
  }
  async upload(req) {
    await this.capacity();
    const id = randomUUID();
    const dir = path.join(this.data, "staging", id);
    await mkdir(dir);
    this.uploads.add(id);
    const fields = {};
    const files = {};
    const writes = [];
    let failure;
    try {
      const parser = Busboy({
        headers: req.headers,
        defParamCharset: "utf8",
        limits: {
          files: 2,
          fields: 2,
          parts: 5,
          fieldSize: 1024,
          fileSize: this.settings.audioMaxBytes,
        },
      });
      const fail = (message) => {
        failure ||= new Error(message);
      };
      parser.on("field", (name, value, info) => {
        if (
          !["title", "artist"].includes(name) ||
          fields[name] !== undefined ||
          info.valueTruncated ||
          value.length > 200
        )
          fail("歌名或歌手字段无效");
        else fields[name] = value.trim();
      });
      parser.on("file", (name, stream, info) => {
        if (!["audio", "lyrics"].includes(name) || files[name]) {
          fail("必须上传一个音频和一个歌词文件");
          stream.resume();
          return;
        }
        const filename = name === "audio" ? "source.audio" : "source.lrc";
        const hash = createHash("sha256");
        let size = 0;
        files[name] = {
          filename,
          original: path.basename(info.filename),
          hash: null,
        };
        const counter = new Transform({
          transform(chunk, encoding, callback) {
            size += chunk.length;
            hash.update(chunk);
            if (
              size >
              (name === "audio"
                ? thisLimit.audioMaxBytes
                : thisLimit.lyricsMaxBytes)
            )
              callback(
                new Error(
                  name === "audio" ? "音频超过大小限制" : "歌词超过 1 MiB 限制",
                ),
              );
            else callback(null, chunk);
          },
        });
        const thisLimit = this.settings;
        stream.on("limit", () => fail("音频超过大小限制"));
        const writing = pipeline(
          stream,
          counter,
          createWriteStream(path.join(dir, filename), { flags: "wx" }),
        )
          .then(() => {
            if (!size) fail("上传文件为空");
            files[name].hash = hash.digest("hex");
          })
          .catch((e) => {
            failure ||= e;
            stream.resume();
          });
        writes.push(writing);
      });
      for (const ev of ["partsLimit", "filesLimit", "fieldsLimit"])
        parser.on(ev, () => fail("上传内容超出限制"));
      await new Promise((resolve, reject) => {
        req.on("aborted", () => {
          parser.destroy(new Error("上传已中断"));
        });
        parser.on("error", reject);
        parser.on("close", resolve);
        req.pipe(parser);
      });
      await Promise.all(writes);
      if (failure) throw failure;
      if (!files.audio?.hash || !files.lyrics?.hash)
        throw new Error("请选择音频和歌词配对上传");
      if (
        !/\.(mp3|flac|ncm)$/i.test(files.audio.original) ||
        !/\.(lrc|lyc)$/i.test(files.lyrics.original)
      )
        throw new Error("请上传 MP3 / FLAC / NCM 和 LRC / LYC");
      const sourceKey = createHash("sha256")
        .update(files.audio.hash + ":" + files.lyrics.hash)
        .digest("hex");
      // Serial JavaScript section reserves the fingerprint before any await.
      const song = loadCatalog(this.data).find(
        (s) => s.sourceKey === sourceKey,
      );
      const existing = [...this.jobs.values()].find(
        (j) => j.sourceKey === sourceKey,
      );
      if (song || existing)
        return {
          duplicate: true,
          songId: song?.id,
          jobId: existing?.id,
          message: song
            ? "这首歌和歌词已经在歌库中。"
            : "相同音频和歌词已有任务，可查看或重试原任务。",
        };
      const job = {
        id,
        title: fields.title || path.parse(files.audio.original).name,
        artist: fields.artist || "",
        sourceKey,
        state: "queued",
        stage: "queued",
        createdAt: new Date().toISOString(),
        error: null,
      };
      this.jobs.set(id, job);
      try {
        await atomic(path.join(dir, "request.json"), {
          ...fields,
          audio: files.audio.filename,
          lyrics: files.lyrics.filename,
          audioName: files.audio.original,
          lyricsName: files.lyrics.original,
          sourceKey,
        });
        await rename(dir, this.dir(id));
        await this.save(job);
      } catch (e) {
        this.jobs.delete(id);
        await rm(this.dir(id), { recursive: true, force: true });
        throw e;
      }
      this.kick();
      return { jobId: id, duplicate: false };
    } finally {
      this.uploads.delete(id);
      await Promise.allSettled(writes);
      await rm(dir, { recursive: true, force: true });
    }
  }
  kick() {
    if (this.active || this.closed) return;
    const job = [...this.jobs.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .find((j) => j.state === "queued");
    if (!job) return;
    this.active = { id: job.id, child: null, stop: null };
    this.running = this.process(job)
      .catch((error) => {
        job.state = "failed";
        job.stage = "failed";
        job.error = `任务记录无法保存：${error.message}。释放磁盘空间后可重试。`;
        console.error(job.error);
      })
      .finally(() => {
        this.active = null;
        this.kick();
      });
  }
  async runStage(job, stage) {
    if (this.active.stop) throw new Error(this.active.stop);
    if (this.runner) return this.runner(job, stage, this);
    const envName = ["prepare", "instrumental", "vocals"].includes(stage)
      ? "separation"
      : "tifa";
    const child = spawn(
      path.join(APP, `runtime/${envName}/bin/python`),
      [path.join(APP, "processing/worker.py"), this.dir(job.id), stage],
      {
        cwd: APP,
        detached: true,
        env: { ...process.env, PYTHONPATH: "", PYTHONUNBUFFERED: "1" },
      },
    );
    this.active.child = child;
    job.workerPid = child.pid;
    const completion = new Promise((resolve) => {
      child.on("error", (error) => resolve({ error }));
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    await this.save(job);
    const log = await open(path.join(this.dir(job.id), "process.log"), "a");
    let tail = "",
      buffer = "",
      logBytes = (await log.stat()).size;
    let progressTail = "";
    const consume = (chunk, isOut) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-5000);
      if (!isOut && ["instrumental", "vocals"].includes(stage)) {
        progressTail = (progressTail + text).slice(-1000);
        const progress = parseSeparationProgress(progressTail);
        if (progress) job.progress = progress;
      }
      if (logBytes < 2 * 1024 * 1024) {
        logBytes += chunk.length;
        log.write(chunk).catch(() => {});
      }
      if (isOut) {
        buffer += text;
        let n;
        while ((n = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, n);
          buffer = buffer.slice(n + 1);
          try {
            const event = JSON.parse(line);
            if (event.kind === "alignment")
              job.progress = {
                kind: "lines",
                engine: event.engine,
                completed: event.completed,
                total: event.total,
                percent: Math.floor((event.completed / event.total) * 100),
              };
            if (event.kind === "error") job.detailError = event.message;
            if (event.kind === "fallbacks") job.fallbackCount = event.count;
            if (event.kind === "checkpoint")
              job.reusedStages = [
                ...new Set([...(job.reusedStages || []), stage]),
              ];
          } catch {}
        }
      }
    };
    child.stdout.on("data", (c) => consume(c, true));
    child.stderr.on("data", (c) => consume(c, false));
    try {
      const { code, signal, error } = await completion;
      if (error || code !== 0)
        throw new Error(
          job.detailError ||
            error?.message ||
            `处理进程退出（${signal || code}）：${tail.slice(-1500)}`,
        );
    } finally {
      await log.close();
      this.active.child = null;
      delete job.workerPid;
    }
  }
  async process(job) {
    job.state = "running";
    job.error = null;
    delete job.failedStage;
    delete job.detailError;
    try {
      for (const stage of stages) {
        if (this.active.stop) throw new Error(this.active.stop);
        await this.capacityDisk();
        job.stage = stage;
        job.progress = null;
        delete job.detailError;
        await this.save(job);
        await this.runStage(job, stage);
      }
      if (this.active.stop) throw new Error(this.active.stop);
      const result = path.join(this.dir(job.id), "result");
      const song = await read(path.join(result, "song.json"));
      if (song.id !== job.id) throw new Error("成品歌曲 ID 与任务不一致");
      // Publish under its display name while keeping IDs and API URLs stable.
      await commitLibrarySong(result, path.join(this.data, "library"), song);
      job.title = song.title;
      job.artist = song.artist;
      job.fallbackCount = song.fallbackCount;
      job.state = "completed";
      job.stage = "completed";
      job.progress = null;
      await this.save(job);
      await this.cleanupInputs(job);
    } catch (e) {
      job.failedStage = job.stage;
      job.state = this.active.stop || "failed";
      job.stage = job.state;
      job.error =
        job.state === "failed"
          ? e.message
          : job.state === "interrupted"
            ? "服务已停止，重试将复用校验通过的阶段。"
            : null;
      job.progress = null;
      await this.save(job);
    }
  }
  async capacityDisk() {
    const s = await statfs(this.data);
    if (s.bavail * s.bsize < this.settings.minFreeBytes)
      throw new Error("磁盘空间不足，请释放空间后重试");
  }
  async cleanupInputs(job) {
    for (const name of await readdir(this.dir(job.id)).catch(() => []))
      if (name !== "job.json")
        await rm(path.join(this.dir(job.id), name), {
          recursive: true,
          force: true,
        });
  }
  async stopActive(state) {
    if (!this.active) return;
    this.active.stop = state;
    const child = this.active.child;
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 5000);
      timer.unref();
      child.once("close", () => clearTimeout(timer));
    }
    await this.running;
  }
  async action(id, action) {
    if (this.actions.has(id))
      throw new Error("此任务正在执行上一项操作，请稍后重试");
    this.actions.add(id);
    try {
      const job = this.jobs.get(id);
      if (!job) throw Object.assign(new Error("任务不存在"), { status: 404 });
      if (action === "cancel") {
        if (job.state === "running") await this.stopActive("cancelled");
        else if (job.state === "queued") {
          job.state = "cancelled";
          job.stage = "cancelled";
          await this.save(job);
        } else throw new Error("此任务已经停止");
      } else if (action === "retry") {
        if (!["failed", "cancelled", "interrupted"].includes(job.state))
          throw new Error("只有失败、取消或中断的任务可以重试");
        job.state = "queued";
        job.stage = "queued";
        job.error = null;
        await this.save(job);
        this.kick();
      } else if (action === "clear") {
        if (!terminal.has(job.state))
          throw new Error("请先取消正在处理或排队的任务");
        await rm(this.dir(id), { recursive: true, force: true });
        this.jobs.delete(id);
      } else throw new Error("未知任务操作");
      return { ok: true };
    } finally {
      this.actions.delete(id);
    }
  }
  async close() {
    this.closed = true;
    if (this.active) await this.stopActive("interrupted");
  }
}
