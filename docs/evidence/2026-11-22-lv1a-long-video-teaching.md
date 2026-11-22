# LV1a: word-by-word captions and chapter cards on the long highlights video (2026-11-22)

Status: built and tested on synthetic data; Codex review (four rounds, the last CLEAN). Not yet seen on a real long
video. Decision: D421. Flag: `long-video-teaching` (on by default, user-requested).

## Built

- `services/clip/clip_captions.py`: word times from the speech to text. whisper.cpp full JSON tokens (a token that
  starts with a space starts a word; `[_...]` tokens skipped; ms offsets to seconds); faster-whisper
  `word_timestamps` when asked.
- `services/clip/reel_captions.py`: words carried through `mark` (clipped to the segment) and `retime` (each word
  moved like its segment, kept inside it); `word_cards`; `_highlight_events` (one event per word, the full card with
  the current word in the accent); `to_ass(highlight=)` (a segment whose text was edited falls back to plain cards);
  `write_ass(extra=)` (chapter styles and events added to the same script).
- `services/clip/long_teaching.py` (new): chapter labels in plain words, chapter events (slide in 350 ms, fade out
  250 ms, shown only where the moment is alone on screen), one ASS per render batch, the per-run context (flag,
  speech model, accent from `reel-title.json`), the info summary for `long.json` and `render.json`.
- `services/clip/long_video.py`: `render(overlay=, overlay_failed=)`; a batch whose overlay fails to burn is
  rendered again without it.
- `services/clip/clipper.py` `_long_video_steps`: wires the overlay; captions and chapter counts in `render.json`,
  the report and `long.json` (`teaching`).
- `data/clip/long-video.json` `teaching` block; `data/flags.json` flag `long-video-teaching`.

## Codex review (2026-11-22)

1. The transcript was cut at the output length, though it is on the pieces-back-to-back timeline: speech in the
   last cross-fade seconds of each batch was lost. It now gets the input length.
2. A chapter card started on the incoming cross fade (over the moment before). It now starts after it.
3. Only three exception types were caught around the speech to text; any exception now leaves the cards. A burn
   failure (libass, font) renders that batch again without the overlay. Writing the captions is guarded too: the
   cards alone, or no overlay for that batch; the video is always made.
4. A word starting exactly on a join was put in the piece before it (a cross fade late). A start on a join now
   belongs to the next piece. This also fixes reel captions (D411).
5. After 4, a caption starting on a join overlapped the one before it during the cross fade; `retime` now ends each
   shown caption at the next shown one, and a card ends at the next card's first word. Hidden rows cut nothing.

## Tests

`tests/py/test_long_teaching.py` (new, 22 tests): token words, no-token rows, `mark` word clipping, `retime` word
moves, a word on a join, no overlap after a join (hidden rows ignored), `word_cards`, one highlight event per word
with the accent, edited text falls back to plain cards, cards inside a segment never overlap, chapter labels, the
timing rule check, chapter numbering and timing with cross fades, chapters without captions, any caption error
leaves the cards, a caption that cannot be written leaves the cards, the transcript gets the input length, flag off
means no overlay, `merge_info`, each batch gets its overlay, a batch whose overlay fails is made without it, and a
real libass burn of a chapter card plus a highlighted caption (ffmpeg, 320x180 test picture, 2 s).

Run 2026-11-22 (`.venv-gpu`, `UJWALAM_HEADLESS=1`): test_long_teaching 22 OK; test_long_video 23 OK;
test_reel_captions 14 OK (2 skipped: need a speech model); test_caption_seam 2 OK (1 skipped);
test_clip_pipeline 37 OK.

## UNVERIFIED

- Word timing on real stream speech (whisper.cpp token times are approximate) and the look on a real long video.
- Run time: each render batch is transcribed on its own (about one speech model load per 12 moments).
- Callout cards and movement paths (the rest of LV1) are not built.
