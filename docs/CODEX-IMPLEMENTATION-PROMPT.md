# Codex implementation prompt

Paste everything below the line into Codex from the repo root.

---

Implement the scanning and reconciliation logic for Followeder, a client-side
Instagram follower-diff tool. Do **not** touch the UI — `src/app/page.tsx`,
`src/app/layout.tsx` and `src/app/globals.css` are finished and owned by someone
else. Do not modify them.

## Read first

`docs/superpowers/specs/2026-07-27-followeder-design.md` — the v5 design spec. It
survived four rounds of adversarial review. **Every rule in it exists because a
specific failure was traced.** Where the spec says "v3 did X and it was wrong",
that is a real bug that was caught; do not reintroduce it. Read §3 (measured
evidence) before §5–§6, because the constants are measured, not guessed.

## Your files

Implement exactly two files. They already exist with the complete type contract
and every constant. **Keep the exported types byte-identical** — the UI imports
them and compiles against them today.

- `src/lib/scan.ts` — replace the `scanVideo` stub. Owns everything async and
  everything touching pixels, including gap detection and bisection.
- `src/lib/reconcile.ts` — replace the `reconcile` and `diff` stubs. Must stay
  **pure and synchronous**: no DOM, no video, no async, no imports beyond
  `./scan` types.

Also create:

- `src/lib/reconcile.test.ts` — the cases listed in spec §10. Plain
  `node --test` or `vitest`, whichever needs less setup. No fixtures, no
  mocking frameworks. It must fail if the logic breaks.

`tesseract.js@7` is installed. Add no other dependency. Do not create additional
files.

## Build order (spec §11)

1. **Milestone 1** — `scan.ts` calibration: §5.2 tab-band OCR and `listTop`
   derivation, crop integrity check, §5.3 per-frame threshold with the range
   guard, §5.4 section state machine.
2. **Milestone 2** — `scan.ts` sampling: §5.1 closed-loop controller, §5.6
   worklist bisection, §5.7 end-of-list detection.
3. **Milestone 3** — `reconcile.ts` + tests: §6.1 clustering, §6.2 voting, §6.3
   contested-string handling, §6.4–§6.8.

Gap refinement must precede any results work. Do not reorder.

## The traps, in priority order

These are the bugs that were caught in review. Each one shipped in a draft
before being found.

1. **§5.3 — recompute `med` after inversion.** `med = 255 - med`. Forget it and
   every light-mode frame fails the range guard and the app silently returns
   zero names.
2. **§5.4 — classify on every probe, before the MAD duplicate-skip.** Paused
   frames are skipped as duplicates; if classification only sees OCR'd frames,
   the "pause after switching tabs" guidance actively breaks section detection.
   Follow the pseudocode literally, including the first-section special case
   that keeps its confirming frame.
3. **§5.1 — `lastProbeT` is separate from `lastOcrT`.** Probe `(lastProbeT, t]`.
   Probing `(lastOcrT, t]` makes a long pause re-scan an ever-growing interval
   and the scan appears to hang.
4. **§5.1 — direction comes from probe-image cross-correlation, not row
   overlap.** At zero overlap there are no shared rows, which is exactly when
   direction matters.
5. **§5.7 — keep username lines *above* the end marker.** Discarding the whole
   frame loses real final rows and emits no gap.
6. **§6.1 — cannot-link edges are between cluster IDs and survive voting.** The
   one-line-per-frame rule applies to the exact-match phase too.
7. **§6.3 — a contested string is withheld from BOTH sections.** This is the
   non-monotonicity trap: removing an identity from one side asserts absence on
   that side, which manufactures the accusation you were trying to prevent.
   Read §2 and §12 on this.
8. **§6.7 — compare each unmatched name against the FULL opposite section**, not
   just the other unmatched names, and use no first-character index.
9. **§6.6 — `unsafeForDiff` is narrow and it suppresses.** A count mismatch
   alone must NOT set it. When it is set, `diff()` returns the asymmetric lists
   **empty** and `suppressed: true`.

## Performance

The sample is `public/sample.mp4` (576×1246, 30fps, 38.4s). Seeking costs
~10–30ms, OCR ~200–500ms, so OCR count is the budget. Expect roughly 80–150 OCR
invocations for that file. If you exceed ~300, the controller is wrong.

Run OCR in Web Workers so the UI thread stays responsive; `scanVideo` already
takes an `AbortSignal` and must actually honour it — terminate workers and stop
seeking on abort.

Self-host the tesseract.js worker/wasm/traineddata under `public/`. Never fall
back to a CDN; the app must make no network request after its assets load.

## Verification

- `npx tsc --noEmit` clean.
- `npx next build` clean.
- The reconcile tests pass.
- Dropping `public/sample.mp4` on the running app produces two section runs, a
  plausible name count against the 587/538 labels, and no crash.

Report the measured OCR invocation count and per-section name counts for
`sample.mp4` when you are done. **Do not claim the Milestone 3 accuracy gate
passes** — that needs three hand-labelled recordings from different devices and
§11 states plainly it is not expected to pass yet. This is an experimental
pipeline spike, not a shippable product; say what the numbers actually are.
