# SPDX-License-Identifier: GPL-3.0-or-later
"""D443 T2: the words on screen in some picture files (the repo's own RapidOCR engine, g1_scan.ocr).

    python ocr_words.py <image> [<image> ...]   ->  one JSON line: {"words": ["word", ...]}

The AI post text checker rejects a name that is on screen (another player's name) unless it is in the allowed vocabulary
(data/posting/ai-text-vocab.json). Needs the OCR venv (numpy, opencv-python-headless, rapidocr, onnxruntime). CPU, 2 threads.
"""
import json
import os
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def word_parts(token):
    """Runs of letters, marks and digits in any script (Malayalam vowel signs are marks); anything else splits."""
    parts, cur = [], []
    for ch in token:
        if unicodedata.category(ch)[0] in "LMN":
            cur.append(ch)
        elif cur:
            parts.append("".join(cur))
            cur = []
    if cur:
        parts.append("".join(cur))
    return parts


def main(paths):
    import cv2
    import g1_scan
    g1_scan.set_ocr_params(g1_scan.thread_params(2))
    words = set()
    read = 0
    for p in paths:
        img = cv2.imread(p)
        if img is None:
            continue
        read += 1
        boxes, _ms = g1_scan.ocr(img)
        for b in boxes:
            # every script's letters (a name may not be Latin); "_" and other marks split words
            for token in str(b.get("text", "")).split():
                parts = word_parts(token)
                for w in parts:
                    if len(w) >= 3:
                        words.add(w.lower())
                # the joined form too: "Shadow_King" is also "shadowking", so a name made of common words is still seen
                joined = "".join(parts)
                if len(parts) > 1 and len(joined) >= 3:
                    words.add(joined.lower())
    if read == 0:
        sys.stderr.write("no picture could be read\n")
        return 3  # the checker fails closed on a non-zero exit
    sys.stdout.write(json.dumps({"words": sorted(words)}) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
