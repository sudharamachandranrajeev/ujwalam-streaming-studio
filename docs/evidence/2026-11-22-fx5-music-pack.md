# FX5: free music pack in the clip music (2026-11-22)

Status: built and tested with a fake pack (synthetic WAV tracks, a fake manifest and marker in a temp folder). The
real pack was not downloaded by the tests. Decision: D427. Plan: `docs/plan/2026-11-21-clip-music-name-transitions.md`
3.4 (FX5).

## Built

- `services/clip/music_library.py`: `pack_manifest`, `pack_files` (manifest + plain file in `<data>/music/pack` +
  download marker entry with the same size as the file and the manifest), `refresh_pack` (its own library file
  `music/pack-library.json`, same `analyse`, same `maxNewPerRun` / `maxFiles` limits, never while live or when live
  is unknown), `usable_pack` (credit from the manifest as it is now). The folder `refresh` shares the scan code
  (`_scan`) and behaves as before.
- `data/clip/music-library.json`: `pack` block (item, manifest, folder, marker, library, licence).
- `services/clip/clipper.py`: `_look_library` adds pack tracks when `pack` is ticked; `pack_record`; the render
  record of a pack pick is `source: "pack"`, `trackId`, `credit {artist, title, licence, link}`; `_recaption_music`
  renders a pack track again or falls back to the made-here bed ("the pack track is gone").
- `data/clip/look.json`: pack source available, default sources `["folder", "pack"]`.
- `services/clip/clip_publish.py` `music_provenance`, `services/clip/countdown.py` `combined_music` (one shared pack
  track: postable with credit; anything mixed: unknown).
- `services/posting/post-text.mjs`: `musicOf`, `renderMusic`, `musicCredit` (pack branch, template and licence/link
  rules in `data/clip/montage-music.json` `pack`).
- `services/studio-ui/user-settings.mjs` `lookInfo().packReady`; `app/studio/qml/SettingsClips.qml` switch "Use the
  free music pack" (hint says to download it in Settings > Downloads when not ready).

## Tests (venv `.venv-gpu`, `UJWALAM_HEADLESS=1`, temp `UJWALAM_DATA_ROOT`)

| Command | Result |
|---|---|
| `python -I -m unittest discover -s tests/py -t tests/py -p test_music_library.py` | 19 tests OK (4 new `PackTests`) |
| `... -p test_countdown.py` | 29 tests OK (new `test_combined_free_pack`) |
| `... -p test_clip_look.py` | 15 tests OK |
| `... -p test_montage_music.py` | 18 tests OK |
| `node --test tests/montage-music.test.mjs tests/user-settings-clip-look.test.mjs tests/downloads.test.mjs` | 47 tests, 46 pass, 0 fail, 1 skipped (existing skip) |

New cases: only manifest files with a marker entry count (a file not in the marker and a file not in the manifest
are left out); a size change drops the track; no marker = no tracks; never analysed live or when live is unknown;
the folder library is untouched; the pack pick writes the pack record with its credit; recaption renders it again
and falls back when the marker is gone; provenance, `musicOf`, `renderMusic`, `musicCredit` (credit present: posted
with the credit text, stamp and description check; missing, empty, bidi, markup, wrong licence, non-https or
non-FMA link, over-long: refused; unknown source: held); countdown combine cases; the manifest's dest and marker
match the music library config; `packReady` follows the marker.

## Codex review fixes (second commit)

SHA-256 check with a cache; the pack folder must be the real folder (junction test with `mklink /J`); posting binds
the credit to the manifest row of `trackId` (real id, wrong pairing, missing and made-up ids tested); recaption
rebuilds the pack record from the rendered track; the no-music branch records no music; the one-time settings move
(Node and Python tests). Test counts are in the commit report.

## Licence evidence

From the manifest `$comment`: every track CC0 1.0 per the FMA metadata (Hugging Face dataset
`seungheondoh/cmd-fma-metadata`); three FMA track pages read on 2026-11-22 say "licensed under a CC0 1.0 Universal
License"; files from `SoundSafari/Public-Domain-Music` (card cc0-1.0) at a pinned revision with SHA-256 per file.
One track marked explicit on FMA was left out.

## UNVERIFIED

- The other 34 FMA pages, by hand.
- A real clip render and post with a downloaded pack track.
- The credit wording ("Music: {artist} - {title} (CC0, Free Music Archive)" + link) against FMA's own guidance; CC0
  needs no credit.
- The Settings switch in the running studio (QML not run here).
