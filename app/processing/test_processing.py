import unittest, tempfile, shutil, sys
from pathlib import Path
from common import *
from lyrics import *
import worker


class LyricsTests(unittest.TestCase):
    def test_english_digits_are_not_changed_to_mandarin(self):
        rows, _ = parse_lrc("[00:01]7 rings\n[00:02]7月 Hello\n[00:03]我有 7 个", 5)
        self.assertEqual(
            [r["text"] for r in rows], ["7 rings", "七月 Hello", "我有 七 个"]
        )
        self.assertEqual(rows[0]["source_text"], "7 rings")

    def test_raw_infinite_score_is_recorded_without_rewriting_timestamps(self):
        from align_model import serializable
        import numpy as np

        self.assertEqual(
            serializable({"scores": np.array([-float("inf"), 0.5])}),
            {"scores": ["-inf", 0.5]},
        )
        self.assertTrue(
            validate_words([{"text": "错", "start": 0, "end": float("inf")}], 0, 10)
        )

    def test_multitags_metadata_blank_offset_encoding(self):
        source = '[ar:歌手]\n[offset:100]\n{"t":0,"c":[{"tx":"制作人"}]}\n[00:01.00][00:03.00]你好\n[00:04.00]\n[00:05.00]HELLO, World!'
        rows, excluded = parse_lrc(source, 8)
        self.assertEqual([r["lrc_start"] for r in rows], [1.1, 3.1, 5.1])
        self.assertEqual(rows[1]["lrc_end"], 4.1)
        self.assertTrue(any(e["reason"] == "blank boundary" for e in excluded))
        self.assertEqual(decode_lrc("歌词".encode("gb18030")), "歌词")

    def test_bad_time_translation_and_empty_rejected(self):
        for text in [
            "[00:60]错",
            "[00:01]甲\n[00:01]乙",
            "[05:01]超出",
            "[ar:空]",
            "没有时间",
            "[offset:-2000]\n[00:01]负数",
        ]:
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    parse_lrc(text, 10)

    def test_case_spaces_and_real_group_boundaries(self):
        rows, _ = parse_lrc("[00:01]Hello,  世界！7月", 10)
        r = rows[0]
        words = [
            dict(text=t, start=a, end=b)
            for t, a, b in [("hello", 1, 2), ("世界", 2, 3), ("七", 3, 4), ("月", 4, 5)]
        ]
        line = display_line(
            r, dict(start=1, end=10, status="ok", engine="tifa", words=words), 10
        )
        self.assertEqual(
            [w["text"] for w in line["words"]], ["Hello", "世界", "7", "月"]
        )
        self.assertEqual(line["text"], "Hello,  世界！7月")

    def test_missing_and_zero_times_fallback_without_fabrication(self):
        row = parse_lrc("[00:01]你好", 4)[0][0]
        result = dict(
            start=1,
            end=4,
            status="ok",
            engine="sofa",
            words=[dict(text="你好", start=2, end=2)],
        )
        line = display_line(row, result, 4)
        self.assertEqual(line["timing"], "line")
        self.assertEqual(line["words"], [])
        self.assertEqual([line["start"], line["end"]], [1, 4])


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="ktv-prepare-"))
        self.job = self.root / "jobs/unit"
        self.job.mkdir(parents=True)
        self.req = dict(
            audio="source.audio",
            lyrics="source.lrc",
            audioName="test.flac",
            lyricsName="test.lyc",
            title="",
            artist="",
            sourceKey="unit",
        )
        save(self.job / "request.json", self.req)
        (self.job / "source.lrc").write_text("[00:00.1]你好")

    def tearDown(self):
        shutil.rmtree(self.root)

    def audio(self):
        import soundfile as sf, numpy as np

        sf.write(
            self.job / "source.audio",
            np.zeros((44100, 2)),
            44100,
            format="FLAC",
            subtype="PCM_16",
        )

    def test_real_format_full_decode_and_lyrics_validation(self):
        self.audio()
        worker.prepare(self.job)
        p = read(self.job / "work/prepared.json")
        self.assertEqual(p["frames"], 44100)
        self.assertEqual(p["format"], "flac")
        self.req["audioName"] = "wrong.mp3"
        save(self.job / "request.json", self.req)
        with self.assertRaisesRegex(ValueError, "扩展名"):
            worker.prepare(self.job)

    def test_corrupt_audio_bad_lrc_and_duration(self):
        (self.job / "source.audio").write_bytes(b"broken")
        with self.assertRaises(ValueError):
            worker.prepare(self.job)
        self.audio()
        (self.job / "source.lrc").write_text("[00:05]超长")
        with self.assertRaises(ValueError):
            worker.prepare(self.job)
        (self.job / "source.lrc").write_text("[00:00.1]你好")
        original = worker.CONFIG["maxDurationSeconds"]
        worker.CONFIG["maxDurationSeconds"] = 0.5
        try:
            with self.assertRaisesRegex(ValueError, "时长"):
                worker.prepare(self.job)
        finally:
            worker.CONFIG["maxDurationSeconds"] = original

    def test_checkpoint_detects_missing_changed_files_and_pipeline(self):
        self.audio()
        (self.job / "sample").write_bytes(b"valid")
        save(
            self.job / "checkpoints/prepare.json",
            dict(
                pipeline=worker.fingerprint(),
                inputs=worker.input_hashes(self.job),
                files={"sample": digest(self.job / "sample")},
            ),
        )
        self.assertTrue(worker.valid_checkpoint(self.job, "prepare"))
        (self.job / "sample").write_bytes(b"changed")
        self.assertFalse(worker.valid_checkpoint(self.job, "prepare"))
        (self.job / "sample").unlink()
        self.assertFalse(worker.valid_checkpoint(self.job, "prepare"))


if __name__ == "__main__":
    unittest.main()
