import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's strip-types runner requires the explicit .ts extension.
import { diff, reconcile } from "./reconcile.ts";
import type {
	Endpoints,
	Gap,
	ScanResult,
	Section,
	Sighting,
} from "./scan";

const complete: Endpoints = {
	sawListTop: true,
	sawEndMarker: true,
	movingTransition: false,
	endedScrolling: false,
};

function seen(
	text: string,
	frameId: number,
	t: number,
	section: Section = "followers",
	conf = 90,
	y = 0,
): Sighting {
	return { text, raw: text, conf, t, y, frameId, section };
}

function scan(
	sightings: Sighting[],
	options: {
		labels?: ScanResult["labelCounts"];
		gaps?: Gap[];
		endpoints?: Partial<Record<Section, Partial<Endpoints>>>;
	} = {},
): ScanResult {
	return {
		sightings,
		labelCounts: options.labels ?? {},
		gaps: options.gaps ?? [],
		sectionRuns: [],
		endpoints: {
			followers: { ...complete, ...options.endpoints?.followers },
			following: { ...complete, ...options.endpoints?.following },
		},
		ocrTimes: [...new Set(sightings.map(({ t }) => t))].sort((a, b) => a - b),
		duration: Math.max(0, ...sightings.map(({ t }) => t)),
	};
}

const usernames = (people: { username: string }[]) =>
	people.map(({ username }) => username).sort();

test("co-occurring jm.cruz and jm.cruzz stay separate", () => {
	const result = reconcile(
		scan([
			seen("jm.cruz", 1, 0, "followers", 90, 10),
			seen("jm.cruzz", 1, 0, "followers", 90, 20),
			seen("jm.cruz", 2, 0.1, "followers", 90, 10),
			seen("jm.cruzz", 2, 0.1, "followers", 90, 20),
		]),
	);

	assert.deepEqual(usernames(result.followers), ["jm.cruz", "jm.cruzz"]);
});

test("distinct one- and two-character usernames never fuzzy-merge", () => {
	const result = reconcile(
		scan([
			seen("a", 1, 0),
			seen("b", 2, 0.1),
			seen("ab", 3, 0.2),
			seen("ac", 4, 0.3),
		]),
	);

	assert.deepEqual(usernames(result.followers), ["a", "ab", "ac", "b"]);
});

test("fuzzy matching requires both spellings to be at least eight characters", () => {
	const result = reconcile(
		scan([seen("abcdefg", 1, 0), seen("abcdefgh", 2, 0.1)]),
	);

	assert.deepEqual(usernames(result.followers), ["abcdefg", "abcdefgh"]);
});

test("three corrupted readings out of ten lose the modal vote", () => {
	const sightings = Array.from({ length: 10 }, (_, i) =>
		seen(i < 3 ? "abcdxfghij" : "abcdefghij", i, i / 10),
	);
	const [person] = reconcile(scan(sightings)).followers;

	assert.equal(person.username, "abcdefghij");
	assert.equal(person.sightings, 10);
	assert.equal(person.conf, 90);
	assert.deepEqual(person.variants, ["abcdxfghij"]);
});

test("summed confidence breaks a tied exact-string vote", () => {
	const [person] = reconcile(
		scan([
			seen("abcdefgh", 1, 0, "followers", 40),
			seen("abcdefgi", 2, 0.1, "followers", 90),
			seen("abcdefgh", 3, 0.2, "followers", 40),
			seen("abcdefgi", 4, 0.3, "followers", 90),
		]),
	).followers;

	assert.equal(person.username, "abcdefgi");
	assert.deepEqual(person.variants, ["abcdefgh"]);
});

test("TTL expiry after five and ten seconds does not duplicate an identity", () => {
	const [person] = reconcile(
		scan([
			seen("same.person", 1, 0),
			seen("same.person", 2, 5),
			seen("same.person", 3, 15),
		]),
	).followers;

	assert.equal(person.username, "same.person");
	assert.equal(person.sightings, 3);
});

test("clusters are partitioned by section", () => {
	const result = reconcile(
		scan([
			seen("same.person", 1, 0, "followers"),
			seen("same.person", 1, 0, "following"),
		]),
	);

	assert.deepEqual(usernames(result.followers), ["same.person"]);
	assert.deepEqual(usernames(result.following), ["same.person"]);
});

test("identical co-occurring rows are contested and withheld bilaterally", () => {
	const result = reconcile(
		scan(
			[
				seen("abcdefgh", 1, 0, "followers", 90, 10),
				seen("abcdefgh", 1, 0, "followers", 90, 20),
				seen("abcdefgh", 2, 0, "following"),
			],
			{ labels: { followers: 2, following: 1 } },
		),
	);
	const finding = result.ambiguous.find(
		({ reason }) => reason === "contested-within-section",
	);

	assert.deepEqual(result.followers, []);
	assert.deepEqual(result.following, []);
	assert.equal(result.check.followers.ocrNames, 2);
	assert.equal(result.check.following.ocrNames, 1);
	assert.equal(finding?.people.length, 3);
	assert.deepEqual(usernames(diff(result).withheld), [
		"abcdefgh",
		"abcdefgh",
		"abcdefgh",
	]);
});

test("cannot-link edges survive when later variants make both clusters vote alike", () => {
	const sightings = [
		seen("abcdefgh", 1, 0, "followers", 90, 10),
		seen("abcdefgi", 1, 0, "followers", 90, 20),
	];
	for (let frame = 2; frame <= 4; frame++) {
		sightings.push(
			seen("abcdefgh", frame, frame / 10, "followers", 90, 10),
			seen("abcdefgh", frame, frame / 10, "followers", 90, 20),
		);
	}
	const result = reconcile(scan(sightings));

	assert.deepEqual(result.followers, []);
	assert.equal(result.ambiguous[0]?.reason, "contested-within-section");
	assert.equal(result.ambiguous[0]?.people.length, 2);
});

test("a low-confidence singleton is dropped before it can contest a real row", () => {
	const result = reconcile(
		scan([
			seen("abcdefgh", 1, 0, "followers", 90, 10),
			seen("abcdefgh", 1, 0, "followers", 40, 20),
		]),
	);

	assert.deepEqual(usernames(result.followers), ["abcdefgh"]);
	assert.equal(result.ambiguous.length, 0);
});

test("split valid-looking OCR lines cannot silently merge with their neighbour", () => {
	const result = reconcile(
		scan([
			seen("longpart", 1, 0, "followers", 90, 10),
			seen("longqart", 1, 0, "followers", 90, 20),
		]),
	);

	assert.deepEqual(usernames(result.followers), ["longpart", "longqart"]);
});

test("cross-section near matches are quarantined", () => {
	const result = reconcile(
		scan(
			[
				seen("vnz.cortez", 1, 0, "followers"),
				seen("vnz.cortaz", 2, 0, "following"),
			],
			{ labels: { followers: 1, following: 1 } },
		),
	);
	const output = diff(result);

	assert.deepEqual(result.followers, []);
	assert.deepEqual(result.following, []);
	assert.deepEqual(usernames(output.withheld), ["vnz.cortaz", "vnz.cortez"]);
	assert.deepEqual(output.mutuals, []);
});

test("cross-section comparison includes first-character edits", () => {
	const result = reconcile(
		scan(
			[
				seen("alice123", 1, 0, "followers"),
				seen("blice123", 2, 0, "following"),
			],
			{ labels: { followers: 1, following: 1 } },
		),
	);

	assert.deepEqual(usernames(diff(result).withheld), ["alice123", "blice123"]);
	assert.equal(result.ambiguous[0]?.reason, "cross-section-near-match");
});

test("an unmatched name is compared with matched names in the opposite section", () => {
	const result = reconcile(
		scan(
			[
				seen("vnz.cortez", 1, 0, "followers"),
				seen("vnz.cortez", 2, 0, "following", 90, 10),
				seen("vnz.cortaz", 2, 0, "following", 90, 20),
			],
			{ labels: { followers: 1, following: 2 } },
		),
	);

	assert.deepEqual(result.followers, []);
	assert.deepEqual(result.following, []);
	assert.deepEqual(usernames(diff(result).withheld), [
		"vnz.cortaz",
		"vnz.cortez",
		"vnz.cortez",
	]);
});

test("three-way cross-section near-collisions quarantine every endpoint", () => {
	const result = reconcile(
		scan(
			[
				seen("aaaaaaaa", 1, 0, "followers"),
				seen("aaaaaaab", 2, 0, "following", 90, 10),
				seen("aaaaaaac", 2, 0, "following", 90, 20),
			],
			{ labels: { followers: 1, following: 2 } },
		),
	);

	assert.deepEqual(usernames(diff(result).withheld), [
		"aaaaaaaa",
		"aaaaaaab",
		"aaaaaaac",
	]);
	assert.deepEqual(result.followers, []);
	assert.deepEqual(result.following, []);
});

test("count mismatch is literal, unsafe, and suppresses asymmetric lists", () => {
	const result = reconcile(
		scan(
			[
				seen("alice", 1, 0, "followers"),
				seen("carol", 2, 0, "following"),
			],
			{ labels: { followers: 2, following: 1 } },
		),
	);
	const output = diff(result);

	assert.deepEqual(
		{
			ocrNames: result.check.followers.ocrNames,
			labelSaid: result.check.followers.labelSaid,
		},
		{ ocrNames: 1, labelSaid: 2 },
	);
	assert.equal(result.check.followers.unsafeForDiff, true);
	assert.match(result.check.followers.reasons.join(" "), /1 fewer.*1 vs 2/i);
	assert.equal(output.suppressed, true);
	assert.deepEqual(output.notFollowingBack, []);
	assert.deepEqual(output.youDontFollowBack, []);
});

test("starting mid-list is unsafe even with count parity and no gaps", () => {
	const result = reconcile(
		scan([seen("alice", 1, 0, "followers")], {
			labels: { followers: 1, following: 0 },
			endpoints: { followers: { sawListTop: false } },
		}),
	);

	assert.equal(result.check.followers.unsafeForDiff, true);
	assert.match(result.check.followers.reasons.join(" "), /top/i);
	assert.equal(diff(result).suppressed, true);
});

test("an unconfirmed gap is unsafe and has a specific reason", () => {
	const result = reconcile(
		scan(
			[
				seen("alice", 1, 0, "followers"),
				seen("carol", 2, 0, "following"),
			],
			{
				labels: { followers: 1, following: 1 },
				gaps: [
					{ section: "followers", tStart: 1.25, tEnd: 1.75, confirmed: false },
				],
			},
		),
	);

	assert.equal(result.check.followers.unsafeForDiff, true);
	assert.match(
		result.check.followers.reasons.join(" "),
		/unresolved.*gap.*1\.25.*1\.75/i,
	);
});

test("motion during an unclassified transition is unsafe", () => {
	const result = reconcile(
		scan(
			[
				seen("alice", 1, 0, "followers"),
				seen("carol", 2, 0, "following"),
			],
			{
				labels: { followers: 1, following: 1 },
				endpoints: { following: { movingTransition: true } },
			},
		),
	);

	assert.equal(result.check.following.unsafeForDiff, true);
	assert.match(result.check.following.reasons.join(" "), /moved.*transition/i);
});

test("exact parity, both endpoints, and no gaps permits asymmetric lists", () => {
	const result = reconcile(
		scan(
			[
				seen("alice", 1, 0, "followers"),
				seen("bob", 2, 0.1, "followers"),
				seen("bob", 3, 0, "following"),
				seen("carol", 4, 0.1, "following"),
			],
			{ labels: { followers: 2, following: 2 } },
		),
	);
	const output = diff(result);

	assert.equal(result.check.followers.unsafeForDiff, false);
	assert.equal(result.check.following.unsafeForDiff, false);
	assert.deepEqual(result.check.followers.reasons, []);
	assert.equal(output.suppressed, false);
	assert.deepEqual(usernames(output.mutuals), ["bob"]);
	assert.deepEqual(usernames(output.notFollowingBack), ["carol"]);
	assert.deepEqual(usernames(output.youDontFollowBack), ["alice"]);
});

test("an empty section suppresses the diff", () => {
	const result = reconcile(
		scan([seen("carol", 1, 0, "following")], {
			labels: { followers: 0, following: 1 },
		}),
	);
	const output = diff(result);

	assert.equal(result.check.followers.unsafeForDiff, true);
	assert.match(result.check.followers.reasons.join(" "), /no followers names/i);
	assert.equal(output.suppressed, true);
	assert.deepEqual(output.notFollowingBack, []);
	assert.deepEqual(output.youDontFollowBack, []);
});
