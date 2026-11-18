/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */
const core = require('../core');
const perf = require('../perf');
const exportSession = require('../export-session');
const BufferWrapper = require('../buffer');

// In-memory cache of decoded .anim files. Characters of the same race share
// a skeleton and its (very large) animation set, so keeping recently used
// animation files around avoids re-reading and re-decompressing them for
// every export. Requests for a file already in flight share one read.

const MAX_CACHE_BYTES = 256 * 1024 * 1024;

const cache = new Map();
const pending = new Map();
let cacheBytes = 0;
let owner = null;

const checkOwner = () => {
	// Drop everything if the data source changed (different install/build).
	if (owner !== core.view.casc) {
		owner = core.view.casc;
		cache.clear();
		pending.clear();
		cacheBytes = 0;
	}
};

const store = (fileDataID, buf) => {
	if (buf.byteLength > MAX_CACHE_BYTES / 4)
		return;

	cache.set(fileDataID, buf);
	cacheBytes += buf.byteLength;

	// Evict least recently used entries (Map preserves insertion order).
	for (const [id, entry] of cache) {
		if (cacheBytes <= MAX_CACHE_BYTES)
			break;

		cache.delete(id);
		cacheBytes -= entry.byteLength;
	}
};

/**
 * Obtain the decoded contents of an .anim file.
 * @param {number} fileDataID
 * @returns {Promise<BufferWrapper>} A fresh reader positioned at the start.
 */
const get = async (fileDataID) => {
	checkOwner();

	const cached = cache.get(fileDataID);
	if (cached !== undefined) {
		// Refresh recency.
		cache.delete(fileDataID);
		cache.set(fileDataID, cached);

		perf.count('anim.cache hit');
		return new BufferWrapper(cached);
	}

	let promise = pending.get(fileDataID);
	if (promise === undefined) {
		const source = owner;
		promise = exportSession.io(async () => {
			const start = perf.now();
			const data = await source.getFile(fileDataID, false, true);
			data.processAllBlocks?.();

			perf.add('anim.read', perf.now() - start, data.byteLength);
			return data.raw;
		}).then(buf => {
			if (owner === source)
				store(fileDataID, buf);

			return buf;
		}).finally(() => {
			if (pending.get(fileDataID) === promise)
				pending.delete(fileDataID);
		});

		pending.set(fileDataID, promise);
	}

	return new BufferWrapper(await promise);
};

/**
 * Begin loading a set of .anim files in the background so that subsequent
 * get() calls resolve without waiting on each read in turn.
 * @param {Iterable<number>} fileDataIDs
 */
const prefetch = (fileDataIDs) => {
	for (const fileDataID of fileDataIDs) {
		if (fileDataID > 0)
			get(fileDataID).catch(() => {});
	}
};

/**
 * Parse the user's animation export filter.
 * @returns {Set<number>|null} Animation IDs to include, or null for all.
 */
const getAnimationFilter = () => {
	const raw = core.view.config.modelsExportAnimationFilter;
	if (typeof raw !== 'string' || raw.trim().length === 0)
		return null;

	const ids = new Set();
	for (const part of raw.split(/[\s,;]+/)) {
		const id = Number.parseInt(part, 10);
		if (Number.isInteger(id) && id >= 0)
			ids.add(id);
	}

	return ids.size > 0 ? ids : null;
};

/**
 * Reduce an animation list (and the per-animation tracks of its bones) to
 * the animations accepted by the filter. Returns new objects; the inputs are
 * left untouched.
 * @param {Array} animations
 * @param {Array} bones
 * @param {Set<number>|null} filter
 * @returns {{animations: Array, bones: Array}}
 */
const applyAnimationFilter = (animations, bones, filter) => {
	if (filter === null || !Array.isArray(animations) || !Array.isArray(bones))
		return { animations, bones };

	const keep = [];
	for (let i = 0; i < animations.length; i++) {
		if (filter.has(animations[i].id))
			keep.push(i);
	}

	const total = animations.length;
	const filterTrack = (track) => {
		if (!track)
			return track;

		const out = Object.assign({}, track);
		if (Array.isArray(track.timestamps) && track.timestamps.length === total)
			out.timestamps = keep.map(i => track.timestamps[i]);

		if (Array.isArray(track.values) && track.values.length === total)
			out.values = keep.map(i => track.values[i]);

		return out;
	};

	const filteredBones = bones.map(bone => Object.assign({}, bone, {
		translation: filterTrack(bone.translation),
		rotation: filterTrack(bone.rotation),
		scale: filterTrack(bone.scale)
	}));

	return { animations: keep.map(i => animations[i]), bones: filteredBones };
};

module.exports = { get, prefetch, getAnimationFilter, applyAnimationFilter };
