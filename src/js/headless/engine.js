/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Export service engine: runs the headless export service on behalf of the
// export service gateway (service/ in this repository), speaking the protocol
// described in service/PROTOCOL.md over a local TCP connection.
//
//   bun src/js/headless/cli.js engine --config <engine.json>
//
// The engine opens one game build, then runs export jobs one at a time and
// answers read-only queries at any time. It exits when the gateway goes away.

const net = require('net');
const { createParser, encode } = require('./ndjson');
const { CODES, describe } = require('./errors');

const PROTOCOL = 1;
const HEARTBEAT_MS = 5000;
const WELCOME_TIMEOUT_MS = 15000;

// Job and query kinds, mapped to service operations. Parameters are the tool
// arguments; outDir and progress come from the engine.
const JOB_KINDS = {
	get_file: 'getFile',
	export_files: 'exportFiles',
	export_textures: 'exportTextures',
	export_model: 'exportModel',
	export_models: 'exportModels',
	export_map: 'exportMap',
	export_table: 'exportTable'
};

const QUERY_KINDS = {
	info: 'info',
	search: 'search',
	file_info: 'fileInfo',
	list_maps: 'listMaps',
	list_map_tiles: 'listMapTiles',
	list_tables: 'listTables',
	describe_table: 'describeTable',
	query_table: 'queryTable'
};

// Parameters the gateway decides, never the request.
const RESERVED_PARAMS = ['outDir', 'onProgress', 'install', 'product', 'region', 'allowRegex'];

/**
 * Check an engine.json object.
 * @param {object} config
 * @returns {string[]} Problems found (empty when valid).
 */
const validateConfig = (config) => {
	const problems = [];
	if (config === null || typeof config !== 'object')
		return ['config must be an object'];

	if (config.protocol !== PROTOCOL)
		problems.push('protocol must be ' + PROTOCOL);

	if (!Number.isInteger(config.gatewayPort) || config.gatewayPort <= 0 || config.gatewayPort > 65535)
		problems.push('gatewayPort must be a TCP port');

	if (typeof config.secret !== 'string' || config.secret.length < 16)
		problems.push('secret must be a string of at least 16 characters');

	if (typeof config.id !== 'string' || config.id.length === 0)
		problems.push('id is required');

	const source = config.source;
	if (source === null || typeof source !== 'object')
		problems.push('source is required');
	else if (source.type === 'local' && (typeof source.install !== 'string' || source.install.length === 0))
		problems.push('source.install is required for a local source');
	else if (source.type !== 'local' && source.type !== 'remote')
		problems.push('source.type must be local or remote');
	else if (typeof source.product !== 'string' || source.product.length === 0)
		problems.push('source.product is required');

	if (typeof config.dataDir !== 'string' || config.dataDir.length === 0)
		problems.push('dataDir is required');

	return problems;
};

/**
 * Copy request parameters, dropping the ones only the gateway may set.
 * @param {object} params
 * @returns {object}
 */
const cleanParams = (params) => {
	const out = {};
	if (params === null || typeof params !== 'object' || Array.isArray(params))
		return out;

	for (const [key, value] of Object.entries(params)) {
		if (!RESERVED_PARAMS.includes(key))
			out[key] = value;
	}

	return out;
};

/**
 * Run the engine.
 * @param {object} config engine.json contents.
 * @param {object} [deps] Replacements for tests.
 * @param {object} [deps.service] The headless service (default: ./service).
 * @param {object} [deps.runtime] The headless runtime (default: ./runtime).
 * @param {function} [deps.exit] Process exit (default: process.exit).
 * @param {function} [deps.log] Diagnostic logger.
 * @returns {Promise<void>} Resolves once connected and the game data is open (or failed to open).
 */
const runEngine = (config, deps = {}) => {
	const problems = validateConfig(config);
	if (problems.length > 0)
		throw new Error('Invalid engine config: ' + problems.join('; '));

	const exit = deps.exit ?? ((code) => process.exit(code));
	const writeLog = deps.log ?? ((...args) => {
		try {
			require('../log').write(...args);
		} catch {
			// logging is best effort
		}
	});

	const started = Date.now();
	let socket = null;
	let welcomed = false;
	let ready = false;
	let exiting = false;
	let currentJob = null;
	let heartbeat = null;
	let service = deps.service ?? null;

	const send = (message) => {
		if (socket !== null && !socket.destroyed && socket.writable)
			socket.write(encode(message));
	};

	const shutdown = (code, reason) => {
		if (exiting)
			return;

		exiting = true;
		writeLog('[engine] exiting (%s)', reason);
		clearInterval(heartbeat);

		// Let queued writes reach the gateway before the process goes.
		const finish = () => exit(code);
		if (socket !== null && !socket.destroyed) {
			socket.end(finish);
			setTimeout(finish, 1000).unref?.();
		} else {
			finish();
		}
	};

	const kinds = () => Object.keys(JOB_KINDS);

	const runQuery = async (message) => {
		const method = QUERY_KINDS[message.kind];
		if (method === undefined)
			return send({ t: 'reply', req: message.req, ok: false, error: { code: CODES.UNSUPPORTED, message: 'Unknown query kind: ' + message.kind } });

		if (!ready)
			return send({ t: 'reply', req: message.req, ok: false, error: { code: CODES.SOURCE_UNAVAILABLE, message: 'The game data is not open yet' } });

		try {
			const params = cleanParams(message.params);
			if (message.kind === 'search')
				params.allowRegex = false;

			const result = await service[method](params);
			send({ t: 'reply', req: message.req, ok: true, result });
		} catch (e) {
			send({ t: 'reply', req: message.req, ok: false, error: describe(e) });
		}
	};

	const runJob = async (message) => {
		const id = message.job;
		const method = JOB_KINDS[message.kind];

		const finish = (fields) => send(Object.assign({ t: 'done', job: id, ok: false, cancelled: false, result: null, failed: [] }, fields));

		if (currentJob !== null)
			return finish({ error: { code: CODES.BUSY, message: 'Engine is already running job ' + currentJob.id } });

		if (method === undefined)
			return finish({ error: { code: CODES.UNSUPPORTED, message: 'Unknown job kind: ' + message.kind } });

		if (!ready)
			return finish({ error: { code: CODES.SOURCE_UNAVAILABLE, message: 'The game data is not open yet' } });

		if (typeof message.outDir !== 'string' || message.outDir.length === 0)
			return finish({ error: { code: CODES.INVALID_PARAMS, message: 'outDir is required' } });

		currentJob = { id, cancelled: false };
		const job = currentJob;

		try {
			const params = cleanParams(message.params);
			if (message.kind === 'export_textures' && params.skipMissing === undefined)
				params.skipMissing = true;

			params.outDir = message.outDir;
			params.onProgress = (done, total, current) => send({ t: 'progress', job: id, done, total, current: current ?? undefined });

			const result = await service[method](params);
			const failed = Array.isArray(result?.failed) ? result.failed : [];
			finish({ ok: failed.length === 0 && !job.cancelled, cancelled: job.cancelled, result, failed });
		} catch (e) {
			const error = describe(e);
			finish({ cancelled: job.cancelled || error.code === CODES.CANCELLED, error });
		} finally {
			currentJob = null;
		}
	};

	const cancelJob = (message) => {
		if (currentJob === null || currentJob.id !== message.job)
			return;

		currentJob.cancelled = true;
		service.cancel();
	};

	const onMessage = (message) => {
		if (!welcomed) {
			if (message.t === 'welcome') {
				// Only a gateway that accepted our secret gets the game data opened.
				welcomed = true;
				load();
				return;
			}

			return shutdown(1, 'unexpected message before welcome: ' + message.t);
		}

		switch (message.t) {
			case 'job': runJob(message); break;
			case 'query': runQuery(message); break;
			case 'cancel': cancelJob(message); break;
			case 'shutdown': shutdown(0, 'gateway asked'); break;
			default: writeLog('[engine] ignoring message %s', message.t);
		}
	};

	let loaded;
	const loadedPromise = new Promise(resolve => loaded = resolve);

	const load = async () => {
		try {
			const source = config.source;
			const runtime = deps.runtime ?? require('./runtime');
			await runtime.init(config.config ?? {});
			service ??= require('./service');

			await service.open({
				install: source.type === 'local' ? source.install : '',
				product: source.product,
				region: source.region ?? 'us'
			});

			const build = await service.info();
			ready = true;
			send({
				t: 'ready',
				build: { product: build.product, version: build.version, buildConfig: build.buildConfig, fileCount: build.fileCount, source: build.source },
				loadMs: Date.now() - started,
				kinds: kinds(),
				queries: Object.keys(QUERY_KINDS)
			});
		} catch (e) {
			send({ t: 'fatal', error: describe(e) });
			shutdown(1, 'unable to open game data: ' + e.message);
		}

		loaded();
	};

	return new Promise((resolve) => {
		loadedPromise.then(resolve);
		socket = net.connect({ host: '127.0.0.1', port: config.gatewayPort });
		socket.setNoDelay(true);

		const parse = createParser(onMessage, (e) => writeLog('[engine] bad message: %s', e.message));
		socket.on('data', parse);
		socket.on('close', () => shutdown(0, 'gateway connection closed'));
		socket.on('error', (e) => {
			writeLog('[engine] connection error: %s', e.message);
			shutdown(1, 'connection error');
		});

		const welcomeTimer = setTimeout(() => {
			if (!welcomed)
				shutdown(1, 'no welcome from gateway');
		}, WELCOME_TIMEOUT_MS);
		welcomeTimer.unref?.();

		socket.on('connect', () => {
			send({ t: 'hello', secret: config.secret, id: config.id, pid: process.pid, protocol: PROTOCOL, host: typeof Bun !== 'undefined' ? 'bun' : (globalThis.nw?.App?.manifest ? 'nw' : 'node') });

			heartbeat = setInterval(() => {
				const memory = process.memoryUsage();
				send({ t: 'heartbeat', rss: memory.rss, heapUsed: memory.heapUsed, job: currentJob?.id ?? null, uptime: Math.round((Date.now() - started) / 1000) });
			}, HEARTBEAT_MS);
		});

		// Resolve once the engine stops before loading, too.
		socket.on('close', () => loaded());
	});
};

module.exports = { runEngine, validateConfig, cleanParams, JOB_KINDS, QUERY_KINDS, PROTOCOL };
