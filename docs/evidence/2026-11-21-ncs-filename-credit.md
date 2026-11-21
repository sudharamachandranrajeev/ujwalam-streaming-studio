# NCS song credit from the file name (D417), 2026-11-21

Status: code and tests written; tests NOT yet run (a full CI was running on the main checkout; the run follows "tests cleared").

## What changed
- `services/clip/montage_music.py`: `parse_ncs_name`, `ncs_credit`, `credit_text(..., origin)`, scan/pick/music_record use source `ncs-filename`.
- `services/clip/clip_publish.py`: `music_provenance` keeps `ncs-filename` with its parsed fields (so uploads.json and the sidecar carry them).
- `services/posting/post-text.mjs`: `musicOf`, `renderMusic`, `musicCredit`, `creditProblem` accept `ncs-filename` (origin), template from data, link check.
- `data/clip/montage-music.json`: `ncsFilename` block (switch, marker, limits, template).
- Tests: `tests/py/test_montage_music.py` (NcsFilenameTests), `tests/montage-music.test.mjs` (ncs-filename credit).

## Test results
UNVERIFIED until run: see the results section appended after "tests cleared".

## UNVERIFIED
- The credit wording against NCS's published usage policy (only "credit artist and song in the description" is quoted in the repo).
- Real NCS folder behaviour (the user's folder was not read; tests use synthetic names only).
- Whether NCS tracks trigger Content ID claims.
