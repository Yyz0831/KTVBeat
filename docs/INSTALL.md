# 从源码准备本地应用

当前经过验证的是 Apple Silicon macOS。本仓库保存源码及固定版本配置，不附带模型、歌曲或可直接搬运的 Python 环境。以下安装步骤根据现有本机环境整理，尚未在另一台干净机器上完整复装验证。

## 1. 依赖

准备 Node.js 22 或更新版本、Python 3.12、Python 3.11，以及可执行的 FFmpeg。分轨环境使用 Python 3.12，SOFA 和 TIFA 使用 Python 3.11。两个歌词模型的 CPU 计算限制为四线程；分轨在可用时使用 MPS。

在仓库根目录执行：

```sh
npm --prefix app/player ci
python3.12 -m venv app/runtime/separation
python3.11 -m venv app/runtime/sofa
python3.11 -m venv app/runtime/tifa
app/runtime/separation/bin/python -m pip install -r app/runtime/separation.lock.txt
app/runtime/sofa/bin/python -m pip install -r app/runtime/sofa.lock.txt
app/runtime/tifa/bin/python -m pip install -r app/runtime/tifa.lock.txt
mkdir -p app/bin app/records app/models/sofa
cp "$(command -v ffmpeg)" app/bin/ffmpeg
chmod +x app/bin/ffmpeg
```

锁定文件是已运行环境的依赖快照，含平台相关包及开发版依赖。若某个固定版本没有当前平台的发行包，安装会失败，需要单独验证替代版本，不能据此宣称已经复现原环境。FFmpeg 若依赖系统动态库，这些库也必须在本机可用。

## 2. 模型和资源

权重由所有歌曲共用，一次性约 2 GiB；Python 环境另计。下载并展开下列作者发布的资源，放到指定位置。已有的仓库配置文件应保留，尤其是 `g2p-zh-en.yaml` 和 `evaluation-english.txt`。

| 资源 | 来源 | 应用内路径 |
| --- | --- | --- |
| BS Roformer | [模型发布页](https://github.com/TRvlvr/model_repo/releases/tag/all_public_uvr_models) 中的 `model_bs_roformer_ep_317_sdr_12.9755.ckpt` | `app/models/separation/` 下同名文件 |
| Mel Band Karaoke | 同上，`mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt` | `app/models/separation/` 下同名文件 |
| SOFA 普通话歌声 | [pretrained_mandarin_singing.zip](https://github.com/qiuqiao/SOFA/releases/download/v1.0.1/pretrained_mandarin_singing.zip) | 将内部 `v1.0.0_mandarin_singing.ckpt` 保存为 `app/models/sofa/model.ckpt` |
| TIFA 1.0 | [TIFA-1.0.zip](https://github.com/openvpi/TIFA/releases/download/v1.0.0/TIFA-1.0.zip) | 内部 `model.pt` → `app/models/tifa/model.pt`，`dictionaries/` → `app/models/tifa/dictionaries/` |
| 英文 G2P | [LstmG2p-Eng.zip](https://github.com/wolfgitpr/LstmG2p/releases/download/v1.0.0/LstmG2p-Eng.zip) | 内部资源放入 `app/models/tifa/assets/LstmG2p-Eng/`，使 `encoder.onnx`、`decoder.onnx` 位于该目录 |

SOFA / TIFA 的推理代码已在 `app/vendor/` 中。TIFA 的大词典随模型资源下载，不重复提交到 Git；运行时读取 `app/models/tifa/dictionaries/`。

所有必要文件的相对路径和 SHA-256 都列在 `app/models/manifest.json`。模型文件准备好后运行：

```sh
app/runtime/tifa/bin/python app/scripts/audit.py
```

应输出空的 `issues`。这会检查模型完整性和已入库歌曲，不运行模型推理。该检查通过仍不等同于新机器已完成一次完整歌曲处理。

## 3. 启动

```sh
node app/player/server.mjs
```

浏览器访问 <http://127.0.0.1:17862>。初次没有内置歌曲，需要自行上传音频与逐句歌词。模型只在上传处理时运行，播放不会启动模型。

使用 `config.json` 配置上传上限、最长时长及线程数。默认音频 256 MiB、歌词 1 MiB、时长 20 分钟；配置修改后重启生效。
