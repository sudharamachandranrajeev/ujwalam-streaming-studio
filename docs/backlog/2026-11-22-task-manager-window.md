# Task manager window (user request, 2026-11-22)

User words (2026-11-22): the current task view (pending and ongoing tasks) needs an update. Ujwalam's task manager
should be able to pop out into its own window.

1. Click a task to see detailed stats about it: every part that is running, when wanted. Pause a task and resume it at
   any moment. Schedule a task for the next time Ujwalam starts, or ask or notify the user about pending tasks, for
   flexible task management.
2. Organise tasks in categories, with sorting and filtering.

Proposed shape (agent's proposal, not yet approved):
- A separate native window (Qt) for the task manager, opened from the existing task view; it also docks back.
- Task detail: stage, progress, current step, elapsed and estimated time, CPU/GPU use, files read and written, log
  tail, the heavy-job lock it holds.
- Pause and resume: each job kind needs a safe checkpoint (clip jobs between pieces, renders between batches); a job
  with no safe point says so instead of offering pause.
- On next start: "run now", "ask me", or "just notify" per task, stored with the task.
- Categories: clips, reels and montages, long video, posting, learning, downloads, maintenance; sort by state, start
  time, category, size; filter by state and category.
- Paused or scheduled work never runs while live (the live check holds it).
- Routing: job runner and pause points go to Opus; the window UI to Sonnet (CLAUDE.md model routing).
