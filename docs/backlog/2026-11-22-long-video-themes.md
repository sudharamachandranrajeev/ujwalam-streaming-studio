# Long video themes (user request, 2026-11-22)

User words (2026-11-22): the K.O. card words are OK, but the effects are "extremely basic". More options are needed that
match gaming themes, for example cyberpunk colours, nuclear wasteland, hellish underground, romance pink. Choose one
theme for each long-form video, and make the music, colour grading, effects and transitions, songs, cuts, animations
and every other element match that same theme.

Proposed shape (agent's proposal, not yet approved):
- A theme is data (`data/clip/themes/<id>.json`): palette (accent, glow, shadow), colour grade (LUT or eq/curves
  values), K.O. card styles and their colours, transition kinds, music tags or folder, cut pacing (mean cut length),
  caption font and outline.
- One theme picked per long video with a seeded RNG (no repeat of the last used), or chosen in Settings > Clips.
- First four themes: cyberpunk, nuclear wasteland, hellish underground, romance pink.
- Every look stays inside the overlay rules (in < 600 ms, out < 400 ms, at most 3 flashes a second).
- Routing: render path and fx graph go to Opus (CLAUDE.md model routing).
