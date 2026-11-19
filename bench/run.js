/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Benchmarks for the export pipeline pieces that can run outside NW.js.
// Run with plain Node (V8, the same engine NW.js uses) for representative numbers.
//
//   node bench/run.js                      run everything
//   node bench/run.js --quick              shorter sampling, smaller inputs
//   node bench/run.js --filter png         only cases whose id contains "png"
//   node bench/run.js --images <dir>       also benchmark real exported PNGs
//   node bench/run.js --save baseline      save to bench/results/baseline.json
//   node bench/run.js --compare baseline   show change vs a saved run
require('../tests/helpers/nw-stub');

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Suite, fmtBytes } = require('./harness');
const { makeImage, makeBLTE, ownedCopy, decodePNG, rng, makeBLP } = require('../tests/helpers/fixtures');

const pngEncode = require('../src/js/png-encode');
const BLPImage = require('../src/js/casc/blp');
const OBJWriter = require('../src/js/3D/writers/OBJWriter');
const generics = require('../src/js/generics');
const os = require('os');
const workerPool = require('../src/js/worker-pool');
const exportSession = require('../src/js/export-session');
const BufferWrapper = require('../src/js/buffer');
const { BLTEReader } = require('../src/js/casc/blte-reader');

workerPool.setScriptPath(path.join(__dirname, '..', 'src', 'js', 'workers', 'export-worker.js'));

const parseArgs = () => {
	const args = { quick: false };
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--quick') args.quick = true;
		else if (a === '--filter') args.filter = argv[++i];
		else if (a === '--images') args.images = argv[++i];
		else if (a === '--save') args.save = argv[++i];
		else if (a === '--compare') args.compare = argv[++i];
		else if (a === '--help' || a === '-h') args.help = true;
		else throw new Error('unknown argument: ' + a);
	}
	return args;
};

const gitCommit = () => {
	try {
		const sha = execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
		const dirty = execSync('git status --porcelain -- src', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
		return sha + (dirty ? '+dirty' : '');
	} catch {
		return undefined;
	}
};

/** Collect up to `limit` RGBA PNGs from a directory tree. */
const loadImages = (dir, limit = 40) => {
	const out = [];
	const walk = (d) => {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			if (out.length >= limit)
				return;

			const p = path.join(d, entry.name);
			if (entry.isDirectory()) {
				walk(p);
			} else if (entry.name.toLowerCase().endsWith('.png')) {
				try {
					const img = decodePNG(fs.readFileSync(p));
					out.push({ name: path.relative(dir, p), ...img });
				} catch {
					// Not an 8-bit RGBA PNG; skip.
				}
			}
		}
	};
	walk(dir);
	return out;
};

const blteCorpus = (count, size, blocks) => {
	const rand = rng(1234);
	return Array.from({ length: count }, () => {
		const payload = Buffer.alloc(size);
		for (let i = 0; i < size; i++)
			payload[i] = i % 4 === 0 ? (rand() * 256) | 0 : (i >> 6) & 0xFF;
		return makeBLTE(payload, { blocks });
	});
};

const benchPNG = async (suite, args) => {
	suite.heading('PNG encoding (main thread, single image)');
	const sizes = args.quick ? [256, 1024] : [256, 512, 1024, 2048];

	for (const size of sizes) {
		const pixels = makeImage(size, size, 'texture');
		const bytes = pixels.length;

		for (const fast of [false, true]) {
			const outputBytes = pngEncode.encode(pixels, size, size, fast).length;
			await suite.add('png', `${fast ? 'fast' : 'adaptive'} ${size}x${size} texture`,
				() => pngEncode.encode(pixels, size, size, fast),
				{ bytes, extra: { outputBytes } });
		}
	}

	if (!args.images)
		return;

	const images = loadImages(args.images);
	if (images.length === 0) {
		console.log(`  (no 8-bit RGBA PNGs found in ${args.images})`);
		return;
	}

	const totalPixels = images.reduce((n, i) => n + i.pixels.length, 0);
	suite.heading(`PNG encoding, ${images.length} real images from ${args.images} (${fmtBytes(totalPixels)} of pixels)`);

	for (const fast of [false, true]) {
		const outputBytes = images.reduce((n, i) => n + pngEncode.encode(i.pixels, i.width, i.height, fast).length, 0);
		await suite.add('png-real', `${fast ? 'fast' : 'adaptive'} encode all`,
			() => { for (const i of images) pngEncode.encode(i.pixels, i.width, i.height, fast); },
			{ bytes: totalPixels, items: images.length, extra: { outputBytes } });
	}
};

const benchWorkersPNG = async (suite, args) => {
	const count = args.quick ? 16 : 48;
	const size = 512;
	const images = Array.from({ length: count }, (_, i) => makeImage(size, size, 'texture', i + 1));
	const bytes = images.reduce((n, p) => n + p.length, 0);

	suite.heading(`PNG batch: ${count} x ${size}x${size} textures (fast mode), pool of ${workerPool.getPoolSize()} workers`);

	await suite.add('png-batch', `main thread, one at a time (${count})`,
		() => { for (const p of images) pngEncode.encode(p, size, size, true); },
		{ bytes, items: count });

	await suite.add('png-batch', `worker pool, all at once (${count})`,
		() => Promise.all(images.map(p => workerPool.encodePNG(p, size, size, true))),
		{ bytes, items: count });

	await suite.add('png-batch', `main thread, adaptive, pre-change default (${count})`,
		() => { for (const p of images) pngEncode.encode(p, size, size, false); },
		{ bytes, items: count });
};

const benchBLTE = async (suite, args) => {
	const mainDecode = ({ data, hash }) => {
		const reader = new BLTEReader(new BufferWrapper(data), hash);
		reader.processAllBlocks();
		return reader;
	};

	suite.heading('BLTE decode, single file');
	const sizes = args.quick ? [[1 << 20, 16]] : [[256 << 10, 4], [1 << 20, 16], [8 << 20, 128]];
	for (const [size, blocks] of sizes) {
		const [file] = blteCorpus(1, size, blocks);
		await suite.add('blte', `main thread ${fmtBytes(size)} (${blocks} blocks)`, () => mainDecode(file), { bytes: size });
		await suite.add('blte', `worker ${fmtBytes(size)} (${blocks} blocks)`,
			() => workerPool.decodeBLTE(ownedCopy(file.data), file.hash), { bytes: size });
	}

	const count = args.quick ? 8 : 32;
	const size = 2 << 20;
	const files = blteCorpus(count, size, 32);
	suite.heading(`BLTE batch: ${count} x ${fmtBytes(size)} files`);

	await suite.add('blte-batch', `main thread, one at a time (${count})`,
		() => { for (const f of files) mainDecode(f); },
		{ bytes: count * size, items: count });

	await suite.add('blte-batch', `worker pool, all at once (${count})`,
		() => Promise.all(files.map(f => workerPool.decodeBLTE(ownedCopy(f.data), f.hash))),
		{ bytes: count * size, items: count });
};

const benchBLP = async (suite, args) => {
	const openBLP = (file) => new BLPImage(new BufferWrapper(Buffer.from(file)));

	suite.heading('BLP decode (main thread)');
	const sizes = args.quick ? [1024] : [512, 2048];
	for (const size of sizes) {
		for (const format of ['dxt1', 'dxt5', 'bgra']) {
			const file = makeBLP(size, size, { format, texture: true });
			await suite.add('blp', `${format} ${size}x${size}`, () => openBLP(file).toUInt8Array(0), { bytes: size * size * 4 });
		}
	}

	// The texture export path: decode + PNG encode for a batch, at the export
	// concurrency the app uses. "worker" sends compressed data to a worker that
	// decodes and encodes; "main decode" decodes here and encodes on a worker
	// (the previous pipeline).
	const count = args.quick ? 8 : 32;
	const size = 2048;
	const files = Array.from({ length: count }, (_, i) => makeBLP(size, size, { format: 'dxt5', texture: true, seed: i + 1 }));
	suite.heading(`Texture export pipeline: ${count} x ${size}x${size} DXT5 -> PNG, concurrency 8`);

	await suite.add('blp-batch', `main decode, worker encode (${count})`,
		() => generics.queue(files, async (f) => { await openBLP(f)._toPNGWriter(0b1111).getBufferAsync(); }, 8),
		{ items: count });

	await suite.add('blp-batch', `worker decode + encode (${count})`,
		() => generics.queue(files, async (f) => {
			const blp = openBLP(f);
			blp._prepare(0);
			await workerPool.encodeBLP(blp.rawData, blp._decodeInfo(), 0b1111, true);
		}, 8),
		{ items: count });
};

const benchOBJ = async (suite, args) => {
	// One ADT tile worth of terrain: 256 chunks x 145 vertices, 256 x 256 triangles.
	const verts = 256 * 145, tris = 256 * 256;
	const rand = rng(77);
	const positions = Array.from(new Float32Array(verts * 3).map(() => rand() * 1000 - 500));
	const normals = Array.from(new Float32Array(verts * 3).map(() => rand() * 2 - 1));
	const uvs = Array.from(new Float32Array(verts * 2).map(() => rand()));
	const indices = Array.from({ length: tris * 3 }, () => (rand() * verts) | 0);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowexport-bench-'));

	suite.heading('OBJ writing');
	await suite.add('obj', `one ADT tile (${verts} verts, ${tris} tris)`, async () => {
		const obj = new OBJWriter(path.join(dir, 'tile.obj'));
		obj.setVertArray(positions);
		obj.setNormalArray(normals);
		obj.addUVArray(uvs);
		obj.addMesh('terrain', indices, 'tex');
		await obj.write();
	}, { items: 1 });

	fs.rmSync(dir, { recursive: true, force: true });
};

const benchSession = async (suite, args) => {
	const n = args.quick ? 2000 : 10000;
	suite.heading(`Export session overhead (${n} calls)`);

	await suite.add('session', `once(), all unique keys (${n})`, async () => {
		exportSession.reset();
		await Promise.all(Array.from({ length: n }, (_, i) => exportSession.once('k' + i, async () => i)));
		exportSession.end();
	}, { items: n });

	await suite.add('session', `once(), 90% duplicate keys (${n})`, async () => {
		exportSession.reset();
		await Promise.all(Array.from({ length: n }, (_, i) => exportSession.once('k' + (i % (n / 10)), async () => i)));
		exportSession.end();
	}, { items: n });

	exportSession.setIOLimit(16);
	await suite.add('session', `io() limiter, 16 slots (${n})`, () =>
		Promise.all(Array.from({ length: n }, () => exportSession.io(async () => 1))), { items: n });

	await suite.add('session', `plain Promise.all, no limiter (${n})`, () =>
		Promise.all(Array.from({ length: n }, async () => 1)), { items: n });
};

// The worker pool unref()s its threads so they never hold the app open. In a
// plain Node script that means the process can exit while awaiting a worker,
// so hold the event loop open until the run finishes.
const keepAlive = setInterval(() => {}, 1 << 30);

(async () => {
	const args = parseArgs();
	if (args.help) {
		console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter(l => l.startsWith('//')).join('\n'));
		return;
	}

	const suite = new Suite({
		filter: args.filter,
		measure: args.quick ? { minTime: 300, minSamples: 3, warmup: 1 } : { minTime: 1500, minSamples: 5, warmup: 2 }
	});

	const env = require('./harness').environment();
	console.log(`wow.export benchmarks  ${env.node} (V8 ${env.v8})  ${env.cpu}, ${env.cores} threads`);

	if (args.compare)
		suite.loadBaseline(args.compare);

	if (!workerPool.isAvailable())
		console.log('Warning: worker pool unavailable; worker cases will fail.');

	await benchPNG(suite, args);
	await benchWorkersPNG(suite, args);
	await benchBLTE(suite, args);
	await benchBLP(suite, args);
	await benchOBJ(suite, args);
	await benchSession(suite, args);

	if (args.save)
		suite.save(args.save, { git: gitCommit(), quick: args.quick });
})().catch((e) => {
	console.error(e);
	process.exitCode = 1;
}).finally(() => clearInterval(keepAlive));
