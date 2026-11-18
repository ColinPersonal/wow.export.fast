/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */
const os = require('os');
const path = require('path');

// Pool of worker threads used to move CPU-heavy export work (PNG encoding,
// CASC block decompression) off the main thread. Everything here is
// best-effort: if workers cannot be started the pool reports itself as
// unavailable and callers do the work on the main thread instead.

const WORKER_SCRIPT = './src/js/workers/export-worker.js';
const MAX_WORKERS = 8;

let enabled = true;
let broken = false;
let nextTaskID = 1;
let scriptPath = WORKER_SCRIPT;

const workers = [];
const idle = [];
const queue = [];
const tasks = new Map();

const getPoolSize = () => {
	const cores = os.cpus()?.length ?? 2;
	return Math.max(1, Math.min(MAX_WORKERS, cores - 1));
};

/**
 * Mark the pool as unusable and fail everything in flight so callers fall back.
 * @param {Error} error
 */
const fail = (error) => {
	broken = true;

	for (const task of tasks.values())
		task.reject(error);

	tasks.clear();

	for (const task of queue.splice(0))
		task.reject(error);

	for (const worker of workers.splice(0))
		worker.terminate().catch(() => {});

	idle.length = 0;
};

const dispatch = (worker, task) => {
	tasks.set(task.id, task);
	worker.activeTask = task.id;
	worker.postMessage(task.message, task.transfer);
};

const spawn = () => {
	const { Worker } = require('worker_threads');
	const worker = new Worker(scriptPath);
	worker.activeTask = null;

	worker.on('message', (msg) => {
		const task = tasks.get(msg.id);
		tasks.delete(msg.id);
		worker.activeTask = null;

		// Hand the worker its next task before settling, keeping it busy.
		const next = queue.shift();
		if (next !== undefined)
			dispatch(worker, next);
		else
			idle.push(worker);

		if (task === undefined)
			return;

		if (msg.ok)
			task.resolve(msg);
		else
			task.reject(new Error(msg.error));
	});

	worker.on('error', (e) => fail(e));
	worker.on('exit', (code) => {
		if (!broken && code !== 0)
			fail(new Error('export worker exited with code ' + code));
	});

	// Don't let idle workers keep the process alive.
	worker.unref();

	workers.push(worker);
	return worker;
};

/**
 * Run a task on a worker thread.
 * @param {object} message
 * @param {Array} [transfer]
 * @returns {Promise<object>}
 */
const run = (message, transfer = []) => {
	return new Promise((resolve, reject) => {
		if (!isAvailable())
			return reject(new Error('worker pool unavailable'));

		const task = { id: nextTaskID++, message, transfer, resolve, reject };
		message.id = task.id;

		try {
			let worker = idle.pop();
			if (worker === undefined && workers.length < getPoolSize())
				worker = spawn();

			if (worker !== undefined)
				dispatch(worker, task);
			else
				queue.push(task);
		} catch (e) {
			fail(e);
			reject(e);
		}
	});
};

/**
 * @returns {boolean} True if work can be sent to worker threads.
 */
const isAvailable = () => enabled && !broken;

/**
 * Enable or disable use of worker threads (user configuration).
 * @param {boolean} state
 */
const setEnabled = (state) => {
	enabled = !!state;
};

/**
 * Override the worker script location (used by tests).
 * @param {string} file
 */
const setScriptPath = (file) => {
	scriptPath = path.resolve(file);
};

/**
 * Encode RGBA pixel data as a PNG on a worker thread.
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} height
 * @param {boolean} fast
 * @returns {Promise<Buffer>}
 */
const encodePNG = async (pixels, width, height, fast) => {
	// The pixel data is copied rather than transferred, as the caller may still use it.
	const result = await run({ type: 'png', pixels, width, height, fast });
	return Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength);
};

/**
 * Verify and decompress a BLTE container on a worker thread.
 * The input buffer is transferred to the worker where possible, so the caller
 * must use the returned `raw` buffer in place of the one passed in.
 * @param {Buffer} raw
 * @param {string} hash
 * @returns {Promise<{decoded: Buffer|null, raw: Buffer}>} decoded is null if
 * the worker could not handle the data; decode `raw` on the main thread instead.
 */
const decodeBLTE = async (raw, hash) => {
	// Only transfer buffers which own their entire ArrayBuffer (not pooled).
	const ownsBuffer = raw.byteOffset === 0 && raw.buffer.byteLength === raw.byteLength && !(raw.buffer instanceof SharedArrayBuffer);
	const view = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);

	const result = await run({ type: 'blte', raw: view, hash }, ownsBuffer ? [raw.buffer] : []);

	if (result.data !== null)
		return { decoded: Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength), raw: null };

	return { decoded: null, raw: Buffer.from(result.raw.buffer, result.raw.byteOffset, result.raw.byteLength) };
};

module.exports = { isAvailable, setEnabled, setScriptPath, encodePNG, decodeBLTE, getPoolSize };
