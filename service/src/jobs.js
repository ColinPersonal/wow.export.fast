// Jobs: queueing, lanes, de-duplication, caching, retries and waiting.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { canonicalJSON, sha256, newId, ServiceError, sleep } = require('./util');

const TERMINAL = new Set(['done', 'partial', 'failed', 'cancelled']);
const MAX_KEPT_JOBS = 5000;

/** How many items a job exports, used for lane choice and limits. */
const countItems = (kind, params) => {
	switch (kind) {
		case 'get_file':
		case 'export_model':
			return { items: 1, tiles: 0 };
		case 'export_files':
		case 'export_textures':
		case 'export_models':
			return { items: params.files?.length ?? 0, tiles: 0 };
		case 'export_table':
			return { items: params.tables?.length ?? 0, tiles: 0 };
		case 'export_map':
		case 'export_map_baked':
		case 'export_minimap':
			return { items: 0, tiles: Array.isArray(params.tiles) ? params.tiles.length : Infinity };
		default:
			return { items: 1, tiles: 0 };
	}
};

/** Hash of the exporter source, so results from older code are never reused. */
const hashSource = (repo) => {
	const root = path.join(repo, 'src');
	const parts = [];
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== 'fa-icons' && entry.name !== 'images' && entry.name !== 'fonts' && entry.name !== 'help_docs')
					walk(full);
			} else if (/\.(js|jsonc|json|shader|wasm)$/.test(entry.name)) {
				parts.push(path.relative(root, full) + ':' + sha256(fs.readFileSync(full)));
			}
		}
	};
	walk(root);
	return sha256(parts.join('\n')).slice(0, 16);
};

class JobStore {
	constructor(stateDir) {
		this.file = path.join(stateDir, 'jobs.jsonl');
	}

	load() {
		const jobs = new Map();
		let text = '';
		try {
			text = fs.readFileSync(this.file, 'utf8');
		} catch {
			return jobs;
		}

		for (const line of text.split('\n')) {
			if (line.trim().length === 0)
				continue;
			try {
				const job = JSON.parse(line);
				jobs.set(job.id, job);
			} catch {
				// a torn last line after a crash
			}
		}

		// Keep the file small: rewrite with one line per kept job.
		const kept = [...jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-MAX_KEPT_JOBS);
		fs.writeFileSync(this.file, kept.map(j => JSON.stringify(j)).join('\n') + (kept.length ? '\n' : ''));
		return new Map(kept.map(j => [j.id, j]));
	}

	save(job) {
		fs.appendFileSync(this.file, JSON.stringify(job) + '\n');
	}
}

class JobService {
	constructor({ config, log, pool, cache }) {
		this.config = config;
		this.log = log;
		this.pool = pool;
		this.cache = cache;
		this.store = new JobStore(config.dirs.state);
		this.jobs = new Map();
		this.queues = new Map();
		this.active = new Map();
		this.waiters = new Map();
		this.submitting = new Map();
		this.codeHash = hashSource(config.repo);
		this.buildsFile = path.join(config.dirs.state, 'builds.json');
		this.builds = {};
		try {
			this.builds = JSON.parse(fs.readFileSync(this.buildsFile, 'utf8'));
		} catch {
			// first run
		}

		pool.on('idle', (engine) => this.onEngineIdle(engine));
		pool.on('exit', (engine) => this.onEngineExit(engine));
		pool.on('demand', (engine, demand) => {
			if ((this.queues.get(engine.id)?.length ?? 0) > 0 || engine.busy)
				demand.wanted = true;
		});
	}

	/** Restore jobs from disk; requeue those that were waiting or running. */
	restore() {
		const restored = this.store.load();
		for (const job of restored.values()) {
			this.jobs.set(job.id, job);
			if (job.status === 'queued' || job.status === 'running') {
				job.status = 'queued';
				job.progress = null;
				this.log.info('requeued %s after restart', job.id);
				this.enqueue(job, false);
			}
		}

		// Staging folders of jobs that are no longer running are leftovers.
		for (const entry of fs.readdirSync(this.config.dirs.staging)) {
			const job = this.jobs.get(entry);
			if (job === undefined || TERMINAL.has(job.status))
				fs.rmSync(path.join(this.config.dirs.staging, entry), { recursive: true, force: true });
		}
	}

	snapshot(job) {
		const out = {
			job_id: job.id,
			status: job.status,
			tool: job.tool,
			product: job.product,
			label: job.label ?? undefined,
			created_at: job.createdAt,
			started_at: job.startedAt ?? undefined,
			finished_at: job.finishedAt ?? undefined,
			cached: job.cached || undefined
		};

		if (job.status === 'queued')
			out.queue_position = this.position(job);
		if (job.progress)
			out.progress = job.progress;
		if (job.error)
			out.error = job.error;
		if (job.resultKey)
			out.result_key = job.resultKey;
		if (job.build)
			out.build = job.build;
		if (job.summary)
			out.summary = job.summary;
		if (job.failed?.length)
			out.failed = job.failed.slice(0, 50);
		return out;
	}

	position(job) {
		const queue = this.queues.get(job.engineId) ?? [];
		const index = queue.indexOf(job);
		return index < 0 ? 0 : index + 1;
	}

	persist(job) {
		const { ...plain } = job;
		this.store.save(plain);
	}

	knownBuild(product) {
		return this.builds[product] ?? null;
	}

	rememberBuild(product, build) {
		const id = build?.buildConfig ?? build?.version ?? null;
		if (id === null || this.builds[product] === id)
			return;
		this.builds[product] = id;
		fs.writeFileSync(this.buildsFile, JSON.stringify(this.builds, null, '\t'));
	}

	requestKey(tool, kind, params, product) {
		return sha256(canonicalJSON({ v: 1, tool, kind, params, product, code: this.codeHash, base: this.config.engineConfig }));
	}

	resultKey(requestKey, build) {
		return sha256(requestKey + ':' + build);
	}

	/**
	 * Submit an export.
	 * @param {object} req { tool, kind, params, product, force, token, label, priority }
	 */
	async submit(req) {
		const requestKey = this.requestKey(req.tool, req.kind, req.params, req.product);

		// Identical submissions arriving together share one job: the async part
		// below runs once per request key at a time.
		if (!req.force) {
			const inflight = this.submitting.get(requestKey);
			if (inflight !== undefined) {
				const job = await inflight.catch(() => null);
				if (job !== null && !TERMINAL.has(job.status) && !job.cached) {
					if (!job.tokens.includes(req.token))
						job.tokens.push(req.token);
					return job;
				}
			}
		}

		const promise = this.submitInner(req, requestKey);
		if (!req.force) {
			this.submitting.set(requestKey, promise);
			promise.finally(() => {
				if (this.submitting.get(requestKey) === promise)
					this.submitting.delete(requestKey);
			}).catch(() => {});
		}
		return promise;
	}

	async submitInner(req, requestKey) {
		const product = req.product;
		const { items, tiles } = countItems(req.kind, req.params);
		if (items > this.config.maxItemsPerJob)
			throw new ServiceError('INVALID_PARAMS', 'Too many files in one job (' + items + ', limit ' + this.config.maxItemsPerJob + ')', { hint: 'Split the request into several jobs.' });
		if (tiles !== Infinity && tiles > this.config.maxTilesPerJob)
			throw new ServiceError('INVALID_PARAMS', 'Too many tiles in one job (' + tiles + ', limit ' + this.config.maxTilesPerJob + ')', { hint: 'Split the request into several jobs.' });

		// A finished result for the last known build is returned straight away.
		const build = this.knownBuild(product);
		if (!req.force && build !== null) {
			const key = this.resultKey(requestKey, build);
			const manifest = await this.cache.get(key);
			if (manifest !== null) {
				this.cache.touch(key);
				const job = this.newJob(req, requestKey);
				Object.assign(job, { status: 'done', cached: true, resultKey: key, build, finishedAt: new Date().toISOString(), summary: this.summarise(manifest) });
				this.jobs.set(job.id, job);
				this.persist(job);
				return job;
			}
		}

		// The same request already queued or running: share it.
		if (!req.force) {
			const existing = this.active.get(requestKey);
			if (existing !== undefined && !TERMINAL.has(existing.status)) {
				if (!existing.tokens.includes(req.token))
					existing.tokens.push(req.token);
				return existing;
			}
		}

		const queued = [...this.jobs.values()].filter(j => j.status === 'queued' && j.tokens.includes(req.token)).length;
		if (queued >= this.config.maxQueuedPerToken)
			throw new ServiceError('QUOTA_EXCEEDED', 'Too many queued jobs for this token (' + queued + ')', { retryable: true, hint: 'Wait for some jobs to finish.' });

		await this.ensureDisk();

		const job = this.newJob(req, requestKey);
		job.lane = (items <= this.config.quickMaxItems && tiles <= this.config.quickMaxTiles) ? 'quick' : 'bulk';
		this.jobs.set(job.id, job);
		this.active.set(requestKey, job);
		this.enqueue(job, true);
		return job;
	}

	newJob(req, requestKey) {
		return {
			id: newId('job'),
			requestKey,
			tool: req.tool,
			kind: req.kind,
			params: req.params,
			product: req.product,
			force: !!req.force,
			label: req.label ?? null,
			priority: req.priority === 'low' ? 'low' : 'normal',
			tokens: [req.token],
			status: 'queued',
			createdAt: new Date().toISOString(),
			attempts: 0
		};
	}

	async ensureDisk() {
		const floor = this.config.minFreeGB * 1024 ** 3;
		if (await this.cache.freeBytes() >= floor)
			return;

		await this.cache.evict();
		if (await this.cache.freeBytes() < floor)
			throw new ServiceError('QUOTA_EXCEEDED', 'Not enough free disk space on the export machine', { retryable: true });
	}

	enqueue(job, persist) {
		const engine = this.pool.get(job.product, job.lane ?? 'bulk');
		job.engineId = engine.id;
		this.active.set(job.requestKey, job);

		let queue = this.queues.get(engine.id);
		if (queue === undefined) {
			queue = [];
			this.queues.set(engine.id, queue);
		}

		// Normal priority jobs go ahead of low priority ones.
		if (job.priority === 'low' || job.retryFront !== true) {
			const index = job.priority === 'low' ? queue.length : queue.findIndex(j => j.priority === 'low');
			queue.splice(index < 0 ? queue.length : index, 0, job);
		} else {
			queue.unshift(job);
		}
		job.retryFront = false;

		if (persist)
			this.persist(job);

		if (engine.state === 'ready')
			this.dispatch(engine);
		else
			engine.ready().catch(() => {});
	}

	onEngineIdle(engine) {
		this.dispatch(engine);
		this.notifyEngine(engine);
	}

	onEngineExit(engine) {
		// If an engine is down, its partner lane takes over its waiting jobs.
		const partner = this.pool.forProduct(engine.product).find(e => e !== engine && e.state === 'ready');
		if (partner !== undefined)
			this.dispatch(partner);
	}

	notifyEngine(engine) {
		if (engine.build)
			this.rememberBuild(engine.product, engine.build);
	}

	/** Next job for an engine: its own queue, then a failed partner's queue. */
	nextJobFor(engine) {
		const own = this.queues.get(engine.id) ?? [];
		if (own.length > 0)
			return own.shift();

		for (const other of this.pool.forProduct(engine.product)) {
			if (other === engine || other.state === 'ready' || other.state === 'starting')
				continue;
			const queue = this.queues.get(other.id) ?? [];
			if (queue.length > 0)
				return queue.shift();
		}
		return null;
	}

	dispatch(engine) {
		if (engine.state !== 'ready' || engine.busy)
			return;

		const job = this.nextJobFor(engine);
		if (job === null)
			return;

		this.runJob(engine, job).catch(e => this.log.error('job %s crashed the dispatcher: %s', job.id, e.stack));
	}

	async runJob(engine, job) {
		this.notifyEngine(engine);
		const build = engine.build?.buildConfig ?? engine.build?.version ?? 'unknown';
		const key = this.resultKey(job.requestKey, build);
		job.build = build;

		// Another job may have produced this result meanwhile.
		if (!job.force) {
			const manifest = await this.cache.get(key);
			if (manifest !== null) {
				this.cache.touch(key);
				this.finish(job, { status: 'done', resultKey: key, cached: true, summary: this.summarise(manifest) });
				this.dispatch(engine);
				return;
			}
		}

		job.status = 'running';
		job.startedAt = new Date().toISOString();
		job.attempts++;
		job.engineId = engine.id;
		job.progress = { done: 0, total: null };
		this.persist(job);
		this.notify(job);

		const outDir = path.join(this.config.dirs.staging, job.id);
		await fsp.rm(outDir, { recursive: true, force: true });
		await fsp.mkdir(outDir, { recursive: true });

		let done;
		try {
			done = await engine.run({
				id: job.id,
				kind: job.kind,
				params: job.params,
				outDir,
				onProgress: (msg) => {
					job.progress = { done: msg.done, total: msg.total, current: msg.current };
					this.notify(job);
				}
			});
		} catch (e) {
			await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
			if (job.cancelRequested) {
				this.finish(job, { status: 'cancelled', error: { code: 'CANCELLED', message: 'Job was cancelled', retryable: false } });
				return;
			}

			if (e.retryable && job.attempts <= this.config.jobRetries) {
				this.log.warn('job %s lost its engine (%s); retrying', job.id, e.message);
				job.status = 'queued';
				job.progress = null;
				job.retryFront = true;
				this.enqueue(job, true);
				return;
			}

			this.finish(job, { status: 'failed', error: { code: e.code ?? 'INTERNAL', message: e.message, retryable: !!e.retryable } });
			return;
		}

		if (done.cancelled || job.cancelRequested) {
			await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
			this.finish(job, { status: 'cancelled', error: { code: 'CANCELLED', message: 'Job was cancelled', retryable: false } });
			return;
		}

		if (done.error) {
			await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
			this.finish(job, { status: 'failed', error: { code: done.error.code ?? 'EXPORT_FAILED', message: done.error.message, retryable: false }, failed: done.failed });
			return;
		}

		const partial = !done.ok;
		// Partial results are kept for download but never reused for a later request.
		const storeKey = partial ? sha256(key + ':' + job.id) : key;

		try {
			const manifest = await this.cache.commit(storeKey, outDir, {
				job: job.id,
				tool: job.tool,
				kind: job.kind,
				product: job.product,
				build,
				params: job.params,
				partial,
				result: done.result ?? null,
				failed: done.failed ?? []
			});

			this.finish(job, { status: partial ? 'partial' : 'done', resultKey: storeKey, failed: done.failed ?? [], summary: this.summarise(manifest), engineResult: done.result ?? null });
		} catch (e) {
			await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
			this.finish(job, { status: 'failed', error: { code: 'INTERNAL', message: 'Could not store the result: ' + e.message, retryable: true } });
		}

		this.cache.evict().catch(e => this.log.warn('eviction failed: %s', e.message));
	}

	summarise(manifest) {
		return {
			file_count: manifest.fileCount,
			total_bytes: manifest.totalBytes,
			partial: manifest.partial || undefined
		};
	}

	finish(job, fields) {
		Object.assign(job, fields, { finishedAt: new Date().toISOString() });
		if (this.active.get(job.requestKey) === job)
			this.active.delete(job.requestKey);
		this.persist(job);
		this.notify(job);
	}

	notify(job) {
		const waiters = this.waiters.get(job.id);
		if (waiters === undefined)
			return;
		this.waiters.delete(job.id);
		for (const w of waiters)
			w();
	}

	get(jobId, token) {
		const job = this.jobs.get(jobId);
		if (job === undefined || (token !== undefined && !job.tokens.includes(token)))
			throw new ServiceError('NOT_FOUND', 'Unknown job ' + jobId, { hint: 'Use list_jobs to see your jobs.' });
		return job;
	}

	/**
	 * Wait until the job finishes or the time runs out.
	 * @param {string} jobId
	 * @param {string} token
	 * @param {number} ms
	 */
	async wait(jobId, token, ms) {
		const deadline = Date.now() + ms;
		let job = this.get(jobId, token);

		while (!TERMINAL.has(job.status)) {
			const left = deadline - Date.now();
			if (left <= 0)
				break;

			await new Promise((resolve) => {
				const timer = setTimeout(resolve, left);
				let list = this.waiters.get(jobId);
				if (list === undefined) {
					list = [];
					this.waiters.set(jobId, list);
				}
				list.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});

			job = this.get(jobId, token);
		}

		return job;
	}

	/**
	 * Cancel a job. When others share it, only this requester is detached.
	 */
	cancel(jobId, token) {
		const job = this.get(jobId, token);
		if (TERMINAL.has(job.status))
			return job;

		if (job.tokens.length > 1) {
			job.tokens = job.tokens.filter(t => t !== token);
			this.persist(job);
			return Object.assign({}, job, { status: 'cancelled', detached: true });
		}

		job.cancelRequested = true;
		if (job.status === 'queued') {
			const queue = this.queues.get(job.engineId) ?? [];
			const index = queue.indexOf(job);
			if (index >= 0)
				queue.splice(index, 1);
			this.finish(job, { status: 'cancelled', error: { code: 'CANCELLED', message: 'Job was cancelled', retryable: false } });
		} else {
			this.pool.engines.get(job.engineId)?.cancel(job.id);
		}

		return job;
	}

	list(token, limit = 20) {
		return [...this.jobs.values()]
			.filter(j => j.tokens.includes(token))
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, limit);
	}

	/**
	 * Run a read-only query on an engine of the product.
	 */
	async query(product, kind, params) {
		const engines = this.pool.forProduct(product);
		// Prefer a ready engine that is not running a bulk job.
		const engine = engines.find(e => e.state === 'ready' && !e.busy) ?? engines.find(e => e.state === 'ready') ?? engines[0];
		await engine.ready();
		this.notifyEngine(engine);
		return engine.query(kind, params);
	}

	queueDepth() {
		let n = 0;
		for (const q of this.queues.values())
			n += q.length;
		return n;
	}
}

module.exports = { JobService, countItems, hashSource, TERMINAL };
