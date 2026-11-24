# SPDX-License-Identifier: GPL-3.0-or-later
"""D442: a clip job paused or stopped part-way keeps the clips it finished (clipper done-row.json per clip)."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "services", "clip"))
import clipper  # noqa: E402


class ClipRowResume(unittest.TestCase):
    def _save(self, wd, key, row):
        with open(os.path.join(wd, clipper.DONE_ROW), "w", encoding="utf-8") as f:
            json.dump({"key": key, "row": row}, f)

    def test_kept_only_with_the_same_inputs_and_every_file_there(self):
        c = {"id": "c01", "start": 10, "end": 30}
        key = clipper._row_key(c, ["v-full"], "h264_nvenc", {"w": 1080}, "3", "none")
        self.assertEqual(key, clipper._row_key(c, ["v-full"], "h264_nvenc", {"w": 1080}, "3", "none"))
        self.assertNotEqual(key, clipper._row_key(dict(c, end=31), ["v-full"], "h264_nvenc", {"w": 1080}, "3", "none"))
        row = {"id": "c01", "files": [{"layout": "v-full", "file": "v.mp4"}], "errors": []}
        with tempfile.TemporaryDirectory() as wd:
            self.assertIsNone(clipper._done_row(wd, key), "no record: make it")
            self._save(wd, key, row)
            self.assertIsNone(clipper._done_row(wd, key), "the video is missing")
            open(os.path.join(wd, "v.mp4"), "wb").close()
            self.assertIsNone(clipper._done_row(wd, key), "an empty video")
            with open(os.path.join(wd, "v.mp4"), "wb") as f:
                f.write(b"x")
            self.assertEqual(clipper._done_row(wd, key), dict(row, resumed=True))
            self.assertIsNone(clipper._done_row(wd, "other"), "other inputs")
            self._save(wd, key, dict(row, errors=[{"layout": "h"}]))
            self.assertIsNone(clipper._done_row(wd, key), "a clip with errors is made again")


if __name__ == "__main__":
    unittest.main()
