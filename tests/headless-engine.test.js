const fs = require('fs');
const os = require('os');
const path = require('path');

// Keep the headless runtime's cache and configuration out of the home directory.
process.env.WOW_EXPORT_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'wowexport-engine-test-'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');

const { createParser, encode } = require('../src/js/headless/ndjson');
const { detectAudioExtension, audioFileName } = require('../src/js/headless/sniff');
const { CODES, fail, describe } = require('../src/js/headless/errors');
const engine = require('../src/js/headless/engine');
const { tools } = require('../src/js/headless/tools');

const SECRET = 'a'.repeat(64);

test('ndjson parser reassembles lines split across chunks and skips bad lines', () => {
	const messages = [];
	const errors = [];
	const feed = createParser(m => messages.push(m), (e, line) => errors.push(line));

	feed('{"t":"a","n":1}\n{"t":"b"');
	feed(',"n":2}\n\nnot json\n[1,2]\n');
	feed(Buffer.from('{"t":"c"}\r\n'));

	assert.deepEqual(messages, [{ t: 'a', n: 1 }, { t: 'b', n: 2 }, { t: 'c' }]);
	assert.deepEqual(errors, ['not json', '[1,2]']);
});

test('ndjson encode writes one line and turns BigInt into strings', () => {
	const line = encode({ t: 'x', big: 12345678901234567890n });
	assert.ok(line.endsWith('\n'));
	assert.equal(line.indexOf('\n'), line.length - 1);
	assert.deepEqual(JSON.parse(line), { t: 'x', big: '12345678901234567890' });
});

test('audio sniffing recognises Ogg and MP3 and renames .unk_sound only', () => {
	assert.equal(detectAudioExtension(Buffer.from('OggS\0')), '.ogg');
	assert.equal(detectAudioExtension(Buffer.from('ID3\x04')), '.mp3');
	assert.equal(detectAudioExtension(Uint8Array.from([0xFF, 0xFB, 0x90, 0x00])), '.mp3');
	assert.equal(detectAudioExtension(Uint8Array.from([0x52, 0x49, 0x46, 0x46])), null);
	assert.equal(detectAudioExtension(Uint8Array.from([0xFF])), null);
	assert.equal(detectAudioExtension(null), null);

	assert.equal(audioFileName('sound/a/b.unk_sound', Buffer.from('OggS')), 'sound/a/b.ogg');
	assert.equal(audioFileName('sound/a/b.UNK_SOUND', Buffer.from('ID3x')), 'sound/a/b.mp3');
	assert.equal(audioFileName('sound/a/b.unk_sound', Buffer.from('RIFF')), 'sound/a/b.unk_sound');
	assert.equal(audioFileName('sound/a/b.ogg', Buffer.from('ID3x')), 'sound/a/b.ogg');
});

test('errors carry known codes; anything else is INTERNAL', () => {
	const e = fail(CODES.NOT_FOUND, 'missing');
	assert.equal(e.code, 'NOT_FOUND');
	assert.ok(e instanceof Error);
	assert.deepEqual(describe(e), { code: 'NOT_FOUND', message: 'missing' });
	assert.deepEqual(describe(new Error('boom')), { code: 'INTERNAL', message: 'boom' });
	assert.deepEqual(describe(Object.assign(new Error('fs'), { code: 'ENOENT' })), { code: 'INTERNAL', message: 'fs' });
	assert.equal(describe('text').message, 'text');
});

test('engine config validation reports every problem', () => {
	assert.deepEqual(engine.validateConfig({
		protocol: 1, id: 'wowf-quick', gatewayPort: 5000, secret: SECRET, dataDir: 'x',
		source: { type: 'local', install: 'C:/WoW', product: 'wowf' }
	}), []);

	assert.deepEqual(engine.validateConfig({ protocol: 1, id: 'r', gatewayPort: 5000, secret: SECRET, dataDir: 'x', source: { type: 'remote', product: 'wow' } }), []);

	const problems = engine.validateConfig({ protocol: 2, gatewayPort: 0, secret: 'short', source: { type: 'local', product: 'wowf' } });
	assert.equal(problems.length, 6);
	assert.deepEqual(engine.validateConfig(null), ['config must be an object']);
	assert.throws(() => engine.runEngine({}), /Invalid engine config/);
});

test('engine strips parameters only the gateway may set', () => {
	assert.deepEqual(engine.cleanParams({ files: [1], outDir: 'C:/evil', product: 'wow', install: 'x', allowRegex: true, onProgress: 1 }), { files: [1] });
	assert.deepEqual(engine.cleanParams(null), {});
	assert.deepEqual(engine.cleanParams([1, 2]), {});
});

test('every engine kind maps to a service operation and an MCP tool', () => {
	const service = require('../src/js/headless/service');
	const names = new Set(tools.map(t => t.name));

	for (const [kind, method] of Object.entries({ ...engine.JOB_KINDS, ...engine.QUERY_KINDS })) {
		assert.equal(typeof service[method], 'function', kind + ' -> ' + method);
		assert.ok(names.has(kind), 'no MCP tool for ' + kind);
	}

	assert.equal(typeof service.cancel, 'function');
	assert.equal(service.cancel(), false, 'nothing to cancel when idle');
});

// --- protocol, against a fake service --------------------------------------

/** A fake gateway: accepts one engine connection and records its messages. */
const startGateway = async ({ secret = SECRET } = {}) => {
	const received = [];
	const waiters = [];
	let socket = null;

	const check = () => {
		for (const waiter of [...waiters]) {
			const found = received.find(waiter.match);
			if (found) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve(found);
			}
		}
	};

	const server = net.createServer(s => {
		socket = s;
		s.on('data', createParser(m => {
			received.push(m);
			if (m.t === 'hello') {
				if (m.secret === secret)
					s.write(encode({ t: 'welcome' }));
				else
					s.destroy();
			}
			check();
		}));
	});

	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

	return {
		port: server.address().port,
		received,
		send: (m) => socket.write(encode(m)),
		wait: (match, ms = 3000) => new Promise((resolve, reject) => {
			const found = received.find(match);
			if (found)
				return resolve(found);

			const waiter = { match, resolve };
			waiters.push(waiter);
			setTimeout(() => reject(new Error('timed out waiting for message; got ' + JSON.stringify(received.map(r => r.t)))), ms);
		}),
		dropClient: () => socket?.destroy(),
		close: () => new Promise(resolve => { socket?.destroy(); server.close(resolve); })
	};
};

/** A fake headless service with controllable jobs. */
const fakeService = () => {
	let release = null;
	let cancelled = false;

	return {
		calls: [],
		open: async () => {},
		info: async () => ({ product: 'wowf', version: '1.2.3', buildConfig: 'abc', fileCount: 10, source: 'local' }),
		search: async (params) => ({ params }),
		queryTable: async ({ table }) => { throw fail(CODES.NOT_FOUND, 'Unknown table: ' + table); },
		listMaps: async () => ({ count: 0, maps: [] }),
		exportTextures: async function(params) {
			this.calls.push(params);
			params.onProgress(1, 2, 'a.png');
			return { requested: 2, failed: [{ item: '99', code: 'NOT_FOUND', error: 'missing' }] };
		},
		exportMap: async (params) => {
			params.onProgress(0, 3, null);
			await new Promise(resolve => release = resolve);
			if (cancelled)
				throw fail(CODES.CANCELLED, 'Export was cancelled');
			return { failed: [] };
		},
		getFile: async () => ({ path: 'x', failed: [] }),
		cancel() {
			cancelled = true;
			release?.();
			return true;
		},
		finishMap: () => release?.()
	};
};

const config = (port, extra = {}) => Object.assign({
	protocol: 1, id: 'test', gatewayPort: port, secret: SECRET, dataDir: os.tmpdir(),
	source: { type: 'local', install: 'C:/WoW', product: 'wowf', region: 'us' }
}, extra);

test('engine handshake, queries, jobs, busy, cancel and exit on disconnect', async () => {
	const gateway = await startGateway();
	const service = fakeService();
	let exitCode = null;
	const exited = new Promise(resolve => {
		engine.runEngine(config(gateway.port), { service, runtime: { init: async () => {} }, exit: (code) => { exitCode = code; resolve(code); }, log: () => {} });
	});

	const hello = await gateway.wait(m => m.t === 'hello');
	assert.equal(hello.secret, SECRET);
	assert.equal(hello.id, 'test');
	assert.equal(hello.protocol, 1);
	assert.equal(typeof hello.pid, 'number');

	const ready = await gateway.wait(m => m.t === 'ready');
	assert.equal(ready.build.product, 'wowf');
	assert.ok(ready.kinds.includes('export_map'));
	assert.ok(ready.queries.includes('search'));

	// Queries: regex is always refused over the engine; errors carry codes.
	gateway.send({ t: 'query', req: 1, kind: 'search', params: { query: '/x/', allowRegex: true, outDir: 'C:/evil' } });
	const reply = await gateway.wait(m => m.t === 'reply' && m.req === 1);
	assert.equal(reply.ok, true);
	assert.deepEqual(reply.result.params, { query: '/x/', allowRegex: false });

	gateway.send({ t: 'query', req: 2, kind: 'query_table', params: { table: 'Nope' } });
	const bad = await gateway.wait(m => m.t === 'reply' && m.req === 2);
	assert.equal(bad.ok, false);
	assert.equal(bad.error.code, 'NOT_FOUND');

	gateway.send({ t: 'query', req: 3, kind: 'rm_rf', params: {} });
	assert.equal((await gateway.wait(m => m.t === 'reply' && m.req === 3)).error.code, 'UNSUPPORTED');

	// A job with a failed item is reported as not ok, with the items listed.
	gateway.send({ t: 'job', job: 'j1', kind: 'export_textures', params: { files: [1, 99], outDir: 'C:/evil' }, outDir: 'C:/out/j1' });
	const progress = await gateway.wait(m => m.t === 'progress' && m.job === 'j1');
	assert.deepEqual([progress.done, progress.total, progress.current], [1, 2, 'a.png']);
	const done1 = await gateway.wait(m => m.t === 'done' && m.job === 'j1');
	assert.equal(done1.ok, false);
	assert.equal(done1.error, undefined);
	assert.equal(done1.failed[0].code, 'NOT_FOUND');
	assert.equal(service.calls[0].outDir, 'C:/out/j1', 'outDir comes from the gateway, not the params');
	assert.equal(service.calls[0].skipMissing, true);

	// Missing outDir and unknown kinds are rejected.
	gateway.send({ t: 'job', job: 'j0', kind: 'get_file', params: {} });
	assert.equal((await gateway.wait(m => m.t === 'done' && m.job === 'j0')).error.code, 'INVALID_PARAMS');
	gateway.send({ t: 'job', job: 'jx', kind: 'format_disk', params: {}, outDir: 'C:/out' });
	assert.equal((await gateway.wait(m => m.t === 'done' && m.job === 'jx')).error.code, 'UNSUPPORTED');

	// One job at a time; queries still answered while busy; cancel stops the job.
	gateway.send({ t: 'job', job: 'j2', kind: 'export_map', params: { map: 0 }, outDir: 'C:/out/j2' });
	await gateway.wait(m => m.t === 'progress' && m.job === 'j2');
	gateway.send({ t: 'job', job: 'j3', kind: 'get_file', params: { file: 1 }, outDir: 'C:/out/j3' });
	const busy = await gateway.wait(m => m.t === 'done' && m.job === 'j3');
	assert.equal(busy.error.code, 'BUSY');

	gateway.send({ t: 'query', req: 4, kind: 'list_maps', params: {} });
	assert.equal((await gateway.wait(m => m.t === 'reply' && m.req === 4)).ok, true);

	gateway.send({ t: 'cancel', job: 'other' });
	gateway.send({ t: 'cancel', job: 'j2' });
	const cancelled = await gateway.wait(m => m.t === 'done' && m.job === 'j2');
	assert.equal(cancelled.cancelled, true);
	assert.equal(cancelled.ok, false);
	assert.equal(cancelled.error.code, 'CANCELLED');

	// The engine is free again.
	gateway.send({ t: 'job', job: 'j4', kind: 'get_file', params: { file: 1 }, outDir: 'C:/out/j4' });
	assert.equal((await gateway.wait(m => m.t === 'done' && m.job === 'j4')).ok, true);

	gateway.dropClient();
	assert.equal(await exited, 0);
	assert.equal(exitCode, 0);
	await gateway.close();
});

test('engine with a wrong secret is disconnected and exits', async () => {
	const gateway = await startGateway({ secret: 'b'.repeat(64) });
	const code = await new Promise(resolve => {
		engine.runEngine(config(gateway.port), { service: fakeService(), runtime: { init: async () => {} }, exit: resolve, log: () => {} });
	});

	try {
		assert.equal(typeof code, 'number');
		assert.ok(!gateway.received.some(m => m.t === 'ready'), 'a rejected engine never reports ready');
	} finally {
		await gateway.close();
	}
});

test('engine reports a fatal error when the game data cannot be opened', async () => {
	const gateway = await startGateway();
	const service = Object.assign(fakeService(), { open: async () => { throw fail(CODES.SOURCE_UNAVAILABLE, 'no install'); } });

	const code = await new Promise(resolve => {
		engine.runEngine(config(gateway.port), { service, runtime: { init: async () => {} }, exit: resolve, log: () => {} });
	});

	try {
		assert.equal(code, 1);
		const fatal = await gateway.wait(m => m.t === 'fatal');
		assert.equal(fatal.error.code, 'SOURCE_UNAVAILABLE');
		assert.ok(!gateway.received.some(m => m.t === 'ready'));
	} finally {
		await gateway.close();
	}
});

test('jobs and queries sent before the game data is open are refused', async () => {
	const gateway = await startGateway();
	let openRelease;
	const service = Object.assign(fakeService(), { open: () => new Promise(resolve => openRelease = resolve) });

	const exited = new Promise(resolve => {
		engine.runEngine(config(gateway.port), { service, runtime: { init: async () => {} }, exit: resolve, log: () => {} });
	});

	await gateway.wait(m => m.t === 'hello');
	await new Promise(resolve => setTimeout(resolve, 50));
	gateway.send({ t: 'query', req: 1, kind: 'info', params: {} });
	gateway.send({ t: 'job', job: 'early', kind: 'get_file', params: { file: 1 }, outDir: 'C:/out' });

	assert.equal((await gateway.wait(m => m.t === 'reply' && m.req === 1)).error.code, 'SOURCE_UNAVAILABLE');
	assert.equal((await gateway.wait(m => m.t === 'done' && m.job === 'early')).error.code, 'SOURCE_UNAVAILABLE');

	openRelease();
	await gateway.wait(m => m.t === 'ready');
	gateway.send({ t: 'shutdown' });
	assert.equal(await exited, 0);
	await gateway.close();
});
