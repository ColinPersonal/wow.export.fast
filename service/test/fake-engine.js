// Fake engine speaking service/PROTOCOL.md, for gateway tests.
//
// Behaviour comes from the file names it is asked to export:
//   "ok/<name>"           writes <name> (content: "data:<name>")
//   "big/<n>/<name>"      writes <name> with n bytes
//   "missing/<name>"      item fails with NOT_FOUND (job becomes partial)
//   "slow/<ms>/<name>"    waits ms (checking for cancel) before writing
//   "crash/<name>"        process exits mid-job
//   "hang/<name>"         stops sending heartbeats and never answers
//   "error/<name>"        whole job fails with EXPORT_FAILED
// Startup is controlled by environment variables:
//   FAKE_ENGINE_DELAY_MS  delay before "ready"
//   FAKE_ENGINE_FATAL     send "fatal" and exit instead of becoming ready
//   FAKE_ENGINE_SECRET    send this secret instead of the real one
const fs = require('fs');
const net = require('net');
const path = require('path');

const specFile = process.argv[process.argv.indexOf('--config') + 1];
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const counterFile = path.join(spec.dataDir, 'jobs-run.txt');

const socket = net.connect(spec.gatewayPort, '127.0.0.1');
socket.setEncoding('utf8');
const send = (msg) => socket.write(JSON.stringify(msg) + '\n');

let current = null;
let heartbeat = null;
let buffer = '';

socket.on('connect', () => {
	send({ t: 'hello', secret: process.env.FAKE_ENGINE_SECRET ?? spec.secret, id: spec.id, pid: process.pid, protocol: 1, host: 'fake' });
});

socket.on('close', () => process.exit(0));
socket.on('error', () => process.exit(0));

socket.on('data', (chunk) => {
	buffer += chunk;
	let nl;
	while ((nl = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, nl);
		buffer = buffer.slice(nl + 1);
		if (line)
			handle(JSON.parse(line));
	}
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const handle = async (msg) => {
	if (msg.t === 'welcome') {
		heartbeat = setInterval(() => send({ t: 'heartbeat', rss: process.memoryUsage().rss, heapUsed: 0, job: current?.job ?? null, uptime: process.uptime() }), 200);
		if (process.env.FAKE_ENGINE_FATAL) {
			send({ t: 'fatal', error: { code: 'SOURCE_UNAVAILABLE', message: process.env.FAKE_ENGINE_FATAL } });
			setTimeout(() => process.exit(3), 50);
			return;
		}
		await sleep(Number(process.env.FAKE_ENGINE_DELAY_MS ?? 0));
		send({ t: 'ready', build: { product: spec.source.product, version: '1.0.0.' + (process.env.FAKE_ENGINE_BUILD ?? '1'), buildConfig: 'fakebuild' + (process.env.FAKE_ENGINE_BUILD ?? '1') }, loadMs: 1, kinds: ['get_file', 'export_files', 'export_textures', 'export_model', 'export_models', 'export_map', 'export_table'] });
		return;
	}

	if (msg.t === 'shutdown')
		process.exit(0);

	if (msg.t === 'cancel') {
		if (current?.job === msg.job)
			current.cancelled = true;
		return;
	}

	if (msg.t === 'query') {
		await sleep(5);
		if (msg.kind === 'search')
			send({ t: 'reply', req: msg.req, ok: true, result: { query: msg.params.query, total: 1, results: [{ fileDataID: 1, fileName: 'ok/' + msg.params.query }] } });
		else if (msg.kind === 'query_table' && msg.params.table === 'Nope')
			send({ t: 'reply', req: msg.req, ok: false, error: { code: 'NOT_FOUND', message: 'Unknown table Nope' } });
		else
			send({ t: 'reply', req: msg.req, ok: true, result: { kind: msg.kind, params: msg.params, engine: spec.id } });
		return;
	}

	if (msg.t === 'job') {
		if (current !== null) {
			send({ t: 'done', job: msg.job, ok: false, cancelled: false, error: { code: 'BUSY', message: 'busy' }, failed: [] });
			return;
		}
		current = { job: msg.job, cancelled: false };
		fs.appendFileSync(counterFile, msg.job + ' ' + msg.kind + '\n');
		try {
			await runJob(msg);
		} finally {
			current = null;
		}
	}
};

const runJob = async (msg) => {
	const files = msg.params.files ?? (msg.params.file !== undefined ? [msg.params.file] : msg.params.tables ?? ['ok/tile']);
	const failed = [];
	let done = 0;

	for (const file of files.map(String)) {
		const parts = file.split('/');
		const mode = parts[0];

		if (mode === 'crash')
			process.exit(9);

		if (mode === 'hang') {
			clearInterval(heartbeat);
			await new Promise(() => {});
		}

		if (mode === 'error') {
			send({ t: 'done', job: msg.job, ok: false, cancelled: false, error: { code: 'EXPORT_FAILED', message: 'boom' }, failed: [] });
			return;
		}

		if (mode === 'slow') {
			const until = Date.now() + Number(parts[1]);
			while (Date.now() < until) {
				if (current.cancelled) {
					send({ t: 'done', job: msg.job, ok: false, cancelled: true, failed: [] });
					return;
				}
				await sleep(20);
			}
		}

		if (mode === 'missing') {
			failed.push({ item: file, error: 'NOT_FOUND: ' + file });
		} else {
			const name = parts[parts.length - 1];
			const size = mode === 'big' ? Number(parts[1]) : 0;
			const out = path.join(msg.outDir, 'out', name);
			fs.mkdirSync(path.dirname(out), { recursive: true });
			fs.writeFileSync(out, size > 0 ? Buffer.alloc(size, 7) : 'data:' + name);
		}

		done++;
		send({ t: 'progress', job: msg.job, done, total: files.length, current: file });
	}

	send({ t: 'done', job: msg.job, ok: failed.length === 0, cancelled: false, result: { exported: done - failed.length }, failed });
};
