"""Generic SOFA-first / TIFA-fallback alignment, with strict LRC conflict repair."""

from common import *
from lyrics import *
import copy, subprocess, sys
import soundfile as sf
from pypinyin import lazy_pinyin, Style


def align(job, prepared):
    rows = prepared["rows"]
    duration = prepared["duration"]
    dictionary = APP / "vendor/SOFA/dictionary/opencpop-extension.txt"
    phones = {
        l.split("\t")[0]: l.split("\t")[1].split()
        for l in dictionary.read_text().splitlines()
        if l.strip()
    }
    for row in rows:
        tokens = units(row["text"])
        syllables = lazy_pinyin(
            row["text"], style=Style.NORMAL, errors=lambda s: units(s)
        )
        row["g2p"] = [
            dict(text=t, pinyin=p, phonemes=phones.get(p))
            for t, p in zip(tokens, syllables)
        ]
        row["sofa_unsupported"] = [
            g
            for g in row["g2p"]
            if g["phonemes"] is None or not re.fullmatch(r"[\u3400-\u9fff]", g["text"])
        ]
        if len(tokens) != len(syllables):
            row["sofa_unsupported"].append(dict(reason="g2p_length_mismatch"))
    attempts = []

    def run(selected, engine, label, strict):
        if not selected:
            return {}
        root = job / "work/alignment" / label / engine
        clips = root / "inputs/clips"
        clips.mkdir(parents=True, exist_ok=True)
        manifest = []
        with sf.SoundFile(job / "work/backing/lead.flac") as audio:
            for original in selected:
                r = copy.deepcopy(original)
                sr = audio.samplerate
                a = round(max(0, r["lrc_start"] - (0 if strict else 0.5)) * sr)
                b = round(min(duration, r["lrc_end"] + (0 if strict else 0.5)) * sr)
                r.update(start=a / sr, end=b / sr)
                audio.seek(a)
                clip = clips / (r["id"] + ".wav")
                sf.write(
                    clip,
                    audio.read(b - a, dtype="float32", always_2d=True).mean(axis=1),
                    sr,
                    subtype="PCM_16",
                )
                clip.with_suffix(".txt").write_text(r["text"] + "\n")
                clip.with_suffix(".lab").write_text(
                    " ".join(g["pinyin"] for g in r["g2p"]) + "\n"
                )
                manifest.append(r)
        save(root / "manifest.json", dict(rows=manifest, strict=strict))
        result = root / engine / "result.json"
        # Re-run this attempt after a crash, never trust an incomplete result list.
        if result.exists():
            result.unlink()
        proc = subprocess.run(
            [
                str(APP / f"runtime/{engine}/bin/python"),
                str(APP / "processing/align_model.py"),
                engine,
                str(root),
            ],
            cwd=APP,
            env=bounded_env(),
        )
        if proc.returncode or not result.exists():
            raise RuntimeError(
                f"{engine.upper()} 模型进程失败（{proc.returncode}），请查看处理日志后重试"
            )
        value = read(result)
        attempts.append(
            dict(
                engine=engine,
                label=label,
                strict=strict,
                **{k: v for k, v in value.items() if k != "rows"},
            )
        )
        return {r["id"]: r for r in value["rows"]}

    def batch(selected, label, strict):
        primary = run(
            [r for r in selected if not r["sofa_unsupported"]], "sofa", label, strict
        )
        missing = [
            r
            for r in selected
            if r["sofa_unsupported"] or invalid(primary.get(r["id"]), r, duration)
        ]
        primary.update(run(missing, "tifa", label, strict))
        return primary

    selected = batch(rows, "initial", False)
    lines = [display_line(r, selected.get(r["id"]), duration) for r in rows]
    repairs = []
    attempted = set()
    for n in range(len(rows) + 1):
        ids = {i for c in conflicts(lines) for i in c["ids"]} | {
            l["id"] for l in lines if l["timing"] == "line"
        }
        ids -= attempted
        if not ids:
            break
        retry = [r for r in rows if r["id"] in ids]
        new = batch(retry, f"repair-{n}", True)
        for i, r in enumerate(rows):
            if r["id"] not in ids:
                continue
            before = lines[i]
            selected[r["id"]] = new.get(r["id"])
            lines[i] = display_line(r, selected[r["id"]], duration)
            repairs.append(
                dict(
                    id=r["id"],
                    lrc=[r["lrc_start"], r["lrc_end"]],
                    before=[before["start"], before["end"]],
                    after=[lines[i]["start"], lines[i]["end"]],
                )
            )
        attempted.update(ids)
    # Any unresolved conflicting lines fall back to real LRC boundaries.
    for n in range(len(rows) + 1):
        bad = {i for c in conflicts(lines) for i in c["ids"]}
        if not bad:
            break
        for i, r in enumerate(rows):
            if r["id"] in bad:
                lines[i] = display_line(r, None, duration)
                lines[i]["issues"].append(dict(kind="unresolved_conflict"))
    assert not conflicts(lines)
    fallback = [
        dict(
            id=l["id"],
            text=l["text"],
            issues=l["issues"],
            model_error=(selected.get(l["id"]) or {}).get("error"),
        )
        for l in lines
        if l["timing"] == "line"
    ]
    output = dict(
        version=1,
        songId=job.name,
        title=prepared["title"],
        artist=prepared["artist"],
        duration=duration,
        timeUnit="seconds",
        lines=lines,
    )
    save(job / "work/lyrics.json", output)
    save(
        job / "work/alignment-record.json",
        dict(
            attempts=attempts,
            repairs=repairs,
            fallbacks=fallback,
            excluded=prepared["excluded"],
            adjacent_overlaps=[
                dict(ids=[a["id"], b["id"]], seconds=a["end"] - b["start"])
                for a, b in zip(lines, lines[1:])
                if a["end"] > b["start"]
            ],
        ),
    )
    return len(fallback)
