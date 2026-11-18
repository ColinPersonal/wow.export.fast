/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */
const perf = require('./perf');

// An export session spans a single export run (one ExportHelper start/finish).
// While a session is active, work registered through once() is performed a
// single time per key, no matter how many tiles/models request it. Concurrent
// requests for the same key share one promise, so two tasks never write the
// same output file at the same time.

let depth = 0;
const pending = new Map();

/**
 * Begin an export session. Nested calls share the outermost session.
 */
const begin = () => {
	if (depth++ === 0)
		pending.clear();
};

/**
 * Start a fresh export session, discarding any previous (possibly leaked) one.
 */
const reset = () => {
	depth = 1;
	pending.clear();
};

/**
 * End an export session.
 */
const end = () => {
	if (depth > 0 && --depth === 0)
		pending.clear();
};

/**
 * @returns {boolean} True if an export session is active.
 */
const isActive = () => depth > 0;

/**
 * Run fn() at most once per key for the lifetime of the session.
 * Subsequent calls resolve with the result of the first call. If the first
 * call fails, the key is released so a later request can retry.
 * Outside of a session, fn() is always invoked.
 * @param {string} key
 * @param {function} fn
 */
const once = (key, fn) => {
	if (depth === 0)
		return fn();

	const existing = pending.get(key);
	if (existing !== undefined) {
		perf.count('dedupe.skipped');
		return existing;
	}

	perf.count('dedupe.unique');

	const promise = (async () => fn())();
	pending.set(key, promise);
	promise.catch(() => {
		if (pending.get(key) === promise)
			pending.delete(key);
	});

	return promise;
};

// Leaf I/O limiter. Only wrap self-contained read/convert/write operations
// with this (never something that itself waits on io()), so it cannot deadlock.
let ioLimit = 16;
let ioActive = 0;
const ioWaiting = [];

/**
 * Set how many io() operations may run at once.
 * @param {number} limit
 */
const setIOLimit = (limit) => {
	ioLimit = Math.max(1, limit | 0);
};

/**
 * Run a leaf I/O operation, waiting for a free slot if too many are in flight.
 * @param {function} fn
 */
const io = async (fn) => {
	if (ioActive >= ioLimit)
		await new Promise(resolve => ioWaiting.push(resolve));
	else
		ioActive++;

	try {
		return await fn();
	} finally {
		// Hand our slot directly to the next waiter, if any.
		const next = ioWaiting.shift();
		if (next !== undefined)
			next();
		else
			ioActive--;
	}
};

/**
 * @param {string} key
 * @returns {boolean} True if the key has been claimed in this session.
 */
const has = (key) => pending.has(key);

module.exports = { begin, reset, end, isActive, once, has, io, setIOLimit };
