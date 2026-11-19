#!/usr/bin/env node
// End-to-end test: a real gateway with real engines on the local WoW Forever
// install, driven through an MCP client exactly like an agent would.
//
//   node service/test-e2e/run.js [--remote] [--keep] [--root <dir>]
//
// Uses its own service root (default ~/wow.export-service/dev/e2e), never the
// real service root or the normal wow.export folders. Prints a report and
// exits non-zero if any check fails.
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const execFileAsync = require('util').promisify(execFile);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const server = require('../src/server');
const { TokenStore } = require('../src/auth');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const ROOT = args.includes('--root') ? args[args.indexOf('--root') + 1] : path.join(os.homedir(), 'wow.export-service', 'dev', 'e2e');
const DL = path.join(ROOT, 'downloads');

const results = [];
let failures = 0;

const check = async (name, fn) => {
	const t = Date.now();
	try {
		const info = await fn();
		const ms = Date.now() - t;
		results.push({ name, ok: true, ms, info });
		console.log(`PASS ${name} (${ms} ms)${info ? ' ' + info : ''}`);
	} catch (e) {
		failures++;
		const ms = Date.now() - t;
		results.push({ name, ok: false, ms, error: e.message });
		console.log(`FAIL ${name} (${ms} ms): ${e.stack}`);
	}
};

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const main = async () => {
	fs.mkdirSync(ROOT, { recursive: true });
	const overrides = { port: 0, waitSeconds: 40 };
	// --repo <dir>: run engines from another checkout (e.g. a worktree).
	if (args.includes('--repo'))
		overrides.repo = path.resolve(args[args.indexOf('--repo') + 1]);
	const svc = await server.start({ root: ROOT, overrides, echo: false });
	const token = new TokenStore(svc.config.dirs.state).add('e2e-' + Date.now());
	const base = 'http://127.0.0.1:' + svc.port;
	console.log('gateway on', base, 'root', ROOT);

	const connect = async () => {
		const client = new Client({ name: 'e2e', version: '1' });
		await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
		return client;
	};

	const client = await connect();
	const call = async (name, a = {}, c = client) => {
		const res = await c.callTool({ name, arguments: a });
		const body = JSON.parse(res.content[0].text);
		if (res.isError)
			throw Object.assign(new Error(name + ': ' + JSON.stringify(body.error)), { body });
		return body;
	};
	const callErr = async (name, a = {}) => {
		const res = await client.callTool({ name, arguments: a });
		return Object.assign(JSON.parse(res.content[0].text), { isError: !!res.isError });
	};

	const download = async (url) => {
		const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
		assert.equal(r.status, 200, url);
		const buf = Buffer.from(await r.arrayBuffer());
		assert.equal(r.headers.get('x-content-sha256'), sha(buf), 'sha256 of ' + url);
		return buf;
	};

	const finished = async (res, timeout = 600) => {
		let job = res;
		const until = Date.now() + timeout * 1000;
		while (['queued', 'running'].includes(job.status) && Date.now() < until)
			job = await call('wait_for_job', { job_id: job.job_id, timeout_seconds: 40 });
		return job;
	};

	// --- discovery ---------------------------------------------------------
	let texture, model, wmo;

	await check('engines become ready', async () => {
		const until = Date.now() + 300000;
		while (Date.now() < until) {
			const s = await call('service_status');
			const ready = s.engines.filter(e => e.state === 'ready').map(e => e.id);
			if (ready.includes('wowf-quick') && ready.includes('wowf-bulk'))
				return ready.join(', ');
			await new Promise(r => setTimeout(r, 2000));
		}
		throw new Error('engines not ready');
	});

	await check('info', async () => {
		const i = await call('info');
		assert.equal(i.product, 'wowf');
		assert.ok(i.fileCount > 100000);
		return i.version + ' (' + i.source + ')';
	});

	await check('search texture/model/wmo', async () => {
		texture = (await call('search', { query: 'inv_sword_04', type: 'texture' })).results[0];
		model = (await call('search', { query: 'creature murloc murloc.m2', type: 'model' })).results[0];
		wmo = (await call('search', { query: 'goldshire inn .wmo', type: 'model', limit: 50 })).results.find(r => /\.wmo$/.test(r.fileName) && !/_\d{3}\.wmo$/.test(r.fileName));
		assert.ok(texture && model, 'found texture and model');
		return [texture.fileName, model.fileName, wmo?.fileName].join(' | ');
	});

	await check('regex search refused', async () => {
		const r = await callErr('search', { query: '/murloc.*/' });
		assert.equal(r.isError, true);
		assert.equal(r.error.code, 'INVALID_PARAMS');
	});

	await check('file_info', async () => {
		const r = await call('file_info', { files: [texture.fileDataID, model.fileName, 999999999] });
		const rows = Array.isArray(r) ? r : r.files ?? r.results;
		assert.ok(Array.isArray(rows) && rows.length === 3, JSON.stringify(r).slice(0, 300));
		return JSON.stringify(rows.map(x => x.inBuild ?? x.exists));
	});

	await check('list_maps / list_map_tiles', async () => {
		const maps = await call('list_maps', { query: 'azeroth' });
		assert.ok(maps.maps.some(m => m.id === 0));
		const tiles = await call('list_map_tiles', { map: 'azeroth' });
		assert.ok(tiles.tiles.includes('32_48'));
		return tiles.tileCount + ' tiles';
	});

	await check('tables: list, describe, query, unknown', async () => {
		const list = await call('list_tables', { query: 'map' });
		const names = list.tables ?? list;
		assert.ok(JSON.stringify(names).includes('Map'));
		const d = await call('describe_table', { table: 'Map' });
		assert.ok(JSON.stringify(d).includes('Directory'));
		const q = await call('query_table', { table: 'Map', id: 0 });
		assert.equal(q.rows[0].Directory, 'Azeroth');
		const bad = await callErr('query_table', { table: 'NoSuchTable' });
		assert.equal(bad.isError, true);
		assert.equal(bad.error.code, 'NOT_FOUND', JSON.stringify(bad));
	});

	// --- exports -----------------------------------------------------------
	await check('get_file png', async () => {
		const r = await finished(await call('get_file', { file: texture.fileDataID, format: 'png', force: true }));
		assert.equal(r.status, 'done', JSON.stringify(r));
		const png = await download(r.files[0].url);
		assert.equal(png.readUInt32BE(0), 0x89504e47);
		return r.files[0].path;
	});

	await check('export_textures (3) as png', async () => {
		const more = (await call('search', { query: 'inv_sword', type: 'texture', limit: 3 })).results.map(x => x.fileDataID);
		const r = await finished(await call('export_textures', { files: more, force: true }));
		assert.equal(r.status, 'done', JSON.stringify(r));
		assert.ok(r.summary.file_count >= 3);
	});

	let glbJob;
	await check('export_model glb', async () => {
		const r = await finished(await call('export_model', { file: model.fileDataID, format: 'glb', force: true }));
		assert.equal(r.status, 'done', JSON.stringify(r));
		const glb = r.files.find(f => f.path.endsWith('.glb'));
		const buf = await download(glb.url);
		assert.equal(buf.toString('ascii', 0, 4), 'glTF');
		assert.equal(buf.readUInt32LE(8), buf.length, 'GLB length header');
		glbJob = r;
		return glb.path + ' ' + buf.length + ' bytes';
	});

	await check('repeat export is a cache hit', async () => {
		const t = Date.now();
		const r = await call('export_model', { file: model.fileDataID, format: 'glb' });
		assert.equal(r.status, 'done');
		assert.equal(r.cached, true);
		assert.equal(r.result_key, glbJob.result_key);
		assert.ok(Date.now() - t < 500, 'took ' + (Date.now() - t) + 'ms');
		return (Date.now() - t) + ' ms';
	});

	await check('export_model obj', async () => {
		const r = await finished(await call('export_model', { file: model.fileDataID, format: 'obj', force: true }));
		assert.equal(r.status, 'done', JSON.stringify(r));
		const m = await call('get_manifest', { job_id: r.job_id, limit: 500 });
		const obj = m.files.find(f => f.path.endsWith('.obj'));
		const text = (await download(obj.url)).toString();
		const v = (text.match(/^v /gm) ?? []).length;
		const f = (text.match(/^f /gm) ?? []).length;
		assert.ok(v > 0 && f > 0);
		assert.ok(m.files.some(x => x.path.endsWith('.mtl')));
		return v + ' vertices, ' + f + ' faces';
	});

	if (wmo) {
		await check('export_model wmo obj', async () => {
			const r = await finished(await call('export_model', { file: wmo.fileDataID, format: 'obj', force: true }));
			assert.equal(r.status, 'done', JSON.stringify(r));
			return r.summary.file_count + ' files';
		});
	}

	await check('export_models (3) gltf', async () => {
		const models = (await call('search', { query: 'creature murloc .m2', type: 'model', limit: 3 })).results.map(x => x.fileDataID);
		const r = await finished(await call('export_models', { files: models, format: 'gltf', force: true }));
		assert.ok(r.status === 'done' || r.status === 'partial', JSON.stringify(r));
		return r.status + ', ' + r.summary.file_count + ' files';
	});

	await check('export_table csv', async () => {
		const r = await finished(await call('export_table', { tables: ['Map'], format: 'csv', force: true }));
		assert.equal(r.status, 'done', JSON.stringify(r));
		const csv = (await download(r.files.find(f => f.path.endsWith('.csv')).url)).toString();
		const header = csv.split('\n')[0];
		assert.ok(header.includes('Directory'), header.slice(0, 200));
		return csv.split('\n').length + ' lines';
	});

	await check('export_files raw', async () => {
		const r = await finished(await call('export_files', { files: [model.fileDataID, texture.fileDataID], force: true }));
		assert.equal(r.status, 'done', JSON.stringify(r));
		assert.equal(r.summary.file_count, 2);
	});

	await check('unknown file is reported per item', async () => {
		const r = await finished(await call('export_textures', { files: [texture.fileDataID, 'interface/does/not/exist.blp'], force: true }));
		assert.equal(r.status, 'partial', JSON.stringify(r));
		assert.ok(r.failed.length === 1);
		return JSON.stringify(r.failed[0]).slice(0, 160);
	});

	await check('export_map raw 1 tile', async () => {
		const r = await finished(await call('export_map', { map: 'azeroth', tiles: ['32_48'], format: 'raw', force: true }));
		assert.equal(r.status, 'done', JSON.stringify(r));
		assert.ok(r.summary.file_count > 100);
		return r.summary.file_count + ' files, ' + (r.summary.total_bytes / 1048576).toFixed(0) + ' MB';
	});

	await check('export_map obj 1 tile', async () => {
		const r = await finished(await call('export_map', { map: 'azeroth', tiles: ['32_49'], format: 'obj', force: true }));
		assert.equal(r.status, 'done', JSON.stringify(r));
		return r.summary.file_count + ' files';
	});

	await check('ocean tile is refused', async () => {
		const tiles = (await call('list_map_tiles', { map: 'azeroth' })).tiles;
		let ocean = null;
		for (let i = 0; i < 4096 && ocean === null; i++) {
			const name = Math.floor(i / 64) + '_' + (i % 64);
			if (!tiles.includes(name))
				ocean = name;
		}
		const r = await finished(await call('export_map', { map: 'azeroth', tiles: [ocean], force: true }));
		assert.equal(r.status, 'failed', JSON.stringify(r));
		assert.ok(['NOT_ON_MAP', 'NOT_FOUND'].includes(r.error.code), JSON.stringify(r.error));
		return ocean + ' -> ' + r.error.code;
	});

	await check('download script (bash) fetches and verifies everything', async () => {
		const s = await call('get_download_script', { job_id: glbJob.job_id, dest: path.join(DL, 'script').replace(/\\/g, '/') });
		const file = path.join(ROOT, 'fetch.sh');
		fs.writeFileSync(file, s.script);
		const bash = fs.existsSync('C:\\Program Files\\Git\\bin\\bash.exe') ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
		// Async: the gateway runs in this process, so a blocking call would deadlock curl.
		const { stdout: out } = await execFileAsync(bash, [file], { env: Object.assign({}, process.env, { WOW_EXPORT_TOKEN: token }), encoding: 'utf8', timeout: 120000 });
		assert.match(out, /^OK: \d+ files downloaded and verified/m);
		return out.trim();
	});

	await check('zip download', async () => {
		const r = await fetch(glbJob.download.zip_url, { headers: { Authorization: 'Bearer ' + token } });
		assert.equal(r.status, 200);
		const buf = Buffer.from(await r.arrayBuffer());
		assert.equal(buf.readUInt32LE(0), 0x04034b50);
		return buf.length + ' bytes';
	});

	await check('quick lane stays fast during a bulk tile export', async () => {
		const bulk = await call('export_map', { map: 'azeroth', tiles: ['31_47', '31_48', '31_49', '32_47', '32_50', '33_47', '33_48', '33_49', '33_50'], format: 'raw', force: true, wait: 0 });
		await new Promise(r => setTimeout(r, 3000));
		const t = Date.now();
		const quick = await call('get_file', { file: texture.fileDataID, format: 'png', force: true });
		const quickMs = Date.now() - t;
		assert.equal(quick.status, 'done', JSON.stringify(quick));
		const t2 = Date.now();
		await call('search', { query: 'murloc', limit: 5 });
		const searchMs = Date.now() - t2;
		const done = await finished(bulk, 900);
		assert.equal(done.status, 'done', JSON.stringify(done));
		assert.ok(quickMs < 10000, 'quick export took ' + quickMs + 'ms');
		return 'quick export ' + quickMs + ' ms, search ' + searchMs + ' ms, bulk ' + done.summary.file_count + ' files';
	});

	await check('5 agents at once, mixed requests', async () => {
		const clients = await Promise.all(Array.from({ length: 5 }, connect));
		const t = Date.now();
		const res = await Promise.all(clients.map((c, i) => [
			() => call('export_model', { file: model.fileDataID, format: 'glb' }, c),
			() => call('get_file', { file: texture.fileDataID, format: 'png' }, c),
			() => call('export_table', { tables: ['AreaTable'] }, c),
			() => call('search', { query: 'murloc', limit: 10 }, c),
			() => call('export_model', { file: model.fileDataID, format: 'obj' }, c)
		][i]()));
		await Promise.all(clients.map(c => c.close()));
		for (const r of res)
			assert.ok(r.results || r.status === 'done', JSON.stringify(r).slice(0, 300));
		return (Date.now() - t) + ' ms';
	});

	if (has('--remote')) {
		await check('remote product (retail from CDN): info + search', async () => {
			const i = await call('info', { product: 'wow' });
			const s = await call('search', { query: 'murloc', product: 'wow', limit: 3 });
			assert.ok(s.results.length > 0);
			return i.version;
		});
	}

	await client.close();
	const status = svc.pool.describe();
	await svc.stop();

	const report = { at: new Date().toISOString(), failures, results, engines: status };
	fs.writeFileSync(path.join(ROOT, 'report.json'), JSON.stringify(report, null, '\t'));
	console.log(failures === 0 ? '\nALL PASSED' : '\n' + failures + ' FAILED');
	console.log('report:', path.join(ROOT, 'report.json'));

	if (!has('--keep'))
		fs.rmSync(DL, { recursive: true, force: true });

	process.exit(failures === 0 ? 0 : 1);
};

main().catch((e) => {
	console.error(e.stack);
	process.exit(2);
});
