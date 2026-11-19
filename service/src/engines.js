// Engine processes: one per product and lane, each a headless exporter that
// connects back over a local socket (see service/PROTOCOL.md). The pool
// starts them on demand, watches their heartbeats, and restarts them when
// they crash, hang or grow too large.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { ServiceError } = require('./util');
const { sourceFor } = require('./config');

const PROTOCOL = 1;
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000];

class Engine extends EventEmitter {
	constructor(pool, product, lane) {
		super();
		this.pool = pool;
		this.config = pool.config;
		this.log = pool.log;
		this.product = product;
		this.lane = lane;
		this.id = product + '-' + lane;
		this.state = 'stopped';
		this.error = null;
		this.build = null;
		this.kinds = [];
		this.proc = null;
		this.socket = null;
		this.job = null;
		this.pendingQueries = new Map();
		this.restarts = 0;
		this.failures = 0;
		this.lastUsed = Date.now();
		this.startedAt = 0;
		this.stats = { rss: 0, heapUsed: 0 };
		this.stopping = false;
		this.readyWaiters = [];
	}

	get busy() {
		return this.job !== null;
	}

	describe() {
		return {
			id: this.id,
			product: this.product,
			lane: this.lane,
			state: this.state,
			error: this.error,
			build: this.build,
			busy: this.busy,
			job: this.job?.id ?? null,
			pid: this.proc?.pid ?? null,
			rssMB: Math.round(this.stats.rss / 1048576),
			restarts: this.restarts,
			uptimeSeconds: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0
		};
	}

	/** Resolve when the engine is ready, starting it if needed. */
	ready(timeoutMs = 180000) {
		if (this.state === 'ready')
			return Promise.resolve(this);

		if (this.state === 'stopped' || (this.state === 'failed' && !this.restartTimer))
			this.start();

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.readyWaiters = this.readyWaiters.filter(w => w.resolve !== resolve);
				reject(new ServiceError('ENGINE_UNAVAILABLE', 'The ' + this.product + ' engine did not become ready in time', { retryable: true }));
			}, timeoutMs);
			this.readyWaiters.push({
				resolve: (v) => { clearTimeout(timer); resolve(v); },
				reject: (e) => { clearTimeout(timer); reject(e); }
			});
		});
	}

	start() {
		if (this.proc !== null)
			return;

		clearTimeout(this.restartTimer);
		this.restartTimer = null;
		this.stopping = false;
		this.state = 'starting';
		this.error = null;
		this.secret = crypto.randomBytes(32).toString('hex');

		const dataDir = path.join(this.config.dirs.engines, this.id);
		fs.mkdirSync(dataDir, { recursive: true });

		const spec = {
			protocol: PROTOCOL,
			id: this.id,
			gatewayPort: this.pool.port,
			secret: this.secret,
			source: sourceFor(this.config, this.product),
			dataDir,
			config: this.config.engineConfig
		};

		const specFile = path.join(dataDir, 'engine.json');
		fs.writeFileSync(specFile, JSON.stringify(spec, null, '\t'));

		const { command, args, env } = this.pool.commandFor(spec, specFile);
		const logFile = fs.openSync(path.join(this.config.dirs.logs, 'engine-' + this.id + '.log'), 'a');

		this.log.info('starting engine %s (%s %s)', this.id, spec.source.type, spec.source.product);
		this.startedAt = Date.now();
		this.proc = spawn(command, args, {
			cwd: this.config.repo,
			env: Object.assign({}, process.env, env ?? {}),
			stdio: ['ignore', logFile, logFile],
			windowsHide: true
		});
		fs.closeSync(logFile);

		try {
			os.setPriority(this.proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
		} catch {
			// not fatal
		}

		this.proc.on('exit', (code, signal) => this.onExit(code, signal));
		this.proc.on('error', (e) => {
			this.log.warn('engine %s failed to start: %s', this.id, e.message);
			this.error = { code: 'ENGINE_UNAVAILABLE', message: 'Engine could not be started: ' + e.message };
		});

		this.pool.expect(this);
		this.armWatchdog();
	}

	armWatchdog() {
		clearTimeout(this.watchdog);
		const limit = this.state === 'ready' ? this.config.heartbeatTimeoutSeconds * 1000 : 10 * 60 * 1000;
		this.watchdog = setTimeout(() => {
			this.log.warn('engine %s missed its heartbeat (%s); restarting', this.id, this.state);
			this.kill('heartbeat timeout');
		}, limit);
	}

	/** Called by the pool once the engine's socket has said hello. */
	attach(socket, hello) {
		this.socket = socket;
		this.host = hello.host;
		this.send({ t: 'welcome' });
		this.armWatchdog();
	}

	send(msg) {
		if (this.socket !== null && !this.socket.destroyed)
			this.socket.write(JSON.stringify(msg) + '\n');
	}

	onMessage(msg) {
		this.armWatchdog();

		switch (msg.t) {
			case 'ready':
				this.state = 'ready';
				this.build = msg.build ?? null;
				this.kinds = Array.isArray(msg.kinds) ? msg.kinds : [];
				this.failures = 0;
				this.log.info('engine %s ready in %dms (%s)', this.id, msg.loadMs ?? 0, this.build?.version ?? this.build?.buildConfig ?? '?');
				for (const w of this.readyWaiters.splice(0))
					w.resolve(this);
				this.emit('ready', this);
				break;

			case 'fatal':
				this.error = msg.error ?? { code: 'SOURCE_UNAVAILABLE', message: 'Engine failed' };
				this.log.warn('engine %s fatal: %s', this.id, this.error.message);
				break;

			case 'heartbeat':
				this.stats = { rss: msg.rss ?? 0, heapUsed: msg.heapUsed ?? 0 };
				if (this.stats.rss > this.config.engineMemoryMB * 1048576 && !this.busy) {
					this.log.warn('engine %s using %d MB; recycling', this.id, Math.round(this.stats.rss / 1048576));
					this.recycle();
				}
				break;

			case 'progress':
				if (this.job?.id === msg.job)
					this.job.onProgress?.(msg);
				break;

			case 'done': {
				const job = this.job;
				if (job?.id !== msg.job)
					break;
				this.job = null;
				this.lastUsed = Date.now();
				job.resolve(msg);
				this.emit('idle', this);
				break;
			}

			case 'reply': {
				const pending = this.pendingQueries.get(msg.req);
				if (pending === undefined)
					break;
				this.pendingQueries.delete(msg.req);
				clearTimeout(pending.timer);
				if (msg.ok)
					pending.resolve(msg.result);
				else
					pending.reject(new ServiceError(msg.error?.code ?? 'INTERNAL', msg.error?.message ?? 'Query failed'));
				break;
			}
		}
	}

	/**
	 * Run a job. Resolves with the engine's `done` message.
	 * @param {object} job { id, kind, params, outDir, onProgress }
	 */
	run(job) {
		if (this.state !== 'ready')
			return Promise.reject(new ServiceError('ENGINE_UNAVAILABLE', 'Engine is not ready', { retryable: true }));
		if (this.busy)
			return Promise.reject(new ServiceError('BUSY', 'Engine is busy', { retryable: true }));

		this.lastUsed = Date.now();
		return new Promise((resolve, reject) => {
			this.job = Object.assign({}, job, { resolve, reject });
			this.send({ t: 'job', job: job.id, kind: job.kind, params: job.params, outDir: job.outDir });
		});
	}

	cancel(jobId) {
		if (this.job?.id === jobId)
			this.send({ t: 'cancel', job: jobId });
	}

	/**
	 * Read-only request answered by the engine while it may be running a job.
	 */
	query(kind, params, timeoutMs = 60000) {
		if (this.state !== 'ready')
			return Promise.reject(new ServiceError('ENGINE_UNAVAILABLE', 'Engine is not ready', { retryable: true }));

		this.lastUsed = Date.now();
		const req = crypto.randomBytes(6).toString('hex');
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingQueries.delete(req);
				reject(new ServiceError('TIMEOUT', 'The engine did not answer in time', { retryable: true }));
			}, timeoutMs);
			this.pendingQueries.set(req, { resolve, reject, timer });
			this.send({ t: 'query', req, kind, params });
		});
	}

	onExit(code, signal) {
		clearTimeout(this.watchdog);
		const wasReady = this.state === 'ready';
		this.proc = null;
		this.socket?.destroy();
		this.socket = null;
		this.state = this.stopping ? 'stopped' : 'failed';

		if (!this.stopping && !this.error)
			this.error = { code: 'ENGINE_UNAVAILABLE', message: 'Engine exited (' + (signal ?? code) + ')' };

		this.log.warn('engine %s exited (code %s, signal %s)', this.id, code, signal);

		const err = new ServiceError(this.error?.code ?? 'ENGINE_UNAVAILABLE', this.error?.message ?? 'Engine stopped', { retryable: true });

		if (this.job !== null) {
			const job = this.job;
			this.job = null;
			job.reject(err);
		}

		for (const pending of this.pendingQueries.values()) {
			clearTimeout(pending.timer);
			pending.reject(err);
		}
		this.pendingQueries.clear();

		this.emit('exit', this);

		if (this.stopping)
			return;

		// Failing before ever becoming ready counts towards giving up for a while.
		if (!wasReady)
			this.failures++;

		const delay = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)];
		if (this.failures >= 6) {
			this.log.warn('engine %s keeps failing; waiting 5 minutes', this.id);
			for (const w of this.readyWaiters.splice(0))
				w.reject(err);
		}

		if (this.pool.wanted(this)) {
			this.restarts++;
			this.restartTimer = setTimeout(() => {
				this.restartTimer = null;
				this.start();
			}, this.failures >= 6 ? 300000 : delay);
		} else {
			for (const w of this.readyWaiters.splice(0))
				w.reject(err);
		}
	}

	kill(reason) {
		if (this.proc === null)
			return;
		this.error = { code: 'ENGINE_UNAVAILABLE', message: 'Engine restarted: ' + reason };
		try {
			this.proc.kill();
		} catch {
			// already gone
		}
	}

	/** Restart now (used when idle, e.g. memory growth or periodic recycle). */
	recycle() {
		this.kill('recycle');
	}

	stop() {
		this.stopping = true;
		clearTimeout(this.restartTimer);
		clearTimeout(this.watchdog);
		for (const w of this.readyWaiters.splice(0))
			w.reject(new ServiceError('ENGINE_UNAVAILABLE', 'Engine stopped', { retryable: true }));

		if (this.proc === null) {
			this.state = 'stopped';
			return Promise.resolve();
		}

		return new Promise((resolve) => {
			const proc = this.proc;
			const timer = setTimeout(() => {
				try { proc.kill(); } catch { /* gone */ }
			}, 5000);
			proc.once('exit', () => {
				clearTimeout(timer);
				resolve();
			});
			this.send({ t: 'shutdown' });
			this.socket?.end();
		});
	}
}

class EnginePool extends EventEmitter {
	/**
	 * @param {object} config
	 * @param {object} log
	 * @param {object} [options]
	 * @param {function} [options.command] (spec, specFile) => {command, args, env}; for tests.
	 */
	constructor(config, log, options = {}) {
		super();
		this.config = config;
		this.log = log;
		this.engines = new Map();
		this.expecting = new Map();
		this.commandOverride = options.command ?? null;
	}

	commandFor(spec, specFile) {
		if (this.commandOverride !== null)
			return this.commandOverride(spec, specFile);

		return {
			command: this.config.bun,
			args: [path.join(this.config.repo, 'src', 'js', 'headless', 'cli.js'), 'engine', '--config', specFile]
		};
	}

	async listen() {
		this.server = net.createServer(socket => this.onConnection(socket));
		await new Promise((resolve, reject) => {
			this.server.once('error', reject);
			this.server.listen(0, '127.0.0.1', resolve);
		});
		this.port = this.server.address().port;

		this.idleTimer = setInterval(() => this.housekeeping(), 30000);
		this.idleTimer.unref();
	}

	expect(engine) {
		this.expecting.set(engine.id, engine);
	}

	onConnection(socket) {
		socket.setEncoding('utf8');
		socket.setNoDelay(true);

		let engine = null;
		let buffer = '';
		const helloTimer = setTimeout(() => socket.destroy(), 10000);

		socket.on('data', (chunk) => {
			buffer += chunk;
			if (buffer.length > 64 * 1024 * 1024) {
				socket.destroy();
				return;
			}

			let nl;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				if (line.trim().length === 0)
					continue;

				let msg;
				try {
					msg = JSON.parse(line);
				} catch {
					socket.destroy();
					return;
				}

				if (engine === null) {
					const candidate = this.expecting.get(msg.id);
					const ok = msg.t === 'hello' && msg.protocol === PROTOCOL && candidate !== undefined && typeof msg.secret === 'string'
						&& msg.secret.length === candidate.secret.length
						&& crypto.timingSafeEqual(Buffer.from(msg.secret), Buffer.from(candidate.secret));

					if (!ok) {
						this.log.warn('rejected engine connection (%s)', msg.id ?? 'no id');
						socket.destroy();
						return;
					}

					clearTimeout(helloTimer);
					this.expecting.delete(msg.id);
					engine = candidate;
					engine.attach(socket, msg);
					continue;
				}

				engine.onMessage(msg);
			}
		});

		socket.on('error', () => {});
		socket.on('close', () => {
			clearTimeout(helloTimer);
			// The engine exits when its socket closes; make sure it does.
			if (engine !== null && engine.socket === socket && engine.proc !== null)
				setTimeout(() => engine.kill('socket closed'), 5000).unref();
		});
	}

	lanesFor(product) {
		return this.config.warmProducts.includes(product) ? ['quick', 'bulk'] : ['main'];
	}

	get(product, lane) {
		const lanes = this.lanesFor(product);
		if (!lanes.includes(lane))
			lane = lanes[0];

		const id = product + '-' + lane;
		let engine = this.engines.get(id);
		if (engine === undefined) {
			engine = new Engine(this, product, lane);
			engine.on('idle', () => this.emit('idle', engine));
			engine.on('ready', () => this.emit('idle', engine));
			engine.on('exit', () => this.emit('exit', engine));
			this.engines.set(id, engine);
		}
		return engine;
	}

	/** Engines of a product, in lane order. */
	forProduct(product) {
		return this.lanesFor(product).map(lane => this.get(product, lane));
	}

	/** True if an engine should be restarted after it exits. */
	wanted(engine) {
		if (this.closing)
			return false;
		if (this.config.warmProducts.includes(engine.product))
			return true;
		return this.emitDemand(engine);
	}

	emitDemand(engine) {
		const demand = { wanted: false };
		this.emit('demand', engine, demand);
		return demand.wanted;
	}

	startWarm() {
		for (const product of this.config.warmProducts) {
			for (const engine of this.forProduct(product))
				engine.start();
		}
	}

	housekeeping() {
		const now = Date.now();
		for (const engine of this.engines.values()) {
			if (engine.state !== 'ready' || engine.busy)
				continue;

			const warm = this.config.warmProducts.includes(engine.product);
			if (!warm && now - engine.lastUsed > this.config.engineIdleStopMinutes * 60000 && !this.emitDemand(engine)) {
				this.log.info('stopping idle engine %s', engine.id);
				engine.stop();
				continue;
			}

			if (now - engine.startedAt > this.config.engineRecycleHours * 3600000 && now - engine.lastUsed > 60000) {
				this.log.info('recycling engine %s after %d hours', engine.id, this.config.engineRecycleHours);
				engine.recycle();
			}
		}
	}

	describe() {
		return [...this.engines.values()].map(e => e.describe());
	}

	async close() {
		this.closing = true;
		clearInterval(this.idleTimer);
		await Promise.all([...this.engines.values()].map(e => e.stop()));
		await new Promise(resolve => this.server ? this.server.close(resolve) : resolve());
	}
}

module.exports = { EnginePool, Engine, PROTOCOL };
