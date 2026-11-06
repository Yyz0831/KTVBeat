"""LRC parsing, real word boundaries and explicit line-level fallback."""

from common import *

CREDIT = re.compile(
    r"^(作词|作曲|制作人|编曲|吉他|录音|混音|母带|发行统筹|营销|监制|OP|SP|版权声明)\s*[:：]",
    re.I,
)
TIMESTAMP = re.compile(r"\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]")


def decode_lrc(data):
    for encoding in ["utf-8-sig", "gb18030"]:
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            pass
    raise ValueError("歌词编码无法读取，请使用 UTF-8 LRC")


def parse_lrc(text, duration):
    entries = []
    excluded = []
    offset = 0
    for number, raw in enumerate(text.splitlines(), 1):
        raw = raw.strip()
        if not raw:
            continue
        if raw.startswith("{"):
            meta = json.loads(raw)
            if not isinstance(meta, dict) or "t" not in meta or "c" not in meta:
                raise ValueError(f"歌词第 {number} 行不是有效的网易云元信息")
            excluded.append(dict(source_line=number, text=raw, reason="metadata"))
            continue
        if m := re.fullmatch(r"\[offset:([+-]?\d+)\]", raw, re.I):
            offset = int(m[1]) / 1000
            continue
        if re.fullmatch(r"\[(ti|ar|al|by|re|ve|length|id|au):.*\]", raw, re.I):
            excluded.append(dict(source_line=number, text=raw, reason="metadata"))
            continue
        tags = []
        cursor = 0
        while m := TIMESTAMP.match(raw, cursor):
            if int(m[2]) >= 60:
                raise ValueError(f"歌词第 {number} 行秒数必须小于 60")
            tags.append(int(m[1]) * 60 + int(m[2]) + float("0." + (m[3] or "0")))
            cursor = m.end()
        if not tags:
            raise ValueError(f"歌词第 {number} 行缺少 [分:秒] 时间")
        value = raw[cursor:].strip()
        for time in tags:
            entries.append(dict(source_line=number, time=time, text=value))
    entries.sort(key=lambda x: x["time"])
    unique = []
    for e in entries:
        e["time"] += offset
        if CREDIT.match(e["text"]):
            excluded.append(dict(e, reason="credit"))
            continue
        if unique and e["time"] == unique[-1]["time"]:
            if not e["text"] or e["text"] == unique[-1]["text"]:
                continue
            if not unique[-1]["text"]:
                unique[-1] = e
                continue
            raise ValueError(
                f"歌词 {e['time']:.3f} 秒存在两句不同文字，请去掉译文或重复时间"
            )
        unique.append(e)
    for e in unique:
        if not 0 <= e["time"] <= duration:
            raise ValueError(
                f"歌词第 {e['source_line']} 行时间超出音频（包括空白边界）"
            )
    rows = []
    for i, e in enumerate(unique):
        if not e["text"]:
            excluded.append(dict(e, reason="blank boundary"))
            continue
        start = e["time"]
        end = min(duration, unique[i + 1]["time"] if i + 1 < len(unique) else duration)
        if not 0 <= start < end <= duration:
            raise ValueError(
                f"歌词第 {e['source_line']} 行时间超出音频或没有可对齐区间"
            )
        original = e["text"]

        # Normalize single digits only in a Chinese context (e.g. 7月).
        # English numbers remain literal; unsupported pronunciations must fall
        # back explicitly instead of silently substituting Mandarin speech.
        def digit(match):
            adjacent = (
                original[max(0, match.start() - 1) : match.start()]
                + original[match.end() : match.end() + 1]
            )
            chinese_context = bool(
                re.search(r"[\u3400-\u9fff]", adjacent)
            ) or not re.search(r"[A-Za-z]", original)
            return (
                "零一二三四五六七八九"[int(match[0])] if chinese_context else match[0]
            )

        model = re.sub(r"(?<![0-9])[0-9](?![0-9])", digit, original)
        rows.append(
            dict(
                id=f"{len(rows) + 1:03d}",
                source_line=e["source_line"],
                source_text=original,
                text=model,
                normalized=norm(model),
                lrc_start=start,
                lrc_end=end,
            )
        )
    if not rows:
        raise ValueError("歌词中没有带时间的演唱内容")
    if len(rows) > 3000:
        raise ValueError("歌词超过 3000 句，请检查文件")
    return rows, excluded


def invalid(result, row, duration):
    if not result or result.get("status") != "ok" or not result.get("words"):
        return ["missing_alignment"]
    errors = validate_words(
        result["words"], max(0, result["start"]), min(duration, result["end"])
    )
    if norm("".join(w["text"] for w in result["words"])) != row["normalized"]:
        errors.append(dict(kind="text_mismatch"))
    return errors


def display_line(row, result, duration):
    errors = invalid(result, row, duration)
    if errors:
        return dict(
            id=row["id"],
            text=row["source_text"],
            start=row["lrc_start"],
            end=row["lrc_end"],
            lrcStart=row["lrc_start"],
            lrcEnd=row["lrc_end"],
            timing="line",
            engine="lrc",
            words=[],
            issues=errors,
        )
    model_chars = []
    source_indices = []
    for index, c in enumerate(row["source_text"]):
        source_indices.extend([index] * len(norm(c)))
    assert len(source_indices) == len(row["normalized"]), "Unmapped text normalization"
    cursor = 0
    words = []
    for w in result["words"]:
        token = norm(w["text"])
        end = cursor + len(token)
        assert row["normalized"][cursor:end] == token
        a, b = source_indices[cursor], source_indices[end - 1] + 1
        words.append(
            dict(
                text=row["source_text"][a:b],
                start=w["start"],
                end=w["end"],
                **{"from": a, "to": b},
            )
        )
        cursor = end
    assert cursor == len(source_indices)
    return dict(
        id=row["id"],
        text=row["source_text"],
        start=words[0]["start"],
        end=words[-1]["end"],
        lrcStart=row["lrc_start"],
        lrcEnd=row["lrc_end"],
        timing="word",
        engine=result["engine"],
        words=words,
        issues=result.get("issues", []),
    )


def conflicts(lines):
    found = []
    for i, line in enumerate(lines):
        if i and line["start"] < lines[i - 1]["start"]:
            found.append(
                dict(kind="reversed_start", ids=[lines[i - 1]["id"], line["id"]])
            )
        if i >= 2 and line["start"] < lines[i - 2]["end"]:
            found.append(
                dict(kind="same_slot_overlap", ids=[lines[i - 2]["id"], line["id"]])
            )
    return found
