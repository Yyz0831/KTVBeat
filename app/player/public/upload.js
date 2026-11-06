const $ = (id) => document.getElementById(id);
const dialog = $("upload-dialog"),
  form = $("upload-form");
$("add-song").addEventListener("click", () => dialog.showModal());
$("upload-close").addEventListener("click", () => dialog.close());
$("upload-audio").addEventListener("change", () => {
  const file = $("upload-audio").files[0];
  if (!file) return;
  const parts = file.name.replace(/\.[^.]+$/, "").split(" - ");
  $("upload-title").value =
    parts.length > 1 ? parts.slice(1).join(" - ") : parts[0];
  $("upload-artist").value = parts.length > 1 ? parts[0] : "";
});
let limits = {
  audioMaxBytes: 268435456,
  lyricsMaxBytes: 1048576,
  maxDurationSeconds: 1200,
};
fetch("/api/config")
  .then((r) => r.json())
  .then((value) => {
    limits = value;
    $("upload-limits").textContent =
      `MP3 / FLAC / NCM，音频不超过 ${Math.round(value.audioMaxBytes / 1048576)} MiB、${Math.round(value.maxDurationSeconds / 60)} 分钟；LRC / LYC 不超过 ${Math.round(value.lyricsMaxBytes / 1048576)} MiB。`;
  })
  .catch(() => {});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const audio = $("upload-audio").files[0],
    lyrics = $("upload-lyrics").files[0];
  if (!audio || !lyrics) return;
  if (
    audio.size > limits.audioMaxBytes ||
    lyrics.size > limits.lyricsMaxBytes
  ) {
    $("upload-message").textContent = $("upload-limits").textContent;
    return;
  }
  $("upload-submit").disabled = true;
  $("upload-message").textContent = "正在上传…";
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/jobs");
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable)
      $("upload-message").textContent =
        `正在上传 ${Math.round((e.loaded / e.total) * 100)}%`;
  };
  xhr.onerror = () => {
    $("upload-message").textContent =
      "连接中断，未完成的上传会自动清理，请重试。";
    $("upload-submit").disabled = false;
  };
  xhr.onload = () => {
    $("upload-submit").disabled = false;
    try {
      const result = JSON.parse(xhr.responseText);
      if (xhr.status >= 400) throw new Error(result.error);
      $("upload-message").textContent = result.duplicate
        ? result.message
        : "已加入队列，可以继续添加下一首。";
      if (!result.duplicate) {
        form.reset();
        dialog.close();
      }
      poll();
    } catch (e) {
      $("upload-message").textContent = e.message;
    }
  };
  xhr.send(new FormData(form));
});
let signature = "",
  busy = false;
const knownCompleted = new Set();
function node(tag, text, className) {
  const n = document.createElement(tag);
  n.textContent = text;
  if (className) n.className = className;
  return n;
}
async function poll() {
  if (busy) return;
  busy = true;
  try {
    const response = await fetch("/api/jobs");
    if (!response.ok) throw new Error("任务服务不可用");
    const jobs = await response.json();
    $("job-connection").textContent = "";
    let changed = false;
    for (const j of jobs)
      if (j.state === "completed" && !knownCompleted.has(j.id)) {
        knownCompleted.add(j.id);
        changed = true;
      }
    if (changed) window.dispatchEvent(new Event("library-updated"));
    const next = JSON.stringify(jobs);
    if (next === signature) return;
    signature = next;
    $("job-count").textContent =
      jobs.filter((j) => ["queued", "running"].includes(j.state)).length || "";
    $("job-list").replaceChildren(
      ...jobs.map((job) => {
        const article = node("article", "", `job job-${job.state}`);
        const header = node("div", "", "job-heading");
        header.append(node("strong", job.title), node("span", job.label));
        article.append(header);
        let detail = job.artist || "";
        if (job.progress)
          detail +=
            job.progress.kind === "chunks"
              ? ` · ${job.progress.completed}/${job.progress.total} 片段`
              : ` · ${job.progress.engine.toUpperCase()} 当前批次 ${job.progress.completed}/${job.progress.total} 句`;
        if (job.state === "completed")
          detail += ` · ${job.fallbackCount || 0} 句待校准`;
        else detail += ` · 占用 ${(job.bytes / 1048576).toFixed(1)} MiB`;
        article.append(node("p", detail));
        if (job.progress) {
          const row = node("div", "", "job-progress");
          const bar = document.createElement("progress");
          bar.max = job.progress.total;
          bar.value = job.progress.completed;
          bar.setAttribute("aria-label", job.label + "进度");
          row.append(bar, node("span", `${job.progress.percent}%`));
          article.append(row);
        }
        if (job.error) article.append(node("p", job.error, "job-error"));
        if (job.reusedStages?.length)
          article.append(node("small", "已复用校验通过的处理阶段"));
        const actions = node("div", "", "job-actions");
        const options = ["queued", "running"].includes(job.state)
          ? [["cancel", "取消"]]
          : [
              ...(job.state === "completed" ? [] : [["retry", "重试"]]),
              ["clear", job.state === "completed" ? "收起记录" : "清理文件"],
            ];
        for (const [action, label] of options) {
          const button = node("button", label);
          button.type = "button";
          button.onclick = async () => {
            button.disabled = true;
            try {
              const r = await fetch(`/api/jobs/${job.id}/${action}`, {
                method: "POST",
              });
              const v = await r.json();
              if (!r.ok) throw new Error(v.error);
              await poll();
            } catch (e) {
              $("job-connection").textContent = e.message;
            } finally {
              button.disabled = false;
            }
          };
          actions.append(button);
        }
        article.append(actions);
        return article;
      }),
    );
    $("job-empty").hidden = jobs.length > 0;
  } catch (e) {
    $("job-connection").textContent =
      "任务状态暂时无法更新，连接恢复后会自动重试。";
  } finally {
    busy = false;
  }
}
poll();
setInterval(poll, 2000);
