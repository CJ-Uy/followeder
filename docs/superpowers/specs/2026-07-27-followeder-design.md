# Followeder — Design Spec

**Date:** 2026-07-27
**Status:** v6 — converged. Codex round 4: "sound enough to implement as an experimental Milestones 1-3 pipeline spike."

## 1. Problem

Instagram does not let you export your followers/following lists, and
third-party tools that offer this want your credentials. The safe alternative
people already use is a screen recording: open Followers, scroll to the bottom,
switch to Following, scroll to the bottom.

Followeder turns that recording into:

1. **You follow them, they don't follow back** — the list people actually want
2. **They follow you, you don't follow back**
3. **Mutuals**
4. **Ambiguous** — identities OCR could not resolve safely (see §6.7)

The fourth list is not a feature; it is a safety valve. A tool whose entire
purpose is accusation must never accuse on uncertain evidence.

## 2. Constraints and decisions

| Decision | Choice | Rationale |
|---|---|---|
| Where processing runs | 100% client-side | The video is a complete social graph. It must not leave the device. |
| OCR engine | `tesseract.js` (WASM), self-hosted assets | No inference cost. Accuracy recovered via multi-frame voting. |
| Cloudflare services | Workers only (static assets, existing OpenNext setup) | D1/R2 have no technical job in v1. |
| Frame access | `<video>` + `currentTime` seeking + `<canvas>` | Universal support, and the only method that can seek *backwards* to refine a suspected gap. |
| Backend | None | No API routes, no auth, no database, no uploads. |
| Locale | English Instagram UI only in v1 | Section detection parses the words `followers`/`following`. Stated in the error message when detection fails. |

**Non-goals for v1:** accounts, saved scan history, cross-scan comparison,
manual OCR correction UI, in-app capture, multi-video merge, non-Instagram
platforms, non-English UI.

**Fail-closed principle, and its limit.** Where this spec must choose between
showing a possibly-wrong name in an accusatory list and withholding it, it
withholds. False accusation is the only truly bad output.

But withholding is **not** automatically safe here, and assuming it was caused
real bugs in three earlier drafts. The output is a set *difference*, so removing
an identity from one side does not abstain — it asserts that person is absent
from that side, which is exactly the accusation. Quarantine is therefore always
**bilateral** (§6.3, §6.7), and when a whole section is unreliable the asymmetric
lists are **suppressed rather than caveated** (§6.6). A caveat does not repair
precision; a provisional false accusation is still a false accusation.

## 3. Measured evidence

Measured on `public/sample.mp4` (576×1246, 30fps, 38.4s, 1153 frames, 840 kbps
H.264; account has 587 followers / 538 following). Where a claim is inference
rather than measurement, it is labelled as such.

### 3.1 Usernames are separable from display names by luminance — MEASURED

Instagram renders usernames near-white (`#fff`), display names mid-gray
(`#8e8e8e`). Luminance histogram of the username-column crop:

```
                    display-name hump      valley           username peak
f_0 (static)             ~148             167-206 (min)          ~240
f_3 (scrolling)          ~148             167-206 (filled in)    ~240
```

Thresholding in the valley removes display names entirely. Verified visually on
both frames: clean black-on-white username-only images.

**Caveat:** these are raw bin counts from two uncontrolled frames with differing
amounts of visible text. The *existence and location* of the valley is solid and
is what the design depends on. The relative bin heights are not evidence of
anything and no conclusion is drawn from them.

### 3.2 Motion degrades the separation — MEASURED effect, HYPOTHESIZED cause

The valley fills in during scrolling. Observed character errors on a scrolling
frame: `vnz.cortez`→`vnz.cortaz`, `rapiboiz`→`rapiboi?`. Static frames showed no
visible errors.

The *cause* is a hypothesis, not a measurement: a screen recorder has no
shutter, so this is not optical motion blur. The likely mechanism is H.264 rate
control — at 840 kbps, fast scrolling creates large inter-frame deltas and the
encoder discards high-frequency detail. **Nothing in the design depends on this
explanation being correct.** It informs only the recording guidance in §7.1.

### 3.3 Sharpest-frame selection — WEAKER THAN IT LOOKS

Picking the sharpest frame within a window, vs naive fixed-interval sampling:

```
0.17s window -> 227 frames, 1.12x sharpness
0.50s window ->  76 frames, 1.35x sharpness
2.00s window ->  20 frames, 1.52x sharpness
```

**This is confounded.** The maximum of N samples from a fixed distribution rises
with N purely as an order statistic, so the monotone trend is partly — possibly
entirely — an artifact of sampling more candidates per window. Global
motion-vs-sharpness correlation was Pearson r = +0.024, i.e. none.

What survives: *within a window, the sharpest frame is sharper than a randomly
chosen one*, which is tautological but is exactly the property we exploit. The
practice is justified; the inference about scroll speed is not. Sharpness is
also never used as an accept/reject gate, only to choose among frames we were
going to OCR anyway, so a wrong sharpness ranking costs at most one frame's
quality.

### 3.4 RETRACTED — pagination does not guarantee coverage

Draft v1 claimed Instagram's pagination acts as a rate limiter, so the video
"cannot skip people, only blur them." **That was wrong.** Pagination only stalls
you at the boundary of *unloaded* content. Once Instagram has loaded 50 rows you
can fling through all 50 faster than any sampler catches them, encountering no
loading boundary at all.

Coverage is therefore **not** guaranteed by anything. It must be measured (§6.5)
and failures must be surfaced (§6.6), not assumed away.

### 3.5 Threshold formula and blank-frame guard — MEASURED

Over all 1153 frames:

```
                          all     text    blank
median                   16.0     16.0     16.5
p99.5                   220.5    229.3     27.0
range (p99.5 - median)  204.5    213.2     10.5
T = 0.75 * p99.5        165.4    172.0     20.2   <- v1 formula
T = med + 0.75 * range  169.4    176.0     24.4   <- v2 formula

% of text frames whose T lands in the measured 167-206 valley:
  T = 0.75 * p99.5       : 70.1%
  T = med + 0.75 * range : 76.7%
```

The background-relative formula is better, and more importantly it degrades
predictably. Both formulas collapse on blank frames (T≈20–24, making the entire
crop foreground), which is why the guard below is mandatory rather than
defensive.

**Dynamic-range guard — the separation is total:**

```
                    text frames    blank frames
range, 0th pct         165.0            9.0
range, 50th pct        220.0           11.0
```

Every cutoff from 30 to 100 keeps 100% of text frames and 0% of blank frames.
`MIN_RANGE = 60` sits in the middle of a 154-wide gap.

`THRESH_FACTOR` was then swept against real OCR output over four hand-labelled
frames (29 known usernames). **0.75 is optimal and both directions are worse:**

```
factor   mean recall   FP-rate
 0.70        45.1%      44.0%
 0.75        55.7%      37.0%   <- optimum
 0.80        42.4%      50.0%
 0.85        29.5%      63.6%
```

### 3.6 MAD saturates and cannot measure displacement — MEASURED

Mean absolute difference between frames at increasing separation:

```
lag  1 (0.03s): MAD p50 = 8.4
lag  3 (0.10s): MAD p50 = 9.7
lag 12 (0.40s): MAD p50 = 9.9
```

A 12× increase in displacement moves the median MAD by 18%. High-contrast text
on black decorrelates after roughly one row of movement, after which MAD is
saturated and carries **no displacement information**.

Consequence: draft v1's `MAD_TRIGGER` ("OCR when content has moved ~40% of a
viewport") is not merely unspecified, it is unimplementable. MAD is retained
only as a binary changed/unchanged test — paused frames measure 0–1, moving
frames 3–22, so `MOTION_EPS = 2` separates them cleanly. Displacement control
moves to a closed loop on measured row overlap (§5.1).

### 3.7 OCR spike results — MEASURED (Milestone 0, executed)

`tesseract.js` 7.0.0 run over frames thresholded by §5.3, scored against
hand-labelled ground truth.

**Per-frame exact-username recall:**

```
scroll_t3     73%   (8/11 exact)
paused_t0     67%   (top-of-list frame, cluttered by the Categories block)
loading_t30   67%
loading_t8     0-33% (heavily degraded frame)
```

**Confidence separates correct from incorrect.** On `scroll_t3`, every correct
read scored 82–92 while all three errors scored ≤ 40:

```
correct:  suzuminion(90) ernifred_(89) franceskaurmuse(82) lorspatawad(76)
wrong:    marcluisdeleon -> marcluisdalzon(4)
          vnz.cortez     -> vnz.coriaz(35)
          dustin_chanlim -> dustin_cihanhny(21)
```

This is the property §6.2 voting depends on, and it holds. Two correct reads did
score low (`rapiboiz(40)`, `micahcnza(64)`), so confidence is a strong signal but
not a clean gate — it is used for tie-breaks and flagging, never as a hard filter
on its own.

**Two findings that changed the spec:**

1. The char whitelist defeated the §5.5 chrome filter. With whitelist
   `[a-z0-9._]`, Tesseract cannot emit a space, so `People you don't follow back`
   arrived as the single token `eopleyoudontfollowbac` and passed every check.
   `Categories` arrived as `ries` at **confidence 96**. Fixed in §5.5.
2. **2× upscaling is harmful, not a fallback.** LANCZOS resampling of a binary
   mask reintroduces the gray edges thresholding removed. `loading_t30` went from
   6 clean names at 1× to 2 garbage tokens at 2×. Removed from §11.

## 4. Architecture

Four files. One new dependency (`tesseract.js`).

```
src/app/page.tsx           UI: dropzone, progress, warnings, 4 lists, export
src/lib/scan.ts            video -> frames -> OCR -> sightings, gaps, section runs
src/lib/reconcile.ts       sightings -> identities -> diff  (pure, sync, no DOM)
src/lib/reconcile.test.ts  the runnable check
```

`scan.ts` owns everything async and everything that touches pixels — **including
gap detection and bisection**, because both require seeking the video. In v1
those lived in `reconcile.ts`, which contradicted its "pure and synchronous"
contract. `reconcile.ts` consumes gaps as plain data.

### 4.1 Data contract

```ts
// ---- scan.ts ----
export type Section = "followers" | "following";

export interface Sighting {
  text: string;      // normalized candidate username
  raw: string;       // pre-normalization OCR line, for the §5.5 whitespace check
  conf: number;      // 0-100 from Tesseract
  t: number;         // source timestamp (seconds)
  y: number;         // line bbox top within crop; establishes within-frame order
  frameId: number;   // which OCR'd frame — REQUIRED for co-occurrence blocking (§6.1)
  section: Section;
}

export interface Gap {
  section: Section;
  tStart: number;
  tEnd: number;
  /** true if bisection bottomed out at frame granularity and rows are genuinely lost */
  confirmed: boolean;
}

export interface ScanResult {
  sightings: Sighting[];
  /** Per-section label counts, modal value across frames. Advisory only (§6.5). */
  labelCounts: Partial<Record<Section, number>>;
  /** Sampling discontinuities, already refined by bisection. */
  gaps: Gap[];
  /** Contiguous runs of confirmed section attribution; transitions excluded. */
  sectionRuns: { section: Section; tStart: number; tEnd: number }[];
  /** Per-section endpoint status. reconcile.ts cannot re-derive any of these
   *  from sightings alone, and §6.6 needs all three. */
  endpoints: Record<Section, {
    sawListTop: boolean;       // first accepted frame was flush with listTop
    sawEndMarker: boolean;     // §5.7 END_MARKERS matched for this section
    movingTransition: boolean; // content moved while the section was unclassified
    endedScrolling: boolean;   // the last accepted frame was still in motion
  }>;
  /** timestamps actually OCR'd, ascending — drives the provenance timeline */
  ocrTimes: number[];
  duration: number;
}

export function scanVideo(
  file: File,
  onProgress: (p: {
    t: number; duration: number; ocrCount: number;
    found: number; section: Section | null;   // section added; thumbnail dropped
  }) => void,
  signal?: AbortSignal,
): Promise<ScanResult>;
```

```ts
// ---- reconcile.ts ----
export interface Person {
  username: string;
  sightings: number;
  conf: number;
  variants: string[];
}

export interface CountCheck {
  ocrNames: number;
  labelSaid: number | null;
  /** every issue found, in user-facing wording. Empty means nothing detected. */
  reasons: string[];
  /** ONLY these suppress the asymmetric lists (§6.6). A count mismatch alone
   *  does not — at 80-90% expected recall it is the normal case. */
  unsafeForDiff: boolean;
}

export interface Reconciled {
  followers: Person[];
  following: Person[];
  /** withheld identities, as full Person objects so the UI can render them.
   *  Covers BOTH §6.3 contested strings and §6.7 cross-section near-matches. */
  ambiguous: { people: Person[]; reason: "contested-within-section" | "cross-section-near-match" }[];
  gaps: Gap[];
  check: Record<Section, CountCheck>;
}

export function reconcile(scan: ScanResult): Reconciled;

export function diff(r: Reconciled): {
  notFollowingBack: Person[];
  youDontFollowBack: Person[];
  mutuals: Person[];
  withheld: Person[];   // quarantined by §6.7 rather than accused
  provisional: boolean; // true when check.trustworthy is false for either section
};
```

## 5. Scan pipeline (`scan.ts`)

### 5.1 Closed-loop adaptive sampling

Seeking costs ~10–30ms; OCR costs ~200–500ms. Probe cheaply, OCR selectively —
but the trigger is **measured row overlap**, not a MAD threshold (§3.6).

```
lastProbeT = 0; lastOcrT = null; step = STEP_INIT
loop until end of video:
  t = lastProbeT + step
  probe frames at 1/30s within (lastProbeT, t]      // NOT (lastOcrT, t] — see below
  lastProbeT = t                                     // always advances, unconditionally
  drop probes with MAD < MOTION_EPS vs the last OCR'd frame     // paused: nothing new
  drop probes failing the §5.3 range guard                       // blank / loading
  if no probe survives: continue                     // inert; touches no other state

  OCR the sharpest survivor with t > lastOcrT
  if section changed or lastOcrT is null:            // §5.4 seeding
     accept frame, set lastOcrT, reset step to STEP_INIT, skip overlap evaluation
     continue

  (shared, dy) = ordered row alignment vs previous OCR'd frame in this section
  if dy < 0:                                         // user scrolled back up
     reset controller state; do NOT record a gap; continue
  overlap = |shared|
    overlap >= OVERLAP_HI -> highStreak++; if highStreak >= 2: step = min(step*1.5, STEP_MAX)
    overlap in LO..HI-1   -> highStreak = 0; keep step
    overlap <  OVERLAP_LO -> highStreak = 0; step = max(step/2, STEP_MIN)
                             enqueue (prevOcrT, t) for bisection
```

**`lastProbeT` must be separate from `lastOcrT`.** v3 probed `(lastOcrT, t]`, and
§5.3 deliberately leaves `lastOcrT` unchanged on skipped frames. During a pause
that interval grows without bound and is re-probed every iteration — a 60-second
pause degenerates into quadratic seeking and the scan appears hung. The MAD
*comparison* still references the last OCR'd frame (that is what detects a
slow cumulative scroll); only the probe *cursor* advances unconditionally.

**Growth requires two consecutive high-overlap observations; shrinking is
immediate.** With 55–73% per-frame recall (§3.7), the overlap count between two
independently imperfect frames is noisy. A symmetric bang-bang controller
oscillates: 0.60s yields 6 overlaps, grows to 0.90s, one bad OCR frame yields 1
overlap, halves to 0.45s, and the cycle repeats while enqueuing false gaps.
Asymmetric hysteresis is fail-closed — sampling too densely costs time, sampling
too sparsely loses people.

**Overlap is an ordered row alignment, not a set intersection.** Rows carry `y`,
and the list is scrolled monotonically within a run, so shared rows must appear
in the same relative order with a consistent displacement.

**Direction cannot come from that alignment.** v4 claimed it did, which is
self-defeating: when overlap is zero there are no shared rows, so no displacement
exists — and zero overlap is precisely the case where direction matters. A large
backward scroll (rows 100–108 → rows 70–78) shares nothing, `dy` is undefined,
and the interval is misread as a forward gap, potentially burning the whole
bisection budget to confirm a loss that never happened.

Direction is therefore measured on **pixels, not rows**: the signed vertical
offset maximizing cross-correlation between adjacent *probe* images, which exist
at 1/30s spacing where displacement is small enough to correlate even when the
OCR'd endpoints share nothing. This is the same row-profile correlation used to
characterize the sample in §3.6, and it is independent of OCR entirely.

```
dy = argmax_s correlate(rowProfile(probe[i-1]), rowProfile(probe[i]), s)
```

Accumulated across the probes in a step, its sign gives direction. `dy < 0`
resets controller state and emits no gap.

Three properties this buys:

- **No unmeasurable constant.** The controller reads the quantity it actually
  cares about — do consecutive frames share rows — rather than a proxy that
  saturates.
- **Self-tuning across devices.** Row height, viewport size and scroll velocity
  all wash out; only overlap matters.
- **Paused recordings are nearly free.** `MAD < MOTION_EPS` skips duplicates
  outright, so OCR count tracks the number of *distinct screenfuls*.

Note the reference for MAD is the **last OCR'd frame**, not the previous probe.
Against the previous probe, a slow steady scroll would never accumulate enough
difference to trigger.

**Honest cost note:** probe/seek work still scales with video duration. Only OCR
work tracks distinct screenfuls. A long recording with animations, backtracking
or compression flicker will cross `MOTION_EPS` more often and cost more OCR than
the ideal. "OCR cost is independent of duration" is a tendency, not a guarantee.

### 5.2 Calibration (once, on the first frame passing the range guard)

Geometry is derived, not hardcoded, because devices differ in notch height:

1. OCR a wide top band, `y ∈ [0.05, 0.20] × H`, bright-pixels-only.
2. Match `/([\d.,\s]+)\s*(followers|following)/i`; strip `.,\s` from the number
   before `parseInt`. **`(\d+)` alone matches `234` inside `1,234`** — wrong for
   any account over 999, i.e. most of them.
3. `listTop` = bbox bottom of that line + 1.5 × its height.
4. No match on any frame → abort with "this doesn't look like an English
   Instagram followers recording".

Horizontal crop is ratio-based: `x ∈ [0.16, 0.63] × W`, dropping the avatar
(left) and Message / Follow back buttons (right).

**Crop integrity check.** After calibration, verify on a text frame that the
crop's leftmost and rightmost 5% columns are background-dominated. A bright
avatar or button leaking into the crop corrupts `p99.5` and therefore every
threshold. On failure, narrow the crop by 2% per side and retry up to 3 times,
then abort with a diagnostic image. This replaces any need for a verified-badge
or bright-avatar special case.

### 5.3 Per-frame processing

```
crop  = frame[listTop..H, 0.16W..0.63W] as grayscale
med   = median(crop)
if (med > 128) {
  crop = 255 - crop                         // light mode -> bright-text-on-dark
  med  = 255 - med                          // MUST recompute; see below
}
range = percentile(crop, 99.5) - med
if (range < MIN_RANGE) skip frame           // blank / loading; skip is inert
T     = med + THRESH_FACTOR * range         // background-relative
mask  = crop > T
ocr   = tesseract(invert(mask), psm=6, whitelist=OCR_WHITELIST)
```

**Recomputing `med` after inversion is not a detail.** v3 inverted the crop but
kept the pre-inversion median. A light-mode frame with `med = 240` inverts to a
background median near 15 while the algorithm still subtracts 240, so `range`
comes out near zero or negative, fails `MIN_RANGE`, and **every light-mode frame
is skipped** — the app returns zero usernames and no error. Because the crop is
inverted wholesale, `255 - med` is exact; no second median pass is needed.

`OCR_WHITELIST` **must** include uppercase letters and the space character:

```
"abcdefghijklmnopqrstuvwxyz0123456789._ABCDEFGHIJKLMNOPQRSTUVWXYZ "
```

This looks backwards — usernames contain none of the added characters — and it
is the single least obvious decision in the spec. The whitelist is not there to
describe usernames; it is there to preserve the features that let §5.5
*identify chrome*. Excluding space and uppercase does not stop Tesseract reading
`Sort by Default`, it only stops it reporting the space and capitals, which
converts a trivially-rejectable string into a plausible username. Measured
effect: FP-rate 48.6% → 37.0% (§3.7).

A skipped frame updates neither `lastOcrT` nor the MAD reference nor the step
controller. Skipping must be inert, or blank loading frames will drag the
controller around.

Measured basis in §3.5. On the sample: `med=16`, `range=229`, `T=188` — inside
the 167–206 valley. Deriving from the frame is what makes dimmed screens, Night
Shift, HDR capture and third-party themes work without a second code path.

### 5.4 Section detection with stability requirement

The active tab renders white, inactive gray, so the same luminance filter
isolates it. Each OCR'd frame re-reads the top band (§5.2 step 1).

Classification is a two-state machine over `pending` and `accepted`, which must
be tracked separately:

**Classification runs on every probe, before the MAD duplicate-skip — and it
must not use OCR.** v4 classified only OCR'd frames, so the "pause after
switching tabs" guidance actively defeated it: paused frames are skipped as
duplicates, so the confirming observation arrived only once scrolling resumed —
exactly when rows start being lost.

But "it only reads the tab strip, which is cheap" was hand-waving, not a
mechanism. The only classifier specified was Tesseract, so a literal
implementation runs one OCR call per probe: ~1153 calls on the sample at
200–500ms each, i.e. **4–10 minutes before any list OCR begins**. That would
have invalidated every performance claim in this section.

The classifier is a **pixel measurement, not a recognizer**. Split the tab strip
at its horizontal midpoint and compare bright-pixel mass either side of it, using
the §5.3 threshold. The active tab is white and the inactive one gray, so after
thresholding one side carries most of the mass:

```
classify(strip):
  L = mass(strip.left half), R = mass(strip.right half)   // pixels > T
  if max(L,R) < MIN_LABEL_MASS or |L-R| / (L+R) < LABEL_MARGIN: return null
  return L > R ? "followers" : "following"
```

Tab *order* is fixed by Instagram (followers left, following right) and is
confirmed once during §5.2 calibration, which does use OCR — once. Per-probe
cost is then a sum over a few thousand pixels.

Full-strip OCR re-runs only when the classification *changes*, to re-read the
count for §6.5. That is a handful of calls per recording.

State is `accepted` (the stable section) plus `candidate`/`streak`. These are
distinct roles; v4's single `pending` carried both "transition candidate" and
"last stable observation" and could not be cleared without breaking one of them.

```
on each PROBE:
  c = classify(strip)          // "followers" | "following" | null (both/neither bright)

  if c == accepted && !inTransition:   // steady state — immediate, no streak
     candidate = null; streak = 0
     -> frame is eligible for OCR and its sightings are accepted
     continue

  // any disagreement is a transition, including a direct A -> B label change
  if !inTransition:                    // EDGE-triggered, not level-triggered
     inTransition = true
     if accepted != null: closeRun(accepted)

  if c == null: candidate = null; streak = 0; continue
  if c == candidate: streak++ else { candidate = c; streak = 1 }

  if streak >= SECTION_CONFIRM_PROBES:
     accepted = c; candidate = null; streak = 0; inTransition = false
     openRun(accepted); reset MAD reference and step controller
     -> ACCEPT this frame's sightings IF the frame is stationary
        (no motion since the transition began); otherwise DISCARD

at EOF: if accepted != null && runOpen: closeRun(accepted)
```

Defects this fixes:

- **The confirming frame was discarded unconditionally**, so any section entered
  after a pause lost its top rows: the discard also resets the MAD reference, so
  every subsequent paused probe is a duplicate and nothing is retained until
  scrolling resumes — by which time the first rows have left the viewport. The
  test is now *stationary*, not *first*. A stationary confirming frame has
  nothing sliding off it regardless of which section it belongs to, and this is
  what makes the "pause after switching tabs" guidance actually pay off.
- **`closeRun` fired on every disagreeing probe.** Level-triggered closure
  double-closes during a flicker. It is now edge-triggered on entering
  transition only, and EOF closes only if a run is open.
- **Returning to `accepted` mid-transition silently resumed.** v5's
  immediate-accept path ignored `inTransition`, so under alternating
  `A,B,A,B,…` every `A` was accepted into a run that had already been closed.
  Steady state now additionally requires `!inTransition`, so a flickering label
  must reconfirm before its rows count again.
- **A direct `A → B` label flip never set `inTransition`** in v4. Only `null`
  did, so an instant switch discarded rows silently and emitted no gap.

**Motion during a transition is a coverage failure, not a free discard.** If
`MAD ≥ MOTION_EPS` while `inTransition`, set `endpoints[accepted]
.movingTransition` and emit `Gap{section: accepted, confirmed: false}` spanning
it. Otherwise a label flicker drops rows while the count check can coincidentally
balance.

This exists because misattribution is strictly worse than omission. During a tab
switch the new label brightens while the *old* list's rows are still sliding
off-screen; attributing those rows to the new section moves a follower-only
account into Following, which reports them as a mutual and erases a true
"doesn't follow back" result. A dropped row costs a name; a misattributed row
produces a false statement about a real person.

Frames whose section cannot be established have their sightings discarded, never
guessed.

`sectionRuns` records the accepted intervals so `reconcile` can partition
clusters by section without re-deriving anything.

### 5.5 Line filtering — validate before normalizing

Order matters, and v1 had it backwards. Requires the widened `OCR_WHITELIST`
from §5.3 — these rules are inert without it.

1. **On the raw OCR line, before any normalization:**
   - reject if it contains whitespace → kills all multi-word chrome
   - reject if it contains `[A-Z]` → Instagram usernames are lowercase;
     UI chrome is Title Case
2. Lowercase, strip to `[a-z0-9._]`.
3. Reject unless it matches `^[a-z0-9._]{1,30}$`.
4. Reject unless it contains at least one `[a-z0-9]`.

v1 stripped disallowed characters *first*, so `Sort by Default` became
`sortbydefault` and passed everything after. Validating raw kills
`People you don't follow back`, `Least interacted with`, `Deactivated accounts`,
`Connect contacts` and `Most shown in feed` on the whitespace rule.

**The uppercase rule removes the need for a chrome denylist.** v2 special-cased
`Default` because it is structurally a valid username. With uppercase preserved
it arrives as `Default` and dies on rule 1 — as does `Categories`, which the
spike caught being emitted as `ries` at confidence 96. A denylist would have had
to enumerate every single-word label in the Instagram UI, in every future
version. The case rule generalizes; a denylist does not.

Residual risk: a genuine username typed by Tesseract with a spurious capital is
now dropped rather than corrected. That is the fail-closed direction, and voting
across ~10 sightings recovers it.

### 5.6 Gap detection and bisection

Owned by `scan.ts` because both need the video.

Consecutive accepted OCR frames in the same section should share rows. Zero
fuzzy overlap between two non-empty frames means rows passed unread.

Bisection uses a **worklist of intervals**, not a single recursive descent:

```
push (A, B)
while worklist and work < MAX_BISECT:
  (lo, hi) = pop
  m = OCR(midpoint)
  if overlap(lo, m) == 0: push (lo, m)
  if overlap(m, hi) == 0: push (m, hi)
  if interval is one decoded frame: emit Gap{confirmed: true}
```

Both children must be re-checked. "Repeat until overlap is found" terminates
early when the midpoint overlaps only the left endpoint, leaving the right half
unexamined — with rows 1–8 at A, 7–14 at M and 20–27 at B, the real gap is
between M and B and v1 would have missed it entirely.

`MAX_BISECT` is a budget **per discontinuity**, not a global pool. A global
budget lets one bad fling early in the recording consume everything and leave
every later discontinuity unexamined. On exhaustion, remaining intervals are
emitted as `Gap{confirmed: false}` — which, per §6.6, is still a trust failure.

`confirmed` distinguishes *known loss* from *could not verify continuity*. It
controls wording only. It never controls trust.

### 5.7 End-of-list detection

**Without this, the app fabricates accusations.** When the Following list ends,
Instagram renders a "Discover people" block with *suggested* accounts — real,
structurally valid usernames, still under the active Following tab. They enter
`following`, survive every filter, and get reported as "you follow them, they
don't follow back" about people the user has never followed. This is the single
most damaging output the app can produce, and it happens on every complete
recording. It is visible in the sample at t≈22s.

Zero row-overlap does not catch it: overlap only triggers bisection, and the
suggestion block is genuinely contiguous with the list above it.

Detection uses the raw OCR lines that §5.5 already produces (the widened
whitelist preserves the capitals and spaces that make these matchable):

```
END_MARKERS = /^(discover people|suggested for you|find people to follow|
                 see all suggestions)$/i
```

The marker line has a bounding box, and so does every username line. **Keep the
valid username lines above the marker; discard the marker and everything below
it; close the run at this frame** and set `endpoints[section].sawEndMarker`.

v4 discarded the whole matching frame and closed at the previous one. A partial
scroll routinely puts the last two real rows *and* the Discover header on screen
together, so those rows were silently lost — and because the marker condition was
considered satisfied, no gap was emitted. If the lost identity exists in the
other section, that omission manufactures exactly the asymmetric result this
section exists to prevent. If the boundary cannot be established (no usable
bbox), emit `Gap{confirmed: false}` instead of guessing.

Marker matching runs on frames that are OCR'd anyway, plus **one forced OCR on
the first stationary frame after motion stops** — the end of a list is exactly
where a user pauses, and that pause would otherwise be skipped as a duplicate.
Matching on every near-end probe was specified in v5 and is unaffordable for the
same reason per-probe classification was (see §5.4); one forced call per pause is
not.

Continue scanning — the other section may still follow.

`END_MARKERS` is a literal-string list and will need maintenance across
Instagram versions, which is exactly the fragility §5.5's case rule was designed
to avoid. It is accepted here because the alternative — treating suggestions as
follows — is a false accusation, and no structural property distinguishes a
suggested account from a followed one. If a marker is missed, §6.5's count check
fires (found > expected) and the result is marked provisional rather than
silently wrong.

## 6. Reconcile pipeline (`reconcile.ts`)

Pure, synchronous, no DOM, no video access.

### 6.1 Frame-batch clustering with co-occurrence blocking

Sightings are grouped by `frameId` and processed frame by frame, in time order.
Active clusters expire after `CLUSTER_TTL` (2s) — but **TTL bounds comparison
cost, it does not define identity** (see §6.3).

For each frame:

1. Exact matches to active clusters first.
2. Remaining lines may fuzzy-match, subject to all three rules:
   - **At most one line per frame may join any given cluster.** Two rows on
     screen simultaneously are two different people, period.
   - **Two spellings co-occurring in any frame may never merge**, in that frame
     or later. Record the pair as mutually exclusive.
   - **Fuzzy matching applies only when both strings are ≥ `FUZZY_MIN_LEN` (8)
     characters**, with edit distance ≤ 1. Shorter usernames are exact-match
     only.
3. Unmatched lines open new clusters.

v1's rule was `levenshtein ≤ max(1, floor(0.2 × maxlen))`. The `max(1, …)` floor
means **any two 1-character usernames merge unconditionally** — `a` and `b` are
distance 1 — and `jm.cruz` / `jm.cruzz` merge at distance 1, silently deleting a
real person. Frequency of merging rises exactly where names are shortest and
most numerous.

The co-occurrence rule is the load-bearing one: it uses the strongest available
evidence of distinctness — simultaneous visibility — and costs one set lookup.

Co-occurrence is recorded as **cannot-link edges between cluster IDs**, not
between strings, and the edges outlive voting. §6.3 consumes them.

The one-line-per-frame restriction applies to the exact-match phase too. Without
that, two co-occurring rows that OCR reads identically both land in one cluster
during step 1, before the fuzzy rules are ever consulted.

**Known limitation: an OCR line is not necessarily a row.** If Tesseract splits
`long_username` into two structurally-valid lines, the one-per-frame rule forces
two clusters and can manufacture a person. If it merges two rows into
`alice bob`, the whitespace rule drops both — a safe omission. If it merges them
into `alicebob`, it manufactures one fake account. `frameId` + bbox `y` orders
*OCR lines*, not Instagram rows, and cannot repair segmentation. No mechanism
here detects this; it is bounded only by the §6.4 minimum-sighting rule and the
§6.5 count check, and is a named residual risk (§12) rather than a solved
problem.

### 6.2 Voting

Per cluster, the winner is the **modal exact string**, tie-broken by summed
confidence. Losing readings are kept in `variants`.

Voting corrects *random* error only. At constant fling velocity all ~10 sightings
of a name smear identically and the same wrong reading wins every vote. §6.7
exists because voting cannot detect this from within a single section.

### 6.3 Global exact-dedupe

After voting, merge clusters within a section whose winning strings are
**exactly** equal, summing sightings and variants.

Required because TTL expiry is a cost optimization, not an identity rule: a 5s
pause, a resume on the same screen, or a scroll back up after 10s all produce a
second cluster for one person, inflating counts and duplicating output rows.
v1's test list referenced this pass but §6 never specified it.

**Exact dedupe must refuse to merge two clusters joined by a cannot-link edge**
(§6.1), and refuse transitively across an already-merged group.

v3 said only "the §6.1 fuzzy restrictions still apply", which is acknowledgement,
not mechanism — and the merge here is exact, so fuzzy restrictions would not
have applied at all. The failure: two rows co-occur on screen, so §6.1 correctly
keeps them apart, but OCR votes both clusters to the identical string
`abcdefgh`. §6.3 then merges them, deleting one real person. If Following holds
the surviving `abcdefgh`, the deleted Followers identity becomes a false one-way
result.

When a cannot-link edge blocks a merge, the winning string is **contested**: two
distinct people voted to one spelling, so neither identity is recoverable.

The contested string must then be **withheld from both sections**, not just the
one where the conflict occurred.

v4 quarantined only the two local clusters, which manufactures the accusation it
was meant to prevent. Trace: Followers OCRs two distinct rows as `abcdefgh`;
both are removed. Following legitimately contains `abcdefgh`. Its exact
counterpart has now vanished from Followers, so §6.7 — which inspects only
surviving identities — sees an unmatched name with no near neighbour and reports
it as "you follow them, they don't follow back." A real mutual has been converted
into an accusation *by the safety mechanism*.

This is the general shape of the problem (§12): in a set-difference product,
deleting an identity from one side is not abstention. It is an assertion of
absence on that side. **Every quarantine must propagate across the comparison
boundary**, which is why contested strings are recorded as `ambiguous` and
removed symmetrically rather than deleted locally.

Order matters: §6.4's minimum-sightings filter runs **before** conflict
escalation, so a single-frame OCR coincidence between two rows is dropped as
weak evidence instead of contesting a real identity.

### 6.4 Minimum sightings

Single-sighting clusters are retained but flagged low-confidence. A cluster with
one sighting **and** mean confidence below `MIN_CONF` (45) is dropped.

### 6.5 Count sanity check — not "coverage"

`check[section] = { ocrNames, labelSaid }`.

This is **not** a completeness measure, and v1 presenting it as `95.6% coverage`
was wrong twice over:

- A recording that starts at follower #100 and captures the remaining 488
  cleanly has **no internal gap** and no way to know 100 are missing.
- One missed person plus one duplicated cluster yields `ocrNames === labelSaid`
  while both are wrong.
- Instagram's own figure includes deactivated and private accounts that may
  render differently or not at all, and the number can change mid-recording.

The UI states both numbers literally — "561 OCR names; Instagram's label said
587" — and never divides them.

### 6.6 Trust gate

**There is no single `trustworthy` boolean.** v4 had one, and it collapsed six
unrelated conditions into a flag that is false on essentially every real
recording — at the 80–90% recall this design actually achieves (§11), a count
mismatch is the *normal* case, not an anomaly. A warning that always fires
carries no information, and the user learns to ignore it.

Two separate outputs instead:

**`reasons[]` — always populated, always shown.** Every condition detected, in
plain wording: count mismatch and by how much, gap timestamps, missing list top,
missing end marker, motion during a transition, quarantined identities. This is
the honest reporting §6.5 exists for, and it is informative precisely because it
is specific.

**`unsafeForDiff` — it suppresses output, and it is set unless the section is
*demonstrably complete*.** It is false only when **all** hold:

- `ocrNames === labelSaid` — exact count parity
- `sawListTop` and `sawEndMarker` are both true
- no gaps of either kind
- no motion during an unclassified transition

v5 claimed "a count mismatch alone does not set it, because missing names shrink
the lists without moving anyone into the wrong one." **That is false, and it is
the same non-monotonicity error §2 warns about.** If Followers misses the mutual
`alice` while Following contains her, `following − followers` reports that alice
does not follow you back. A missing name on one side is an assertion of absence
on that side. There is no version of set subtraction where incomplete input is
merely a smaller answer.

v5 also let a missing end marker pass when the last accepted frame was
stationary. Also wrong: a user can pause halfway down and stop recording, which
is stationary and radically incomplete. Stationary is not evidence of
completion; only the end marker is.

**The consequence is that the asymmetric lists will usually be suppressed.**
At the 80–90% recall §11 expects, exact count parity is uncommon. That is the
correct result, not a defect to engineer around: the recording genuinely does not
support the claim. When parity does hold, every name Instagram reports was read,
and the subtraction is sound.

Quarantine does not set `unsafeForDiff` — quarantine is the mechanism working,
and it is already bilateral.

When `unsafeForDiff` holds for either section, `diff()` returns empty asymmetric
lists and `provisional: true`; mutuals and the raw per-section lists are still
shown. **The lists are suppressed, not labelled.** v4 said "show provisional
accusations" in §7.3 and "suppress asymmetric lists" in §11 — contradictory
policies, and the suppressing one is correct: a provisional false accusation is
still a false accusation, and a caveat does not repair precision.

`sawListTop` is determined during scanning, not reconciliation: the first
accepted frame's topmost row is flush with `listTop` (Following) or with the
`Categories` block that §3.7 documents at the head of Followers. `reconcile.ts`
cannot re-derive it, which is why it travels in `ScanResult.endpoints`.

When a section is empty, the diff is suppressed entirely — a diff against an
empty set accuses everyone.

### 6.7 Cross-section ambiguity quarantine

The failure this exists for: Following consistently reads `vnz.cortez` as
`vnz.cortaz` while Followers reads it correctly. Both sections have the expected
count. The count check passes at 100%. Set subtraction then places **the same
person in both one-way lists** — simultaneously accusing them of not following
back and being unfollowed.

This is the worst output the app can produce and no amount of within-section
voting detects it, because each section is internally consistent.

Detection, after voting:

1. Compute the exact intersection. Those are settled mutuals.
2. Let `U` be every name with **no exact counterpart** in the opposite section —
   these are the only names that can appear in an asymmetric list, so they are
   the only ones capable of accusing.
3. For each `u ∈ U`, compare against **every** name in the opposite section, not
   only the unmatched ones. If any is within edit distance 1, mark the pair
   ambiguous and withhold `u` **and** that neighbour from all three primary
   lists.

Both scoping rules here are corrections of earlier drafts:

**No first-character index.** v3 bucketed by length *and first character*, so
`alice123` (followers) and `blice123` (following) — edit distance 1 — were never
compared. Any edit at position 0 defeated the index. Full comparison is
587 × 538 ≈ 316,000 bounded-length checks, nothing beside ~150 OCR invocations.
Speculative optimization that cost correctness.

**Unmatched names are compared against the full opposite section.** v4 restricted
this to `U_followers × U_following`, which fails on the spec's own example:
Followers `{vnz.cortez}`, Following `{vnz.cortez, vnz.cortaz}`. The exact
intersection consumes `vnz.cortez` on both sides, leaving `U_followers = ∅` — so
the cross product is empty and `vnz.cortaz` escapes into an asymmetric list
exactly as in v3. An unmatched name must be checked against *everything*
opposite it, because the identity it duplicates may already have matched.

Withholding both endpoints of every ambiguous edge already removes each connected
component in full, so no explicit transitive-closure pass is needed — v4 added
one and it was redundant.

**False-quarantine rate is unmeasured.** Two genuinely different people —
`jm.cruz` who follows you, `jm.cruzz` whom you follow — are withheld even though
both were read correctly. That is the fail-closed direction, but the rate is not
known, and it grows with the size of the cross product. §11 gates it.

This deliberately inverts §6.1's prior, and the inversion is the point. Within a
section, near-identical strings that co-occur are almost certainly different
people. Across sections, a near-identical pair with no exact counterpart is
almost certainly one person read two ways. Same edit distance, opposite
conclusion, because the evidence differs.

### 6.8 Diff

Set operations on winning usernames, minus anything quarantined by §6.7.

## 7. UI (`page.tsx`)

Three states: **idle → scanning → results**.

### 7.1 Idle

Dropzone plus recording guidance, since recording quality dominates accuracy:

- Scroll, **pause**, scroll, pause — roughly one screenful per fling
- **Pause briefly after switching tabs**, so the transition is unambiguous
- Start at the very top of each list and scroll to the very bottom
- Capture both tabs in one recording
- A longer file is fine — nothing is uploaded

### 7.2 Scanning

Progress over duration, live counts, **current section**, cancellable via
`AbortSignal`. No live thumbnail — it costs pixel transfer per frame and proves
nothing about progress. A thresholded diagnostic frame is rendered only in the
zero-results failure state, where it is genuinely diagnostic.

### 7.3 Results

Honest header first: literal counts and every entry in `reasons`, always shown.

When `unsafeForDiff` holds for either section, the asymmetric lists are
**suppressed, not labelled** — the UI shows the two raw per-section lists,
mutuals, and an explanation of what is missing. It does not show a caveated
accusation. Otherwise: four lists, `notFollowingBack` default-selected, each with
count, search, copy-all and CSV export.

Low-confidence rows carry a marker that is **click/tap-expandable** to reveal
`variants`. Hover-only disclosure is unusable on the phones most of this
audience will be on.

## 8. Error handling

| Condition | Behavior |
|---|---|
| Not a video / undecodable | Reject at select with the decode error |
| No `followers`/`following` label ever found | Abort: "not an English Instagram followers recording" |
| Crop integrity check fails after 3 retries | Abort with diagnostic thresholded frame |
| Only one section present | Show that list, suppress diff, explain |
| Zero usernames extracted | Show a thresholded frame so the user sees what OCR saw |
| Tesseract worker fails to load | Report missing assets; never fall back to a CDN |
| User cancels | Abort seeks, terminate workers |

## 9. Constants

Every value below has either a measured basis or an explicit "starting value,
to be validated by the spike" label. None is a silent guess.

```ts
// Geometry
CROP_X            = [0.16, 0.63]  // fraction of width
LIST_TOP_FALLBACK = 0.16
CROP_EDGE_BG_PCT  = 0.05          // columns checked by the integrity test

// Thresholding — MEASURED (§3.5, §3.7)
THRESH_FACTOR = 0.75   // swept against OCR output; 0.70/0.80/0.85 all measurably worse
MIN_RANGE     = 60     // text frames >=165, blank frames <=11; center of the gap
OCR_WHITELIST = "a-z0-9._" + "A-Z" + " "   // uppercase and space are REQUIRED by §5.5
NO_UPSCALE    = true   // 2x LANCZOS on the binary mask measurably destroys accuracy

// Sampling — MEASURED (§3.6)
MOTION_EPS   = 2        // paused 0-1, moving 3-22
STEP_INIT    = 0.15     // seconds; self-corrects, so precision is not required
STEP_MIN     = 1/30
STEP_MAX     = 1.0
OVERLAP_LO   = 2        // rows; below this -> undersampling. UNVALIDATED
OVERLAP_HI   = 6        // rows; at/above this -> oversampling. UNVALIDATED
GROW_STREAK  = 2        // consecutive high observations required to grow (§5.1)
MAX_BISECT   = 40       // per discontinuity, NOT a global pool (§5.6)
PROBE_HZ     = 30       // "one decoded frame" == 1/PROBE_HZ; bisection floor

// OVERLAP_LO/HI are load-bearing and unmeasured. They are gated by the
// deterministic controller-sequence test in §10, not by assertion.

// Identity
CLUSTER_TTL   = 2.0    // seconds; bounds comparison cost only, never identity
FUZZY_MIN_LEN = 8      // shorter usernames are exact-match only
FUZZY_MAX_ED  = 1
MIN_CONF      = 45     // starting value; validated by spike

// Section stability
SECTION_CONFIRM_PROBES = 2
```

Tab brightness margin, sharpness ranking and probe cadence are defined
operationally in §5 rather than as tunables — they either have no free parameter
or self-correct.

## 10. Testing

`reconcile.test.ts` — pure functions, synthetic sightings, no video, no DOM.
Cases chosen for the failures that *fabricate* results, not the happy path:

**Identity**
- `jm.cruz` and `jm.cruzz` in the same frame stay two people
- distinct 1- and 2-character usernames never merge
- a 10-char name with one corrupted character in 3 of 10 sightings votes correctly
- 5s pause, and scroll-back-up after 10s, each yield one person after §6.3
- clusters are partitioned by section; identical names in both sections stay separate

- two co-occurring rows that OCR reads *identically* are quarantined, not merged
  by §6.3 (cannot-link edge survives voting)
- an OCR line split into two valid-looking halves is a known, untested
  limitation — assert only that it cannot silently merge with a neighbour

**Gaps and sampling** (pure controller; feed it a scripted overlap sequence)
- gap detection silent on partial overlap, fires on zero overlap
- midpoint overlapping only the left endpoint still splits the right interval
- `MAX_BISECT` exhaustion emits `confirmed: false` **and still sets provisional**
- budget is per-discontinuity: an early exhausting fling does not starve a later one
- **controller seeding**: the first frame of a section, and the first after a
  section change, evaluate no overlap and emit no gap
- **no oscillation**: the sequence `6,6,1,6,6,1,…` must not alternate step size
  every observation — growth requires `GROW_STREAK` consecutive highs
- **backward scroll** (`dy < 0`) resets state and emits no gap
- a range-skipped probe advances the probe cursor but not the OCR reference,
  and a long blank interval does not manufacture a gap against a stale frame

**Sections**
- both-labels and neither-label frames are rejected
- **the state machine bootstraps**: the first two agreeing probes accept a
  section (v3's rule could never accept anything)
- a second tab switch is accepted after a first
- rows surviving a tab switch are not attributed to the new section
- motion during an unclassified transition emits a gap and sets provisional

**Filtering and list end**
- `Sort by Default` rejected on the raw-whitespace rule
- `Default` rejected on the raw-uppercase rule, with no denylist present
- `1,234 followers` parses as 1234, not 234
- `Discover people` closes the section, and suggested accounts appearing after
  it never enter `following`

**Output safety**
- cross-section `vnz.cortez`/`vnz.cortaz` quarantined, absent from all three lists
- `alice123`/`blice123` quarantined — first-character differences are compared
- when Following holds both `vnz.cortez` and `vnz.cortaz` and Followers holds
  only `vnz.cortez`, the unmatched `vnz.cortaz` is still quarantined
- three-way near-collisions quarantine the whole connected component
- empty section suppresses the diff
- count mismatch sets `unsafeForDiff` and empties the asymmetric lists
- started-mid-list sets `unsafeForDiff` even with zero gaps
- an *unconfirmed* gap sets `unsafeForDiff`
- a section with exact count parity, both endpoints and no gaps is NOT suppressed

`scan.ts` is validated by the spike (§11), not unit tests — mocking video decode
and WASM OCR would only test the mocks.

## 11. Build order

**Milestone 0 — spike. DONE. Results in §3.7.**

Executed before any other code. Outcome: **proceed.** Per-frame exact-username
recall 67–73% on representative frames, with confidence cleanly separating
correct reads (82–92) from errors (≤40).

The metric is **exact-username recall**, not character accuracy. v1's "60%
character accuracy" bar was meaningless: at 60% per-character a 10-character
username is fully correct ~0.6% of the time, and even 90% character accuracy
yields ~35% exact strings. Set subtraction needs exact identities.

**A gate on single-frame false-positive rate was also wrong**, and v2 set one
(< 0.02) that the spike measured at 0.37. That is not a failure — it is a
category error. Single-frame output is not the product. Chrome tokens, partial
rows clipped at the viewport edge, and one-off misreads are all expected in raw
per-frame output and are removed downstream by §5.5 filtering, §6.2 voting and
§6.4 minimum-sightings. Precision can only be honestly measured on *pipeline*
output.

So the gate splits:

- **Milestone 0 (met):** per-frame exact recall ≥ 50% on scrolling frames, and
  confidence must separate correct from incorrect readings. Both hold.
- **End of Milestone 3**, measured on **at least three** hand-labelled
  recordings from different devices — not the one this spec was tuned on — with
  all four required simultaneously:
  - final identity **precision ≥ 0.98** per section
  - final identity **recall ≥ 0.90** per section
  - **false-quarantine rate ≤ 0.05**, counting withholding from §6.3 *and* §6.7
  - `notFollowingBack` contains **zero** names that are in fact followers

A precision floor alone is not a gate: discarding every identity gives a
false-positive rate of zero and would pass. v3 specified exactly that.

**Milestones 1–3 are an experimental pipeline spike, not a shipping build, and
the gate is not currently expected to pass.** Stating that plainly is the point.
From §3.7's measurements: at 55% per-frame recall a row needs ~3 independent
sightings to reach 90% odds of one exact read (80% at two); at 73%, two
sightings give 93%. The controller does not guarantee two *substantially
independent* observations per row — a paused screenful may yield exactly one
OCR frame, and §3.2 notes errors can be systematic rather than independent, in
which case extra sightings add no information. Filtering and quarantine only
subtract. An evidence-based expectation is **80–90% final recall**, putting the
0.90 floor at the edge rather than comfortably inside.

Zero false accusations is harder still. Across ~500 identities, even a 0.2%
independent per-identity error rate gives only a ~37% chance of a clean run; at
1% it is under 1%. Edit-distance-1 quarantine does not catch the multi-character
errors actually measured (`marcluisdeleon` → `marcluisdalzon`).

So the honest outcomes on failure are: **ship without the asymmetric lists**
(show both raw lists, mutuals, and the evidence — still useful, and it is what
the recording actually supports), or **do not ship**. "Tighten quarantine" is
not a remedy — it lowers recall and raises false-quarantine, failing two other
gates to rescue one. That response was specified in v4 and it was incoherent.

There is no 2× upscale fallback — measured harmful (§3.7). There is no Workers
AI fallback — it would upload frames, contradicting §2. If the Milestone 3 gate fails,
see §11 — the response is to reduce scope, not to add an engine or tighten
quarantine.

**Milestone 1** — `scan.ts`: calibration, crop integrity, threshold + range
guard, section stability.
**Milestone 2** — `scan.ts`: closed-loop sampling, gap detection, worklist
bisection.
**Milestone 3** — `reconcile.ts` + tests: clustering, voting, dedupe,
quarantine, trust gate, diff.
**Milestone 4** — `page.tsx`.

Gap refinement precedes the UI. v1 sequenced bisection *after* the results
screen, which would have shipped an interface presenting accusations while the
mechanism meant to verify sampling continuity did not yet exist.

## 12. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| ~~Tesseract exact-string accuracy too low~~ | RETIRED | Measured 67–73% per-frame recall with usable confidence separation (§3.7) |
| Voted accuracy still insufficient after reconciliation | **High** | End-of-Milestone-3 gate (§11); response is reduced scope — ship without the asymmetric lists — never more quarantine |
| Systematic smear defeats voting | **High** | §6.7 quarantine; recording guidance; provisional labelling |
| Recording starts mid-list | Medium | Detected, sets `provisional`; guidance says start at top |
| Crop ratios wrong on another device | Medium | Integrity check with retry, then abort with a diagnostic rather than emitting garbage |
| IG redesigns the list layout | Medium | Geometry derived from the tab bbox; luminance relationship is more stable than offsets |
| Seek performance on mobile Safari | Low | Progress UI, cancellable |
| Very large videos | Low | Frames never retained — crop, OCR, discard. Memory flat in duration. |
| **Quarantine is non-monotonic** — removing an identity from one side asserts absence on that side | **High** | All withholding propagates across the comparison boundary (§6.3, §6.7). This is the deepest structural hazard in the design. |
| OCR splits or merges a row into the wrong number of lines | Medium | Unsolved. Bounded by §6.4 minimum sightings and the §6.5 count check; named, not fixed. |
| `END_MARKERS` goes stale on an Instagram redesign | Medium | Count check fires (found > expected) and the section is marked provisional rather than silently accusing suggested accounts |

**Not claimed:** that the app works offline. Self-hosting Tesseract assets
removes a third-party runtime request; it does not make the app available before
its bundle and WASM are cached. No service worker is added merely to support the
phrase.
