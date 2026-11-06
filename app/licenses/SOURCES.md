# 上游来源与本机固定版本

- audio-separator 0.47.0：安装包中的源码及许可证保存在 `runtime/separation`，许可副本在本目录。来源 https://github.com/nomadkaraoke/python-audio-separator 。两个固定分离权重沿用本机已验证文件，校验值见 `models/manifest.json`；运行时不查询或下载模型目录。
- BS Roformer：`model_bs_roformer_ep_317_sdr_12.9755.ckpt`；Mel Band Karaoke：`mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt`。上游分发索引 https://github.com/TRvlvr/model_repo/releases/tag/all_public_uvr_models 。模型配置一并保存。
- SOFA v1.0.3 / commit 584d6b9a57927843f85decebf4cbf03b9598125f，MIT，源码和 opencpop-extension 词典保存在 `vendor/SOFA`。模型来自 https://github.com/qiuqiao/SOFA/releases/tag/v1.0.1 的 pretrained_mandarin_singing.zip（内部 v1.0.0_mandarin_singing.ckpt）。
- TIFA commit 7b210ca36ff5a2b79187fb1727af58fc977cc301，MIT，源码、词典说明保存在 `vendor/TIFA`。TIFA-1.0 权重来自 https://github.com/openvpi/TIFA/releases/tag/v1.0.0 。
- 英文 LSTM G2P： https://github.com/wolfgitpr/LstmG2p/releases/tag/v1.0.0 ，保存在 `models/tifa/assets/LstmG2p-Eng`。通用英文词典与中文词典随 TIFA 模型保存；本地附加发音来自先前已验收歌词实验，追加 WTF / dont / wat，不替代通用 G2P。
- ncmdump 0.1.1： https://pypi.org/project/ncmdump/ ，PyPI 包元数据声明 MIT。包元数据保存在 `licenses/ncmdump/METADATA`；源文件保存在独立环境中。该版发行包没有附带单独 LICENSE 正文，原仓库许可证页面本次无法获取，未自行补造版权声明。
- FFmpeg 8.1-tessus：现有二进制的独立副本。构建许可输出见 `FFmpeg.txt`；来源 https://evermeet.cx/ffmpeg/ ，上游源码 https://ffmpeg.org/releases/ 。
- Busboy 1.6.0 / streamsearch 1.1.0：包内 LICENSE 保存在 `player/node_modules/`，安装完整性哈希见 `player/package-lock.json`。

以上记录区分代码许可与模型来源；未假定代码仓库许可自动覆盖所有第三方训练数据及权重。完整 Python 依赖锁定在 `runtime/*.lock.txt`，各依赖的 dist-info 中保留其发行元数据及许可证。
