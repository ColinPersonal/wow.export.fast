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

test('fast mode output stays within 2x the adaptive size', () => {
	// A regression guard, not a target: `npm run bench` reports the actual
	// size ratio. On the synthetic texture fixture fast mode is ~1.7x larger.
	for (const kind of ['texture', 'noise', 'flat']) {
		const pixels = makeImage(512, 512, kind);
		const adaptive = pngEncode.encode(pixels, 512, 512, false).length;
		const fast = pngEncode.encode(pixels, 512, 512, true).length;
		assert.ok(fast <= adaptive * 2, `${kind}: fast ${fast} bytes vs adaptive ${adaptive} bytes`);
	}
});
