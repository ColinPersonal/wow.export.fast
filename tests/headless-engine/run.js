/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Integration test for the export service engine (src/js/headless/engine.js).
// Acts as the gateway: starts real engines under Bun against a real game
// installation, runs every job and query kind, checks the files written and
// the error paths, and prints timings.
//
//   node tests/headless-engine/run.js [--install <dir>] [--product wowf] [--root <dir>] [--no-remote] [--bun <path>]
//
// Defaults: the installation and product your wow.export opened last (read
// only), test area C:\Users\<you>\wow.export-service\dev\engine-test (or
// ~/wow.export-service/dev/engine-test), Bun from ~/.bun/bin.
// Nothing is written outside the test area.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createParser, encode } = require('../../src/js/headless/ndjson');
const { decodePNG } = require('../helpers/fixtures');

const REPO = path.join(__dirname, '..', '..');
const CLI = path.join(REPO, 'src', 'js', 'headless', 'cli.js');

// --- arguments -----------------------------------------------------------------

const normalAppConfig = () => {
	const base = process.platform === 'win32' ? process.env.LOCALAPPDATA : path.join(os.homedir(), '.config');
	try {
		return JSON.parse(fs.readFileSync(path.join(base ?? '', 'wow.export', 'User Data', 'Default', 'config.json'), 'utf8'));
	} catch {
		return {};
	}
};

const parseArgs = () => {
	const recent = normalAppConfig().recentLocal?.[0] ?? {};
	const args = {
		install: recent.path,
		product: recent.product,
		root: path.join(os.homedir(), 'wow.export-service', 'dev', 'engine-test'),
		bun: path.join(os.homedir(), '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun'),
		remote: true
	};

	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--install') args.install = argv[++i];
		else if (a === '--product') args.product = argv[++i];
		else if (a === '--root') args.root = argv[++i];
		else if (a === '--bun') args.bun = argv[++i];
		else if (a === '--no-remote') args.remote = false;
		else throw new Error('unknown argument: ' + a);
	}

	if (!args.install || !args.product)
		throw new Error('no installation known; pass --install and --product');

	return args;
};

// --- fake gateway ----------------------------------------------------------------

class Gateway {
	constructor(secret) {
		this.secret = secret;
		this.received = [];
		this.waiters = [];
		this.socket = null;
		this.rejected = 0;
	}

	async listen() {
		this.server = net.createServer(socket => {
			socket.on('data', createParser(message => {
				if (message.t === 'hello') {
					if (message.secret !== this.secret) {
						this.rejected++;
						socket.destroy();
						return;
					}

					this.socket = socket;
					socket.write(encode({ t: 'welcome' }));
				}

				this.received.push(message);
				this.check();
			}));
			socket.on('error', () => {});
		});

		await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve));
		this.port = this.server.address().port;
	}

	check() {
		for (const waiter of [...this.waiters]) {
			const index = this.received.findIndex(waiter.match);
			if (index !== -1) {
				this.waiters.splice(this.waiters.indexOf(waiter), 1);
				clearTimeout(waiter.timer);
				waiter.resolve(this.received[index]);
			}
		}
	}

	wait(match, ms, what) {
		return new Promise((resolve, reject) => {
			const found = this.received.find(match);
			if (found)
				return resolve(found);

			const waiter = { match, resolve };
			waiter.timer = setTimeout(() => {
				this.waiters.splice(this.waiters.indexOf(waiter), 1);
				reject(new Error('timed out after ' + ms + 'ms waiting for ' + what));
			}, ms);
			this.waiters.push(waiter);
		});
	}

	send(message) {
		this.socket.write(encode(message));
	}

	close() {
		this.socket?.destroy();
		return new Promise(resolve => this.server.close(() => resolve()));
	}
}

// --- engine process ----------------------------------------------------------------

const startEngine = (args, gateway, { id, source, secret = gateway.secret }) => {
	const dir = path.join(args.root, 'engines', id);
	fs.mkdirSync(dir, { recursive: true });

	const config = {
		protocol: 1,
		id,
		gatewayPort: gateway.port,
		secret,
		source,
		dataDir: path.join(dir, 'appdata'),
		config: { exportConcurrency: 8 }
	};

	const file = path.join(dir, 'engine.json');
	fs.writeFileSync(file, JSON.stringify(config, null, '\t'));

	const child = spawn(args.bun, [CLI, 'engine', '--config', file], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
	const output = { stdout: '', stderr: '' };
	child.stdout.on('data', chunk => output.stdout += chunk);
	child.stderr.on('data', chunk => output.stderr += chunk);

	const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal, at: Date.now() })));
	return { child, exited, output };
};

// --- checks ------------------------------------------------------------------------

const results = [];

const record = (name, ok, ms, detail = '') => {
	results.push({ name, ok, ms, detail });
	console.log((ok ? 'PASS ' : 'FAIL ') + name.padEnd(46) + String(Math.round(ms)).padStart(7) + 'ms  ' + detail);
};

const check = async (name, fn) => {
	const start = performance.now();
	try {
		const detail = await fn();
		record(name, true, performance.now() - start, detail ?? '');
	} catch (e) {
		record(name, false, performance.now() - start, e.message);
	}
};

const assert = (condition, message) => {
	if (!condition)
		throw new Error(message);
};

let req = 0;
const query = async (gateway, kind, params = {}, ms = 120000) => {
	const id = ++req;
	gateway.send({ t: 'query', req: id, kind, params });
	return gateway.wait(m => m.t === 'reply' && m.req === id, ms, 'reply to ' + kind);
};

let jobCounter = 0;
const runJob = async (gateway, args, kind, params, ms = 600000) => {
	const job = 'job-' + (++jobCounter) + '-' + kind;
	const outDir = path.join(args.root, 'out', job);
	fs.rmSync(outDir, { recursive: true, force: true });
	gateway.send({ t: 'job', job, kind, params, outDir });
	const done = await gateway.wait(m => m.t === 'done' && m.job === job, ms, 'done of ' + job);
	const progress = gateway.received.filter(m => m.t === 'progress' && m.job === job);
	return { job, outDir, done, progress };
};

const walk = (dir) => {
	const out = [];
	const visit = (d) => {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			const full = path.join(d, entry.name);
			if (entry.isDirectory())
				visit(full);
			else
				out.push(full);
		}
	};

	if (fs.existsSync(dir))
		visit(dir);

	return out;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/** Check any PNG: signature, chunk CRCs, and that IDAT inflates to the size IHDR implies. */
const checkPNG = (file) => {
	const png = fs.readFileSync(file);
	assert(png.subarray(0, 8).equals(PNG_SIGNATURE), 'bad PNG signature: ' + file);

	let ofs = 8;
	let ihdr = null;
	const idat = [];
	while (ofs < png.length) {
		const length = png.readUInt32BE(ofs);
		const type = png.toString('latin1', ofs + 4, ofs + 8);
		const body = png.subarray(ofs + 8, ofs + 8 + length);
		assert(png.readUInt32BE(ofs + 8 + length) === zlib.crc32(png.subarray(ofs + 4, ofs + 8 + length)), 'bad CRC in ' + type + ': ' + file);

		if (type === 'IHDR')
			ihdr = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), bitDepth: body[8], colorType: body[9] };
		else if (type === 'IDAT')
			idat.push(body);

		ofs += 12 + length;
	}

	assert(ihdr !== null, 'no IHDR: ' + file);
	const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType];
	const bytesPerPixel = channels * ihdr.bitDepth / 8;
	const raw = zlib.inflateSync(Buffer.concat(idat));
	assert(raw.length === ihdr.height * (1 + ihdr.width * bytesPerPixel), 'PNG data size mismatch: ' + file);

	// Fully decode 8-bit RGBA images.
	if (ihdr.bitDepth === 8 && ihdr.colorType === 6)
		decodePNG(png);

	return ihdr;
};

const checkGLB = (file) => {
	const glb = fs.readFileSync(file);
	assert(glb.toString('latin1', 0, 4) === 'glTF', 'bad GLB magic: ' + file);
	assert(glb.readUInt32LE(4) === 2, 'GLB version is not 2');
	assert(glb.readUInt32LE(8) === glb.length, 'GLB length field ' + glb.readUInt32LE(8) + ' != file size ' + glb.length);
	const jsonLength = glb.readUInt32LE(12);
	assert(glb.toString('latin1', 16, 20) === 'JSON', 'first GLB chunk is not JSON');
	const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength));
	assert(Array.isArray(json.meshes) && json.meshes.length > 0, 'GLB has no meshes');
	return json;
};

const checkGLTF = (file) => {
	const json = JSON.parse(fs.readFileSync(file, 'utf8'));
	assert(Array.isArray(json.meshes) && json.meshes.length > 0, 'glTF has no meshes');
	for (const buffer of json.buffers ?? []) {
		if (buffer.uri && !buffer.uri.startsWith('data:')) {
			const size = fs.statSync(path.join(path.dirname(file), decodeURIComponent(buffer.uri))).size;
			assert(size === buffer.byteLength, 'buffer ' + buffer.uri + ' is ' + size + ' bytes, glTF says ' + buffer.byteLength);
		}
	}
	return json;
};

const checkOBJ = (file) => {
	const text = fs.readFileSync(file, 'utf8');
	let v = 0, f = 0, mtllib = null;
	for (const line of text.split('\n')) {
		if (line.startsWith('v ')) v++;
		else if (line.startsWith('f ')) f++;
		else if (line.startsWith('mtllib ')) mtllib = line.slice(7).trim();
	}
	assert(v > 0 && f > 0, 'OBJ has ' + v + ' vertices and ' + f + ' faces: ' + file);
	if (mtllib !== null)
		assert(fs.existsSync(path.join(path.dirname(file), mtllib)), 'missing MTL ' + mtllib);

	// Every face index must refer to an existing vertex.
	let max = 0;
	for (const match of text.matchAll(/^f (.+)$/gm)) {
		for (const part of match[1].trim().split(/\s+/))
			max = Math.max(max, parseInt(part, 10));
	}
	assert(max <= v, 'face index ' + max + ' exceeds vertex count ' + v);
	return { v, f, mtllib };
};

const csvHeader = (file) => {
	const text = fs.readFileSync(file, 'utf8');
	const line = text.slice(0, text.indexOf('\n')).replace(/\r$/, '');
	return line.split(/[;,]/);
};

// --- the test run ------------------------------------------------------------------

const main = async () => {
	const args = parseArgs();
	assert(fs.existsSync(args.bun), 'Bun not found at ' + args.bun);
	fs.mkdirSync(args.root, { recursive: true });

	const secret = crypto.randomBytes(32).toString('hex');
	const gateway = new Gateway(secret);
	await gateway.listen();

	console.log('install %s (%s), test area %s', args.install, args.product, args.root);

	const t0 = performance.now();
	const engine = startEngine(args, gateway, { id: 'local', source: { type: 'local', install: args.install, product: args.product, region: 'us' } });

	let ready;
	await check('engine starts and opens the local build', async () => {
		const hello = await gateway.wait(m => m.t === 'hello', 60000, 'hello');
		assert(hello.host === 'bun', 'host is ' + hello.host);
		ready = await Promise.race([
			gateway.wait(m => m.t === 'ready', 600000, 'ready'),
			gateway.wait(m => m.t === 'fatal', 600000, 'fatal').then(m => { throw new Error('fatal: ' + m.error.message); })
		]);
		assert(ready.build.product === args.product, 'product ' + ready.build.product);
		assert(ready.build.version, 'no version reported');
		assert(engine.output.stdout.length === 0, 'engine wrote to stdout: ' + engine.output.stdout.slice(0, 200));
		return ready.build.version + ', ' + ready.build.fileCount + ' files, load ' + ready.loadMs + 'ms';
	});

	if (!ready) {
		console.log(engine.output.stderr.slice(-4000));
		throw new Error('engine did not start');
	}

	// --- queries -------------------------------------------------------------
	let texture, model, wmo, sound, font;

	await check('query info', async () => {
		const r = await query(gateway, 'info');
		assert(r.ok && r.result.source === 'local', JSON.stringify(r));
		return r.result.version;
	});

	await check('query search (texture, model, wmo, sound, font)', async () => {
		const find = async (q, type) => {
			const r = await query(gateway, 'search', { query: q, type, limit: 5 });
			assert(r.ok, JSON.stringify(r.error));
			return r.result.results;
		};

		texture = (await find('inv_sword_04', 'texture'))[0];
		model = (await find('creature/murloc/murloc.m2', 'model'))[0];
		wmo = (await find('stormwind', 'model')).find(e => e.fileName.endsWith('.wmo')) ?? (await find('.wmo', 'model')).find(e => /\.wmo$/.test(e.fileName) && !/_\d{3}\.wmo$/.test(e.fileName));
		sound = (await find('.ogg', 'sound'))[0];
		font = (await find('.ttf', 'font'))[0];
		assert(texture && model && wmo && sound && font, 'missing search results: ' + JSON.stringify({ texture, model, wmo, sound, font }));
		return [texture, model, wmo, sound, font].map(e => e.fileName).join(', ');
	});

	await check('query search refuses regex', async () => {
		const r = await query(gateway, 'search', { query: '/.*/', limit: 1 });
		assert(r.ok && r.result.total === 0, 'regex was evaluated: total ' + r.result?.total);
	});

	await check('query file_info', async () => {
		const r = await query(gateway, 'file_info', { files: [texture.fileDataID, model.fileName, 'no/such/file.blp', 2147483000] });
		assert(r.ok, JSON.stringify(r.error));
		const [a, b, c, d] = r.result.files;
		assert(a.inBuild && a.fileName === texture.fileName, 'by id: ' + JSON.stringify(a));
		assert(b.fileDataID === model.fileDataID && b.inBuild, 'by name: ' + JSON.stringify(b));
		assert(c.error?.code === 'NOT_FOUND', 'unknown name: ' + JSON.stringify(c));
		assert(d.inBuild === false, 'unknown id: ' + JSON.stringify(d));
	});

	await check('query list_maps / list_map_tiles', async () => {
		const maps = await query(gateway, 'list_maps', { query: 'azeroth' });
		assert(maps.ok && maps.result.maps.some(m => m.id === 0), 'no map 0');
		const tiles = await query(gateway, 'list_map_tiles', { map: 'azeroth' });
		assert(tiles.ok && tiles.result.tiles.includes('32_48'), 'no tile 32_48');
		const unknown = await query(gateway, 'list_map_tiles', { map: 'no_such_map' });
		assert(!unknown.ok && unknown.error.code === 'NOT_FOUND', JSON.stringify(unknown));
		return tiles.result.tileCount + ' tiles';
	});

	let mapColumns;
	await check('query list_tables / describe_table / query_table', async () => {
		const list = await query(gateway, 'list_tables', { query: 'map' });
		assert(list.ok && list.result.tables.includes('Map'), 'no Map table');
		const describe = await query(gateway, 'describe_table', { table: 'map' });
		assert(describe.ok && describe.result.table === 'Map' && describe.result.columnCount > 5 && describe.result.rowCount > 10, JSON.stringify(describe).slice(0, 300));
		mapColumns = describe.result.columnCount;
		const row = await query(gateway, 'query_table', { table: 'Map', id: 0 });
		assert(row.ok && row.result.rows[0].Directory === 'Azeroth', 'row 0');
		const where = await query(gateway, 'query_table', { table: 'Map', where: { ExpansionID: 0 }, limit: 2 });
		assert(where.ok && where.result.count === 2 && where.result.total > 2, 'where filter');
		const unknown = await query(gateway, 'query_table', { table: 'NoSuchTable' });
		assert(!unknown.ok && unknown.error.code === 'NOT_FOUND', JSON.stringify(unknown));
		const invalid = await query(gateway, 'query_table', { table: '../x' });
		assert(!invalid.ok && invalid.error.code === 'INVALID_PARAMS', JSON.stringify(invalid));
		return list.result.count + ' tables matching "map", Map has ' + mapColumns + ' columns';
	});

	// --- jobs ----------------------------------------------------------------
	let rawSize;

	await check('job get_file raw', async () => {
		const { done, outDir } = await runJob(gateway, args, 'get_file', { file: texture.fileDataID, format: 'raw' });
		assert(done.ok, JSON.stringify(done.error ?? done.failed));
		const file = path.join(outDir, texture.fileName);
		rawSize = fs.statSync(file).size;
		assert(fs.readFileSync(file).toString('latin1', 0, 4) === 'BLP2', 'not a BLP2 file');
		return rawSize + ' bytes';
	});

	await check('job get_file png', async () => {
		const { done } = await runJob(gateway, args, 'get_file', { file: texture.fileName, format: 'png' });
		assert(done.ok, JSON.stringify(done.error ?? done.failed));
		const ihdr = checkPNG(done.result.path);
		return ihdr.width + 'x' + ihdr.height;
	});

	await check('job get_file of a file not in the build', async () => {
		const { done } = await runJob(gateway, args, 'get_file', { file: 2147483000 });
		assert(!done.ok && done.error.code === 'NOT_FOUND', JSON.stringify(done));
	});

	for (const format of ['png', 'webp', 'blp']) {
		await check('job export_textures ' + format + ' (+1 missing)', async () => {
			const { done, outDir, progress } = await runJob(gateway, args, 'export_textures', { files: [texture.fileDataID, 'interface/no/such.blp'], format });
			assert(!done.ok && !done.error, 'expected partial result: ' + JSON.stringify(done.error));
			assert(done.failed.length === 1 && done.failed[0].code === 'NOT_FOUND', 'failed: ' + JSON.stringify(done.failed));
			const files = walk(outDir);
			assert(files.length === 1, files.length + ' files written');
			if (format === 'png')
				checkPNG(files[0]);
			else if (format === 'webp')
				assert(fs.readFileSync(files[0]).toString('latin1', 8, 12) === 'WEBP', 'not WEBP');
			else
				assert(fs.statSync(files[0]).size === rawSize, 'BLP size differs from raw');
			assert(progress.length > 0, 'no progress messages');
			return path.basename(files[0]);
		});
	}

	await check('job export_model glb', async () => {
		const { done, outDir } = await runJob(gateway, args, 'export_model', { file: model.fileDataID, format: 'glb' });
		assert(done.ok, JSON.stringify(done.error ?? done.failed));
		const json = checkGLB(done.result.path);
		return json.meshes.length + ' meshes, ' + walk(outDir).length + ' files';
	});

	await check('job export_models obj (m2 + wmo + missing)', async () => {
		const { done, outDir } = await runJob(gateway, args, 'export_models', { files: [model.fileDataID, wmo.fileDataID, 999999999], format: 'obj' });
		assert(!done.ok && !done.error, 'expected partial: ' + JSON.stringify(done.error));
		assert(done.failed.length === 1 && done.failed[0].code === 'NOT_FOUND', JSON.stringify(done.failed));
		assert(done.result.exported === 2, 'exported ' + done.result.exported);
		const objs = done.result.models.map(m => checkOBJ(m.path));
		const pngs = walk(outDir).filter(f => f.endsWith('.png'));
		pngs.slice(0, 5).forEach(checkPNG);
		return objs.map(o => o.v + 'v/' + o.f + 'f').join(', ') + ', ' + pngs.length + ' textures';
	});

	await check('job export_models gltf + stl', async () => {
		const gltf = await runJob(gateway, args, 'export_models', { files: [model.fileDataID], format: 'gltf' });
		assert(gltf.done.ok, JSON.stringify(gltf.done.error ?? gltf.done.failed));
		checkGLTF(gltf.done.result.models[0].path);
		const stl = await runJob(gateway, args, 'export_models', { files: [model.fileDataID], format: 'stl' });
		assert(stl.done.ok, JSON.stringify(stl.done.error ?? stl.done.failed));
		assert(fs.statSync(stl.done.result.models[0].path).size > 84, 'STL too small');
	});

	await check('job export_model raw', async () => {
		const { done, outDir } = await runJob(gateway, args, 'export_model', { file: model.fileName, format: 'raw' });
		assert(done.ok, JSON.stringify(done.error ?? done.failed));
		const files = walk(outDir);
		assert(files.some(f => f.endsWith('.m2')) && files.some(f => f.endsWith('.skin')), 'missing m2/skin');
		return files.length + ' files';
	});

	await check('job export_files (sound, font, missing)', async () => {
		const { done, outDir } = await runJob(gateway, args, 'export_files', { files: [sound.fileDataID, font.fileName, 'no/such/file.ogg'] });
		assert(!done.ok && done.failed.length === 1 && done.failed[0].code === 'NOT_FOUND', JSON.stringify(done.failed));
		const files = walk(outDir);
		assert(files.length === 2, files.length + ' files');
		const ogg = files.find(f => f.endsWith('.ogg'));
		assert(ogg && fs.readFileSync(ogg).toString('latin1', 0, 4) === 'OggS', 'sound is not Ogg');
		return files.map(f => path.basename(f) + ' ' + fs.statSync(f).size).join(', ');
	});

	for (const format of ['csv', 'sql', 'db2']) {
		await check('job export_table ' + format + ' (+1 unknown)', async () => {
			const { done, outDir } = await runJob(gateway, args, 'export_table', { tables: ['Map', 'NoSuchTable'], format });
			assert(!done.ok && done.failed.length === 1 && done.failed[0].code === 'NOT_FOUND', JSON.stringify(done.failed));
			const file = path.join(outDir, 'Map.' + format);
			assert(fs.existsSync(file), 'missing ' + file);
			if (format === 'csv') {
				const header = csvHeader(file);
				assert(header.length === mapColumns, 'CSV has ' + header.length + ' columns, describe_table says ' + mapColumns);
				assert(header[0].replace(/"/g, '').toUpperCase() === 'ID', 'first column ' + header[0]);
			} else if (format === 'sql') {
				const text = fs.readFileSync(file, 'utf8');
				assert(/CREATE TABLE/i.test(text) && /INSERT INTO/i.test(text), 'SQL lacks CREATE/INSERT');
			} else {
				assert(fs.readFileSync(file).toString('latin1', 0, 3) === 'WDC', 'not a WDC file');
			}
			return fs.statSync(file).size + ' bytes';
		});
	}

	await check('job export_map raw 32_48', async () => {
		const { done, outDir } = await runJob(gateway, args, 'export_map', { map: 'azeroth', tiles: ['32_48'], format: 'raw' });
		assert(done.ok, JSON.stringify(done.error ?? done.failed));
		const files = walk(outDir);
		assert(files.some(f => /azeroth_32_48\.adt$/.test(f)), 'no root ADT');
		assert(files.length > 100, 'only ' + files.length + ' files');
		return files.length + ' files';
	});

	await check('job export_map obj 32_48 (terrain only)', async () => {
		const { done, outDir } = await runJob(gateway, args, 'export_map', { map: 0, tiles: ['32_48'], format: 'obj', models: false, wmos: false, foliage: false });
		assert(done.ok, JSON.stringify(done.error ?? done.failed));
		const obj = walk(outDir).find(f => f.endsWith('.obj'));
		assert(obj, 'no OBJ');
		const r = checkOBJ(obj);
		return r.v + 'v/' + r.f + 'f';
	});

	await check('job export_map heightmap 32_48 + 32_49', async () => {
		const { done, outDir } = await runJob(gateway, args, 'export_map', { map: 'azeroth', tiles: ['32_48', '32_49'], format: 'heightmap', heightmapResolution: 128, heightmapBitDepth: 16 });
		assert(done.ok, JSON.stringify(done.error ?? done.failed));
		const pngs = walk(outDir).filter(f => f.endsWith('.png'));
		assert(pngs.length === 2, pngs.length + ' heightmaps');
		for (const png of pngs) {
			const ihdr = checkPNG(png);
			assert(ihdr.width === 128 && ihdr.bitDepth === 16 && ihdr.colorType === 0, JSON.stringify(ihdr));
		}
		return 'range ' + JSON.stringify(done.result.heightRange);
	});

	await check('job export_map on a tile with no terrain', async () => {
		const tiles = await query(gateway, 'list_map_tiles', { map: 'azeroth' });
		let empty = null;
		for (let i = 0; i < 4096 && empty === null; i++) {
			const name = Math.floor(i / 64) + '_' + (i % 64);
			if (!tiles.result.tiles.includes(name))
				empty = name;
		}
		const { done } = await runJob(gateway, args, 'export_map', { map: 'azeroth', tiles: [empty], format: 'raw' });
		assert(!done.ok && done.error.code === 'NOT_ON_MAP', JSON.stringify(done));
		return empty;
	});

	await check('job with invalid params', async () => {
		const bad = await runJob(gateway, args, 'export_map', { map: 'azeroth', tiles: ['99_99'] });
		assert(bad.done.error?.code === 'INVALID_PARAMS', JSON.stringify(bad.done));
		const format = await runJob(gateway, args, 'export_models', { files: [1], format: 'fbx' });
		assert(format.done.error?.code === 'INVALID_PARAMS', JSON.stringify(format.done));
	});

	await check('busy engine rejects a second job; cancel stops a tile job', async () => {
		const job = 'job-cancel';
		const outDir = path.join(args.root, 'out', job);
		fs.rmSync(outDir, { recursive: true, force: true });
		gateway.send({ t: 'job', job, kind: 'export_map', params: { map: 'azeroth', tiles: ['30_46', '30_47', '30_48', '31_46', '31_47', '31_48', '33_48', '33_49'], format: 'raw' }, outDir });
		await gateway.wait(m => m.t === 'progress' && m.job === job, 120000, 'progress of cancel job');

		gateway.send({ t: 'job', job: 'job-busy', kind: 'get_file', params: { file: texture.fileDataID }, outDir: path.join(args.root, 'out', 'job-busy') });
		const busy = await gateway.wait(m => m.t === 'done' && m.job === 'job-busy', 10000, 'busy reply');
		assert(busy.error?.code === 'BUSY', 'second job: ' + JSON.stringify(busy));

		const q = await query(gateway, 'info', {}, 10000);
		assert(q.ok, 'query while busy failed');

		const sent = Date.now();
		gateway.send({ t: 'cancel', job });
		const done = await gateway.wait(m => m.t === 'done' && m.job === job, 300000, 'cancelled job');
		assert(done.cancelled === true && done.ok === false, JSON.stringify(done).slice(0, 300));

		// The engine accepts work again afterwards.
		const after = await runJob(gateway, args, 'get_file', { file: texture.fileDataID });
		assert(after.done.ok, 'job after cancel failed');
		return 'cancelled in ' + (Date.now() - sent) + 'ms';
	});

	await check('heartbeats arrive with memory figures', async () => {
		const beat = await gateway.wait(m => m.t === 'heartbeat', 10000, 'heartbeat');
		assert(beat.rss > 0 && beat.uptime >= 0, JSON.stringify(beat));
		return Math.round(beat.rss / 1048576) + ' MB rss';
	});

	await check('engine exits within 5s when the gateway disconnects', async () => {
		const closed = Date.now();
		gateway.socket.destroy();
		const exit = await Promise.race([engine.exited, new Promise(resolve => setTimeout(() => resolve(null), 5000))]);
		assert(exit !== null, 'engine still running after 5s');
		return 'exited after ' + (exit.at - closed) + 'ms, code ' + exit.code;
	});

	await gateway.close();

	// --- wrong secret ----------------------------------------------------------
	await check('engine with a wrong secret is refused and exits', async () => {
		const strict = new Gateway(crypto.randomBytes(32).toString('hex'));
		await strict.listen();
		const bad = startEngine(args, strict, { id: 'bad-secret', source: { type: 'local', install: args.install, product: args.product }, secret: 'f'.repeat(64) });
		const exit = await Promise.race([bad.exited, new Promise(resolve => setTimeout(() => resolve(null), 15000))]);
		await strict.close();
		if (exit === null)
			bad.child.kill();
		assert(exit !== null, 'engine still running 15s after being refused');
		assert(strict.rejected === 1, 'gateway did not see the bad hello');
		assert(!strict.received.some(m => m.t === 'ready'), 'refused engine reported ready');
		return 'exit code ' + exit.code;
	});

	// --- remote source ---------------------------------------------------------
	if (args.remote) {
		await check('remote engine (wow, CDN): info + search', async () => {
			const remoteGateway = new Gateway(crypto.randomBytes(32).toString('hex'));
			await remoteGateway.listen();
			const remote = startEngine(args, remoteGateway, { id: 'remote-wow', source: { type: 'remote', product: 'wow', region: 'us' } });

			try {
				const r = await Promise.race([
					remoteGateway.wait(m => m.t === 'ready', 1200000, 'remote ready'),
					remoteGateway.wait(m => m.t === 'fatal', 1200000, 'remote fatal').then(m => { throw new Error('fatal: ' + m.error.message); })
				]);
				const info = await query(remoteGateway, 'info');
				assert(info.ok && info.result.source === 'cdn' && info.result.product === 'wow', JSON.stringify(info));
				const search = await query(remoteGateway, 'search', { query: 'murloc', type: 'model', limit: 1 });
				assert(search.ok && search.result.total > 0, 'no results');
				return r.build.version + ', load ' + r.loadMs + 'ms';
			} finally {
				remoteGateway.send({ t: 'shutdown' });
				await Promise.race([remote.exited, new Promise(resolve => setTimeout(resolve, 5000))]);
				remote.child.kill();
				await remoteGateway.close();
			}
		});
	}

	const failed = results.filter(r => !r.ok);
	console.log('\n%d checks, %d failed, %ss total', results.length, failed.length, ((performance.now() - t0) / 1000).toFixed(1));

	fs.writeFileSync(path.join(args.root, 'report.json'), JSON.stringify({ when: new Date().toISOString(), install: args.install, product: args.product, results }, null, '\t'));

	if (failed.length > 0) {
		console.log('\nengine stderr (tail):\n' + engine.output.stderr.slice(-3000));
		process.exitCode = 1;
	}
};

main().catch(e => {
	console.error(e.stack);
	process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(), 100));
