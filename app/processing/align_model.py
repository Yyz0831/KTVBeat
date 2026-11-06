"""Isolated CPU inference adapter. Derived from the verified comparison adapter."""

from common import *
import sys, time, traceback, resource
from types import SimpleNamespace

OUT = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None


def serializable(obj):
    # Raw model scores may legitimately contain -inf for impossible paths.
    # Preserve that fact as text in diagnostic JSON; timestamps are validated
    # separately and are never rounded, shifted, or fabricated here.
    if isinstance(obj, float) and not math.isfinite(obj):
        return str(obj)
    if isinstance(obj, Path):
        return str(obj)
    if isinstance(obj, dict):
        return {str(k): serializable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [serializable(v) for v in obj]
    if hasattr(obj, "tolist"):
        return serializable(obj.tolist())
    return obj


class Tifa:
    def __init__(self, rows):
        import torch, onnxruntime as ort

        # Bound the optional English G2P ONNX sessions as well as PyTorch.
        original = ort.InferenceSession

        def bounded_session(*args, **kwargs):
            options = kwargs.get("sess_options") or ort.SessionOptions()
            options.intra_op_num_threads = 4
            options.inter_op_num_threads = 1
            kwargs["sess_options"] = options
            return original(*args, **kwargs)

        ort.InferenceSession = bounded_session
        sys.path.insert(0, str(APP / "vendor/TIFA"))
        from inference.api import load_inference_model, load_g2p_config
        from inference.module import ForcedAlignmentInferenceModule
        from inference.data import AudioTextDataset
        from inference.callbacks import SaveTextGridCallback
        from lib.config.schema import ConfigurationScope

        self.torch = torch
        modeldir = APP / "models/tifa"
        for name, sha in read(APP / "models/manifest.json")["files"].items():
            if name.startswith("models/tifa/") and digest(APP / name) != sha:
                raise ValueError("TIFA 模型或词典校验失败：" + name)
        backend, vocab, config = load_inference_model(
            modeldir / "model.pt", scope=ConfigurationScope.FA
        )
        self.model = (
            ForcedAlignmentInferenceModule(
                backend, score_unit="levenshtein", skip_penalty=0.5
            )
            .cpu()
            .eval()
        )
        self.timestep = backend.timestep
        g2p_config = OUT / "inputs/tifa-g2p.yaml"
        if not g2p_config.exists():
            g2p_config = modeldir / "g2p-zh-en.yaml"
        self.dataset = AudioTextDataset(
            {r["id"]: OUT / "inputs/clips" / (r["id"] + ".wav") for r in rows},
            load_g2p_config(g2p_config),
            modeldir,
            vocab,
            config.features.audio_sample_rate,
            language=["zh", "en"],
            oov_handling="raise",
        )
        self.callback_cls = SaveTextGridCallback
        self.settings = dict(
            model="TIFA-1.0",
            timestep=self.timestep,
            languages=["zh", "en"],
            score_unit="levenshtein",
            skip_penalty=0.5,
            ved=False,
            g2p_config=str(g2p_config),
            g2p_config_sha256=digest(g2p_config),
            normalized_output="Raw semantic word spans; zero-width phones retained and flagged, no 1ms fabrication",
        )

    def align(self, row, index, dest):
        item = self.dataset[index]
        if item.get("skip"):
            raise ValueError(item)
        batch = self.dataset.collate([item])
        # No trainer is needed: all inference uses the official predict_step.
        warnings = batch.pop("warning", [])
        with self.torch.inference_mode():
            output = self.model.predict_step(batch, index)
        if len(output) != 1:
            raise ValueError("No TIFA prediction")
        raw = output[0]
        compact = {
            k: v for k, v in raw.items() if k not in ("spectrogram", "similarity")
        }
        compact.update(
            timestep=self.timestep, duration=item["duration"], warnings=warnings
        )
        save(dest / "raw" / (row["id"] + ".json"), serializable(compact))
        spans = raw["spans"].tolist()
        owners = raw["words"].tolist()
        words, issues = [], []
        for word_id, text in enumerate(raw["texts"], 1):
            indices = [i for i, owner in enumerate(owners) if owner == word_id]
            if not indices:
                issues.append(dict(kind="missing_word", text=text, word_id=word_id))
                continue
            words.append(
                dict(
                    text=text,
                    start=row["start"] + spans[indices[0]][0] * self.timestep,
                    end=row["start"] + spans[indices[-1]][1] * self.timestep,
                )
            )
        for i, (a, b) in enumerate(spans):
            if b <= a:
                issues.append(
                    dict(
                        kind="skipped_phone",
                        index=i,
                        phone=raw["phonemes"][i],
                        frames=[a, b],
                    )
                )
        if warnings:
            issues.append(dict(kind="upstream_warning", messages=warnings))
        # Native export has its own documented omission/rounding policy; scoring uses raw JSON above.
        trainer = SimpleNamespace(progress_bar_callback=SimpleNamespace(print=print))
        try:
            self.callback_cls(
                dest / "raw",
                language="zh",
                timestep=self.timestep,
                skip_handling="omit",
                fill="SP",
            ).on_predict_batch_end(trainer, self.model, output, batch)
        except Exception as e:
            issues.append(dict(kind="native_export_error", message=str(e)))
        return words, issues


class UnsupportedLine(Exception):
    pass


class Sofa:
    def __init__(self, rows):
        import torch

        self.torch = torch
        sys.path.insert(0, str(APP / "vendor/SOFA"))
        from modules.task.forced_alignment import LitForcedAlignmentTask
        from modules.g2p.dictionary_g2p import DictionaryG2P
        from modules.AP_detector import LoudnessSpectralcentroidAPDetector
        from modules.utils.post_processing import post_processing
        from modules.utils.export_tool import Exporter

        checkpoint = APP / "models/sofa/model.ckpt"
        if (
            digest(checkpoint)
            != read(APP / "models/manifest.json")["files"]["models/sofa/model.ckpt"]
        ):
            raise ValueError("SOFA 模型校验失败")
        self.model = (
            LitForcedAlignmentTask.load_from_checkpoint(
                str(checkpoint), map_location="cpu"
            )
            .cpu()
            .eval()
        )
        self.model.set_inference_mode("force")
        self.model.on_predict_start()
        self.g2p = DictionaryG2P(
            dictionary=str(APP / "vendor/SOFA/dictionary/opencpop-extension.txt")
        )
        self.detector = LoudnessSpectralcentroidAPDetector()
        self.post_processing = post_processing
        self.exporter = Exporter
        self.settings = dict(
            model=str(checkpoint),
            inference_mode="force",
            post_processing="Official AP detector and post_processing, same as prior SOFA experiment",
            english_support=False,
        )

    def align(self, row, index, dest):
        import copy

        if row["sofa_unsupported"]:
            raise UnsupportedLine(
                "Mandarin SOFA cannot represent this full mixed/English line; no English tokens silently removed."
            )
        clip = OUT / "inputs/clips" / (row["id"] + ".wav")
        phones, syllables, mapping = self.g2p(clip.with_suffix(".lab").read_text())
        assert len(syllables) == len(row["g2p"]), "G2P dropped a syllable"
        with self.torch.inference_mode():
            raw = self.model.predict_step((clip, phones, syllables, mapping), index)
        save(dest / "raw" / (row["id"] + "-model.json"), serializable(raw))
        processed, errors = self.post_processing(
            self.detector.process([copy.deepcopy(raw)])
        )
        save(
            dest / "raw" / (row["id"] + "-processed.json"),
            serializable(dict(predictions=processed, errors=errors)),
        )
        if errors or not processed:
            raise ValueError(f"SOFA post-processing errors: {errors}")
        pred = processed[0]
        pairs = [
            (str(s), interval)
            for s, interval in zip(pred[5], pred[6])
            if str(s) not in ["SP", "AP"]
        ]
        assert [s for s, _ in pairs] == syllables
        words = [
            dict(
                text=g["text"],
                pinyin=g["pinyin"],
                start=row["start"] + float(interval[0]),
                end=row["start"] + float(interval[1]),
            )
            for g, (_, interval) in zip(row["g2p"], pairs)
        ]
        issues = []
        export = copy.deepcopy(processed)
        export[0][0] = dest / "raw" / (row["id"] + ".wav")
        try:
            self.exporter(export, errors).export(["textgrid", "htk", "confidence"])
        except Exception as e:
            issues.append(dict(kind="native_export_error", message=str(e)))
        return words, issues


def main():
    import torch

    torch.set_num_threads(CONFIG["cpuThreads"])
    torch.set_num_interop_threads(1)
    torch.set_grad_enabled(False)
    torch.manual_seed(0)
    engine = sys.argv[1]
    rows = read(OUT / "manifest.json")["rows"]
    dest = OUT / engine
    (dest / "raw").mkdir(parents=True, exist_ok=True)
    began = time.perf_counter()
    adapter = {"sofa": Sofa, "tifa": Tifa}[engine](rows)
    load = time.perf_counter() - began
    outputs = []
    for i, row in enumerate(rows):
        tick = time.perf_counter()
        result = {k: row[k] for k in ["id", "text", "start", "end"]}
        result.update(words=[], issues=[], status="ok", engine=engine)
        try:
            result["words"], result["issues"] = adapter.align(row, i, dest)
        except Exception as e:
            result.update(
                status="failed", error=str(e), traceback=traceback.format_exc()
            )
        result["seconds"] = time.perf_counter() - tick
        outputs.append(result)
        save(
            dest / "result.json",
            serializable(
                dict(
                    rows=outputs,
                    load_seconds=load,
                    seconds=time.perf_counter() - began,
                    peak_rss_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                )
            ),
        )
        event(kind="alignment", engine=engine, completed=i + 1, total=len(rows))


if __name__ == "__main__":
    main()
