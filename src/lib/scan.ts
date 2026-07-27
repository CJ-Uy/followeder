/**
 * Video -> OCR sightings. Owns everything async and everything touching pixels,
 * including gap detection and bisection (both need to seek the video).
 *
 * Contract per docs/superpowers/specs/2026-07-27-followeder-design.md §4.1, §5.
 */

import { createWorker, OEM, PSM, type Worker as TesseractWorker } from "tesseract.js";

export type Section = "followers" | "following";

export interface Sighting {
	/** normalized candidate username */
	text: string;
	/** pre-normalization OCR line; §5.5 validates this before stripping */
	raw: string;
	/** 0-100 from Tesseract */
	conf: number;
	/** source timestamp, seconds */
	t: number;
	/** line bbox top within the crop; establishes within-frame row order */
	y: number;
	/** which OCR'd frame — required for §6.1 co-occurrence blocking */
	frameId: number;
	section: Section;
}

export interface Gap {
	section: Section;
	tStart: number;
	tEnd: number;
	/** true if bisection bottomed out at frame granularity — rows genuinely lost */
	confirmed: boolean;
}

export interface SectionRun {
	section: Section;
	tStart: number;
	tEnd: number;
}

/** Per-section endpoint status. reconcile.ts cannot re-derive these. (§6.6) */
export interface Endpoints {
	/** first accepted frame was flush with listTop */
	sawListTop: boolean;
	/** §5.7 END_MARKERS matched for this section */
	sawEndMarker: boolean;
	/** content moved while the section was unclassified */
	movingTransition: boolean;
	/** the section's last accepted frame was still scrolling */
	endedScrolling: boolean;
}

export interface ScanResult {
	sightings: Sighting[];
	/** modal tab-label count per section. Advisory only — see §6.5. */
	labelCounts: Partial<Record<Section, number>>;
	gaps: Gap[];
	/** contiguous runs of confirmed section attribution; transitions excluded */
	sectionRuns: SectionRun[];
	endpoints: Record<Section, Endpoints>;
	/** timestamps actually OCR'd, ascending — drives the provenance timeline */
	ocrTimes: number[];
	duration: number;
}

export interface ScanProgress {
	t: number;
	duration: number;
	ocrCount: number;
	found: number;
	section: Section | null;
}

// ---- §9 constants. Every value has a measured basis or an explicit gate. ----

/** fraction of width; drops avatar (left) and Message/Follow back buttons (right) */
export const CROP_X: readonly [number, number] = [0.16, 0.63];
export const LIST_TOP_FALLBACK = 0.16;
export const CROP_EDGE_BG_PCT = 0.05;

/** MEASURED §3.5/§3.7 — swept against OCR output; 0.70/0.80/0.85 all worse */
export const THRESH_FACTOR = 0.75;
/**
 * §5.2 calibration ONLY. The 0.75 list threshold keeps just the bright ACTIVE
 * tab, but calibration must see both tabs to establish their order and read
 * both counts. Measured on the sample: at 0.75 OCR returns only
 * "587 followers"; at 0.50 it returns "587 followers 538 following".
 */
export const CAL_THRESH_FACTOR = 0.5;
/** MEASURED §3.5 — text frames >=165, blank frames <=11; center of the gap */
export const MIN_RANGE = 60;
/** Uppercase and space are REQUIRED so §5.5 can identify chrome. See §5.3. */
export const OCR_WHITELIST =
	"abcdefghijklmnopqrstuvwxyz0123456789._ABCDEFGHIJKLMNOPQRSTUVWXYZ ";

/** MEASURED §3.6 — paused frames 0-1, moving 3-22 */
export const MOTION_EPS = 2;
export const STEP_INIT = 0.15;
export const STEP_MIN = 1 / 30;
export const STEP_MAX = 1.0;
/**
 * MEASURED CORRECTION: OVERLAP_LO was 2. At the 55-73% per-frame recall of
 * §3.7, two consecutive frames must BOTH correctly read the same >=2 rows,
 * which frequently fails by chance and manufactured 61 phantom discontinuities
 * on the sample. 1 shared row still proves continuity. OVERLAP_HI unvalidated.
 */
export const OVERLAP_LO = 1;
export const OVERLAP_HI = 6;
/** consecutive high observations required to grow; shrinking is immediate (§5.1) */
export const GROW_STREAK = 2;
/** per discontinuity, NOT a global pool (§5.6) */
export const MAX_BISECT = 40;
/**
 * Global ceiling across ALL discontinuities. §5.6 made the budget
 * per-discontinuity to stop one early fling starving later ones, but left the
 * total unbounded: 61 discontinuities x 40 = 2440 extra OCR calls (8-20 min).
 * Measured on the sample. Fairness still comes from MAX_BISECT; this only
 * bounds the worst case.
 */
export const MAX_BISECT_TOTAL = 240;
/** "one decoded frame" == 1/PROBE_HZ; the bisection floor */
export const PROBE_HZ = 30;

export const SECTION_CONFIRM_PROBES = 2;

/**
 * §5.4 — the per-probe section classifier is a PIXEL MEASUREMENT, not OCR.
 * Comparing bright-pixel mass either side of the tab strip's midpoint costs a
 * few thousand pixel reads; running Tesseract per probe would cost ~1153 calls
 * (4-10 min) on the sample before any list OCR began.
 */
export const MIN_LABEL_MASS = 0.004; // fraction of strip pixels above T
export const LABEL_MARGIN = 0.25; // |L-R| / (L+R); below this = mid-transition

/**
 * §5.7 — without this, suggested accounts after the end of Following are
 * reported as people you follow who don't follow back. Literal list; will need
 * maintenance across Instagram versions. See §5.7 for why no structural rule
 * can replace it.
 */
export const END_MARKERS =
	/^(discover people|suggested for you|find people to follow|see all suggestions)$/i;

interface ThresholdedFrame {
	gray: Uint8Array;
	width: number;
	height: number;
	med: number;
	range: number;
	threshold: number;
	inverted: boolean;
}

interface OcrLine {
	raw: string;
	conf: number;
	bbox: { x0: number; y0: number; x1: number; y1: number };
	words: { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }[];
}

interface Calibration {
	listTop: number;
	tabTop: number;
	tabBottom: number;
	x0: number;
	x1: number;
	/**
	 * Horizontal extent of each tab's own label, in strip-local pixels.
	 * REQUIRED: this UI has four tabs (followers / following / Subscriptions /
	 * Flagged), so a midpoint split puts BOTH real tabs on the left and can
	 * never report "following". Measured on the sample: midpoint said left on
	 * 1153/1153 frames; per-label boxes separate 672/469 with 12 ambiguous.
	 */
	followersBox: readonly [number, number];
	followingBox: readonly [number, number];
}

interface OcrFrame {
	t: number;
	section: Section;
	sightings: Sighting[];
	topY: number;
	lineHeight: number;
	marker: boolean;
	markerBoundaryKnown: boolean;
	verifiable: boolean;
}

interface Discontinuity {
	section: Section;
	lo: OcrFrame;
	hi: OcrFrame;
}

interface ProbeChoice {
	t: number;
	section: Section;
	frame: ThresholdedFrame;
	sharpness: number;
	dy: number;
	moving: boolean;
	mustOcr: boolean;
}

const FRAME_TIME = 1 / PROBE_HZ;
const TOP_BAND: readonly [number, number] = [0.05, 0.2];
const COUNT_RE = /([\d.,\s]+)\s*(followers|following)/gi;

function abortError(): DOMException {
	return new DOMException("Scan aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

function percentile(histogram: Uint32Array, total: number, q: number): number {
	const target = Math.ceil(total * q);
	let seen = 0;
	for (let i = 0; i < histogram.length; i++) {
		seen += histogram[i];
		if (seen >= target) return i;
	}
	return 255;
}

function thresholdPixels(
	data: Uint8ClampedArray,
	width: number,
	height: number,
	factor: number = THRESH_FACTOR,
): ThresholdedFrame {
	const gray = new Uint8Array(width * height);
	let histogram = new Uint32Array(256);
	for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
		const value = (77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2]) >> 8;
		gray[p] = value;
		histogram[value]++;
	}
	let med = percentile(histogram, gray.length, 0.5);
	const inverted = med > 128;
	if (inverted) {
		const flipped = new Uint32Array(256);
		for (let i = 0; i < 256; i++) flipped[255 - i] = histogram[i];
		histogram = flipped;
		for (let i = 0; i < gray.length; i++) gray[i] = 255 - gray[i];
		// §5.3: crop and median must be inverted together.
		med = 255 - med;
	}
	const range = percentile(histogram, gray.length, 0.995) - med;
	return { gray, width, height, med, range, threshold: med + factor * range, inverted };
}

function meanAbsoluteDifference(a: Uint8Array | null, b: Uint8Array): number {
	if (!a || a.length !== b.length) return Number.POSITIVE_INFINITY;
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
	return sum / a.length;
}

function sharpness(frame: ThresholdedFrame): number {
	const { gray, width, height } = frame;
	let score = 0;
	for (let y = 1; y < height - 1; y += 2) {
		const row = y * width;
		for (let x = 1; x < width - 1; x += 2) {
			const i = row + x;
			score += Math.abs(2 * gray[i] - gray[i - 1] - gray[i + 1]);
			score += Math.abs(2 * gray[i] - gray[i - width] - gray[i + width]);
		}
	}
	return score;
}

function rowProfile(frame: ThresholdedFrame): Float64Array {
	const bins = Math.min(128, frame.height);
	const profile = new Float64Array(bins);
	for (let y = 0; y < frame.height; y++) {
		const bin = Math.min(bins - 1, Math.floor((y * bins) / frame.height));
		const row = y * frame.width;
		for (let x = 0; x < frame.width; x++) {
			if (frame.gray[row + x] > frame.threshold) profile[bin] += 1 / frame.width;
		}
	}
	return profile;
}

/** Signed vertical cross-correlation of adjacent probe row profiles. */
function signedProfileOffset(previous: Float64Array | null, current: Float64Array, height: number): number {
	if (!previous || previous.length !== current.length) return 0;
	const n = current.length;
	const maxShift = Math.max(1, Math.floor(n / 4));
	let bestShift = 0;
	let best = Number.NEGATIVE_INFINITY;
	for (let shift = -maxShift; shift <= maxShift; shift++) {
		const start = Math.max(0, -shift);
		const end = Math.min(n, n - shift);
		let sumA = 0;
		let sumB = 0;
		for (let y = start; y < end; y++) {
			sumA += previous[y + shift];
			sumB += current[y];
		}
		const meanA = sumA / (end - start);
		const meanB = sumB / (end - start);
		let covariance = 0;
		let varianceA = 0;
		let varianceB = 0;
		for (let y = start; y < end; y++) {
			const a = previous[y + shift] - meanA;
			const b = current[y] - meanB;
			covariance += a * b;
			varianceA += a * a;
			varianceB += b * b;
		}
		const score = varianceA && varianceB ? covariance / Math.sqrt(varianceA * varianceB) : -1;
		if (score > best) {
			best = score;
			bestShift = shift;
		}
	}
	// previous[y + shift] vs current[y]: normal downward-list scrolling is positive.
	return (bestShift * height) / n;
}

function editDistanceAtMostOne(a: string, b: string): boolean {
	if (a === b) return true;
	if (Math.abs(a.length - b.length) > 1) return false;
	let i = 0;
	let j = 0;
	let edits = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			i++;
			j++;
			continue;
		}
		if (++edits > 1) return false;
		if (a.length > b.length) i++;
		else if (b.length > a.length) j++;
		else {
			i++;
			j++;
		}
	}
	return edits + Number(i < a.length || j < b.length) <= 1;
}

function sameRow(a: string, b: string): boolean {
	return a === b || (Math.min(a.length, b.length) >= 8 && editDistanceAtMostOne(a, b));
}

function median(values: number[]): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

/** Ordered LCS, then a y-displacement consistency filter (§5.1). */
function orderedOverlap(a: OcrFrame, b: OcrFrame): number {
	const left = [...a.sightings].sort((x, y) => x.y - y.y);
	const right = [...b.sightings].sort((x, y) => x.y - y.y);
	const dp = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
	for (let i = 1; i <= left.length; i++) {
		for (let j = 1; j <= right.length; j++) {
			dp[i][j] = sameRow(left[i - 1].text, right[j - 1].text)
				? dp[i - 1][j - 1] + 1
				: Math.max(dp[i - 1][j], dp[i][j - 1]);
		}
	}
	const displacements: number[] = [];
	for (let i = left.length, j = right.length; i && j; ) {
		if (sameRow(left[i - 1].text, right[j - 1].text) && dp[i][j] === dp[i - 1][j - 1] + 1) {
			displacements.push(right[j - 1].y - left[i - 1].y);
			i--;
			j--;
		} else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
		else j--;
	}
	if (displacements.length < 2) return displacements.length;
	const center = median(displacements);
	const tolerance = Math.max(a.lineHeight, b.lineHeight, 1);
	return displacements.filter((value) => Math.abs(value - center) <= tolerance).length;
}

function flattenLines(page: Awaited<ReturnType<TesseractWorker["recognize"]>>["data"]): OcrLine[] {
	return page.blocks?.flatMap((block) =>
		block.paragraphs.flatMap((paragraph) => paragraph.lines.map((line) => ({
			raw: line.text.replace(/[\r\n]+$/, ""),
			conf: line.confidence,
			bbox: line.bbox,
			words: line.words.map((word) => ({ text: word.text, bbox: word.bbox })),
		}))),
	) ?? [];
}

function parseCounts(lines: OcrLine[]): Partial<Record<Section, number>> {
	const counts: Partial<Record<Section, number>> = {};
	for (const line of lines) {
		COUNT_RE.lastIndex = 0;
		for (let match = COUNT_RE.exec(line.raw); match; match = COUNT_RE.exec(line.raw)) {
			const value = Number.parseInt(match[1].replace(/[.,\s]/g, ""), 10);
			if (Number.isFinite(value)) counts[match[2].toLowerCase() as Section] = value;
		}
	}
	return counts;
}

function modal(values: number[]): number | undefined {
	let winner: number | undefined;
	let winnerCount = 0;
	const frequencies = new Map<number, number>();
	for (const value of values) {
		const count = (frequencies.get(value) ?? 0) + 1;
		frequencies.set(value, count);
		if (count >= winnerCount) {
			winner = value;
			winnerCount = count;
		}
	}
	return winner;
}

function parseListLines(lines: OcrLine[], t: number, frameId: number, section: Section): OcrFrame {
	const markerLine = lines.find((line) => END_MARKERS.test(line.raw.trim()));
	const markerBoundaryKnown = !markerLine ||
		[markerLine.bbox.x0, markerLine.bbox.y0, markerLine.bbox.x1, markerLine.bbox.y1]
			.every(Number.isFinite);
	const markerY = markerBoundaryKnown && markerLine ? markerLine.bbox.y0 : undefined;
	const accepted: { sighting: Sighting; height: number }[] = [];
	if (!markerLine || markerBoundaryKnown) {
		for (const line of lines) {
			if (markerY !== undefined && line.bbox.y1 > markerY) continue;
			const raw = line.raw;
			// §5.5: validate raw evidence before normalization.
			if (/\s/.test(raw) || /[A-Z]/.test(raw)) continue;
			const text = raw.toLowerCase().replace(/[^a-z0-9._]/g, "");
			if (!/^[a-z0-9._]{1,30}$/.test(text) || !/[a-z0-9]/.test(text)) continue;
			if (![line.bbox.y0, line.bbox.y1].every(Number.isFinite)) continue;
			accepted.push({
				sighting: { text, raw, conf: line.conf, t, y: line.bbox.y0, frameId, section },
				height: Math.max(1, line.bbox.y1 - line.bbox.y0),
			});
		}
	}
	return {
		t, section,
		sightings: accepted.map(({ sighting }) => sighting),
		topY: accepted.length ? Math.min(...accepted.map(({ sighting }) => sighting.y)) : Infinity,
		lineHeight: median(accepted.map(({ height }) => height)),
		marker: Boolean(markerLine), markerBoundaryKnown, verifiable: accepted.length > 0,
	};
}

function classifySection(
	data: Uint8ClampedArray,
	width: number,
	height: number,
	threshold: number,
	inverted: boolean,
	followersBox: readonly [number, number],
	followingBox: readonly [number, number],
): Section | null {
	const massIn = ([bx0, bx1]: readonly [number, number]) => {
		const x0 = Math.max(0, Math.min(width, Math.floor(bx0)));
		const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil(bx1)));
		let hits = 0;
		for (let y = 0; y < height; y++) {
			for (let x = x0; x < x1; x++) {
				const i = (y * width + x) * 4;
				let value = (77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2]) >> 8;
				if (inverted) value = 255 - value;
				if (value > threshold) hits++;
			}
		}
		return hits / Math.max(1, (x1 - x0) * height);
	};
	const a = massIn(followersBox);
	const b = massIn(followingBox);
	const total = a + b;
	// Only the ACTIVE tab is rendered bright, so one box carries nearly all mass.
	if (Math.max(a, b) < MIN_LABEL_MASS || !total) return null;
	if (Math.abs(a - b) / total < LABEL_MARGIN) return null; // mid-transition
	return a > b ? "followers" : "following";
}

function waitForMetadata(video: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
	if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timeout = window.setTimeout(() => {
			cleanup();
			reject(new Error("The video metadata did not load. On iPhone, make sure the recording is downloaded locally and try again."));
		}, 15000);
		const cleanup = () => {
			window.clearTimeout(timeout);
			video.removeEventListener("loadedmetadata", loaded);
			video.removeEventListener("error", failed);
			signal?.removeEventListener("abort", aborted);
		};
		const loaded = () => { cleanup(); resolve(); };
		const failed = () => { cleanup(); reject(new Error("The video could not be decoded.")); };
		const aborted = () => { cleanup(); reject(abortError()); };
		video.addEventListener("loadedmetadata", loaded, { once: true });
		video.addEventListener("error", failed, { once: true });
		signal?.addEventListener("abort", aborted, { once: true });
	});
}

function seekVideo(video: HTMLVideoElement, t: number, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const target = Math.max(0, Math.min(t, video.duration));
	if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
		Math.abs(video.currentTime - target) < 0.0005) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			video.removeEventListener("seeked", done);
			video.removeEventListener("error", failed);
			signal?.removeEventListener("abort", aborted);
		};
		const done = () => { cleanup(); resolve(); };
		const failed = () => {
			cleanup();
			reject(new Error(`Could not decode the video near ${target.toFixed(2)}s.`));
		};
		const aborted = () => { cleanup(); reject(abortError()); };
		video.addEventListener("seeked", done, { once: true });
		video.addEventListener("error", failed, { once: true });
		signal?.addEventListener("abort", aborted, { once: true });
		video.currentTime = target;
	});
}

/**
 * Decode, threshold, OCR, and resolve sampling gaps.
 * Implementation per §5. Never retains frames — crop, OCR, discard pixels.
 */
export async function scanVideo(
	file: File,
	onProgress: (p: ScanProgress) => void,
	signal?: AbortSignal,
): Promise<ScanResult> {
	throwIfAborted(signal);
	const video = document.createElement("video");
	video.muted = true;
	video.playsInline = true;
	video.preload = "auto";
	const objectUrl = URL.createObjectURL(file);
	video.src = objectUrl;
	video.load();

	let worker: TesseractWorker | null = null;
	let workerPromise: Promise<TesseractWorker> | null = null;
	let termination: Promise<unknown> | null = null;
	const stopWorker = () => {
		if (termination) return termination;
		const active = worker ? Promise.resolve(worker) : workerPromise;
		if (!active) return Promise.resolve();
		termination = active.then((value) => value.terminate()).catch(() => undefined);
		return termination;
	};
	const abort = () => {
		video.pause();
		void stopWorker();
	};
	signal?.addEventListener("abort", abort, { once: true });

	try {
		await waitForMetadata(video, signal);
		const duration = video.duration;
		const width = video.videoWidth;
		const height = video.videoHeight;
		if (!Number.isFinite(duration) || duration <= 0 || !width || !height) {
			throw new Error("The selected file does not contain a readable video track.");
		}

		workerPromise = createWorker("eng", OEM.LSTM_ONLY, {
			workerPath: "/tesseract/worker.min.js",
			corePath: "/tesseract/",
			langPath: "/tesseract/",
			workerBlobURL: false,
			gzip: true,
		});
		worker = await workerPromise;
		throwIfAborted(signal);
		await worker.setParameters({
			tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
			tessedit_char_whitelist: OCR_WHITELIST,
			preserve_interword_spaces: "1",
		});
		throwIfAborted(signal);

		const captureCanvas = document.createElement("canvas");
		const captureContext = captureCanvas.getContext("2d", { willReadFrequently: true });
		const ocrCanvas = document.createElement("canvas");
		const ocrContext = ocrCanvas.getContext("2d");
		if (!captureContext || !ocrContext) {
			throw new Error("This browser cannot create the canvas needed to read video frames.");
		}

		const capture = (x: number, y: number, w: number, h: number) => {
			const sourceX = Math.max(0, Math.floor(x));
			const sourceY = Math.max(0, Math.floor(y));
			const sourceWidth = Math.max(1, Math.min(width - sourceX, Math.floor(w)));
			const sourceHeight = Math.max(1, Math.min(height - sourceY, Math.floor(h)));
			if (captureCanvas.width !== sourceWidth || captureCanvas.height !== sourceHeight) {
				captureCanvas.width = sourceWidth;
				captureCanvas.height = sourceHeight;
			}
			captureContext.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight,
				0, 0, sourceWidth, sourceHeight);
			return captureContext.getImageData(0, 0, sourceWidth, sourceHeight);
		};

		const toOcrCanvas = (frame: ThresholdedFrame) => {
			if (ocrCanvas.width !== frame.width || ocrCanvas.height !== frame.height) {
				ocrCanvas.width = frame.width;
				ocrCanvas.height = frame.height;
			}
			const binary = ocrContext.createImageData(frame.width, frame.height);
			for (let p = 0, i = 0; p < frame.gray.length; p++, i += 4) {
				const value = frame.gray[p] > frame.threshold ? 0 : 255;
				binary.data[i] = value;
				binary.data[i + 1] = value;
				binary.data[i + 2] = value;
				binary.data[i + 3] = 255;
			}
			ocrContext.putImageData(binary, 0, 0);
			return ocrCanvas;
		};

		const sightings: Sighting[] = [];
		const gaps: Gap[] = [];
		const sectionRuns: SectionRun[] = [];
		const discontinuities: Discontinuity[] = [];
		const ocrTimes: number[] = [];
		const countSamples: Record<Section, number[]> = { followers: [], following: [] };
		const endpoints: Record<Section, Endpoints> = {
			followers: { sawListTop: false, sawEndMarker: false, movingTransition: false, endedScrolling: false },
			following: { sawListTop: false, sawEndMarker: false, movingTransition: false, endedScrolling: false },
		};
		const firstAccepted: Record<Section, boolean> = { followers: false, following: false };
		const endTimes: Partial<Record<Section, number>> = {};
		const found = new Set<string>();
		let ocrCount = 0;
		let frameId = 0;
		let accepted: Section | null = null;

		const progress = (t: number) => onProgress({
			t, duration, ocrCount, found: found.size, section: accepted,
		});
		const recognize = async (frame: ThresholdedFrame, t: number): Promise<OcrLine[]> => {
			throwIfAborted(signal);
			ocrCount++;
			ocrTimes.push(t);
			progress(t);
			const result = await worker!.recognize(toOcrCanvas(frame), {}, { text: true, blocks: true });
			throwIfAborted(signal);
			return flattenLines(result.data);
		};
		const rememberCounts = (values: Partial<Record<Section, number>>) => {
			// Only trust a frame that parsed BOTH labels. Measured on the sample:
			// a clean frame yields "586 followers 537 following"; a smeared one
			// yields "8586 followers DT fol mariog", where a noise blob fuses onto
			// the digits. A half-parsed frame is exactly the corrupted case, and a
			// wrong count poisons the §6.6 parity gate that decides whether the
			// accusation list may be shown at all.
			if (values.followers === undefined || values.following === undefined) return;
			for (const section of ["followers", "following"] as const) {
				const value = values[section];
				if (value !== undefined && value > 0 && value < 1e7) {
					countSamples[section].push(value);
				}
			}
		};
		const readTopBand = () => {
			const top = Math.floor(TOP_BAND[0] * height);
			const bottom = Math.ceil(TOP_BAND[1] * height);
			const image = capture(0, top, width, bottom - top);
			// Lower factor so the INACTIVE tab survives — see CAL_THRESH_FACTOR.
			return { top, frame: thresholdPixels(image.data, image.width, image.height, CAL_THRESH_FACTOR) };
		};
		const calibrationFrom = (lines: OcrLine[], bandTop: number): Calibration | null => {
			const labels: { section: Section; x: number; x0: number; x1: number; line: OcrLine }[] = [];
			for (const line of lines) {
				for (const word of line.words) {
					const normalized = word.text.toLowerCase().replace(/[^a-z]/g, "");
					if (normalized === "followers" || normalized === "following") {
						labels.push({
							section: normalized,
							x: (word.bbox.x0 + word.bbox.x1) / 2,
							x0: word.bbox.x0, x1: word.bbox.x1, line,
						});
					}
				}
			}
			const followers = labels.find((label) => label.section === "followers");
			const following = labels.find((label) => label.section === "following");
			if (!followers || !following || followers.x >= following.x) return null;
			const followersWord = { x0: followers.x0, x1: followers.x1 };
			const followingWord = { x0: following.x0, x1: following.x1 };
			const labelLines = [followers.line, following.line];
			const lineBottom = Math.max(...labelLines.map((line) => line.bbox.y1));
			const lineHeight = median(labelLines.map((line) => Math.max(1, line.bbox.y1 - line.bbox.y0)));
			const listTop = Math.round(bandTop + lineBottom + 1.5 * lineHeight);
			const tabTop = Math.max(0, Math.floor(bandTop +
				Math.min(...labelLines.map((line) => line.bbox.y0)) - lineHeight / 2));
			const tabBottom = Math.min(height, Math.ceil(bandTop + lineBottom + lineHeight / 2));
			if (listTop <= tabBottom || listTop >= height || tabBottom <= tabTop) return null;
			return {
				listTop, tabTop, tabBottom,
				x0: Math.floor(CROP_X[0] * width), x1: Math.ceil(CROP_X[1] * width),
				// pad slightly: OCR bboxes hug the glyphs
				followersBox: [followersWord.x0 - 4, followersWord.x1 + 4] as const,
				followingBox: [followingWord.x0 - 4, followingWord.x1 + 4] as const,
			};
		};

		const checkCrop = (measured: Calibration): Calibration => {
			let diagnostic = "";
			for (let retry = 0; retry <= 3; retry++) {
				const x0 = Math.floor((CROP_X[0] + retry * 0.02) * width);
				const x1 = Math.ceil((CROP_X[1] - retry * 0.02) * width);
				const image = capture(x0, measured.listTop, x1 - x0, height - measured.listTop);
				const frame = thresholdPixels(image.data, image.width, image.height);
				const edgeWidth = Math.max(1, Math.floor(frame.width * CROP_EDGE_BG_PCT));
				let left = 0;
				let right = 0;
				for (let y = 0; y < frame.height; y++) {
					const row = y * frame.width;
					for (let x = 0; x < edgeWidth; x++) {
						if (frame.gray[row + x] > frame.threshold) left++;
						if (frame.gray[row + frame.width - 1 - x] > frame.threshold) right++;
					}
				}
				const edgePixels = edgeWidth * frame.height;
				if (left / edgePixels < 0.5 && right / edgePixels < 0.5) return { ...measured, x0, x1 };
				diagnostic = toOcrCanvas(frame).toDataURL("image/png");
			}
			const error = new Error(
				"The username crop still includes an avatar or button after three retries.",
			) as Error & { diagnosticImage?: string };
			error.diagnosticImage = diagnostic;
			throw error;
		};

		let calibration: Calibration | null = null;
		let step = STEP_INIT;
		let highStreak = 0;
		let lastProbeT = 0;
		let lastListOcrT: number | null = null;
		let lastOcrGray: Uint8Array | null = null;
		let previousProbeGray: Uint8Array | null = null;
		let previousProbeProfile: Float64Array | null = null;
		let previousProbeMoving = false;
		let controllerFrame: OcrFrame | null = null;
		let controllerNeedsSeed = true;
		let candidate: Section | null = null;
		let streak = 0;
		let inTransition = false;
		let transitionFrom: Section | null = null;
		let transitionStart = 0;
		let transitionMoved = false;
		let runOpen: { section: Section; tStart: number; lastT: number } | null = null;

		const closeRun = (at?: number) => {
			if (!runOpen) return;
			sectionRuns.push({
				section: runOpen.section,
				tStart: runOpen.tStart,
				tEnd: Math.max(runOpen.tStart, at ?? runOpen.lastT),
			});
			runOpen = null;
		};
		const resetController = () => {
			step = STEP_INIT;
			highStreak = 0;
			lastOcrGray = null;
			controllerFrame = null;
			controllerNeedsSeed = true;
		};
		const finishMovingTransition = (t: number) => {
			if (transitionFrom && transitionMoved) gaps.push({
				section: transitionFrom, tStart: transitionStart,
				tEnd: Math.max(transitionStart, t), confirmed: false,
			});
		};
		const acceptFrame = (frame: OcrFrame, moving: boolean, updateEndpoint = true) => {
			if (!firstAccepted[frame.section]) {
				firstAccepted[frame.section] = true;
				endpoints[frame.section].sawListTop = frame.verifiable &&
					frame.topY <= Math.max(1, 1.5 * frame.lineHeight);
			}
			if (updateEndpoint) endpoints[frame.section].endedScrolling = moving;
			if (frame.marker) {
				if (frame.markerBoundaryKnown) {
					endpoints[frame.section].sawEndMarker = true;
					endTimes[frame.section] = Math.min(endTimes[frame.section] ?? Infinity, frame.t);
					closeRun(frame.t);
				} else gaps.push({
					section: frame.section,
					tStart: Math.max(0, controllerFrame?.t ?? frame.t - FRAME_TIME),
					tEnd: frame.t, confirmed: false,
				});
			}
			if (!frame.marker || frame.markerBoundaryKnown) {
				for (const sighting of frame.sightings) {
					sightings.push(sighting);
					found.add(`${sighting.section}:${sighting.text}`);
				}
			}
		};
		const readListFrame = async (t: number, section: Section, frame: ThresholdedFrame) =>
			parseListLines(await recognize(frame, t), t, frameId++, section);

		while (lastProbeT < duration - 0.0005) {
			throwIfAborted(signal);
			const intervalStart = lastProbeT;
			const intervalEnd = Math.min(duration, intervalStart + step);
			const probeTimes: number[] = [];
			for (let t = intervalStart + FRAME_TIME; t <= intervalEnd + 0.0005; t += FRAME_TIME) {
				probeTimes.push(Math.min(t, intervalEnd));
			}
			if (!probeTimes.length || Math.abs(probeTimes[probeTimes.length - 1] - intervalEnd) > 0.0005) {
				probeTimes.push(intervalEnd);
			}
			// §5.1: advance this independently and unconditionally, never from lastListOcrT.
			lastProbeT = intervalEnd;

			let best: ProbeChoice | null = null;
			let calibrationCandidate: {
				t: number; sharpness: number; bandTop: number; band: ThresholdedFrame;
			} | null = null;
			let intervalDy = 0;

			for (const probeT of probeTimes) {
				throwIfAborted(signal);
				await seekVideo(video, probeT, signal);
				const listTop = calibration?.listTop ?? Math.floor(LIST_TOP_FALLBACK * height);
				const x0 = calibration?.x0 ?? Math.floor(CROP_X[0] * width);
				const x1 = calibration?.x1 ?? Math.ceil(CROP_X[1] * width);
				const image = capture(x0, listTop, x1 - x0, height - listTop);
				const frame = thresholdPixels(image.data, image.width, image.height);
				const validRange = frame.range >= MIN_RANGE;

				if (!calibration) {
					if (validRange) {
						const score = sharpness(frame);
						if (!calibrationCandidate || score > calibrationCandidate.sharpness) {
							const band = readTopBand();
							calibrationCandidate = {
								t: probeT, sharpness: score, bandTop: band.top, band: band.frame,
							};
						}
					}
					continue;
				}

				const profile = rowProfile(frame);
				intervalDy += signedProfileOffset(previousProbeProfile, profile, frame.height);
				const adjacentMad = meanAbsoluteDifference(previousProbeGray, frame.gray);
				const stoppedAfterMotion = validRange && previousProbeGray !== null &&
					previousProbeMoving && adjacentMad < MOTION_EPS;
				if (validRange && previousProbeGray !== null) previousProbeMoving = adjacentMad >= MOTION_EPS;
				previousProbeGray = frame.gray;
				previousProbeProfile = profile;

				const strip = capture(0, calibration.tabTop, width, calibration.tabBottom - calibration.tabTop);
				// §5.4: classify every probe with pixels, before the MAD duplicate skip.
				const classified = classifySection(
					strip.data, strip.width, strip.height, frame.threshold, frame.inverted,
					calibration.followersBox, calibration.followingBox,
				);
				const madFromLastOcr = meanAbsoluteDifference(lastOcrGray, frame.gray);
				const moving = lastOcrGray !== null
					? madFromLastOcr >= MOTION_EPS
					: adjacentMad >= MOTION_EPS;
				let eligible = false;
				let confirmedNow = false;
				let previousAccepted: Section | null = accepted;

				if (classified === accepted && !inTransition) {
					candidate = null;
					streak = 0;
					eligible = accepted !== null;
					if (runOpen && runOpen.section === accepted) runOpen.lastT = probeT;
				} else {
					if (!inTransition) {
						inTransition = true;
						transitionFrom = accepted;
						transitionStart = probeT;
						transitionMoved = false;
						best = null;
						closeRun();
					}
					if (moving && transitionFrom) {
						transitionMoved = true;
						endpoints[transitionFrom].movingTransition = true;
					}

					if (classified === null) {
						candidate = null;
						streak = 0;
					} else {
						if (classified === candidate) streak++;
						else {
							candidate = classified;
							streak = 1;
						}
						if (streak >= SECTION_CONFIRM_PROBES) {
							finishMovingTransition(probeT);
							previousAccepted = accepted;
							accepted = classified;
							candidate = null;
							streak = 0;
							inTransition = false;
							runOpen = { section: accepted, tStart: probeT, lastT: probeT };
							confirmedNow = true;
							eligible = !transitionMoved && !moving;
							transitionFrom = null;
							transitionMoved = false;
							resetController();

							// Calibration already read the initial counts; re-read only on a real change.
							if (previousAccepted !== null && previousAccepted !== accepted) {
								const band = readTopBand();
								if (band.frame.range >= MIN_RANGE) {
									rememberCounts(parseCounts(await recognize(band.frame, probeT)));
								}
							}
						}
					}
				}

				if (!validRange || !eligible || !accepted || endpoints[accepted].sawEndMarker ||
					(lastListOcrT !== null && probeT <= lastListOcrT)) continue;
				const mustOcr = (confirmedNow && !moving) || stoppedAfterMotion;
				if (lastOcrGray !== null && madFromLastOcr < MOTION_EPS && !mustOcr) continue;
				const choice: ProbeChoice = {
					t: probeT,
					section: accepted,
					frame,
					sharpness: confirmedNow ? Infinity : sharpness(frame),
					dy: intervalDy,
					moving,
					mustOcr,
				};
				if (!best || (choice.mustOcr && !best.mustOcr) ||
					(choice.mustOcr === best.mustOcr && choice.sharpness > best.sharpness)) best = choice;
			}

			if (!calibration) {
				if (calibrationCandidate) {
					const lines = await recognize(calibrationCandidate.band, calibrationCandidate.t);
					const counts = parseCounts(lines);
					rememberCounts(counts);
					const measured = Object.keys(counts).length ? calibrationFrom(lines, calibrationCandidate.bandTop) : null;
					if (measured) {
						await seekVideo(video, calibrationCandidate.t, signal);
						calibration = checkCrop(measured);
						previousProbeGray = null;
						previousProbeProfile = null;
						previousProbeMoving = false;
						resetController();
					}
				}
				progress(lastProbeT);
				continue;
			}

			if (!best || best.section !== accepted || inTransition) {
				progress(lastProbeT);
				continue;
			}
			const current = await readListFrame(best.t, best.section, best.frame);
			acceptFrame(current, best.moving);
			lastListOcrT = best.t;
			lastOcrGray = best.frame.gray;

			if (controllerNeedsSeed || !controllerFrame || controllerFrame.section !== current.section) {
				controllerNeedsSeed = false;
				highStreak = 0;
				step = STEP_INIT;
				controllerFrame = current;
				progress(lastProbeT);
				continue;
			}
			if (best.dy < 0) {
				// Backward scrolls reseed; they never emit a forward-coverage gap.
				step = STEP_INIT;
				highStreak = 0;
				controllerFrame = current;
				progress(lastProbeT);
				continue;
			}

			const overlap = orderedOverlap(controllerFrame, current);
			if (overlap >= OVERLAP_HI) {
				if (++highStreak >= GROW_STREAK) {
					step = Math.min(step * 1.5, STEP_MAX);
					highStreak = 0;
				}
			} else if (overlap >= OVERLAP_LO) highStreak = 0;
			else {
				highStreak = 0;
				step = Math.max(step / 2, STEP_MIN);
				if (controllerFrame.verifiable && current.verifiable) {
					discontinuities.push({ section: current.section, lo: controllerFrame, hi: current });
				} else gaps.push({
					section: current.section, tStart: controllerFrame.t, tEnd: current.t, confirmed: false,
				});
			}
			controllerFrame = current;
			progress(lastProbeT);
		}

		if (!calibration) {
			throw new Error("This doesn't look like an English Instagram followers recording.");
		}
		if (inTransition) finishMovingTransition(duration);
		if (runOpen) closeRun();

		const unreadable = (t: number, section: Section): OcrFrame => ({
			t, section, sightings: [], topY: Infinity, lineHeight: 0,
			marker: false, markerBoundaryKnown: false, verifiable: false,
		});
		const readBisectFrame = async (t: number, section: Section): Promise<OcrFrame> => {
			throwIfAborted(signal);
			await seekVideo(video, t, signal);
			const image = capture(
				calibration.x0, calibration.listTop,
				calibration.x1 - calibration.x0, height - calibration.listTop,
			);
			const frame = thresholdPixels(image.data, image.width, image.height);
			if (frame.range < MIN_RANGE) return unreadable(t, section);
			const strip = capture(0, calibration.tabTop, width, calibration.tabBottom - calibration.tabTop);
			if (classifySection(strip.data, strip.width, strip.height, frame.threshold,
				frame.inverted, calibration.followersBox, calibration.followingBox,
			) !== section) return unreadable(t, section);
			const result = await readListFrame(t, section, frame);
			acceptFrame(result, false, false);
			return result;
		};

		let bisectTotal = 0;
		for (const discontinuity of discontinuities) {
			if ((endTimes[discontinuity.section] ?? Infinity) <= discontinuity.lo.t) continue;
			if (bisectTotal >= MAX_BISECT_TOTAL) break;
			// The budget is created here, once per discontinuity—not shared globally.
			const worklist: { lo: OcrFrame; hi: OcrFrame }[] = [
				{ lo: discontinuity.lo, hi: discontinuity.hi },
			];
			let work = 0;
			while (worklist.length && work < MAX_BISECT && bisectTotal < MAX_BISECT_TOTAL) {
				throwIfAborted(signal);
				const interval = worklist.pop()!;
				const overlap = orderedOverlap(interval.lo, interval.hi);
				if (interval.hi.t - interval.lo.t <= FRAME_TIME + 0.0005) {
					if (overlap === 0) gaps.push({
						section: discontinuity.section,
						tStart: interval.lo.t,
						tEnd: interval.hi.t,
						confirmed: interval.lo.verifiable && interval.hi.verifiable,
					});
					continue;
				}

				work++;
				bisectTotal++;
				const middle = await readBisectFrame(
					(interval.lo.t + interval.hi.t) / 2,
					discontinuity.section,
				);
				if (middle.marker && !middle.markerBoundaryKnown) {
					gaps.push({
						section: discontinuity.section,
						tStart: interval.lo.t,
						tEnd: interval.hi.t,
						confirmed: false,
					});
					continue;
				}
				// Both children are checked independently; a left match cannot hide a right gap.
				if (orderedOverlap(interval.lo, middle) === 0) {
					worklist.push({ lo: interval.lo, hi: middle });
				}
				if (!middle.marker && orderedOverlap(middle, interval.hi) === 0) {
					worklist.push({ lo: middle, hi: interval.hi });
				}
			}
			for (const interval of worklist) gaps.push({
				section: discontinuity.section,
				tStart: interval.lo.t,
				tEnd: interval.hi.t,
				confirmed: false,
			});
		}

		const finalSightings = sightings
			.filter((sighting) => sighting.t <= (endTimes[sighting.section] ?? Infinity))
			.sort((a, b) => a.t - b.t || a.y - b.y);
		const finalRuns = sectionRuns
			.filter((run) => run.tStart <= (endTimes[run.section] ?? Infinity))
			.map((run) => ({
				...run,
				tEnd: Math.min(run.tEnd, endTimes[run.section] ?? Infinity),
			}))
			.filter((run) => run.tEnd >= run.tStart)
			.sort((a, b) => a.tStart - b.tStart);
		const finalGaps = gaps
			.filter((gap) => gap.tStart < (endTimes[gap.section] ?? Infinity))
			.map((gap) => ({
				...gap,
				tEnd: Math.min(gap.tEnd, endTimes[gap.section] ?? Infinity),
			}))
			.sort((a, b) => a.tStart - b.tStart || a.tEnd - b.tEnd);
		const labelCounts: Partial<Record<Section, number>> = {};
		for (const section of ["followers", "following"] as const) {
			const value = modal(countSamples[section]);
			if (value !== undefined) labelCounts[section] = value;
		}

		ocrTimes.sort((a, b) => a - b);
		progress(duration);
		return {
			sightings: finalSightings,
			labelCounts,
			gaps: finalGaps,
			sectionRuns: finalRuns,
			endpoints,
			ocrTimes,
			duration,
		};
	} catch (error) {
		if (signal?.aborted) throw abortError();
		throw error;
	} finally {
		signal?.removeEventListener("abort", abort);
		video.pause();
		video.removeAttribute("src");
		video.load();
		URL.revokeObjectURL(objectUrl);
		await stopWorker();
	}
}
