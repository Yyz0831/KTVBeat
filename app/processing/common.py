from pathlib import Path
import hashlib, json, os, unicodedata, math, re

APP = Path(__file__).resolve().parents[1]
CONFIG = json.loads((APP / "config.json").read_text())
ROLES = ["instrumental", "lead", "backing"]


def read(path):
    return json.loads(Path(path).read_text())


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    )
    os.replace(tmp, path)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def norm(text):
    return "".join(
        c
        for c in unicodedata.normalize("NFKC", text).lower()
        if unicodedata.category(c)[0] in "LN"
    )


def units(text):
    return re.findall(r"[\u3400-\u9fff]|[A-Za-z]+(?:[\x27’][A-Za-z]+)?|[0-9]+", text)


def event(**fields):
    print(json.dumps(fields, ensure_ascii=False), flush=True)


def bounded_env():
    env = dict(
        os.environ,
        PYTHONUNBUFFERED="1",
        PYTHON_DOTENV_DISABLED="1",
        MPLBACKEND="Agg",
        TOKENIZERS_PARALLELISM="false",
        PATH=str(APP / "bin") + os.pathsep + os.environ.get("PATH", ""),
        HF_HUB_OFFLINE="1",
        TRANSFORMERS_OFFLINE="1",
        NUMBA_CACHE_DIR=str(APP / "runtime/cache/numba"),
    )
    for key in [
        "OMP_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "MKL_NUM_THREADS",
        "VECLIB_MAXIMUM_THREADS",
        "NUMEXPR_NUM_THREADS",
        "NUMBA_NUM_THREADS",
    ]:
        env[key] = str(CONFIG["cpuThreads"])
    env.pop("PYTHONPATH", None)
    for key in ["AUDIO_SEPARATOR_API_URL", "AUDIOSHAKE_API_TOKEN", "RUNPOD_API_KEY"]:
        env.pop(key, None)
    return env


def validate_words(words, start, end):
    issues = []
    previous = None
    for i, w in enumerate(words):
        a, b = w.get("start"), w.get("end")
        if (
            not isinstance(a, (int, float))
            or not isinstance(b, (int, float))
            or not math.isfinite(a + b)
        ):
            issues.append(dict(kind="invalid_time", index=i))
            continue
        if a < start - 0.002 or b > end + 0.002:
            issues.append(dict(kind="outside_window", index=i))
        if b <= a:
            issues.append(dict(kind="nonpositive_duration", index=i))
        if previous and a < previous["end"] - 0.002:
            issues.append(dict(kind="word_overlap", index=i))
        previous = w
    return issues
