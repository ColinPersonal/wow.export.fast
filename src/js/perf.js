/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Lightweight export profiler. Collects cumulative time, call count and byte
// totals per label while an export is running, and renders a summary at the end.
// Timings are cumulative across concurrent tasks, so they can exceed wall time.

const stats = new Map();
let started = 0;
let depth = 0;

const entry = (label) => {
	let e = stats.get(label);
	if (e === undefined) {
		e = { ms: 0, count: 0, bytes: 0 };
		stats.set(label, e);
	}

	return e;
};

/**
 * Begin a profiling run. Nested calls share the outermost run.
 */
const begin = () => {
	if (depth++ === 0) {
		stats.clear();
		started = performance.now();
	}
};

/**
 * Start a fresh profiling run, discarding any previous (possibly leaked) one.
 */
const reset = () => {
	depth = 1;
	stats.clear();
	started = performance.now();
};

/**
 * End a profiling run.
 * @returns {string[]|null} Summary lines if this ended the outermost run.
 */
const end = () => {
	if (depth === 0 || --depth > 0)
		return null;

	return summary();
};

/**
 * Record a measurement.
 * @param {string} label
 * @param {number} ms
 * @param {number} [bytes]
 */
const add = (label, ms, bytes = 0) => {
	if (depth === 0)
		return;

	const e = entry(label);
	e.ms += ms;
	e.count++;
	e.bytes += bytes;
};

/**
 * Increment a counter without timing.
 * @param {string} label
 * @param {number} [n]
 */
const count = (label, n = 1) => {
	if (depth === 0)
		return;

	entry(label).count += n;
};

/**
 * Time an async function under the given label.
 * @param {string} label
 * @param {function} fn
 */
const time = async (label, fn) => {
	if (depth === 0)
		return await fn();

	const start = performance.now();
	try {
		return await fn();
	} finally {
		add(label, performance.now() - start);
	}
};

/**
 * Time a synchronous function under the given label.
 * @param {string} label
 * @param {function} fn
 */
const timeSync = (label, fn) => {
	if (depth === 0)
		return fn();

	const start = performance.now();
	try {
		return fn();
	} finally {
		add(label, performance.now() - start);
	}
};

const now = () => performance.now();

const format_bytes = (bytes) => {
	if (bytes >= 1073741824)
		return (bytes / 1073741824).toFixed(2) + ' GB';

	if (bytes >= 1048576)
		return (bytes / 1048576).toFixed(1) + ' MB';

	return (bytes / 1024).toFixed(0) + ' KB';
};

/**
 * Build summary lines for the current run.
 * @returns {string[]}
 */
const summary = () => {
	const wall = performance.now() - started;
	const lines = ['Export profile: ' + (wall / 1000).toFixed(2) + 's wall time (phase times are cumulative across concurrent tasks)'];

	const sorted = [...stats.entries()].sort((a, b) => b[1].ms - a[1].ms);
	for (const [label, e] of sorted) {
		let line = '  ' + label.padEnd(24) + (e.ms / 1000).toFixed(2).padStart(9) + 's' + String(e.count).padStart(9) + 'x';
		if (e.bytes > 0)
			line += format_bytes(e.bytes).padStart(12);

		lines.push(line);
	}

	return lines;
};

module.exports = { begin, reset, end, add, count, time, timeSync, now, summary };
