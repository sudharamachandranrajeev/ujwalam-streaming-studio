# SPDX-License-Identifier: GPL-3.0-or-later
"""D443 T2: the words on screen in some picture files (the repo's own RapidOCR engine, g1_scan.ocr).

    python ocr_words.py <image> [<image> ...]   ->  one JSON line: {"words": ["word", ...]}

The AI post text checker rejects a name that is on screen (another player's name) unless it is in the allowed vocabulary
(data/posting/ai-text-vocab.json). Needs the OCR venv (numpy, opencv-python-headless, rapidocr, onnxruntime). CPU, 2 threads.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main(paths):
    import cv2
    import g1_scan
    g1_scan.set_ocr_params(g1_scan.thread_params(2))
    words = set()
    for p in paths:
        img = cv2.imread(p)
        if img is None:
            continue
        boxes, _ms = g1_scan.ocr(img)
        for b in boxes:
            for w in re.split(r"[^0-9A-Za-z]+", str(b.get("text", ""))):
                if len(w) >= 3:
                    words.add(w.lower())
    sys.stdout.write(json.dumps({"words": sorted(words)}) + "\n")


if __name__ == "__main__":
    main(sys.argv[1:])
