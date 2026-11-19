// The BLP decoder rewrite must produce exactly what the original decoder did
// (tests/helpers/blp-reference.js is a frozen copy of it), apart from the one
// deliberate fix: odd pixels of 4-bit palette alpha.
require('./helpers/nw-stub');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const BufferWrapper = require('../src/js/buffer');
const BLPImage = require('../src/js/casc/blp');
const ReferenceBLP = require('./helpers/blp-reference');
const blpDecode = require('../src/js/casc/blp-decode');
const pngEncode = require('../src/js/png-encode');
const workerPool = require('../src/js/worker-pool');
const { makeBLP, decodePNG } = require('./helpers/fixtures');

workerPool.setScriptPath(path.join(__dirname, '..', 'src', 'js', 'workers', 'export-worker.js'));

const open = (Cls, file) => new Cls(new BufferWrapper(Buffer.from(file)));

// Run the reference decoder into a given target (Buffer, or a clamped array
// to mimic a canvas) the same way its drawToCanvas() did.
const referenceDecode = (file, mipmap, mask, makeTarget) => {
	const ref = open(ReferenceBLP, file);
	ref._prepare(mipmap);
	const out = makeTarget(ref.scaledLength * 4);
	switch (ref.encoding) {
		case 1: ref._getUncompressed(out, mask); break;
		case 2: ref._getCompressed(out, mask); break;
		case 3: ref._marshalBGRA(out, mask); break;
	}
	return out;
};

const newDecode = (file, mipmap, mask, makeTarget) => {
	const blp = open(BLPImage, file);
	blp._prepare(mipmap);
	return blp._decodeInto(makeTarget(blp.scaledLength * 4), mask);
};

const FORMATS = [
	{ format: 'dxt1' },
	{ format: 'dxt1', alphaDepth: 1 },
	{ format: 'dxt3' },
	{ format: 'dxt5' },
	{ format: 'bgra' },
	{ format: 'palette', alphaDepth: 0 },
	{ format: 'palette', alphaDepth: 1 },
	{ format: 'palette', alphaDepth: 8 }
];
const SIZES = [[64, 64], [128, 32], [6, 10], [1, 1], [256, 256]];
const MASKS = [0b1111, 0b0111, 0b1000, 0b0101];

for (const opts of FORMATS) {
	const label = opts.format + (opts.alphaDepth !== undefined ? ` alpha${opts.alphaDepth}` : '');

	for (const [w, h] of SIZES) {
		test(`${label} ${w}x${h}: matches the original decoder (Buffer and canvas targets, all masks, mipmaps)`, () => {
			const file = makeBLP(w, h, { ...opts, mipmaps: 3, seed: w * 7 + h });

			for (const mask of MASKS) {
				for (const mip of [0, 1, 2]) {
					const ref = referenceDecode(file, mip, mask, n => Buffer.alloc(n));
					const got = newDecode(file, mip, mask, n => Buffer.alloc(n));
					assert.ok(got.equals(ref), `Buffer target differs (mask ${mask.toString(2)}, mip ${mip})`);

					// Canvas ImageData is a Uint8ClampedArray, which rounds rather than truncates.
					const refC = referenceDecode(file, mip, mask, n => new Uint8ClampedArray(n));
					const gotC = newDecode(file, mip, mask, n => new Uint8ClampedArray(n));
					assert.deepEqual(gotC, refC, `canvas target differs (mask ${mask.toString(2)}, mip ${mip})`);
				}
			}
		});
	}
}

test('public outputs match the original: toBuffer, toUInt8Array, getRawMipmap, get_raw_mipmaps', () => {
	for (const opts of FORMATS) {
		const file = makeBLP(32, 16, { ...opts, mipmaps: 2, seed: 3 });
		const a = open(BLPImage, file), b = open(ReferenceBLP, file);

		// The original toBuffer() was broken for palette and BGRA images (it passed
		// arrays to writeUInt8, writing zeros) and has no callers, so for those it
		// is checked against the decoded pixels instead.
		const expected = opts.format === 'bgra' || opts.format === 'palette'
			? Buffer.from(b.toUInt8Array(0, 0b1111))
			: Buffer.from(b.toBuffer(0, 0b1111).raw);
		assert.ok(Buffer.from(a.toBuffer(0, 0b1111).raw).equals(expected), `${opts.format} toBuffer`);
		assert.deepEqual(a.toUInt8Array(1, 0b0111), b.toUInt8Array(1, 0b0111), `${opts.format} toUInt8Array`);
		assert.ok(a.getRawMipmap(1).equals(b.getRawMipmap(1)), `${opts.format} getRawMipmap`);
		assert.deepEqual(a.get_raw_mipmaps(), b.get_raw_mipmaps(), `${opts.format} get_raw_mipmaps`);
	}
});

test('toPNG output is byte-identical to the original', () => {
	for (const opts of FORMATS) {
		const file = makeBLP(64, 32, { ...opts, seed: 11 });
		const a = open(BLPImage, file).toPNG(0b1111);
		const b = open(ReferenceBLP, file).toPNG(0b1111);
		assert.ok(Buffer.from(a.raw).equals(Buffer.from(b.raw)), opts.format);
	}
});

test('4-bit palette alpha: even pixels unchanged, odd pixels now read the high nibble', () => {
	const file = makeBLP(16, 4, { format: 'palette', alphaDepth: 4, seed: 5 });
	const ref = referenceDecode(file, 0, 0b1111, n => Buffer.alloc(n));
	const got = newDecode(file, 0, 0b1111, n => Buffer.alloc(n));

	const blp = open(BLPImage, file);
	blp._prepare(0);
	const pixels = 16 * 4;

	for (let i = 0; i < pixels; i++) {
		const p = i * 4;
		assert.deepEqual([...got.subarray(p, p + 3)], [...ref.subarray(p, p + 3)], `colour of pixel ${i}`);

		const byte = blp.rawData[pixels + (i >> 1)];
		if (i % 2 === 0) {
			assert.equal(got[p + 3], ref[p + 3], `even pixel ${i} alpha should be unchanged`);
			assert.equal(got[p + 3], (byte & 0x0F) << 4);
		} else {
			assert.equal(ref[p + 3], 0, 'the original decoder gave odd pixels alpha 0');
			assert.equal(got[p + 3], byte & 0xF0, `odd pixel ${i} alpha`);
		}
	}
});

test('truncated DXT data leaves missing blocks zeroed in toBuffer', () => {
	const file = makeBLP(16, 16, { format: 'dxt1', seed: 2 });
	// Claim the full mip size but cut the data short by half.
	const blp = open(BLPImage, file);
	blp._prepare(0);
	const half = blp.rawData.subarray(0, blp.rawData.length / 2);
	const out = blpDecode.decode(half, blp._decodeInfo(), 0b1111, Buffer.alloc(16 * 16 * 4));
	assert.ok(out.subarray(16 * 8 * 4).every(b => b === 0), 'bottom half should be untouched');
});

test('worker decode+encode is byte-identical to main-thread decode+encode', async () => {
	for (const opts of FORMATS) {
		const file = makeBLP(256, 128, { ...opts, seed: 21 });
		const blp = open(BLPImage, file);
		blp._prepare(0);

		for (const fast of [true, false]) {
			const worker = await workerPool.encodeBLP(blp.rawData, blp._decodeInfo(), 0b1111, fast);
			const main = pngEncode.encode(blp._toPNGWriter(0b1111).getPixelData(), 256, 128, fast);
			assert.ok(worker.equals(main), `${opts.format} fast=${fast}`);
		}
	}
});

test('saveToPNG writes the same file with and without workers', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowexport-blp-'));
	const file = makeBLP(256, 256, { format: 'dxt5', seed: 8 });

	const viaWorker = path.join(dir, 'worker.png');
	await open(BLPImage, file).saveToPNG(viaWorker);

	workerPool.setEnabled(false);
	const viaMain = path.join(dir, 'main.png');
	try {
		await open(BLPImage, file).saveToPNG(viaMain);
	} finally {
		workerPool.setEnabled(true);
	}

	const a = fs.readFileSync(viaWorker), b = fs.readFileSync(viaMain);
	assert.ok(a.equals(b));
	assert.equal(decodePNG(a).width, 256);

	// Same as the original implementation's output.
	const refPNG = Buffer.from(open(ReferenceBLP, file).toPNG().raw);
	assert.ok(a.equals(refPNG));
	fs.rmSync(dir, { recursive: true });
});
