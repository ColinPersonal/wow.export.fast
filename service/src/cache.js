// Finished results: <root>/results/<key>/files/... plus manifest.json.
// Results are keyed by everything that affects the output, so a repeated
// request is served from here without exporting again.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { hashFile, listFiles, isInside, ServiceError } = require('./util');

const KEY_RE = /^[0-9a-f]{64}$/;

class ResultCache {
	/**
	 * @param {object} config Gateway config (dirs, diskBudgetGB, minFreeGB, retentionDays).
	 * @param {object} [log]
	 */
	constructor(config, log = console) {
		this.config = config;
		this.dir = config.dirs.results;
		this.log = log;
		this.accessFile = path.join(config.dirs.state, 'access.json');
		this.access = new Map();
		this.inUse = new Map();
		this.manifests = new Map();

		try {
			for (const [key, at] of Object.entries(JSON.parse(fs.readFileSync(this.accessFile, 'utf8'))))
				this.access.set(key, at);
		} catch {
			// first run
		}
	}

	resultDir(key) {
		if (!KEY_RE.test(key))
			throw new ServiceError('NOT_FOUND', 'Unknown result');
		return path.join(this.dir, key);
	}

	filesDir(key) {
		return path.join(this.resultDir(key), 'files');
	}

	/**
	 * Manifest for a key, or null if there is no finished result.
	 * @param {string} key
	 */
	async get(key) {
		if (!KEY_RE.test(key))
			return null;

		if (this.manifests.has(key))
			return this.manifests.get(key);

		try {
			const manifest = JSON.parse(await fsp.readFile(path.join(this.resultDir(key), 'manifest.json'), 'utf8'));
			this.manifests.set(key, manifest);
			return manifest;
		} catch (e) {
			if (e.code === 'ENOENT')
				return null;
			throw e;
		}
	}

	touch(key) {
		this.access.set(key, Date.now());
		this.dirtyAccess = true;
	}

	/** Mark a result as being read (download in progress) so it is not evicted. */
	hold(key) {
		this.inUse.set(key, (this.inUse.get(key) ?? 0) + 1);
		let released = false;
		return () => {
			if (released)
				return;
			released = true;
			const n = (this.inUse.get(key) ?? 1) - 1;
			if (n <= 0)
				this.inUse.delete(key);
			else
				this.inUse.set(key, n);
		};
	}

	/**
	 * Turn a finished staging directory into a cached result.
	 * @param {string} key
	 * @param {string} stagingDir Directory the engine exported into.
	 * @param {object} meta Fields stored in the manifest (job, tool, product, build, params, result, failed).
	 */
	async commit(key, stagingDir, meta) {
		const files = await listFiles(stagingDir);
		const entries = new Array(files.length);
		let totalBytes = 0;

		// Hash with a few files in flight at once.
		let next = 0;
		const worker = async () => {
			while (next < files.length) {
				const i = next++;
				const full = path.join(stagingDir, ...files[i].split('/'));
				const [stat, sha] = await Promise.all([fsp.stat(full), hashFile(full)]);
				entries[i] = { path: files[i], size: stat.size, sha256: sha };
				totalBytes += stat.size;
			}
		};
		await Promise.all(Array.from({ length: Math.min(8, files.length) }, worker));

		const manifest = Object.assign({}, meta, {
			key,
			createdAt: new Date().toISOString(),
			fileCount: entries.length,
			totalBytes,
			files: entries
		});

		const target = this.resultDir(key);
		if (fs.existsSync(path.join(target, 'manifest.json'))) {
			// Another job produced the same result first; keep that one.
			await fsp.rm(stagingDir, { recursive: true, force: true });
			return this.get(key);
		}

		await fsp.rm(target, { recursive: true, force: true });
		await fsp.mkdir(target, { recursive: true });
		await fsp.rename(stagingDir, path.join(target, 'files')).catch(async (e) => {
			// Staging may be empty (nothing written) and never created.
			if (e.code === 'ENOENT')
				await fsp.mkdir(path.join(target, 'files'), { recursive: true });
			else
				throw e;
		});

		const tmp = path.join(target, 'manifest.json.tmp');
		await fsp.writeFile(tmp, JSON.stringify(manifest));
		await fsp.rename(tmp, path.join(target, 'manifest.json'));

		this.manifests.set(key, manifest);
		this.touch(key);
		return manifest;
	}

	/**
	 * Absolute path of a file inside a result, after checking it is safe.
	 * @param {string} key
	 * @param {string} rel Path as listed in the manifest (forward slashes).
	 */
	async resolveFile(key, rel) {
		const manifest = await this.get(key);
		if (manifest === null)
			throw new ServiceError('NOT_FOUND', 'Unknown or expired result', { status: 404 });

		if (typeof rel !== 'string' || rel.length === 0 || rel.length > 1024 || rel.includes('\0') || rel.includes('\\'))
			throw new ServiceError('NOT_FOUND', 'Unknown file', { status: 404 });

		// Only paths listed in the manifest can be served.
		const entry = manifest.files.find(f => f.path === rel);
		if (entry === undefined)
			throw new ServiceError('NOT_FOUND', 'Unknown file', { status: 404 });

		const base = this.filesDir(key);
		const full = path.resolve(base, ...rel.split('/'));
		if (!isInside(full, base) || full === path.resolve(base))
			throw new ServiceError('NOT_FOUND', 'Unknown file', { status: 404 });

		// Refuse anything that is not a plain file (links, junctions, devices).
		const stat = await fsp.lstat(full).catch(() => null);
		if (stat === null || !stat.isFile())
			throw new ServiceError('NOT_FOUND', 'Unknown file', { status: 404 });

		const real = await fsp.realpath(full);
		if (!isInside(real, await fsp.realpath(base)))
			throw new ServiceError('NOT_FOUND', 'Unknown file', { status: 404 });

		return { full, entry };
	}

	/** Total bytes of all cached results. */
	async usage() {
		let total = 0;
		const keys = [];
		for (const key of await fsp.readdir(this.dir).catch(() => [])) {
			const manifest = await this.get(key);
			if (manifest === null)
				continue;
			total += manifest.totalBytes;
			keys.push(key);
		}
		return { totalBytes: total, results: keys.length, keys };
	}

	async freeBytes() {
		const stat = await fsp.statfs(this.dir);
		return stat.bavail * stat.bsize;
	}

	async remove(key) {
		this.manifests.delete(key);
		this.access.delete(key);
		await fsp.rm(this.resultDir(key), { recursive: true, force: true });
	}

	/**
	 * Delete expired results, then least recently used ones until under the
	 * disk budget and above the free space floor. Results in use are kept.
	 * @param {object} [options]
	 * @param {number} [options.needBytes] Extra space a new job is expected to need.
	 */
	async evict({ needBytes = 0 } = {}) {
		const budget = this.config.diskBudgetGB * 1024 ** 3;
		const floor = this.config.minFreeGB * 1024 ** 3;
		const maxAge = this.config.retentionDays * 86400 * 1000;
		const now = Date.now();

		const { keys } = await this.usage();
		const items = [];
		for (const key of keys) {
			const manifest = await this.get(key);
			const at = this.access.get(key) ?? Date.parse(manifest.createdAt);
			items.push({ key, at, bytes: manifest.totalBytes });
		}
		items.sort((a, b) => a.at - b.at);

		let total = items.reduce((sum, i) => sum + i.bytes, 0);
		let free = await this.freeBytes();
		const removed = [];

		for (const item of items) {
			if (this.inUse.has(item.key))
				continue;

			const expired = now - item.at > maxAge;
			const overBudget = total + needBytes > budget;
			const lowDisk = free - needBytes < floor;
			if (!expired && !overBudget && !lowDisk)
				continue;

			await this.remove(item.key);
			total -= item.bytes;
			free += item.bytes;
			removed.push(item.key);
		}

		if (removed.length > 0)
			this.log.info?.('evicted %d result(s)', removed.length);

		return { removed, totalBytes: total, freeBytes: free };
	}

	async flushAccess() {
		if (!this.dirtyAccess)
			return;
		this.dirtyAccess = false;
		const tmp = this.accessFile + '.tmp';
		await fsp.writeFile(tmp, JSON.stringify(Object.fromEntries(this.access)));
		await fsp.rename(tmp, this.accessFile);
	}
}

module.exports = { ResultCache, KEY_RE };
