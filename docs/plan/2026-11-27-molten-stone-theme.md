# Molten Stone theme (2026-11-27, approved by the user)

User (2026-11-27): "add a new theme - [reference image]. be truthful to the reference. find a use for every element in
the image somewhere in the app when theme is applied. should be precise and should not create artifacts or
intersections. theme itself looks good due to its unpredictable UI design style. implement effectively without glitches,
freezes, crashes and errors."

User decisions (2026-11-27):
- Stone, cracks, molten metal and glow are **painted textures** (small PNGs, 9-slice `BorderImage`), not live shaders.
- Smoke and drips **animate only off air**; on air / High performance / plain mode they are still images.
- New controls are **mapped to real places in the app for every theme**, styled best in this one.

The reference image is not in the repo (it may not be committed: it is the user's image). This file is the
description of it; build from this text.

## Reference description (theme id `molten-stone`, name "Molten Stone")

Overall: dark warm-grey graphite background with a soft vignette (lighter centre-top #8a8a8c, edges #3a3a3e). All
surfaces are carved stone: matte mid-grey (#6e6e72 to #8c8c90), subtle grain, slightly irregular organic rounded
edges (blobby, not geometric), soft top highlight and dark bottom shadow. The accent is **molten rose gold / copper**:
glowing edge rims (#e8a27c core, #f4c2a0 highlight, #c06a4a deep), warm outer glow (orange-pink, soft, ~8-14 px). Text
on stone: near-white #f2efec for labels on dark plates, #2a2a2c dark text on light stone headings; section titles in
caps, dark charcoal (#2b2b2e), bold. Font: clean sans (Inter/Barlow-like; use a bundled OFL font only). Danger = warm
red #e0584a glow. Success = soft green #8fd18a text. Warning = amber #f0c060.

Foundations:
- Surface tokens: Base layer (flat stone square, rounded), Raised layer (stone with rose-gold glowing rim), Inset layer
  (stone with a sunken, darker recessed centre), Pressed layer (stone broken in the middle: jagged crack hole with
  glowing molten edge). Spacing scale 6 px.
- Elevation levels 1-4: stacked stone slabs; level 1 flat; 2 low shadow; 3 mid shadow; 4 high shadow; "surreal shadow
  recipes": shadow drips downward like smoke/liquid under level 4.
- Border thickness: thin 1 px, regular 2 px, medium 3 px, thick 4 px, drawn as twisted rose-gold metal wire/rope.
- Radius scale: small 4, medium 8, large 12, full: organic blob shapes in glossy grey.
- Iconography: outline icons in rose gold, stroke 1.5 px, sizes 14/18/22 px (home, search, user); glow on accent icons.

Controls:
- Button primary normal: pill stone button, dark-grey fill, rose-gold glowing rim, white caps label "SUBMIT".
- Button primary pressed/loading: button cracked open, dark recess with jagged glowing edges, label "LOADING..." with a
  small rose-gold ring spinner at right.
- Button primary disabled: flat pale stone pill, no rim, engraved grey caps text "UNAVAILABLE".
- Checkbox: small dark empty square above; checked = stone square with a sunken well and a big rose-gold check mark.
- Radio: dark stone pill holding two round knobs; selected knob rose-gold ring with check.
- Switch: dark recessed stone track; OFF/ON labels under it; ON state has yellow-orange smoke rising from the knob.
- Text field: label "Email Address" on a dark plate with rose-gold rim, inner recessed dark input "enter your email...",
  helper text under ("We'll never share your email."). Error state: plate with torn/jagged edges, red alert icon +
  "Invalid email format" header, red rim on the input, red helper text. Focused: round stone ring with glowing
  rose-gold inner ring (focus ring).
- Slider: a cracked stone track with a molten glowing fill (left part), a glossy rose-gold ball handle, value bubble
  "75%" above, tick marks under, label "VOLUME"; spacing marks 20/26 px.

Navigation:
- Tabs: stone pill segments in one bar; active tab glowing rose-gold fill with white caps; inactive grey stone with
  dark caps ("DASHBOARD", "PROJECTS", "SETTINGS"); padding 10/14 px.
- Breadcrumbs: small stone beads on a thin line, first bead glowing rose gold; labels "Home > Users > Settings >
  Profile".
- Pagination: blobby stone pebbles "PREV 1 2 3 NEXT", current page glowing rose gold.
- 5-step process: five glossy grey spheres joined by cracked stone links; current step larger and glowing rose gold,
  with a tooltip bubble "Confirm details below" and smoke wisp above; caption "STEP 3: VERIFICATION" in rose gold.

Data display:
- Card: stone card "PROJECT ALPHA" with a rose-gold line chart drawn into it and "Status: Active"; stacked stone
  layers behind it (a second card edge peeking).
- List items: dark stone rows "Task A / Due: Tomorrow" with a glowing rose-gold "NEW" pill badge at right.
- Avatars: round stone discs with a swirled rose-gold spiral in relief (no faces).
- Tooltip: small dark pill "This is a helpful tip" with a molten drop pointer below.
- Compact table header: dark stone header row "NAME (sort arrows) DATE STATUS", sort icon at right; rows are blurred
  skeleton bars with small rose-gold gear/slider icons at the right; row height 28, header 36 px.
- Spacing scale annotations 6/10 px.

Feedback:
- Modal confirmation: cracked stone slab with smoke around it, title "DELETE ACCOUNT?" in rose-gold caps,
  "CANCEL" plain text button and "DELETE" dark pill with rose-gold rim.
- Toast stack: three overlapping dark stone plates: "Success: Item saved." (green word), "Warning: Connection
  unstable." (amber plate rim), "Error: Failed to load." (red word); each plate with its own coloured rim.
- Linear progress: recessed stone track, molten rose-gold fill dripping downward at its end, label "Processing: 60%".
- Spinner: a stone disc with a rose-gold spiral swirl and small gears beside it.
- Skeleton rows: faint grey bars with tiny diamond bullets.
- Empty state: grey moon-landscape vignette with an astronaut and a planet, "No Results Found", "CREATE NEW" button
  with rose-gold rim.
- "Spating" bar: a stone track with molten flowing fill and a gear at its end (use as the busy/processing bar for
  long tasks).

## Rules for the build

- Every element above must have a real use in the studio (list each in the evidence doc with where it appears).
  Suggested placement: breadcrumbs in Settings page headers; steps in Go live and first-start setup; pagination in Clips
  and Schedule lists; skeleton rows while lists load; astronaut empty state on empty lists (Clips, Schedule, Tasks);
  avatars on channel/account rows (no faces, no names committed); table header on Schedule and Task lists; toast stack
  for app toasts; modal for confirm-type dialogs that exist today (no new "are you sure" prompts, D332); spinner and
  linear progress in the task panel; "spating" bar for clip jobs; card with chart for stats; tooltip everywhere.
- New controls work in every theme (drawn from Theme tokens); Molten Stone adds the textures.
- Textures: generated by a committed, deterministic script (no downloaded art, no AI image service), small PNGs
  (aim under 1.5 MB total), 9-slice margins chosen so stretching never distorts cracks or rims. 1x and 2x.
- Animation: smoke and drips only off air and only in full fx; never in plain mode; no loop runs while hidden;
  enter under 600 ms, exit under 400 ms for UI transitions. Must not raise idle GPU/CPU noticeably (measure).
- No overlap/intersection artefacts: glow and smoke stay inside each control's padded bounds or a reserved margin;
  no layout jumps between themes (same control heights).
- Contrast rules still apply (text 4.5:1, controls 3:1). Plain mode: flat fills, no glow.
- Ships on (requested feature): theme selectable in Settings > Appearance.
</content>
</invoke>
