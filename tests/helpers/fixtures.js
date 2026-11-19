/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Synthetic data shared by the tests and the benchmarks: texture-like RGBA
// images, BLTE containers and a minimal PNG decoder for round-trip checks.
const crypto = require('crypto');
const zlib = require('zlib');

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

/**
 * Deterministic PRNG (mulberry32) so fixtures are identical between runs.
 * @param {number} seed
 */
const rng = (seed) => () => {
	seed |= 0;
	seed = (seed + 0x6D2B79F5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * Build RGBA pixel data of a given kind.
 * - 'texture': smooth gradients with mild noise and an alpha mask, roughly
 *   what decoded BLP textures look like. Used as the realistic default.
 * - 'noise': random bytes; the worst case for compression.
 * - 'flat': a single colour; the best case.
 * @param {number} width
 * @param {number} height
 * @param {'texture'|'noise'|'flat'} [kind]
 * @param {number} [seed]
 * @returns {Buffer}
 */
const makeImage = (width, height, kind = 'texture', seed = 1) => {
	const data = Buffer.alloc(width * height * 4);
	const rand = rng(seed);

	if (kind === 'flat') {
		for (let i = 0; i < data.length; i += 4) {
			data[i] = 120; data[i + 1] = 80; data[i + 2] = 40; data[i + 3] = 255;
		}
		return data;
	}

	if (kind === 'noise') {
		for (let i = 0; i < data.length; i++)
			data[i] = (rand() * 256) | 0;
		return data;
	}

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			const n = (rand() * 12) | 0;
			data[i] = ((x * 255 / width) + n) & 0xFF;
			data[i + 1] = ((y * 255 / height) + n) & 0xFF;
			data[i + 2] = (((x + y) * 128 / (width + height)) + 64 + n) & 0xFF;
			data[i + 3] = ((x >> 4) + (y >> 4)) % 3 === 0 ? 0 : 255;
		}
	}

	return data;
};

/**
 * Build a BLTE container.
 * @param {Buffer} payload Decoded content.
 * @param {object} [opts]
 * @param {number} [opts.blocks=1] Number of blocks (0 = headerless single block).
 * @param {'plain'|'zlib'|'mixed'} [opts.mode='zlib'] Block encoding.
 * @param {boolean} [opts.blockHashes=true] Include per-block MD5s in the header.
 * @returns {{ data: Buffer, hash: string }} Container and its encoding key.
 */
const makeBLTE = (payload, opts = {}) => {
	const blocks = opts.blocks ?? 1;
	const mode = opts.mode ?? 'zlib';
	const blockHashes = opts.blockHashes ?? true;

	const encodeBlock = (chunk, i) => {
		const compress = mode === 'zlib' || (mode === 'mixed' && i % 2 === 0);
		return compress
			? Buffer.concat([Buffer.from([0x5A]), zlib.deflateSync(chunk)])
			: Buffer.concat([Buffer.from([0x4E]), chunk]);
	};

	if (blocks === 0) {
		const body = encodeBlock(payload, 0);
		const header = Buffer.alloc(8);
		header.writeUInt32LE(0x45544c42, 0);
		header.writeInt32BE(0, 4);

		const data = Buffer.concat([header, body]);
		return { data, hash: md5(data) };
	}

	const chunkSize = Math.ceil(payload.length / blocks);
	const encoded = [];
	const decodedSizes = [];
	for (let i = 0; i < blocks; i++) {
		const chunk = payload.subarray(i * chunkSize, Math.min(payload.length, (i + 1) * chunkSize));
		decodedSizes.push(chunk.length);
		encoded.push(encodeBlock(chunk, i));
	}

	const headerSize = 12 + 24 * blocks;
	const header = Buffer.alloc(headerSize);
	header.writeUInt32LE(0x45544c42, 0);
	header.writeInt32BE(headerSize, 4);
	header[8] = 0x0F;
	header[9] = (blocks >> 16) & 0xFF;
	header[10] = (blocks >> 8) & 0xFF;
	header[11] = blocks & 0xFF;

	let ofs = 12;
	for (let i = 0; i < blocks; i++) {
		header.writeInt32BE(encoded[i].length, ofs);
		header.writeInt32BE(decodedSizes[i], ofs + 4);
		if (blockHashes)
			Buffer.from(md5(encoded[i]), 'hex').copy(header, ofs + 8);
		ofs += 24;
	}

	const data = Buffer.concat([header, ...encoded]);
	return { data, hash: md5(header) };
};

/**
 * Copy a buffer into its own ArrayBuffer (like data read from a file),
 * so the worker pool can transfer it.
 * @param {Buffer} buf
 */
const ownedCopy = (buf) => {
	const out = Buffer.from(new ArrayBuffer(buf.length));
	buf.copy(out);
	return out;
};

/**
 * Decode an 8-bit RGBA, non-interlaced PNG and validate its chunk CRCs.
 * Only supports what png-encode produces, which is all the tests need.
 * @param {Buffer} png
 * @returns {{ width: number, height: number, pixels: Buffer, filters: number[] }}
 */
const decodePNG = (png) => {
	const SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
	if (!png.subarray(0, 8).equals(SIGNATURE))
		throw new Error('bad PNG signature');

	let ofs = 8;
	let width = 0, height = 0;
	const idat = [];
	let sawEnd = false;

	while (ofs < png.length) {
		const length = png.readUInt32BE(ofs);
		const type = png.toString('latin1', ofs + 4, ofs + 8);
		const body = png.subarray(ofs + 8, ofs + 8 + length);
		const crc = png.readUInt32BE(ofs + 8 + length);
		const expected = zlib.crc32(png.subarray(ofs + 4, ofs + 8 + length));
		if (crc !== expected)
			throw new Error(`bad CRC on ${type} chunk`);

		if (type === 'IHDR') {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0)
				throw new Error('unsupported PNG format');
		} else if (type === 'IDAT') {
			idat.push(body);
		} else if (type === 'IEND') {
			sawEnd = true;
		}

		ofs += 12 + length;
	}

	if (!sawEnd)
		throw new Error('missing IEND');

	const raw = zlib.inflateSync(Buffer.concat(idat));
	const bpp = 4;
	const stride = width * bpp;
	const pixels = Buffer.alloc(stride * height);
	const filters = [];

	for (let y = 0; y < height; y++) {
		const f = raw[y * (stride + 1)];
		filters.push(f);
		const src = y * (stride + 1) + 1;
		const dst = y * stride;

		for (let x = 0; x < stride; x++) {
			const a = x >= bpp ? pixels[dst + x - bpp] : 0;
			const b = y > 0 ? pixels[dst + x - stride] : 0;
			const c = y > 0 && x >= bpp ? pixels[dst + x - stride - bpp] : 0;
			let v = raw[src + x];

			if (f === 1) v += a;
			else if (f === 2) v += b;
			else if (f === 3) v += (a + b) >> 1;
			else if (f === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
				v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
			} else if (f !== 0) {
				throw new Error('unknown filter ' + f);
			}

			pixels[dst + x] = v & 0xFF;
		}
	}

	return { width, height, pixels, filters };
};

module.exports = { md5, rng, makeImage, makeBLTE, ownedCopy, decodePNG };
