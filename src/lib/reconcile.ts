/**
 * Sightings -> voted identities -> diff. Pure and synchronous: no DOM, no video,
 * no async. Everything here must be unit-testable with plain objects.
 *
 * Contract per docs/superpowers/specs/2026-07-27-followeder-design.md §4.1, §6.
 */

import type { Gap, ScanResult, Section, Sighting } from "./scan";

export interface Person {
	/** winning (modal) reading */
	username: string;
	/** how many frames voted for this identity */
	sightings: number;
	/** mean confidence of the winning reading */
	conf: number;
	/** losing readings — surfaced in the UI rather than hidden */
	variants: string[];
}

export interface CountCheck {
	ocrNames: number;
	labelSaid: number | null;
	/** every issue found, in user-facing wording. Always shown. Empty = nothing detected. */
	reasons: string[];
	/**
	 * Narrow, and it SUPPRESSES the asymmetric lists rather than labelling them.
	 * FALSE only when the section is demonstrably complete: exact count parity,
	 * sawListTop && sawEndMarker, no gaps, no motion during a transition.
	 *
	 * A count mismatch DOES set this. If Followers misses the mutual `alice`
	 * while Following has her, `following - followers` accuses her of not
	 * following back. Incomplete input to a set difference is not a smaller
	 * answer, it is a wrong one. Expect suppression to be common. (§6.6)
	 */
	unsafeForDiff: boolean;
}

export interface Ambiguity {
	/** every identity withheld by this finding, as full objects so the UI can render them */
	people: Person[];
	reason: "cross-section-near-match" | "contested-within-section";
}

export interface Reconciled {
	followers: Person[];
	following: Person[];
	/** §6.7 — near-identical across sections; withheld from every primary list */
	ambiguous: Ambiguity[];
	gaps: Gap[];
	check: Record<Section, CountCheck>;
}

export interface DiffResult {
	/** following - followers. The list people came for. EMPTY when suppressed. */
	notFollowingBack: Person[];
	/** followers - following. EMPTY when suppressed. */
	youDontFollowBack: Person[];
	/** always shown — a missing name shrinks this list, it cannot corrupt it */
	mutuals: Person[];
	/** withheld by §6.3 (contested) AND §6.7 (cross-section near-match) — both */
	withheld: Person[];
	/**
	 * True when either section set `unsafeForDiff`. The asymmetric lists are
	 * then returned EMPTY — suppressed, not caveated. A provisional false
	 * accusation is still a false accusation. (§6.6)
	 */
	suppressed: boolean;
	/**
	 * The asymmetric lists that `suppressed` withheld, present ONLY when
	 * suppressed is true.
	 *
	 * Deliberately not named `notFollowingBack` so nothing renders it by
	 * accident: reaching for this field is an explicit choice to show a result
	 * the evidence does not support. The UI puts it behind a user action and
	 * keeps the warning visible. Undefined when the diff is trustworthy.
	 */
	unsafe?: { notFollowingBack: Person[]; youDontFollowBack: Person[] };
}

// ---- §9 identity constants ----

/** seconds; bounds comparison cost only — never defines identity (§6.3) */
export const CLUSTER_TTL = 2.0;
/** below this length, matching is exact-only (§6.1) */
export const FUZZY_MIN_LEN = 8;
export const FUZZY_MAX_ED = 1;
/**
 * §6.7 cross-section only. Within a section, near-identical strings that
 * co-occur are different people, so ED<=1 is deliberately tight. ACROSS
 * sections the prior inverts: an unmatched near-twin is almost certainly one
 * person read two ways. Measured on the slower sample, ED<=1 let two real
 * duplicate pairs through into the accusation list —
 * `jamesshoutista_`/`jamessbautista_` and `clarkcastor`/`clariccastor` — both
 * at ED 2. Long names carry enough signal that 2 edits is still the same
 * person; short ones do not, so they stay at 1.
 */
export const XSECTION_LONG_LEN = 10;
export const XSECTION_MAX_ED_LONG = 2;
export const MIN_CONF = 45;

interface Cluster {
	id: number;
	readings: Sighting[];
	lastT: number;
}

interface VotedCluster {
	cluster: Cluster;
	person: Person;
	winnerCount: number;
	winnerConf: number;
}

interface ClusterResult {
	clusters: Cluster[];
	cannotLink: Map<number, Set<number>>;
}

interface Consolidated {
	all: Person[];
	available: Person[];
	contested: Set<string>;
}

const SECTIONS: readonly Section[] = ["followers", "following"];

/** Levenshtein distance, capped — returns > max as soon as it is exceeded. */
function editDistanceAtMost(a: string, b: string, max: number): boolean {
	if (a === b) return true;
	if (Math.abs(a.length - b.length) > max) return false;
	let prev = new Array<number>(b.length + 1);
	let curr = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		let rowMin = curr[0];
		for (let j = 1; j <= b.length; j++) {
			curr[j] = Math.min(
				prev[j] + 1,
				curr[j - 1] + 1,
				prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
			if (curr[j] < rowMin) rowMin = curr[j];
		}
		if (rowMin > max) return false;
		[prev, curr] = [curr, prev];
	}
	return prev[b.length] <= max;
}

/** §6.7 cross-section similarity. Looser than within-section by design. */
function crossSectionNear(a: string, b: string): boolean {
	const max = Math.min(a.length, b.length) >= XSECTION_LONG_LEN
		? XSECTION_MAX_ED_LONG
		: FUZZY_MAX_ED;
	return editDistanceAtMost(a, b, max);
}

/** Exact Levenshtein <= 1 without allocating a general-purpose DP matrix. */
function withinOne(a: string, b: string): boolean {
	if (a === b) return true;
	if (Math.abs(a.length - b.length) > FUZZY_MAX_ED) return false;

	if (a.length === b.length) {
		let edits = 0;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i] && ++edits > FUZZY_MAX_ED) return false;
		}
		return true;
	}

	const shorter = a.length < b.length ? a : b;
	const longer = a.length < b.length ? b : a;
	let i = 0;
	let j = 0;
	let edits = 0;
	while (i < shorter.length && j < longer.length) {
		if (shorter[i] === longer[j]) {
			i++;
			j++;
		} else {
			if (++edits > FUZZY_MAX_ED) return false;
			j++;
		}
	}
	return true;
}

function linked(
	cannotLink: Map<number, Set<number>>,
	a: number,
	b: number,
): boolean {
	return cannotLink.get(a)?.has(b) ?? false;
}

function addLink(
	cannotLink: Map<number, Set<number>>,
	a: number,
	b: number,
): void {
	if (a === b) return;
	if (!cannotLink.has(a)) cannotLink.set(a, new Set());
	if (!cannotLink.has(b)) cannotLink.set(b, new Set());
	cannotLink.get(a)?.add(b);
	cannotLink.get(b)?.add(a);
}

function addReading(cluster: Cluster, sighting: Sighting): void {
	cluster.readings.push(sighting);
	cluster.lastT = Math.max(cluster.lastT, sighting.t);
}

function mostRecent(clusters: Cluster[]): Cluster | undefined {
	let best: Cluster | undefined;
	for (const cluster of clusters) {
		if (!best || cluster.lastT > best.lastT) best = cluster;
	}
	return best;
}

function clusterSightings(sightings: Sighting[]): ClusterResult {
	const byFrame = new Map<number, Sighting[]>();
	for (const sighting of sightings) {
		const frame = byFrame.get(sighting.frameId);
		if (frame) frame.push(sighting);
		else byFrame.set(sighting.frameId, [sighting]);
	}

	const frames = [...byFrame.entries()]
		.map(([frameId, lines]) => ({
			frameId,
			t: Math.min(...lines.map(({ t }) => t)),
			lines: [...lines].sort((a, b) => a.y - b.y),
		}))
		.sort((a, b) => a.t - b.t || a.frameId - b.frameId);
	const clusters: Cluster[] = [];
	const cannotLink = new Map<number, Set<number>>();

	for (const frame of frames) {
		const active = clusters.filter(
			({ lastT }) => frame.t - lastT <= CLUSTER_TTL,
		);
		const used = new Set<number>();
		const assigned = new Map<Sighting, Cluster>();

		// Exact phase is deliberately complete before any fuzzy comparison.
		for (const line of frame.lines) {
			const candidate = mostRecent(
				active.filter(
					(cluster) =>
						!used.has(cluster.id) &&
						cluster.readings.some(({ text }) => text === line.text),
				),
			);
			if (!candidate) continue;
			addReading(candidate, line);
			used.add(candidate.id);
			assigned.set(line, candidate);
		}

		for (const line of frame.lines) {
			if (assigned.has(line) || line.text.length < FUZZY_MIN_LEN) continue;
			const candidate = mostRecent(
				active.filter(
					(cluster) =>
						!used.has(cluster.id) &&
						cluster.readings.some(
							({ text }) =>
								text.length >= FUZZY_MIN_LEN && withinOne(text, line.text),
						),
				),
			);
			if (!candidate) continue;
			addReading(candidate, line);
			used.add(candidate.id);
			assigned.set(line, candidate);
		}

		for (const line of frame.lines) {
			if (assigned.has(line)) continue;
			const cluster: Cluster = {
				id: clusters.length,
				readings: [line],
				lastT: line.t,
			};
			clusters.push(cluster);
			assigned.set(line, cluster);
		}

		const coOccurring = [...new Set(assigned.values())];
		for (let i = 0; i < coOccurring.length; i++) {
			for (let j = i + 1; j < coOccurring.length; j++) {
				addLink(cannotLink, coOccurring[i].id, coOccurring[j].id);
			}
		}
	}

	return { clusters, cannotLink };
}

function vote(cluster: Cluster): VotedCluster {
	const stats = new Map<string, { count: number; conf: number; first: number }>();
	for (const [first, reading] of cluster.readings.entries()) {
		const current = stats.get(reading.text);
		if (current) {
			current.count++;
			current.conf += reading.conf;
		} else {
			stats.set(reading.text, { count: 1, conf: reading.conf, first });
		}
	}

	let winner = "";
	let winnerStats: { count: number; conf: number; first: number } | undefined;
	for (const [text, current] of stats) {
		if (
			!winnerStats ||
			current.count > winnerStats.count ||
			(current.count === winnerStats.count && current.conf > winnerStats.conf) ||
			(current.count === winnerStats.count &&
				current.conf === winnerStats.conf &&
				current.first < winnerStats.first)
		) {
			winner = text;
			winnerStats = current;
		}
	}

	if (!winnerStats) throw new Error("Cannot vote an empty cluster");
	return {
		cluster,
		person: {
			username: winner,
			sightings: cluster.readings.length,
			conf: winnerStats.conf / winnerStats.count,
			variants: [...stats.keys()].filter((text) => text !== winner),
		},
		winnerCount: winnerStats.count,
		winnerConf: winnerStats.conf,
	};
}

function mergeVotes(votes: VotedCluster[]): Person {
	const variants = new Set<string>();
	let sightings = 0;
	let winnerCount = 0;
	let winnerConf = 0;
	for (const current of votes) {
		sightings += current.person.sightings;
		winnerCount += current.winnerCount;
		winnerConf += current.winnerConf;
		for (const variant of current.person.variants) variants.add(variant);
	}
	return {
		username: votes[0].person.username,
		sightings,
		conf: winnerConf / winnerCount,
		variants: [...variants],
	};
}

function consolidate(result: ClusterResult): Consolidated {
	// §6.4 precedes voting conflict escalation by design.
	const votes = result.clusters
		.filter(
			(cluster) =>
				cluster.readings.length !== 1 || cluster.readings[0].conf >= MIN_CONF,
		)
		.map(vote);
	const byWinner = new Map<string, VotedCluster[]>();
	for (const current of votes) {
		const bucket = byWinner.get(current.person.username);
		if (bucket) bucket.push(current);
		else byWinner.set(current.person.username, [current]);
	}

	const all: Person[] = [];
	const available: Person[] = [];
	const contested = new Set<string>();
	for (const [username, bucket] of byWinner) {
		let conflict = false;
		for (let i = 0; i < bucket.length && !conflict; i++) {
			for (let j = i + 1; j < bucket.length; j++) {
				if (
					linked(
						result.cannotLink,
						bucket[i].cluster.id,
						bucket[j].cluster.id,
					)
				) {
					conflict = true;
					break;
				}
			}
		}

		if (conflict) {
			contested.add(username);
			all.push(...bucket.map(({ person }) => person));
		} else {
			const person = mergeVotes(bucket);
			all.push(person);
			available.push(person);
		}
	}
	return { all, available, contested };
}

function countCheck(
	section: Section,
	ocrNames: number,
	labelSaid: number | null,
	scan: ScanResult,
	quarantined: number,
): CountCheck {
	const name = section === "followers" ? "followers" : "following";
	const reasons: string[] = [];
	const gaps = scan.gaps.filter((gap) => gap.section === section);
	const endpoints = scan.endpoints[section];

	if (ocrNames === 0) reasons.push(`No ${name} names were recovered by OCR.`);
	if (labelSaid === null) {
		reasons.push(`Instagram's ${name} label count was not captured.`);
	} else if (ocrNames !== labelSaid) {
		const delta = Math.abs(ocrNames - labelSaid);
		const direction = ocrNames < labelSaid ? "fewer" : "more";
		reasons.push(
			`${delta} ${direction} ${name} name${delta === 1 ? "" : "s"} were recovered by OCR than Instagram's label (${ocrNames} vs ${labelSaid}).`,
		);
	}
	if (!endpoints.sawListTop) {
		reasons.push(`The recording did not show the top of the ${name} list.`);
	}
	if (!endpoints.sawEndMarker) {
		reasons.push(`The recording did not reach the end of the ${name} list.`);
	}
	// One line per section, not one per gap: 13 near-identical rows buried the
	// result. The timeline already plots every gap individually.
	if (gaps.length) {
		// 2dp, trailing zeros dropped: raw float seconds printed 15 digits.
		const at = (t: number) => String(Number(t.toFixed(2)));
		const unresolved = gaps.filter((g) => !g.confirmed).length;
		const kind = unresolved === gaps.length
			? "unresolved "
			: unresolved === 0
				? "confirmed "
				: "";
		const spans = gaps.slice(0, 3).map((g) => `${at(g.tStart)}–${at(g.tEnd)}s`).join(", ");
		const more = gaps.length > 3 ? ` and ${gaps.length - 3} more` : "";
		reasons.push(
			`${gaps.length} ${kind}gap${gaps.length === 1 ? "" : "s"} in the ${name} scroll ` +
				`(${spans}${more}).`,
		);
	}
	if (endpoints.movingTransition) {
		reasons.push(`Content moved during an unclassified ${name} transition.`);
	}
	if (quarantined > 0) {
		reasons.push(
			`${quarantined} ${name} identit${quarantined === 1 ? "y was" : "ies were"} withheld because OCR could not distinguish them safely.`,
		);
	}

	return {
		ocrNames,
		labelSaid,
		reasons,
		unsafeForDiff:
			ocrNames === 0 ||
			labelSaid === null ||
			ocrNames !== labelSaid ||
			!endpoints.sawListTop ||
			!endpoints.sawEndMarker ||
			gaps.length > 0 ||
			endpoints.movingTransition,
	};
}

/** Cluster, vote, dedupe, quarantine, and gate. Implementation per §6. */
export function reconcile(scan: ScanResult): Reconciled {
	const consolidated = Object.fromEntries(
		SECTIONS.map((section) => [
			section,
			consolidate(
				clusterSightings(
					scan.sightings.filter((sighting) => sighting.section === section),
				),
			),
		]),
	) as Record<Section, Consolidated>;
	const ambiguous: Ambiguity[] = [];
	const contestedNames = new Set([
		...consolidated.followers.contested,
		...consolidated.following.contested,
	]);
	for (const username of contestedNames) {
		ambiguous.push({
			people: SECTIONS.flatMap((section) =>
				consolidated[section].all.filter(
					(person) => person.username === username,
				),
			),
			reason: "contested-within-section",
		});
	}

	let followers = consolidated.followers.available.filter(
		({ username }) => !contestedNames.has(username),
	);
	let following = consolidated.following.available.filter(
		({ username }) => !contestedNames.has(username),
	);
	const followerNames = new Set(followers.map(({ username }) => username));
	const followingNames = new Set(following.map(({ username }) => username));
	const unmatchedFollowers = followers.filter(
		({ username }) => !followingNames.has(username),
	);
	const unmatchedFollowing = following.filter(
		({ username }) => !followerNames.has(username),
	);
	const nearNames = new Set<string>();

	for (const person of unmatchedFollowers) {
		for (const opposite of following) {
			if (crossSectionNear(person.username, opposite.username)) {
				nearNames.add(person.username);
				nearNames.add(opposite.username);
			}
		}
	}
	for (const person of unmatchedFollowing) {
		for (const opposite of followers) {
			if (crossSectionNear(person.username, opposite.username)) {
				nearNames.add(person.username);
				nearNames.add(opposite.username);
			}
		}
	}
	if (nearNames.size > 0) {
		ambiguous.push({
			people: [...followers, ...following].filter(({ username }) =>
				nearNames.has(username),
			),
			reason: "cross-section-near-match",
		});
		followers = followers.filter(({ username }) => !nearNames.has(username));
		following = following.filter(({ username }) => !nearNames.has(username));
	}

	const quarantinedNames = new Set([...contestedNames, ...nearNames]);
	const check = Object.fromEntries(
		SECTIONS.map((section) => [
			section,
			countCheck(
				section,
				consolidated[section].all.length,
				scan.labelCounts[section] ?? null,
				scan,
				consolidated[section].all.filter(({ username }) =>
					quarantinedNames.has(username),
				).length,
			),
		]),
	) as Record<Section, CountCheck>;

	return { followers, following, ambiguous, gaps: scan.gaps, check };
}

/** Set operations minus anything §6.7 quarantined. */
export function diff(r: Reconciled): DiffResult {
	const followerNames = new Set(r.followers.map(({ username }) => username));
	const followingNames = new Set(r.following.map(({ username }) => username));
	const suppressed = SECTIONS.some((section) => r.check[section].unsafeForDiff);
	const withheld = [...new Set(r.ambiguous.flatMap(({ people }) => people))];

	const heldNames = new Set(withheld.map(({ username }) => username));
	const notFollowingBack = r.following.filter(
		({ username }) => !followerNames.has(username) && !heldNames.has(username),
	);
	const youDontFollowBack = r.followers.filter(
		({ username }) => !followingNames.has(username) && !heldNames.has(username),
	);

	return {
		notFollowingBack: suppressed ? [] : notFollowingBack,
		youDontFollowBack: suppressed ? [] : youDontFollowBack,
		mutuals: r.followers.filter(({ username }) => followingNames.has(username)),
		withheld,
		suppressed,
		...(suppressed ? { unsafe: { notFollowingBack, youDontFollowBack } } : {}),
	};
}
