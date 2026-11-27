# Instagram queue stuck on one container (2026-11-27)

Status: unit-tested with fakes; real run PENDING (needs the installed studio and the user's go).

## Problem (installed queue, 2026-11-27)
1 done, 71 waiting, nothing posted since 26 Nov 06:58. Clip 2's container reported IN_PROGRESS for about 24 h.
- `processing-timeout` / `container-unknown` retried for ever (no count, no ceiling), the container never replaced.
- Due jobs were sorted by `dueAt` only, so the stuck oldest job won every pass once its short `nextAt` passed.

## Fix
- `services/posting/instagram-queue.mjs`: new job field `containerSince` (set when `onContainer` gives a new id; cleared on done or drop).
  `processing-timeout` / `container-unknown` on a job with a container: under `stuckContainerMs` keep the id and retry in `pollEveryMs * 12`;
  past it drop the id, count an attempt, back off (`retryMinutes * 2^(n-1)`), reason `container-stuck`; at `maxAttempts` the job fails.
  Old queue files lack `containerSince`: the clock starts at the first such failure (no migration).
- Fairness: due jobs already deferred (`nextAt` set) sort behind jobs not tried yet; untried by `dueAt`, deferred by `nextAt`.
  Gap and live guard unchanged.
- `data/posting/instagram.json`: `stuckContainerMs` 7200000 (2 h); optional in `loadIgConfig` (range 60000 to 86400000).
- Reason text `container-stuck`: "Instagram never finished the upload; uploading it again".

## Evidence
`node --test tests/posting-instagram.test.mjs`: 34 pass, 0 fail (3 new tests: past-ceiling drop and attempt, old shape and max attempts, no head-of-line blocking).

## Real run pending
Install, watch the stuck clip: expect its container dropped within 2 h of the first stuck failure and the other waiting clips posting one per gap.
