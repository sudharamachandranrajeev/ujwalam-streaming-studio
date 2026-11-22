# NVENC hard kill and NVIDIA driver resets (2026-11-21)

Status: cause of the CI-time resets found (correlation); real-stream impact UNVERIFIED.

## What happened

`npm run ci` refused a pass stamp twice on 2026-11-21 ("GPU driver reset logged ... nvlddmkm"). The System log has
nvlddmkm event 153 (TDR, driver recovered) at 21:17:15 and 21:53:50, and earlier on 11-19, 11-20 and 11-21 18:43:29.
The user installed the NVIDIA Studio driver 32.0.16.2124 at about 21:24; the 21:53:50 reset happened on it.

## Correlation

Host test logs under `out/host/tests/` keep their start and end times. For every reset, the host tests that were
running within 15 s:

| reset | running host tests |
|---|---|
| 11-21 21:53:50 | `live-keys-crash` 21:53:44-21:53:45, `live-keys` 21:53:35-21:53:52, `instagram` |
| 11-21 21:17:15 | `live-keys-crash` 21:17:09-21:17:10, `live-keys` 21:17:00-21:17:17, `instagram` |
| 11-19 18:53:31 | `live-keys-crash` 18:53:24-18:53:26, `live-keys` 18:53:15-18:53:32, `instagram` |

`live-keys-crash` (app/host/tests/host-live-keys.test.mjs, "crash safety") records with an NVENC rung and then
TerminateProcess-kills the host mid-encode. The reset follows 5-6 s later every time it occurs (not on every run:
earlier CI runs the same day passed with no reset).

The 11-21 18:43:29 reset was not CI: it came 1 s after `taskkill /F` of an ffmpeg capture recording that was encoding
with h264_nvenc. Same trigger: a process killed mid-NVENC-encode. Resets at 11-19 15:50, 18:57 and 11-20 23:11 have
no host test or recording nearby (unexplained).

## Change

The crash-safety test now records with x264 (`encoder: 'x264'` on its rung). What it checks (the .mkv still probes
after a hard kill) is the muxer's behaviour, not the encoder's, and a driver reset can disturb a studio or stream
running on the same GPU. NVENC start/stop paths stay covered by the other host tests, which stop the host cleanly.

## Open (not done)

- A real host crash during a stream would end the NVENC session the same way; the driver reset that may follow
  could disturb other GPU users (game capture, Meld, browser). UNVERIFIED on a real stream.
- Stopping a capture recording: send `q` to ffmpeg (graceful) instead of `taskkill /F`.
