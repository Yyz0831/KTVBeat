# KTVBeat

本地运行的三轨卡拉 OK 网页播放器。上传音频和逐句歌词后，应用分离伴奏、主唱、和声，并生成可扫色的歌词。

- 三轨共用一个播放进度，可分别调节音量，并控制总音量。
- 支持滚动歌词和 KTV 双行歌词，中文按字、英文按词扫色。
- 接受 MP3、FLAC、NCM，以及 LRC 格式的 `.lrc` / `.lyc` 文件。
- audio-separator 负责两阶段分轨；中文歌词优先 SOFA，英文及混合句由 TIFA 对齐。
- 任务串行处理，显示实际阶段进度，支持取消、重试和中断恢复。
- 每首成品只保存三轨 FLAC、原歌词、播放歌词和两份元数据；目录名为 `歌曲名_作者1_作者2`。

正式应用位于 [`app/`](app/)。已在 Apple Silicon macOS 本机运行；当前不是一键安装包，其他平台尚未验收。

## 开始使用

首次克隆请先按 [安装说明](docs/INSTALL.md) 安装 Node 依赖、三个 Python 环境、FFmpeg 和模型。仓库不包含歌曲、模型权重、Python 环境、处理日志或历史测试产物。

完成准备后：

```sh
npm --prefix app/player ci
node app/player/server.mjs
```

打开 <http://127.0.0.1:17862>。macOS 也可双击 `launchers/启动 KTVBeat 播放器.command`。

首次启动的歌库为空。点击「添加歌曲」，选择音频和对应的逐句歌词，填写歌名与歌手后上传处理。

## 项目结构

| 路径 | 用途 |
| --- | --- |
| `app/player/` | 原生网页、本地 HTTP 服务、上传与任务队列 |
| `app/processing/` | 音频检查、分轨、歌词对齐、成品校验 |
| `app/vendor/` | 已固定版本的 SOFA / TIFA 上游代码 |
| `app/models/manifest.json` | 模型和配套资源的 SHA-256 |
| `app/runtime/*.lock.txt` | 三个 Python 环境的本机依赖快照 |
| `app/licenses/` | 上游许可与来源 |
| `app/data/` | 本地歌库和任务，Git 忽略 |

使用方式、接口及参数见 [应用说明](app/README.md)，人工试听步骤见 [浏览器验收](app/浏览器验收.md)。上游代码遵循各自许可，见 [第三方来源](app/licenses/SOURCES.md)。

## 测试

```sh
npm --prefix app/player ci
npm --prefix app/player test
```

Node 测试无需模型；HTTP 测试使用临时合成数据。已有三首参考歌的实物歌词检查仅在本机存在这些文件时运行。Python 检查需要先完成安装：

```sh
app/runtime/separation/bin/python -m unittest discover -s app/processing -p 'test_*.py'
app/runtime/tifa/bin/python app/scripts/audit.py
```

自动测试覆盖队列、音频调度与歌词时间逻辑，不代表完成了人工试听。
