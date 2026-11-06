"""One process per stage; checkpoints are hashed before reuse."""

from common import *
from lyrics import parse_lrc, decode_lrc, conflicts, validate_words
import sys, subprocess, shutil, time, traceback, logging
import soundfile as sf

STAGES = ["prepare", "instrumental", "vocals", "lyrics", "finalize"]
MODELS = {
    "instrumental": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
    "vocals": "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt",
}
YAMLS = {
    "instrumental": "model_bs_roformer_ep_317_sdr_12.9755.yaml",
    "vocals": "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956_config.yaml",
}


def run(command):
    result = subprocess.run(
        command,
        env=bounded_env(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode:
        raise ValueError(result.stderr[-2500:] or f"命令失败：{result.returncode}")
    return result.stdout


def fingerprint():
    h = hashlib.sha256()
    for p in sorted((APP / "processing").glob("*.py")):
        if not p.name.startswith("test_"):
            h.update(p.read_bytes())
    h.update((APP / "models/manifest.json").read_bytes())
    h.update((APP / "config.json").read_bytes())
    for p in sorted((APP / "runtime").glob("*.lock.txt")):
        h.update(p.read_bytes())
    return h.hexdigest()


def input_hashes(job):
    req = read(job / "request.json")
    return {
        name: digest(job / name)
        for name in [req["audio"], req["lyrics"], "request.json"]
    }


def valid_checkpoint(job, stage):
    try:
        record = read(job / "checkpoints" / f"{stage}.json")
        return (
            record["pipeline"] == fingerprint()
            and record.get("inputs") == input_hashes(job)
            and bool(record["files"])
            and all(
                (job / f).is_file() and digest(job / f) == h
                for f, h in record["files"].items()
            )
        )
    except (OSError, ValueError, KeyError, TypeError):
        return False


def file_info(path):
    i = sf.info(path)
    if (
        i.samplerate != 44100
        or i.channels != 2
        or i.subtype != "PCM_16"
        or not i.frames
    ):
        raise ValueError(f"{path.name} 格式不是 44.1 kHz / 立体声 / 16-bit")
    return i


def prepare(job):
    import mutagen
    from mutagen.mp3 import MP3
    from mutagen.flac import FLAC

    req = read(job / "request.json")
    audio = job / req["audio"]
    lyrics = job / req["lyrics"]
    work = job / "work"
    work.mkdir(exist_ok=True)
    ext = Path(req["audioName"]).suffix.lower()
    if ext not in [".mp3", ".flac", ".ncm"]:
        raise ValueError("仅支持 MP3、FLAC 或 NCM 音频")
    if Path(req["lyricsName"]).suffix.lower() not in [".lrc", ".lyc"]:
        raise ValueError("歌词必须是 .lrc 或 LRC 内容的 .lyc")
    if (
        audio.stat().st_size > CONFIG["audioMaxBytes"]
        or lyrics.stat().st_size > CONFIG["lyricsMaxBytes"]
    ):
        raise ValueError("上传文件超过大小限制")
    with audio.open("rb") as f:
        magic = f.read(8)
    if ext == ".ncm":
        if magic != b"CTENFDAM":
            raise ValueError("扩展名是 NCM，但文件头不是有效 NCM")
        from ncmdump import dump

        target = work / "extracted.audio"
        if target.exists():
            target.unlink()
        dump(str(audio), output_path=lambda *_: str(target), skip=False)
        audio = target
    elif magic == b"CTENFDAM":
        raise ValueError("实际是 NCM 文件，请使用正确的 .ncm 扩展名")
    try:
        meta = mutagen.File(audio)
    except Exception as e:
        raise ValueError(f"音频格式无法识别：{e}")
    actual = (
        "flac" if isinstance(meta, FLAC) else "mp3" if isinstance(meta, MP3) else None
    )
    if not actual:
        raise ValueError("文件内部不是可识别的 MP3 或 FLAC")
    if ext != ".ncm" and ext != "." + actual:
        raise ValueError(f"扩展名 {ext} 与实际 {actual.upper()} 格式不符")
    if not 0 < meta.info.length <= CONFIG["maxDurationSeconds"]:
        raise ValueError("音频时长必须大于 0 且不超过 20 分钟")
    free = shutil.disk_usage(job).free
    needed = CONFIG["minFreeBytes"] + int(meta.info.length * 44100 * 2 * 4 * 8)
    if free < needed:
        raise ValueError(
            f"磁盘空间不足：至少需 {needed / 2**30:.2f} GiB，目前 {free / 2**30:.2f} GiB"
        )
    # Reject malformed timestamps before decoding or loading any model.
    parse_lrc(decode_lrc(lyrics.read_bytes()), meta.info.length + 0.1)
    target = work / "input.wav"
    run(
        [
            str(APP / "bin/ffmpeg"),
            "-nostdin",
            "-v",
            "error",
            "-xerror",
            "-y",
            "-i",
            str(audio),
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "2",
            "-ar",
            "44100",
            "-c:a",
            "pcm_s16le",
            str(target),
        ]
    )
    info = file_info(target)
    if info.duration > CONFIG["maxDurationSeconds"]:
        raise ValueError("解码后的音频超过 20 分钟")
    rows, excluded = parse_lrc(decode_lrc(lyrics.read_bytes()), info.duration)
    tags = mutagen.File(audio, easy=True)

    def tag(k):
        return str((tags or {}).get(k, [""])[0]).strip()

    value = dict(
        duration=info.duration,
        frames=info.frames,
        title=req.get("title") or tag("title") or Path(req["audioName"]).stem,
        artist=req.get("artist") or tag("artist") or "未知歌手",
        format=actual,
        entryFormat=ext[1:],
        rows=rows,
        excluded=excluded,
        source=dict(audio=digest(job / req["audio"]), lyrics=digest(lyrics)),
        sourceKey=req["sourceKey"],
    )
    save(work / "prepared.json", value)
    return ["work/input.wav", "work/prepared.json"]


def separation(job, stage):
    from audio_separator.separator import Separator

    output = job / ("work/separation" if stage == "instrumental" else "work/backing")
    output.mkdir(parents=True, exist_ok=True)
    separator = Separator(
        model_file_dir=str(APP / "models/separation"),
        output_dir=str(output),
        output_format="FLAC",
        sample_rate=44100,
        normalization_threshold=0.9,
        amplification_threshold=0.0,
        use_soundfile=False,
        mdxc_params={
            "segment_size": 256,
            "override_model_segment_size": False,
            "batch_size": 1,
            "overlap": 4,
            "pitch_shift": 0,
        },
    )
    # Resolve only the two bundled, checksummed models; never fetch model catalogs.
    model = APP / "models/separation" / MODELS[stage]
    yaml = YAMLS[stage]
    manifest = read(APP / "models/manifest.json")["files"]
    for p in [model, model.parent / yaml]:
        if digest(p) != manifest[str(p.relative_to(APP))]:
            raise ValueError(f"模型校验失败：{p.name}")
    separator.download_model_files = lambda name: (name, "MDXC", name, str(model), yaml)
    separator.load_model(MODELS[stage])
    names = (
        {"Instrumental": "instrumental", "Vocals": "total-vocals"}
        if stage == "instrumental"
        else {"Instrumental": "backing", "Vocals": "lead"}
    )
    source = job / (
        "work/input.wav"
        if stage == "instrumental"
        else "work/separation/total-vocals.flac"
    )
    separator.separate(str(source), custom_output_names=names)
    if stage == "instrumental":
        from pydub import AudioSegment

        p = output / "instrumental.flac"
        a = AudioSegment.from_file(p)
        if math.isfinite(a.max_dBFS):
            a.apply_gain(-a.max_dBFS).export(p, format="flac")
    expected = read(job / "work/prepared.json")["frames"]
    paths = []
    for name in names.values():
        p = output / (name + ".flac")
        info = file_info(p)
        if info.frames != expected:
            raise ValueError(f"{name} 长度与输入不一致：{info.frames} / {expected} 帧")
        paths.append(str(p.relative_to(job)))
    return paths


def finalize(job):
    prepared = read(job / "work/prepared.json")
    lyric = read(job / "work/lyrics.json")
    alignment = read(job / "work/alignment-record.json")
    if conflicts(lyric["lines"]) or len(lyric["lines"]) != len(prepared["rows"]):
        raise ValueError("歌词冲突或覆盖校验未通过")
    for row, line in zip(prepared["rows"], lyric["lines"]):
        if (
            line["text"] != row["source_text"]
            or not 0 <= line["start"] < line["end"] <= prepared["duration"] + 0.002
        ):
            raise ValueError("歌词文字或时间校验失败")
        if line["timing"] == "word" and validate_words(
            line["words"], line["start"], line["end"]
        ):
            raise ValueError("逐字时间校验失败")
    dest = job / "result"
    dest.mkdir(exist_ok=True)
    sources = dict(
        instrumental=job / "work/separation/instrumental.flac",
        lead=job / "work/backing/lead.flac",
        backing=job / "work/backing/backing.flac",
    )
    for role, p in sources.items():
        if file_info(p).frames != prepared["frames"]:
            raise ValueError("三轨长度不同")
        shutil.copyfile(p, dest / (role + ".flac"))
    shutil.copyfile(job / read(job / "request.json")["lyrics"], dest / "original.lrc")
    shutil.copyfile(job / "work/lyrics.json", dest / "lyrics.json")
    checks = {
        p.name: digest(p)
        for p in dest.iterdir()
        if p.is_file() and p.name not in ["song.json", "processing.json"]
    }
    save(
        dest / "song.json",
        dict(
            id=job.name,
            title=prepared["title"],
            artist=prepared["artist"],
            frames=prepared["frames"],
            duration=prepared["duration"],
            color="violet",
            order=time.time(),
            sourceKey=prepared["sourceKey"],
            source=prepared["source"],
            fallbackCount=len(alignment["fallbacks"]),
            checksums=checks,
        ),
    )
    stages = {
        p.stem: read(p)
        for p in (job / "checkpoints").glob("*.json")
        if p.stem != "finalize"
    }
    save(
        dest / "processing.json",
        dict(
            version=1,
            pipeline=fingerprint(),
            source=prepared["source"],
            entryFormat=prepared["entryFormat"],
            actualFormat=prepared["format"],
            models=read(APP / "models/manifest.json"),
            parameters=dict(
                separator="0.47.0",
                batch_size=1,
                overlap=4,
                normalization_threshold=0.9,
                instrumental_peak_db=0,
                alignment_threads=4,
            ),
            stages=stages,
            alignment=alignment,
        ),
    )
    return ["result/" + p.name for p in dest.iterdir() if p.is_file()]


def main():
    job = Path(sys.argv[1]).resolve()
    stage = sys.argv[2]
    if job.parent.name != "jobs" or not job.is_dir() or stage not in STAGES:
        raise ValueError("无效任务目录或阶段")
    if valid_checkpoint(job, stage):
        event(kind="checkpoint", stage=stage, reused=True)
        return
    # Invalidate downstream checkpoints after any input or code change.
    for name in STAGES[STAGES.index(stage) :]:
        (job / "checkpoints" / f"{name}.json").unlink(missing_ok=True)
    began = time.perf_counter()
    pipeline_version = fingerprint()
    inputs = input_hashes(job)
    if stage == "prepare":
        files = prepare(job)
    elif stage in MODELS:
        files = separation(job, stage)
    elif stage == "lyrics":
        from align import align

        count = align(job, read(job / "work/prepared.json"))
        event(kind="fallbacks", count=count)
        files = ["work/lyrics.json", "work/alignment-record.json"]
    else:
        files = finalize(job)
    save(
        job / "checkpoints" / f"{stage}.json",
        dict(
            pipeline=pipeline_version,
            inputs=inputs,
            seconds=time.perf_counter() - began,
            files={f: digest(job / f) for f in files},
        ),
    )
    event(kind="stage_complete", stage=stage)


if __name__ == "__main__":
    os.environ.update(bounded_env())
    try:
        # Cross-server guard: even a separate acceptance instance cannot run a
        # second model stage concurrently with the main application.
        import fcntl

        with (APP / "runtime/processing.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            main()
    except Exception as e:
        event(kind="error", message=str(e))
        traceback.print_exc()
        sys.exit(1)
