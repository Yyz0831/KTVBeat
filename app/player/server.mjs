import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { loadCatalog, publicCatalog, roles, DATA } from "./catalog.mjs";
import { JobQueue, config } from "./jobs.mjs";

const assets = new Map([
  ["/", ["public/index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["public/styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["public/app.js", "text/javascript; charset=utf-8"]],
  [
    "/audio-engine.js",
    ["public/audio-engine.js", "text/javascript; charset=utf-8"],
  ],
  [
    "/lyrics-timing.js",
    ["public/lyrics-timing.js", "text/javascript; charset=utf-8"],
  ],
  [
    "/lyrics-view.js",
    ["public/lyrics-view.js", "text/javascript; charset=utf-8"],
  ],
  ["/upload.js", ["public/upload.js", "text/javascript; charset=utf-8"]],
  ["/upload.css", ["public/upload.css", "text/css; charset=utf-8"]],
  ["/lyrics.css", ["public/lyrics.css", "text/css; charset=utf-8"]],
  ["/tests/audio", ["tests/audio.html", "text/html; charset=utf-8"]],
  [
    "/tests/audio.js",
    ["tests/audio-browser.js", "text/javascript; charset=utf-8"],
  ],
]);

function json(res, status, data, head = false) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(head ? undefined : body);
}

export function createServer({
  data = DATA,
  queue = new JobQueue({ data }),
} = {}) {
  let initialize;
  const ready = new Promise((resolve, reject) => {
    initialize = () => queue.init().then(resolve, reject);
  });
  const server = http.createServer(async (req, res) => {
    try {
      await ready;
      const expectedHost = `127.0.0.1:${server.address().port}`;
      if (
        req.headers.host !== expectedHost &&
        req.headers.host !== `localhost:${server.address().port}`
      )
        return json(res, 403, { error: "仅允许本机地址访问。" });
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self'; object-src 'none'; frame-ancestors 'none'",
      );
      const head = req.method === "HEAD";
      let pathname;
      try {
        pathname = decodeURIComponent(
          new URL(req.url, "http://localhost").pathname,
        );
      } catch {
        return json(res, 400, { error: "无效地址。" }, head);
      }
      if (!["GET", "HEAD"].includes(req.method)) {
        if (
          req.headers.origin !== `http://${req.headers.host}` ||
          (req.headers["sec-fetch-site"] &&
            req.headers["sec-fetch-site"] !== "same-origin")
        )
          return json(res, 403, { error: "写入仅允许本机同源网页请求。" });
        if (req.method === "POST" && pathname === "/api/jobs")
          return json(res, 202, await queue.upload(req));
        const action = /^\/api\/jobs\/([a-z0-9-]+)\/(cancel|retry|clear)$/.exec(
          pathname,
        );
        if (req.method === "POST" && action)
          return json(res, 200, await queue.action(action[1], action[2]));
        return json(res, 405, { error: "不支持的写入操作。" });
      }
      if (pathname === "/api/jobs")
        return json(res, 200, await queue.list(), head);
      if (pathname === "/api/config")
        return json(
          res,
          200,
          {
            audioMaxBytes: config.audioMaxBytes,
            lyricsMaxBytes: config.lyricsMaxBytes,
            maxDurationSeconds: config.maxDurationSeconds,
          },
          head,
        );
      if (pathname === "/api/songs")
        return json(res, 200, publicCatalog(data), head);
      const catalog = loadCatalog(data);
      if (pathname === "/api/health")
        return json(
          res,
          200,
          { app: "ktvbeat-player", version: "0.3.0" },
          head,
        );
      let filename, mime;
      const lyricMatch = /^\/api\/lyrics\/([^/]+)$/.exec(pathname);
      const lyricSong =
        lyricMatch && catalog.find((item) => item.id === lyricMatch[1]);
      const asset = assets.get(pathname);
      if (lyricMatch) {
        if (!lyricSong) return json(res, 404, { error: "歌曲不存在。" }, head);
        filename = lyricSong.lyricsFile;
        mime = "application/json; charset=utf-8";
      } else if (asset) {
        filename = fileURLToPath(new URL(asset[0], import.meta.url));
        mime = asset[1];
      } else {
        const match = /^\/audio\/([^/]+)\/([^/]+)$/.exec(pathname);
        const song = match && catalog.find((item) => item.id === match[1]);
        if (!song || !roles.includes(match[2]))
          return json(res, 404, { error: "文件不存在。" }, head);
        filename = song.files[match[2]];
        mime = "audio/flac";
      }
      try {
        const info = await stat(filename);
        if (!info.isFile())
          return json(res, 404, { error: "音频文件不存在。" }, head);
        res.writeHead(200, {
          "Content-Type": mime,
          "Content-Length": info.size,
        });
        if (head) return res.end();
        const stream = createReadStream(filename);
        res.on("close", () => stream.destroy());
        stream.on("error", () => res.destroy());
        stream.pipe(res);
      } catch (error) {
        json(
          res,
          error.code === "ENOENT" ? 404 : 500,
          {
            error: lyricMatch
              ? "无法读取歌词，请检查歌词文件是否已生成。"
              : "无法读取歌库文件，请检查文件是否完整。",
          },
          head,
        );
      }
    } catch (error) {
      if (!res.headersSent)
        json(res, error.status || 400, { error: error.message });
      else res.destroy();
    }
  });
  // A second launch must fail to bind before touching persisted jobs.
  server.once("listening", initialize);
  server.queue = queue;
  server.ready = ready;
  return server;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.PORT || 17862);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("PORT 必须是 1–65535 之间的端口号。");
    process.exit(1);
  }
  const server = createServer();
  server.on("error", (error) => {
    console.error(
      error.code === "EADDRINUSE"
        ? `端口 ${port} 已被占用。请关闭先前启动的播放器，或用 PORT 指定其他端口。`
        : `启动失败：${error.message}`,
    );
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`KTVBeat 播放器：http://127.0.0.1:${port}`);
    console.log("保持此终端打开；按 Control+C 停止服务。");
    if (process.argv.includes("--open") && process.platform === "darwin") {
      const browser = spawn(
        "/usr/bin/open",
        ["-a", "Google Chrome", `http://127.0.0.1:${port}`],
        { stdio: "ignore" },
      );
      browser.on("error", () => console.log("请手动在浏览器打开上方地址。"));
      browser.on("exit", (code) => {
        if (code) console.log("请手动在浏览器打开上方地址。");
      });
    }
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await server.queue.close();
      server.close();
      server.closeAllConnections();
    });
}
