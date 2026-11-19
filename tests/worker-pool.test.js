require('./helpers/nw-stub');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const workerPool = require('../src/js/worker-pool');
const pngEncode = require('../src/js/png-encode');
const PNGWriter = require('../src/js/png-writer');
const { makeImage, decodePNG } = require('./helpers/fixtures');

workerPool.setScriptPath(path.join(__dirname, '..', 'src', 'js', 'workers', 'export-worker.js'));

test('pool size leaves one core free and is capped at 8', () => {
	const size = workerPool.getPoolSize();
	const cores = os.cpus().length;
	assert.equal(size, Math.max(1, Math.min(8, cores - 1)));
});

test('worker PNG output is byte-identical to main-thread output', async () => {
	const pixels = makeImage(300, 200);
	for (const fast of [false, true]) {
		const worker = await workerPool.encodePNG(pixels, 300, 200, fast);
		const main = pngEncode.encode(pixels, 300, 200, fast);
		assert.ok(worker.equals(main), `mismatch in ${fast ? 'fast' : 'adaptive'} mode`);
	}
});

test('encodePNG leaves the caller pixel buffer usable', async () => {
	const pixels = makeImage(64, 64);
	const copy = Buffer.from(pixels);
	await workerPool.encodePNG(pixels, 64, 64, true);
	assert.ok(pixels.equals(copy));
});

test('more tasks than workers all complete with the right results', async () => {
	const n = workerPool.getPoolSize() * 4 + 3;
	const images = Array.from({ length: n }, (_, i) => ({ w: 32 + i, h: 16 + (i % 5), seed: i }));

	const results = await Promise.all(images.map(({ w, h, seed }) =>
		workerPool.encodePNG(makeImage(w, h, 'texture', seed), w, h, true)));

	results.forEach((png, i) => {
		const { w, h, seed } = images[i];
		const out = decodePNG(png);
		assert.equal(out.width, w);
		assert.ok(out.pixels.equals(makeImage(w, h, 'texture', seed)), `task ${i} returned the wrong image`);
	});
});

test('PNGWriter.getBufferAsync matches getBuffer for worker-sized images', async () => {
	const writer = new PNGWriter(256, 256);
	makeImage(256, 256).copy(writer.getPixelData());

	const sync = writer.getBuffer();
	const async = await writer.getBufferAsync();
	assert.ok(Buffer.from(async.raw).equals(Buffer.from(sync.raw)));
});

test('PNGWriter.getBufferAsync encodes small images on the calling thread', async () => {
	const writer = new PNGWriter(8, 8);
	makeImage(8, 8).copy(writer.getPixelData());
	const buf = await writer.getBufferAsync();
	assert.equal(decodePNG(Buffer.from(buf.raw)).width, 8);
});

test('disabling the pool rejects tasks and PNGWriter falls back', async () => {
	workerPool.setEnabled(false);
	try {
		assert.equal(workerPool.isAvailable(), false);
		await assert.rejects(workerPool.encodePNG(makeImage(4, 4), 4, 4, true), /unavailable/);

		const writer = new PNGWriter(256, 256);
		makeImage(256, 256).copy(writer.getPixelData());
		const buf = await writer.getBufferAsync();
		assert.equal(decodePNG(Buffer.from(buf.raw)).width, 256);
	} finally {
		workerPool.setEnabled(true);
	}
	assert.equal(workerPool.isAvailable(), true);
});
