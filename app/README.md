# KTVBeat 本地应用

双击项目 `launchers/启动 KTVBeat 播放器.command`，或在此目录运行：

```sh
node player/server.mjs
```

打开 http://127.0.0.1:17862 。按 Control+C 退出；运行中的任务标记为已中断，重新启动后点击重试。端口占用时会明确报错。

## 添加歌曲

点击左侧「添加歌曲」，选择一个 MP3 / FLAC / NCM 和一个逐句 LRC（内容相同的 .lyc 也接受），确认歌名、歌手，点击「上传并处理」。任务会排队；上传后可以继续播放现有歌曲或继续添加。

任务卡片显示当前阶段。分轨百分比来自模型真实片段计数；歌词百分比是当前 SOFA / TIFA 批次已完成句数。更换模型、冲突重跑时批次重新计数，不能把各阶段百分比当成整首歌的总百分比。模型加载、文件检查和保存只显示状态。完成时显示待校准句数；这些句子仍显示原歌词，使用 LRC 逐句高亮。

取消会停止当前进程组；重试只复用输入、程序版本及产物校验通过的阶段。失败/取消/中断的任务保留重试文件并显示占用，可点击「清理文件」。完成任务的「收起记录」只移除任务卡片，不删除歌曲。相同音频文件与同一歌词文件再次上传会提示已有歌曲或任务。

## 目录与独立性

- `player/`：网页、Node 本地服务、上传及任务队列。
- `processing/`：格式验证、分轨、SOFA / TIFA 对齐、成品校验。
- `runtime/{separation,sofa,tifa}/`：独立 Python 环境；版本在相邻 `*.lock.txt`。
- `models/`：所有歌曲共用的必要权重、词典、G2P；SHA-256 在 `manifest.json`。
- `vendor/`、`licenses/`：上游代码、许可和来源说明。
- `bin/ffmpeg`：本地解码/FLAC 写入工具。
- `data/library/<歌曲名_作者>/`：正式歌库，多个作者用 `_` 分隔，作者姓名中的空格保留。重名目录追加 ` (2)`、` (3)`；路径特殊字符会替换，超长名称会缩短，完整歌名与作者保留在元数据中。歌曲 ID 和播放链接不随目录名改变。每首只有三轨 FLAC、`original.lrc`、`lyrics.json`、`song.json`、`processing.json`。
- `data/jobs/`：持久化任务状态与失败重试文件；成功后只保留小型任务记录。
- `data/staging/`：未完成上传；请求中断或启动恢复时自动清理。
- `records/`：迁移映射、清理清单、校验及验收记录。
- `scripts/audit.py`：模型、文件及目录独立性检查；`scripts/rename_library.mjs`：已有歌库目录改名工具，应在处理队列空闲且服务停止时执行。

运行时不引用项目外面的 `tools/`、`evaluation/` 环境、模型或脚本，也不链接旧音频。Python 的基础解释器仍使用已安装的 Python 3.11 / 3.12；Node.js 需要 22 或更新版本。仓库不包含环境、模型权重和歌曲；首次克隆按 [安装说明](../docs/INSTALL.md) 准备。此版本不是可直接搬到另一台 Mac 的独立安装包。

音频限制、歌词限制、时长、空间保留和 CPU 线程集中在 `config.json`。修改后重新启动。所有模型阶段串行；分轨使用可用的 MPS，SOFA / TIFA 使用 CPU，最多四线程。播放只读取成品，不运行模型。中文优先 SOFA；英文/混合句整句 TIFA；未知英文由词典及 LSTM G2P 处理，无有限词表限制。`WTF` / `dont` / `wat` 延续已有歌曲的发音约定。

## HTTP 接口

- `GET /api/songs`、`GET /audio/:songId/:role`、`GET /api/lyrics/:songId`
- `GET /api/jobs`、`GET /api/config`、`GET /api/health`
- `POST /api/jobs`：multipart 字段 `audio`、`lyrics`、可选 `title`、`artist`
- `POST /api/jobs/:id/cancel`、`retry`、`clear`

服务只监听 127.0.0.1；写入必须带与 Host 完全匹配的本地 Origin。文件路径由服务器生成，不接受客户端指定的读写路径。未校验完成的任务不会出现在歌库。

## 本机检查

```sh
cd player && npm test
../runtime/separation/bin/python -m unittest discover -s ../processing -p 'test_*.py'
../runtime/tifa/bin/python ../scripts/audit.py
```

浏览器试听步骤见 `浏览器验收.md`。Node/Python 自动测试不等同于实际浏览器试听。
