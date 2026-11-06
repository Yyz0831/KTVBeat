"""Read-only audit of the self-contained application and committed library."""

from pathlib import Path
import sys, json, subprocess, time

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / "processing"))
from common import digest, read, save
import soundfile as sf


def main():
    issues = []
    model = read(APP / "models/manifest.json")
    for name, expected in model["files"].items():
        p = APP / name
        if not p.is_file() or digest(p) != expected:
            issues.append("model checksum: " + name)
    links = []
    for p in APP.rglob("*"):
        if p.is_symlink():
            target = p.resolve()
            links.append(dict(path=str(p.relative_to(APP)), target=str(target)))
            if "/tools/" in str(target) or "/evaluation/" in str(target):
                issues.append("external experiment link: " + str(p))
    # Do not treat provenance strings in imported lyric JSON as runtime paths.
    for root in ["processing", "player"]:
        for p in (APP / root).rglob("*"):
            if (
                p.suffix not in [".py", ".js", ".mjs"]
                or "node_modules" in p.parts
                or "__pycache__" in p.parts
            ):
                continue
            if "/tools/" in p.read_text() or "/evaluation/" in p.read_text():
                issues.append("runtime reference: " + str(p))
    songs = []
    for p in (APP / "data/library").glob("*/song.json"):
        song = read(p)
        folder = p.parent
        expected = {
            "song.json",
            "processing.json",
            "original.lrc",
            "lyrics.json",
            "instrumental.flac",
            "lead.flac",
            "backing.flac",
        }
        if set(f.name for f in folder.iterdir()) != expected:
            issues.append("song file whitelist: " + song["id"])
        for name, sha in song["checksums"].items():
            if digest(folder / name) != sha:
                issues.append("song checksum: " + song["id"] + "/" + name)
        infos = [
            sf.info(folder / (r + ".flac")) for r in ["instrumental", "lead", "backing"]
        ]
        if any(
            i.frames != song["frames"]
            or i.samplerate != 44100
            or i.channels != 2
            or i.subtype != "PCM_16"
            for i in infos
        ):
            issues.append("song format: " + song["id"])
        songs.append(
            dict(
                id=song["id"],
                frames=song["frames"],
                audioBytes=sum(
                    (folder / (r + ".flac")).stat().st_size
                    for r in ["instrumental", "lead", "backing"]
                ),
            )
        )
    records = dict(
        time=time.time(),
        issues=issues,
        songs=songs,
        python_links=links,
        modelBytes=sum(
            (APP / name).stat().st_size
            for name in model["files"]
            if (APP / name).is_file()
        ),
    )
    save(APP / "records/isolation-audit.json", records)
    print(
        json.dumps(
            dict(
                issues=issues, songs=len(songs), modelGiB=records["modelBytes"] / 2**30
            ),
            ensure_ascii=False,
        )
    )
    if issues:
        sys.exit(1)


if __name__ == "__main__":
    main()
