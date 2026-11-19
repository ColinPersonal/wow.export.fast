// Small shared helpers for the gateway.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** JSON with object keys sorted, so equal values always serialise the same. */
const canonicalJSON = (value) => JSON.stringify(sortKeys(value));

const sortKeys = (value) => {
	if (Array.isArray(value))
		return value.map(sortKeys);

	if (value !== null && typeof value === 'object') {
		const out = {};
		for (const key of Object.keys(value).sort()) {
			if (value[key] !== undefined)
				out[key] = sortKeys(value[key]);
		}
		return out;
	}

	return value;
};

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Random ID with a readable prefix, e.g. job_3f9c2a71b0d4e815. */
const newId = (prefix) => prefix + '_' + crypto.randomBytes(8).toString('hex');

/** Hash a file's contents (streamed). */
const hashFile = (file) => new Promise((resolve, reject) => {
	const hash = crypto.createHash('sha256');
	fs.createReadStream(file)
		.on('error', reject)
		.on('data', chunk => hash.update(chunk))
		.on('end', () => resolve(hash.digest('hex')));
});

/**
 * True if `child` is `parent` or inside it. Both are resolved first and
 * compared case-insensitively on Windows.
 */
const isInside = (child, parent) => {
	let c = path.resolve(child);
	let p = path.resolve(parent);
	if (process.platform === 'win32') {
		c = c.toLowerCase();
		p = p.toLowerCase();
	}
	const rel = path.relative(p, c);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Error with a machine-readable code, as returned to agents. */
class ServiceError extends Error {
	constructor(code, message, { hint, retryable = false, status } = {}) {
		super(message);
		this.code = code;
		this.hint = hint;
		this.retryable = retryable;
		this.status = status;
	}

	toJSON() {
		const out = { code: this.code, message: this.message, retryable: this.retryable };
		if (this.hint)
			out.hint = this.hint;
		return out;
	}
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Recursively list files under a directory as paths relative to it (forward slashes). */
const listFiles = async (root) => {
	const out = [];
	const walk = async (dir) => {
		let entries;
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch (e) {
			if (e.code === 'ENOENT')
				return;
			throw e;
		}

		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory())
				await walk(full);
			else if (entry.isFile())
				out.push(path.relative(root, full).split(path.sep).join('/'));
		}
	};
	await walk(root);
	return out.sort();
};

// Windows refuses to rename a folder while another process (a virus scanner, the
// search indexer, an engine closing its files) holds a handle inside it. Retry for a
// few seconds, then copy and delete instead.
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
const moveDir = async (from, to, { attempts = 8, firstDelayMs = 50 } = {}) => {
	const fsp = require('fs/promises');
	let delay = firstDelayMs;
	for (let i = 0; ; i++) {
		try {
			return await fsp.rename(from, to);
		} catch (e) {
			if (!BUSY.has(e.code))
				throw e;
			if (i >= attempts - 1)
				break;
			await sleep(delay);
			delay = Math.min(delay * 2, 1000);
		}
	}
	await fsp.rm(to, { recursive: true, force: true });
	await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false });
	// Best effort: leftover staging folders are removed when the gateway restarts.
	await fsp.rm(from, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
};

module.exports = { canonicalJSON, sortKeys, sha256, newId, hashFile, isInside, ServiceError, sleep, listFiles, moveDir };
