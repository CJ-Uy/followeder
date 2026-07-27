"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { scanVideo, type Gap, type ScanProgress, type ScanResult, type SectionRun } from "@/lib/scan";
import { diff, reconcile, type DiffResult, type Person, type Reconciled } from "@/lib/reconcile";

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

type Phase =
	| { k: "idle" }
	| { k: "scanning"; p: ScanProgress }
	| { k: "error"; message: string }
	| { k: "done"; scan: ScanResult; rec: Reconciled; d: DiffResult };

type ListKey = "notFollowingBack" | "youDontFollowBack" | "mutuals" | "withheld";

const LISTS: { key: ListKey; label: string; note: string }[] = [
	{
		key: "notFollowingBack",
		label: "Not following you back",
		note: "You follow them. They don't follow you.",
	},
	{
		key: "youDontFollowBack",
		label: "You don't follow back",
		note: "They follow you. You don't follow them.",
	},
	{ key: "mutuals", label: "Mutual", note: "Following each other." },
	{
		key: "withheld",
		label: "Unresolved",
		note: "Two readings a character apart across both lists — probably one person read two ways. Withheld rather than guessed.",
	},
];

/** Lists that a gap can corrupt. Hidden entirely when `suppressed` (spec §6.6). */
const ASYMMETRIC = new Set<ListKey>(["notFollowingBack", "youDontFollowBack"]);

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/* ------------------------------------------------------------------ *
 * Timeline — the provenance artifact. Shows which parts of the
 * recording were actually read, and where they weren't.
 * ------------------------------------------------------------------ */

function Timeline({
	duration,
	ocrTimes,
	runs,
	gaps,
	playhead,
}: {
	duration: number;
	ocrTimes: number[];
	runs: SectionRun[];
	gaps: Gap[];
	playhead?: number;
}) {
	const pct = (t: number) =>
		`${Math.min(100, Math.max(0, (t / Math.max(duration, 0.001)) * 100))}%`;

	return (
		<div>
			<div className="flex items-baseline justify-between font-mono text-[10px] tracking-widest text-dimmer uppercase">
				<span>{clock(0)}</span>
				<span>Scan coverage</span>
				<span>{clock(duration)}</span>
			</div>

			<div className="relative mt-2 h-14 overflow-hidden rounded-[3px] border border-line bg-surface">
				{runs.map((r, i) => (
					<div
						key={i}
						className="absolute top-0 h-3"
						style={{
							left: pct(r.tStart),
							width: pct(r.tEnd - r.tStart),
							background: r.section === "followers" ? "var(--dimmer)" : "var(--dim)",
						}}
						title={`${r.section} · ${clock(r.tStart)}–${clock(r.tEnd)}`}
					/>
				))}

				<svg
					className="absolute inset-x-0 top-3 h-8 w-full"
					preserveAspectRatio="none"
					viewBox="0 0 1000 32"
					aria-hidden
				>
					{ocrTimes.map((t, i) => {
						const x = (t / Math.max(duration, 0.001)) * 1000;
						return (
							<line key={i} x1={x} x2={x} y1={6} y2={26} stroke="var(--line-bright)" strokeWidth={1} />
						);
					})}
				</svg>

				{gaps.map((g, i) => (
					<div
						key={i}
						className="absolute top-0 bottom-0 border-x border-signal bg-signal/15"
						style={{ left: pct(g.tStart), width: `max(2px, ${pct(g.tEnd - g.tStart)})` }}
						title={`Gap · ${g.section} · ${g.tStart.toFixed(1)}–${g.tEnd.toFixed(1)}s`}
					/>
				))}

				{playhead !== undefined && (
					<div className="absolute top-0 bottom-0 w-px bg-fg" style={{ left: pct(playhead) }} />
				)}

				{runs.map((r, i) => (
					<span
						key={i}
						className="absolute bottom-1 font-mono text-[10px] tracking-wider text-dimmer"
						style={{ left: `calc(${pct(r.tStart)} + 4px)` }}
					>
						{r.section}
					</span>
				))}
			</div>

			<div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[10px] text-dimmer">
				<span>{ocrTimes.length} frames read</span>
				{gaps.length > 0 && (
					<span className="text-signal">
						{gaps.length} gap{gaps.length === 1 ? "" : "s"} ·{" "}
						{gaps.map((g) => `${g.tStart.toFixed(1)}–${g.tEnd.toFixed(1)}s`).join("  ")}
					</span>
				)}
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ *
 * Row — shows the losing OCR readings rather than hiding them
 * ------------------------------------------------------------------ */

function Row({ p }: { p: Person }) {
	const [open, setOpen] = useState(false);
	const uncertain = p.conf < 70 || p.variants.length > 0;

	return (
		<li className="border-b border-line/60 last:border-0">
			<div className="flex items-baseline gap-3 py-2.5">
				<button
					type="button"
					disabled={!uncertain}
					onClick={() => setOpen((v) => !v)}
					aria-expanded={uncertain ? open : undefined}
					className={`flex-1 truncate text-left font-mono text-[15px] leading-none ${
						uncertain
							? "cursor-pointer text-fg/80 underline decoration-dimmer decoration-dotted underline-offset-4"
							: "cursor-default text-fg"
					}`}
				>
					{p.username}
				</button>
				<span className="shrink-0 font-mono text-[11px] tabular-nums text-dimmer">{p.sightings}×</span>
				<span
					className={`w-7 shrink-0 text-right font-mono text-[11px] tabular-nums ${
						p.conf < 70 ? "text-signal" : "text-dimmer"
					}`}
				>
					{Math.round(p.conf)}
				</span>
			</div>

			{open && p.variants.length > 0 && (
				<p className="pb-2.5 font-mono text-[11px] leading-relaxed text-dimmer">
					<span className="opacity-70">also read as </span>
					{p.variants.join("  ·  ")}
				</p>
			)}
		</li>
	);
}

/* ------------------------------------------------------------------ *
 * page
 * ------------------------------------------------------------------ */

export default function Home() {
	const [phase, setPhase] = useState<Phase>({ k: "idle" });
	const [tab, setTab] = useState<ListKey>("notFollowingBack");
	const [q, setQ] = useState("");
	const [dragging, setDragging] = useState(false);
	// Opt-in reveal of a suppressed comparison. Default false: the evidence
	// does not support it, so seeing it must be a deliberate act.
	const [revealed, setRevealed] = useState(false);
	const abort = useRef<AbortController | null>(null);

	const run = useCallback(async (file: File) => {
		abort.current = new AbortController();
		setPhase({ k: "scanning", p: { t: 0, duration: 0, ocrCount: 0, found: 0, section: null } });
		try {
			const scan = await scanVideo(file, (p) => setPhase({ k: "scanning", p }), abort.current.signal);
			const rec = reconcile(scan);
			const d = diff(rec);
			setPhase({ k: "done", scan, rec, d });
		} catch (e) {
			setPhase({ k: "error", message: e instanceof Error ? e.message : String(e) });
		}
	}, []);

	// Lists actually rendered. When the user reveals a suppressed comparison the
	// asymmetric lists come from `unsafe`; otherwise they stay empty.
	const lists = useMemo(() => {
		if (phase.k !== "done") return null;
		const d = phase.d;
		if (d.suppressed && revealed && d.unsafe) {
			return { ...d, notFollowingBack: d.unsafe.notFollowingBack, youDontFollowBack: d.unsafe.youDontFollowBack };
		}
		return d;
	}, [phase, revealed]);

	const showAsym = phase.k === "done" && (!phase.d.suppressed || revealed);

	// Derived, never stored: a hidden asymmetric tab must not be renderable even
	// if `tab` still points at one. Deriving beats remembering to setTab.
	const view: ListKey = phase.k === "done" && !showAsym && ASYMMETRIC.has(tab) ? "mutuals" : tab;

	const missing = useMemo(() => {
		if (phase.k !== "done") return 0;
		return (["followers", "following"] as const).reduce((n, s) => {
			const c = phase.rec.check[s];
			return n + Math.max(0, (c.labelSaid ?? c.ocrNames) - c.ocrNames);
		}, 0);
	}, [phase]);

	const rows = useMemo(() => {
		if (phase.k !== "done") return [];
		const needle = q.trim().toLowerCase();
		const list = (lists ?? phase.d)[view];
		return needle ? list.filter((p) => p.username.includes(needle)) : list;
	}, [phase, lists, view, q]);

	const reasons = useMemo(() => {
		if (phase.k !== "done") return [];
		// Labelled by section — "26 names short" and "9 names short" are
		// meaningless side by side without knowing which list each refers to.
		return (["followers", "following"] as const).flatMap((s) =>
			phase.rec.check[s].reasons.map((r) => ({ section: s, text: r })),
		);
	}, [phase]);

	const download = () => {
		if (phase.k !== "done") return;
		const body = ["username,sightings,confidence"]
			.concat((lists ?? phase.d)[view].map((p) => `${p.username},${p.sightings},${Math.round(p.conf)}`))
			.join("\n");
		const url = URL.createObjectURL(new Blob([body], { type: "text/csv" }));
		const a = document.createElement("a");
		a.href = url;
		a.download = `followeder-${view}.csv`;
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<div className="min-h-screen bg-bg">
			<div className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-8 sm:py-16">
				<header className="border-b border-line pb-6">
					<h1 className="font-mono text-[13px] font-semibold tracking-[0.42em] text-fg uppercase">
						Followeder
					</h1>
					<p className="mt-3 max-w-md text-[26px] leading-[1.15] font-extrabold tracking-[-0.02em] text-fg sm:text-[32px]">
						Reads your screen recording.
						<br />
						<span className="text-dim">Names the difference.</span>
					</p>
				</header>

				{phase.k === "idle" && <Idle dragging={dragging} setDragging={setDragging} onFile={run} />}

				{phase.k === "scanning" && (
					<section className="py-14">
						<Timeline
							duration={phase.p.duration}
							ocrTimes={[]}
							runs={phase.p.section ? [{ section: phase.p.section, tStart: 0, tEnd: phase.p.t }] : []}
							gaps={[]}
							playhead={phase.p.t}
						/>
						<dl className="mt-8 grid grid-cols-3 gap-px overflow-hidden rounded-[3px] border border-line bg-line">
							{[
								["Elapsed", `${phase.p.t.toFixed(1)}s`],
								["Frames read", String(phase.p.ocrCount)],
								["Names found", String(phase.p.found)],
							].map(([k, v]) => (
								<div key={k} className="bg-surface px-4 py-3">
									<dt className="font-mono text-[10px] tracking-widest text-dimmer uppercase">{k}</dt>
									<dd className="mt-1 font-mono text-xl tabular-nums text-fg">{v}</dd>
								</div>
							))}
						</dl>
						<button
							type="button"
							onClick={() => abort.current?.abort()}
							className="mt-6 font-mono text-[11px] tracking-wider text-dimmer uppercase hover:text-fg"
						>
							Stop scan
						</button>
					</section>
				)}

				{phase.k === "error" && (
					<section className="py-14">
						<p className="font-mono text-[11px] tracking-widest text-signal uppercase">Scan stopped</p>
						<p className="mt-3 max-w-lg text-[15px] leading-relaxed text-dim">{phase.message}</p>
						<button
							type="button"
							onClick={() => setPhase({ k: "idle" })}
							className="mt-6 rounded-[3px] border border-line-bright px-4 py-2 font-mono text-[11px] tracking-wider text-fg uppercase hover:border-fg"
						>
							Start over
						</button>
					</section>
				)}

				{phase.k === "done" && (
					<section className="pt-10">
						<Timeline
							duration={phase.scan.duration}
							ocrTimes={phase.scan.ocrTimes}
							runs={phase.scan.sectionRuns}
							gaps={phase.scan.gaps}
						/>

						{/* literal counts, never a percentage — see spec §6.5 */}
						<div className="mt-6 space-y-1.5 font-mono text-[12px] leading-relaxed">
							{(["followers", "following"] as const).map((s) => {
								const c = phase.rec.check[s];
								return (
									<p key={s} className="text-dim">
										<span className="inline-block w-20 text-dimmer">{s}</span>
										{c.ocrNames} names read
										{c.labelSaid !== null && (
											<span className={c.labelSaid === c.ocrNames ? "" : "text-signal"}>
												{" · Instagram's label said "}
												{c.labelSaid}
											</span>
										)}
									</p>
								);
							})}
						</div>

						{/* reasons are always shown; suppression is separate and stronger */}
						{reasons.length > 0 && (
							<ul className="mt-4 space-y-1">
								{reasons.map((r) => (
									<li
										key={`${r.section}:${r.text}`}
										className="flex gap-2.5 text-[13px] leading-relaxed text-dim"
									>
										<span className="w-20 shrink-0 font-mono text-[11px] text-dimmer">
											{r.section}
										</span>
										{r.text}
									</li>
								))}
							</ul>
						)}

						{phase.d.suppressed && (
							<div className="mt-5 border-l-2 border-signal bg-signal/6 py-3 pr-3 pl-3">
								<p className="font-mono text-[11px] tracking-widest text-signal uppercase">
									{revealed ? "Shown despite gaps" : "Comparison withheld"}
								</p>
								<p className="mt-1.5 max-w-lg text-[13px] leading-relaxed text-dim">
									{revealed ? (
										<>
											{missing > 0 ? `${missing} names` : "Some names"}{" "}were missed, and every one
											of them looks like someone who doesn&apos;t follow you back. Treat this list
											as a lead, not a verdict — check a name on Instagram before acting on it.
										</>
									) : (
										<>
											This recording has gaps, so anyone missed looks like someone who
											doesn&apos;t follow you back. Re-recording the incomplete part gives a
											reliable answer.
										</>
									)}
								</p>
								{!revealed && (phase.d.unsafe?.notFollowingBack.length ?? 0) > 0 && (
									<button
										type="button"
										onClick={() => setRevealed(true)}
										className="mt-3 rounded-[3px] border border-signal/60 px-3 py-1.5 font-mono text-[11px] tracking-wider text-signal uppercase hover:bg-signal/10"
									>
										Show it anyway · {phase.d.unsafe?.notFollowingBack.length} names
									</button>
								)}
							</div>
						)}

						<nav className="mt-8 flex flex-wrap gap-x-6 gap-y-2 border-b border-line">
							{LISTS.filter((l) => showAsym || !ASYMMETRIC.has(l.key)).map((l) => {
								const n = (lists ?? phase.d)[l.key].length;
								const on = view === l.key;
								return (
									<button
										key={l.key}
										type="button"
										onClick={() => setTab(l.key)}
										aria-current={on}
										className={`-mb-px border-b-2 pb-2.5 text-left ${
											on ? "border-signal" : "border-transparent"
										}`}
									>
										<span
											className={`font-mono text-[11px] tracking-wider uppercase ${
												on ? "text-signal" : "text-dimmer hover:text-dim"
											}`}
										>
											{l.label}
										</span>
										<span
											className={`ml-2 font-mono text-[13px] tabular-nums ${on ? "text-fg" : "text-dimmer"}`}
										>
											{n}
										</span>
									</button>
								);
							})}
						</nav>

						<p className="mt-3 max-w-lg text-[13px] leading-relaxed text-dimmer">
							{LISTS.find((l) => l.key === view)!.note}
						</p>

						<div className="mt-5 flex items-center gap-3">
							<input
								value={q}
								onChange={(e) => setQ(e.target.value)}
								placeholder="Filter"
								aria-label="Filter names"
								className="min-w-0 flex-1 rounded-[3px] border border-line bg-surface px-3 py-2 font-mono text-[13px] text-fg placeholder:text-dimmer focus:border-line-bright focus:outline-none"
							/>
							<button
								type="button"
								onClick={() => navigator.clipboard?.writeText(rows.map((p) => p.username).join("\n"))}
								className="rounded-[3px] border border-line px-3 py-2 font-mono text-[11px] tracking-wider text-dim uppercase hover:border-line-bright hover:text-fg"
							>
								Copy
							</button>
							<button
								type="button"
								onClick={download}
								className="rounded-[3px] border border-line px-3 py-2 font-mono text-[11px] tracking-wider text-dim uppercase hover:border-line-bright hover:text-fg"
							>
								CSV
							</button>
						</div>

						<ul className={`mt-2 ${view === "withheld" ? "hatch" : ""}`}>
							{rows.map((p) => (
								<Row key={p.username} p={p} />
							))}
						</ul>

						{rows.length === 0 && (
							<p className="py-10 text-center font-mono text-[12px] text-dimmer">
								{q ? `Nothing matches "${q}".` : "This list is empty."}
							</p>
						)}

						<p className="mt-8 font-mono text-[10px] leading-relaxed text-dimmer">
							Dotted names were read with low confidence — tap one to see the other readings.
						</p>
					</section>
				)}
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ *
 * idle
 * ------------------------------------------------------------------ */

function Idle({
	dragging,
	setDragging,
	onFile,
}: {
	dragging: boolean;
	setDragging: (v: boolean) => void;
	onFile: (f: File) => void;
}) {
	return (
		<>
			{/* The thesis: a follow is a directed edge, and there are exactly
			    three ways two accounts can be connected. */}
			<ul className="mt-9 space-y-0 border-y border-line">
				{[
					["you", "───▶", "them", "Not following you back", true],
					["you", "◀───", "them", "You don't follow back", false],
					["you", "◀──▶", "them", "Mutual", false],
				].map(([a, arrow, b, label, primary]) => (
					<li
						key={label as string}
						className="flex items-baseline gap-4 border-b border-line py-3 last:border-0"
					>
						<span className="w-[132px] shrink-0 font-mono text-[13px] whitespace-nowrap text-dim">
							{a}
							<span className={`px-1.5 ${primary ? "text-signal" : "text-dimmer"}`}>{arrow}</span>
							{b}
						</span>
						<span
							className={`text-[14px] leading-none ${primary ? "font-medium text-fg" : "text-dimmer"}`}
						>
							{label}
						</span>
					</li>
				))}
			</ul>

			<label
				onDragOver={(e) => {
					e.preventDefault();
					setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={(e) => {
					e.preventDefault();
					setDragging(false);
					const f = e.dataTransfer.files?.[0];
					if (f) onFile(f);
				}}
				className={`mt-9 flex cursor-pointer flex-wrap items-center justify-between gap-4 rounded-[4px] border border-dashed px-5 py-5 transition-colors ${
					dragging ? "border-signal bg-signal/6" : "border-line-bright bg-surface hover:border-dim"
				}`}
			>
				<input
					type="file"
					accept="video/*"
					className="sr-only"
					onChange={(e) => {
						const f = e.target.files?.[0];
						if (f) onFile(f);
					}}
				/>
				<span>
					<span className="block text-[17px] font-medium text-fg">Drop a screen recording</span>
					<span className="mt-1 block font-mono text-[11px] text-dimmer">
						Read in this tab. Never uploaded.
					</span>
				</span>
				<span className="rounded-[3px] border border-line-bright px-3 py-1.5 font-mono text-[11px] tracking-wider text-dim uppercase">
					Choose file
				</span>
			</label>

			<section className="mt-14">
				<h2 className="font-mono text-[11px] tracking-[0.3em] text-dim uppercase">Record it like this</h2>
				<ul className="mt-5 space-y-3.5">
					{[
						[
							"Scroll, pause, scroll, pause.",
							"About one screenful at a time. A paused frame reads almost perfectly; a fast fling smears the text past recognition.",
						],
						[
							"Pause for a beat after switching tabs.",
							"Rows from the old list keep sliding off-screen during the animation, and they must not be counted against the new one.",
						],
						[
							"Start at the top of each list, reach the bottom.",
							"A recording that begins mid-list has no way to know what it missed.",
						],
						[
							"Capture followers and following in one recording.",
							"Both lists are needed to compare them.",
						],
					].map(([head, body]) => (
						<li key={head} className="border-l border-line pl-4">
							<p className="text-[14px] leading-snug font-medium text-fg">{head}</p>
							<p className="mt-1 max-w-lg text-[13px] leading-relaxed text-dimmer">{body}</p>
						</li>
					))}
				</ul>
				<p className="mt-8 max-w-lg text-[13px] leading-relaxed text-dimmer">
					A longer file is fine. Nothing uploads, so length costs you nothing but patience.
				</p>
			</section>
		</>
	);
}
