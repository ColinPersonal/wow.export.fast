const { test } = require('node:test');
const assert = require('node:assert/strict');
const pngEncode = require('../src/js/png-encode');
const { makeImage, decodePNG } = require('./helpers/fixtures');

const SIZES = [[1, 1], [2, 3], [7, 5], [64, 64], [127, 33], [256, 256]];
const KINDS = ['texture', 'noise', 'flat'];

for (const fast of [false, true]) {
	const mode = fast ? 'fast' : 'adaptive';

	for (const [w, h] of SIZES) {
		for (const kind of KINDS) {
			test(`${mode} encode round-trips ${kind} ${w}x${h}`, () => {
				const pixels = makeImage(w, h, kind, w * 31 + h);
				const png = pngEncode.encode(pixels, w, h, fast);
				const out = decodePNG(png);

				assert.equal(out.width, w);
				assert.equal(out.height, h);
				assert.ok(out.pixels.equals(pixels), 'decoded pixels differ from input');
			});
		}
	}
}

test('fast mode uses no filter on the first row and Up on the rest', () => {
	const png = pngEncode.encode(makeImage(16, 8), 16, 8, true);
	const { filters } = decodePNG(png);
	assert.deepEqual(filters, [0, 2, 2, 2, 2, 2, 2, 2]);
});

test('adaptive mode only uses valid filter types', () => {
	const png = pngEncode.encode(makeImage(64, 64, 'texture'), 64, 64, false);
	const { filters } = decodePNG(png);
	assert.ok(filters.every(f => f >= 0 && f <= 4));
});

test('encode accepts a Uint8Array as well as a Buffer', () => {
	const pixels = makeImage(32, 32);
	const a = pngEncode.encode(pixels, 32, 32, true);
	const b = pngEncode.encode(new Uint8Array(pixels), 32, 32, true);
	assert.ok(a.equals(b));
});

test('encode is deterministic', () => {
	const pixels = makeImage(128, 128);
	for (const fast of [false, true])
		assert.ok(pngEncode.encode(pixels, 128, 128, fast).equals(pngEncode.encode(pixels, 128, 128, fast)));
});

test('fast mode output stays within 1.3x the adaptive size', () => {
	// A regression guard, not a target: `npm run bench` reports the actual
	// size ratio. On the synthetic texture fixture fast mode is ~1.04x larger.
	for (const kind of ['texture', 'noise']) {
		const pixels = makeImage(512, 512, kind);
		const adaptive = pngEncode.encode(pixels, 512, 512, false).length;
		const fast = pngEncode.encode(pixels, 512, 512, true).length;
		assert.ok(fast <= adaptive * 1.3, `${kind}: fast ${fast} bytes vs adaptive ${adaptive} bytes`);
	}

	// A flat image compresses to almost nothing either way (2 KB vs 6 KB), so
	// only check it stays small.
	const flat = pngEncode.encode(makeImage(512, 512, 'flat'), 512, 512, true).length;
	assert.ok(flat < 16384, `flat: ${flat} bytes`);
});

// --- other pixel formats (heightmaps) ----------------------------------------

const zlibNode = require('zlib');

/** Decode a non-interlaced PNG of any byte-aligned format to its raw bytes. */
const decodeRaw = (png) => {
	let ofs = 8, ihdr = null;
	const idat = [];
	while (ofs < png.length) {
		const length = png.readUInt32BE(ofs);
		const type = png.toString('latin1', ofs + 4, ofs + 8);
		const body = png.subarray(ofs + 8, ofs + 8 + length);
		if (type === 'IHDR')
			ihdr = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), bitDepth: body[8], colorType: body[9] };
		else if (type === 'IDAT')
			idat.push(body);
		ofs += 12 + length;
	}

	const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType] * ihdr.bitDepth / 8;
	const stride = ihdr.width * bpp;
	const raw = zlibNode.inflateSync(Buffer.concat(idat));
	const out = Buffer.alloc(stride * ihdr.height);

	for (let y = 0; y < ihdr.height; y++) {
		const filterType = raw[y * (stride + 1)];
		for (let x = 0; x < stride; x++) {
			const v = raw[y * (stride + 1) + 1 + x];
			const a = x >= bpp ? out[y * stride + x - bpp] : 0;
			const b = y > 0 ? out[(y - 1) * stride + x] : 0;
			const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
			let p;
			switch (filterType) {
				case 0: p = 0; break;
				case 1: p = a; break;
				case 2: p = b; break;
				case 3: p = (a + b) >> 1; break;
				case 4: { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; break; }
				default: throw new Error('bad filter ' + filterType);
			}
			out[y * stride + x] = (v + p) & 0xFF;
		}
	}

	return { ihdr, pixels: out };
};

for (const fast of [false, true]) {
	for (const [bytesPerPixel, bitDepth] of [[1, 8], [2, 16]]) {
		test(`${fast ? 'fast' : 'adaptive'} encode writes ${bitDepth}-bit greyscale (heightmaps)`, () => {
			const w = 37, h = 19;
			// PNGWriter allocates 4 bytes per pixel whatever the format; only the start is used.
			const data = Buffer.alloc(w * h * 4, 0xEE);
			for (let i = 0; i < w * h * bytesPerPixel; i++)
				data[i] = (i * 7 + (i >> 3)) & 0xFF;

			const png = pngEncode.encode(data, w, h, fast, { bytesPerPixel, bitDepth, colorType: 0 });
			const { ihdr, pixels } = decodeRaw(png);

			assert.deepEqual(ihdr, { width: w, height: h, bitDepth, colorType: 0 });
			assert.ok(pixels.equals(data.subarray(0, w * h * bytesPerPixel)), 'greyscale pixels differ');
		});
	}
}

test('PNGWriter honours bitDepth and colorType set by heightmap export', () => {
	const PNGWriter = require('../src/js/png-writer');
	const writer = new PNGWriter(4, 2);
	writer.bytesPerPixel = 2;
	writer.bitDepth = 16;
	writer.colorType = 0;
	writer.getPixelData().fill(0x12, 0, 16);

	const { ihdr, pixels } = decodeRaw(writer.getBuffer().raw);
	assert.equal(ihdr.bitDepth, 16);
	assert.equal(ihdr.colorType, 0);
	assert.ok(pixels.equals(Buffer.alloc(16, 0x12)));

	// The default stays 8-bit RGBA.
	const rgba = new PNGWriter(2, 2);
	assert.equal(decodePNG(rgba.getBuffer().raw).width, 2);
});
