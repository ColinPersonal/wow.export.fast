const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { startGateway, connect, call, waitFor, authed } = require('./helpers');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

describe('gateway with fake engines', () => {
	let gw;
	let client;

	before(async () => {
		gw = await startGateway();
		client = await connect(gw);
	});

	after(async () => {
		await client?.close();
		await gw?.stop();
	});

	test('lists the tools and serves instructions', async () => {
		const { tools } = await client.listTools();
		const names = tools.map(t => t.name);
		for (const name of ['search', 'export_textures', 'export_model', 'export_map', 'export_table', 'wait_for_job', 'get_download_script', 'cancel_job'])
			assert.ok(names.includes(name), name);
		assert.match(client.getInstructions(), /wait_for_job/);
	});

	test('queries go to an engine', async () => {
		const res = await call(client, 'search', { query: 'murloc' });
		assert.equal(res.isError, false);
		assert.equal(res.results[0].fileName, 'ok/murloc');
	});

	test('regex search is refused', async () => {
		const res = await call(client, 'search', { query: '/(a+)+$/' });
		assert.equal(res.isError, true);
		assert.equal(res.error.code, 'INVALID_PARAMS');
	});

	test('engine errors keep their code', async () => {
		const res = await call(client, 'query_table', { table: 'Nope' });
		assert.equal(res.isError, true);
		assert.equal(res.error.code, 'NOT_FOUND');
	});

	test('invalid arguments are rejected before reaching an engine', async () => {
		const res = await client.callTool({ name: 'export_map', arguments: { map: 'azeroth', tiles: ['32-48'] } });
		assert.equal(res.isError, true);
	});

	test('an export finishes within one call and its files download intact', async () => {
		const res = await call(client, 'export_textures', { files: ['ok/a.png', 'ok/b.png'] });
		assert.equal(res.status, 'done', JSON.stringify(res));
		assert.equal(res.summary.file_count, 2);
		assert.ok(res.download.zip_url.startsWith(gw.base));
		assert.ok(res.local_path, 'local requests get a local path');

		for (const f of res.files) {
			const r = await authed(gw, new URL(f.url).pathname);
			assert.equal(r.status, 200);
			const body = Buffer.from(await r.arrayBuffer());
			assert.equal(body.length, f.size);
			assert.equal(r.headers.get('x-content-sha256'), sha(body));
		}

		const manifest = await call(client, 'get_manifest', { job_id: res.job_id });
		assert.equal(manifest.total, 2);
		assert.equal(manifest.files[0].sha256.length, 64);
	});

	test('identical requests are served from the cache without exporting again', async () => {
		const runs = () => fs.readFileSync(path.join(gw.config.dirs.engines, 'wowf-quick', 'jobs-run.txt'), 'utf8').trim().split('\n').length;

		const first = await call(client, 'export_files', { files: ['ok/cache-me.bin'] });
		assert.equal(first.status, 'done');
		const before = runs();

		const t = Date.now();
		// Same files in another order and form: same result.
		const second = await call(client, 'export_files', { files: ['OK/cache-me.bin'] });
		assert.equal(second.status, 'done');
		assert.equal(second.cached, true);
		assert.equal(second.result_key, first.result_key);
		assert.ok(Date.now() - t < 1000, 'cache hit is fast');
		assert.equal(runs(), before, 'engine not called again');

		const forced = await call(client, 'export_files', { files: ['ok/cache-me.bin'], force: true });
		assert.equal(forced.status, 'done');
		assert.equal(runs(), before + 1);
	});

	test('concurrent identical requests share one export', async () => {
		const runs = () => fs.readFileSync(path.join(gw.config.dirs.engines, 'wowf-quick', 'jobs-run.txt'), 'utf8').trim().split('\n').length;
		const before = runs();
		const clients = await Promise.all(Array.from({ length: 5 }, () => connect(gw)));
		const results = await Promise.all(clients.map(c => call(c, 'export_files', { files: ['slow/300/shared.bin'] })));
		await Promise.all(clients.map(c => c.close()));

		assert.ok(results.every(r => r.status === 'done'), JSON.stringify(results.map(r => r.status)));
		assert.equal(new Set(results.map(r => r.job_id)).size, 1, 'all share a job');
		assert.equal(runs(), before + 1);
	});

	test('partial results report each failed item and are not reused', async () => {
		const res = await call(client, 'export_files', { files: ['ok/good.bin', 'missing/bad.bin'] });
		assert.equal(res.status, 'partial');
		assert.equal(res.failed.length, 1);
		assert.match(res.failed[0].error, /NOT_FOUND/);

		const again = await call(client, 'export_files', { files: ['ok/good.bin', 'missing/bad.bin'] });
		assert.notEqual(again.cached, true);
	});

	test('a failed job returns its error', async () => {
		const res = await call(client, 'export_files', { files: ['error/x'] });
		assert.equal(res.status, 'failed');
		assert.equal(res.error.code, 'EXPORT_FAILED');
	});

	test('long jobs return early and finish via wait_for_job', async () => {
		const res = await call(client, 'export_files', { files: ['slow/1500/later.bin'], wait: 0 });
		assert.ok(['queued', 'running'].includes(res.status));
		const done = await call(client, 'wait_for_job', { job_id: res.job_id, timeout_seconds: 10 });
		assert.equal(done.status, 'done');
	});

	test('cancelling a running job', async () => {
		const res = await call(client, 'export_files', { files: ['slow/5000/cancel.bin'], wait: 0 });
		await waitFor(async () => (await call(client, 'get_job', { job_id: res.job_id })).status === 'running');
		await call(client, 'cancel_job', { job_id: res.job_id });
		const done = await call(client, 'wait_for_job', { job_id: res.job_id, timeout_seconds: 10 });
		assert.equal(done.status, 'cancelled');
		assert.ok(!fs.existsSync(path.join(gw.config.dirs.staging, res.job_id)), 'staging cleaned up');
	});

	test('quick jobs do not wait behind bulk jobs', async () => {
		const bulkFiles = Array.from({ length: 30 }, (_, i) => 'slow/100/bulk' + i + '.bin');
		const bulk = await call(client, 'export_files', { files: bulkFiles, wait: 0 });
		await waitFor(async () => (await call(client, 'get_job', { job_id: bulk.job_id })).status === 'running');

		const t = Date.now();
		const quick = await call(client, 'export_files', { files: ['ok/quick.bin'] });
		assert.equal(quick.status, 'done');
		assert.ok(Date.now() - t < 1500, 'quick lane answered in ' + (Date.now() - t) + 'ms');

		const finished = await call(client, 'wait_for_job', { job_id: bulk.job_id, timeout_seconds: 15 });
		assert.equal(finished.status, 'done');
	});

	test('jobs belong to their token', async () => {
		const res = await call(client, 'export_files', { files: ['ok/mine.bin'] });
		const other = gw.tokens.add('other-' + Date.now());
		const otherClient = await connect(gw, other);
		const peek = await call(otherClient, 'get_job', { job_id: res.job_id });
		assert.equal(peek.isError, true);
		assert.equal(peek.error.code, 'NOT_FOUND');
		const list = await call(otherClient, 'list_jobs');
		assert.equal(list.jobs.length, 0);
		await otherClient.close();
	});

	test('download script lists every file without embedding the token', async () => {
		const res = await call(client, 'export_files', { files: ['ok/s1.bin', 'ok/dir with space.bin'] });
		const script = await call(client, 'get_download_script', { job_id: res.job_id });
		assert.match(script.script, /WOW_EXPORT_TOKEN/);
		assert.ok(!script.script.includes(gw.token));

		const list = await authed(gw, '/list/' + res.result_key + '?format=sha256sum');
		const lines = (await list.text()).trim().split('\n');
		assert.equal(lines.length, 2);

		const cfg = await (await authed(gw, '/list/' + res.result_key + '?format=curl')).text();
		assert.match(cfg, /dir%20with%20space\.bin/);
	});

	test('zip download contains every file', async () => {
		const res = await call(client, 'export_files', { files: ['ok/z1.bin', 'ok/z2.bin'] });
		const r = await authed(gw, '/zip/' + res.result_key);
		assert.equal(r.status, 200);
		const buf = Buffer.from(await r.arrayBuffer());
		assert.equal(buf.readUInt32LE(0), 0x04034b50, 'zip signature');
		assert.ok(buf.includes(Buffer.from('out/z1.bin')));
		assert.ok(buf.includes(Buffer.from('out/z2.bin')));
	});

	test('range requests', async () => {
		const res = await call(client, 'export_files', { files: ['big/1000/range.bin'] });
		const url = new URL(res.files[0].url).pathname;
		const r = await authed(gw, url, { headers: { Range: 'bytes=10-19' } });
		assert.equal(r.status, 206);
		assert.equal(r.headers.get('content-range'), 'bytes 10-19/1000');
		assert.equal((await r.arrayBuffer()).byteLength, 10);

		const bad = await authed(gw, url, { headers: { Range: 'bytes=5000-' } });
		assert.equal(bad.status, 416);
	});

	test('status reports engines and cache', async () => {
		const res = await call(client, 'service_status');
		assert.ok(res.engines.some(e => e.id === 'wowf-quick' && e.state === 'ready'));
		assert.equal(res.default_product, 'wowf');
	});
});

describe('auth and request safety', () => {
	let gw;

	before(async () => {
		gw = await startGateway();
	});

	after(async () => gw?.stop());

	const raw = (pathname, headers = {}, method = 'GET', body) => new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port: gw.port, path: pathname, method, headers }, (res) => {
			const chunks = [];
			res.on('data', c => chunks.push(c));
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
		});
		req.on('error', reject);
		if (body)
			req.write(body);
		req.end();
	});

	test('health needs no token and says nothing else', async () => {
		const r = await raw('/health');
		assert.equal(r.status, 200);
		assert.deepEqual(JSON.parse(r.body), { ok: true });
	});

	test('missing, malformed, wrong and revoked tokens get the same 401', async () => {
		const name = 'revoke-me';
		const token = gw.tokens.add(name);
		gw.tokens.revoke(name);

		const cases = [{}, { Authorization: 'Bearer' }, { Authorization: 'Basic abc' }, { Authorization: 'Bearer wxs_wrong' }, { Authorization: 'Bearer ' + token }, { Authorization: 'Bearer ' + 'x'.repeat(5000) }];
		const bodies = new Set();
		for (const headers of cases) {
			const r = await raw('/mcp', Object.assign({ 'Content-Type': 'application/json' }, headers), 'POST', '{}');
			assert.equal(r.status, 401, JSON.stringify(headers).slice(0, 80));
			bodies.add(r.body);
		}
		assert.equal(bodies.size, 1);
	});

	test('downloads need a token', async () => {
		const r = await raw('/zip/' + 'a'.repeat(64));
		assert.equal(r.status, 401);
	});

	test('unknown Host headers are refused (DNS rebinding)', async () => {
		const r = await raw('/mcp', { Host: 'evil.example:8787', Authorization: 'Bearer ' + gw.token }, 'POST', '{}');
		assert.equal(r.status, 421);
	});

	test('path tricks never escape a result', async () => {
		const client = await connect(gw);
		const res = await call(client, 'export_files', { files: ['ok/safe.bin'] });
		await client.close();
		const key = res.result_key;
		const auth = { Authorization: 'Bearer ' + gw.token };

		// A file outside results that an attacker would like to read.
		fs.writeFileSync(path.join(gw.config.dirs.state, 'secret.txt'), 'secret');

		const attempts = [
			'/files/' + key + '/../../state/secret.txt',
			'/files/' + key + '/..%2f..%2fstate%2fsecret.txt',
			'/files/' + key + '/%2e%2e/%2e%2e/state/secret.txt',
			'/files/' + key + '/..%5c..%5cstate%5csecret.txt',
			'/files/' + key + '/C:%5cWindows%5cwin.ini',
			'/files/' + key + '/%2fetc%2fpasswd',
			'/files/' + key + '/out%00/safe.bin',
			'/files/' + key + '/',
			'/files/' + key + '/out',
			'/files/' + '0'.repeat(64) + '/out/safe.bin',
			'/files/' + key.toUpperCase() + '/out/safe.bin',
			'/files/../state/tokens.json',
			'/manifest/..%2fstate',
			'/list/' + key + '?format=evil'
		];

		for (const p of attempts) {
			const r = await raw(p, auth);
			assert.ok(r.status === 404 || r.status === 400, p + ' -> ' + r.status);
			assert.ok(!r.body.includes('secret'), p);
		}

		const ok = await raw('/files/' + key + '/out/safe.bin', auth);
		assert.equal(ok.status, 200);
	});

	test('a symlink planted in a result is not followed', async () => {
		const client = await connect(gw);
		const res = await call(client, 'export_files', { files: ['ok/link-target.bin'] });
		await client.close();
		const file = path.join(gw.config.dirs.results, res.result_key, 'files', 'out', 'link-target.bin');
		fs.rmSync(file);
		try {
			fs.symlinkSync(path.join(gw.config.dirs.state, 'tokens.json'), file);
		} catch {
			return; // symlinks need privileges on Windows; nothing to test then
		}
		const r = await raw('/files/' + res.result_key + '/out/link-target.bin', { Authorization: 'Bearer ' + gw.token });
		assert.equal(r.status, 404);
	});

	test('oversized request bodies are refused', async () => {
		const r = await raw('/mcp', { Authorization: 'Bearer ' + gw.token, 'Content-Type': 'application/json' }, 'POST', '{"x":"' + 'a'.repeat(2 * 1024 * 1024) + '"}');
		assert.equal(r.status, 413);
	});

	test('requests are rate limited per token', async () => {
		const limited = await startGateway({ overrides: { requestsPerSecondPerToken: 2 } });
		let tooMany = 0;
		for (let i = 0; i < 20; i++) {
			const r = await fetch(limited.base + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + limited.token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'ping' }) });
			if (r.status === 429)
				tooMany++;
		}
		await limited.stop();
		assert.ok(tooMany > 0);
	});
});
