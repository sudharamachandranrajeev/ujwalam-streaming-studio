# NCS song credit from the file name (D417), 2026-11-21

Status: tests pass; Codex review fixed (one P2, three P3), Codex second verify clean (2026-11-21 session 2).

## What changed
- `services/clip/montage_music.py`: `parse_ncs_name`, `ncs_credit`, `credit_text(..., origin)`, scan/pick/music_record use source `ncs-filename`.
- `services/clip/clip_publish.py`: `music_provenance` keeps `ncs-filename` with its parsed fields (so uploads.json and the sidecar carry them).
- `services/posting/post-text.mjs`: `musicOf`, `renderMusic`, `musicCredit`, `creditProblem` accept `ncs-filename` (origin), template from data, link check.
- `data/clip/montage-music.json`: `ncsFilename` block (switch, marker, limits, template).
- Tests: `tests/py/test_montage_music.py` (NcsFilenameTests), `tests/montage-music.test.mjs` (ncs-filename credit).

## Codex review (codex exec, read-only, medium effort)
- P2: a name the strict parser refused (for example with a zero-width character) fell back to the loose
  "Artist - Title" parser, whose cleaner kept invisible characters, and the credit could post. Fixed: an NCS-marked name
  the strict parser refused is never credited from its name (its tags still may); the cleaner drops invisible characters.
- P3: Python counted code points, the posting check counted UTF-16 units. Fixed: the posting check counts code points.
- P3: soft hyphen and C1 controls passed; on verify, Unicode tag characters (U+E0001) passed. Fixed at the root: one
  category rule in both languages (`unsafe_text` / `CREDIT_BAD`): `< > { }`, Cc, Cf, Co, Cs, plus CGJ and the Hangul
  fillers. `credit_problems` uses it too, so a credit Python calls complete is never refused by posting for a character.
- Second verify: no findings.

## Test results (2026-11-21)
- `python -I -m unittest discover -s tests/py -t tests/py -p test_montage_music.py` (.venv-gpu): Ran 18 tests, OK.
- `node --test tests/montage-music.test.mjs tests/posting-pt1-text.test.mjs`: pass 24, fail 0.
- New tests: refused NCS name gets no loose credit; invisible characters make a credit incomplete; reject table adds soft
  hyphen, C1 control, word-joiner range, tag character, private use, Hangul filler; JS refuses the same and counts
  code points (61 astral characters inside the 120 limit).

## UNVERIFIED
- The credit wording against NCS's published usage policy (only "credit artist and song in the description" is quoted in the repo).
- Real NCS folder behaviour (the user's folder was not read; tests use synthetic names only).
- Whether NCS tracks trigger Content ID claims.
