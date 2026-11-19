// Runs in its own process (node --test isolates files), because a failed
// pool stays marked broken for the rest of the process.
require('./helpers/nw-stub');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const workerPool = require('../src/js/worker-pool');
const PNGWriter = require('../src/js/png-writer');
const { makeImage, decodePNG } = require('./helpers/fixtures');

test('a crashing worker marks the pool unavailable and callers fall back', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowexport-worker-'));
	const script = path.join(dir, 'crash-worker.js');
	fs.writeFileSync(script, 'throw new Error("worker failed to start");');
	workerPool.setScriptPath(script);

	assert.equal(workerPool.isAvailable(), true);
	await assert.rejects(workerPool.encodePNG(makeImage(4, 4), 4, 4, true));
	assert.equal(workerPool.isAvailable(), false, 'pool should be marked broken');

	// Later work goes straight to the main thread.
	await assert.rejects(workerPool.encodePNG(makeImage(4, 4), 4, 4, true), /unavailable/);

	const writer = new PNGWriter(256, 256);
	makeImage(256, 256).copy(writer.getPixelData());
	const buf = await writer.getBufferAsync();
	assert.equal(decodePNG(Buffer.from(buf.raw)).height, 256);
});
