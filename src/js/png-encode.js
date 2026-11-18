/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>
	License: MIT
 */

// Dependency-free PNG encoder. This file is loaded both by the main
// application and by export worker threads, so it must only depend on
// node built-ins.
const zlib = require('zlib');

const FILTERS = {
	// None
	0: (data, dataOfs, byteWidth, raw, rawOfs, bytesPerPixel) => {
		for (let x = 0; x < byteWidth; x++)
			raw[rawOfs + x] = data[dataOfs + x];
	},

	// Sub
	1: (data, dataOfs, byteWidth, raw, rawOfs, bytesPerPixel) => {
		for (let x = 0; x < byteWidth; x++) {
			let left = x >= bytesPerPixel ? data[dataOfs + x - bytesPerPixel] : 0;
			let value = data[dataOfs + x] - left;

			raw[rawOfs + x] = value;
		}
	},

	// Up
	2: (data, dataOfs, byteWidth, raw, rawOfs, bytesPerPixel) => {
		for (let x = 0; x < byteWidth; x++) {
			let up = dataOfs > 0 ? data[dataOfs + x - byteWidth] : 0;
			let value = data[dataOfs + x] - up;

			raw[rawOfs + x] = value;
		}
	},

	// Average
	3: (data, dataOfs, byteWidth, raw, rawOfs, bytesPerPixel) => {
		for (let x = 0; x < byteWidth; x++) {
			let left = x >= bytesPerPixel ? data[dataOfs + x - bytesPerPixel] : 0;
			let up = dataOfs > 0 ? data[dataOfs + x - byteWidth] : 0;
			let value = data[dataOfs + x] - ((left + up) >> 1);

			raw[rawOfs + x] = value;
		}
	},

	// Paeth
	4: (data, dataOfs, byteWidth, raw, rawOfs, bytesPerPixel) => {
		for (let x = 0; x < byteWidth; x++) {
			let left = x >= bytesPerPixel ? data[dataOfs + x - bytesPerPixel] : 0;
			let up = dataOfs > 0 ? data[dataOfs + x - byteWidth] : 0;
			let upLeft = dataOfs > 0 && x >= bytesPerPixel ? data[dataOfs + x - (byteWidth + bytesPerPixel)] : 0;
			let value = data[dataOfs + x] - paeth(left, up, upLeft);

			raw[rawOfs + x] = value;
		}
	}
};

const FILTER_SUMS = {
	// None
	0: (data, dataOfs, byteWidth, bytesPerPixel) => {
		let sum = 0;
		for (let i = dataOfs, len = dataOfs + byteWidth; i < len; i++)
			sum += Math.abs(data[i]);

		return sum;
	},

	// Sub
	1: (data, dataOfs, byteWidth, bytesPerPixel) => {
		let sum = 0;
		for (let x = 0; x < byteWidth; x++) {
			let left = x >= bytesPerPixel ? data[dataOfs + x - bytesPerPixel] : 0;
			let value = data[dataOfs + x] - left;

			sum += Math.abs(value);
		}

		return sum;
	},

	// Up
	2: (data, dataOfs, byteWidth, bytesPerPixel) => {
		let sum = 0;
		for (let x = dataOfs, len = dataOfs + byteWidth; x < len; x++) {
			let up = dataOfs > 0 ? data[x - byteWidth] : 0;
			let value = data[x] - up;

			sum += Math.abs(value);
		}

		return sum;
	},

	// Average
	3: (data, dataOfs, byteWidth, bytesPerPixel) => {
		let sum = 0;
		for (let x = 0; x < byteWidth; x++) {
			let left = x >= bytesPerPixel ? data[dataOfs + x - bytesPerPixel] : 0;
			let up = dataOfs > 0 ? data[dataOfs + x - byteWidth] : 0;
			let value = data[dataOfs + x] - ((left + up) >> 1);

			sum += Math.abs(value);
		}

		return sum;
	},

	// Paeth
	4: (data, dataOfs, byteWidth, bytesPerPixel) => {
		let sum = 0;
		for (let x = 0; x < byteWidth; x++) {
			let left = x >= bytesPerPixel ? data[dataOfs + x - bytesPerPixel] : 0;
			let up = dataOfs > 0 ? data[dataOfs + x - byteWidth] : 0;
			let upLeft = dataOfs > 0 && x >= bytesPerPixel ? data[dataOfs + x - (byteWidth + bytesPerPixel)] : 0;
			let value = data[dataOfs + x] - paeth(left, up, upLeft);

			sum += Math.abs(value);
		}

		return sum;
	}
};

const paeth = (left, up, upLeft) => {
	let paeth = left + up - upLeft;
	let paethLeft = Math.abs(paeth - left);
	let paethUp = Math.abs(paeth - up);
	let paethUpLeft = Math.abs(paeth - upLeft);

	if (paethLeft <= paethUp && paethLeft <= paethUpLeft)
		return left;

	if (paethUp <= paethUpLeft)
		return up;

	return upLeft;
};

/**
 * Apply adaptive filtering to image data.
 * @param {Buffer} data 
 * @param {number} width 
 * @param {number} height 
 * @param {number} bytesPerPixel
 * @returns {Buffer}
 */
const filter = (data, width, height, bytesPerPixel) => {
	let byteWidth = width * bytesPerPixel;
	let dataOfs = 0;

	let rawOfs = 0;
	let raw = Buffer.alloc((byteWidth + 1) * height);

	let selectedFilter = 0;
	for (let y = 0; y < height; y++) {
		let min = Infinity;

		for (let i = 0, len = Object.keys(FILTERS).length; i < len; i++) {
			let sum = FILTER_SUMS[i](data, dataOfs, byteWidth, bytesPerPixel);
			if (sum < min) {
				selectedFilter = i;
				min = sum;
			}
		}

		raw[rawOfs] = selectedFilter;
		rawOfs++;
	
		FILTERS[selectedFilter](data, dataOfs, byteWidth, raw, rawOfs, bytesPerPixel);
		rawOfs += byteWidth;
		dataOfs += byteWidth;
	}
	return raw;
};

/**
 * Apply the "Up" filter to every row. Far cheaper than adaptive filtering
 * and compresses nearly as well for typical texture data.
 * @param {Uint8Array} data
 * @param {number} width
 * @param {number} height
 * @param {number} bytesPerPixel
 * @returns {Buffer}
 */
const filterFast = (data, width, height, bytesPerPixel) => {
	const byteWidth = width * bytesPerPixel;
	const raw = Buffer.allocUnsafe((byteWidth + 1) * height);

	// The first row has no row above it, which is equivalent to no filtering.
	raw[0] = 0;
	for (let x = 0; x < byteWidth; x++)
		raw[1 + x] = data[x];

	let rawOfs = byteWidth + 1;
	let dataOfs = byteWidth;

	for (let y = 1; y < height; y++) {
		raw[rawOfs++] = 2;

		for (let x = 0; x < byteWidth; x++, dataOfs++)
			raw[rawOfs++] = data[dataOfs] - data[dataOfs - byteWidth];
	}

	return raw;
};

const CRC_TABLE = new Int32Array(256);
for (let i = 0; i < 256; i++) {
	let current = i;
	for (let j = 0; j < 8; j++)
		current = (current & 1) ? (0xEDB88320 ^ (current >>> 1)) : (current >>> 1);

	CRC_TABLE[i] = current;
}

const crc32 = (buf, start, end) => {
	let res = -1;
	for (let i = start; i < end; i++)
		res = CRC_TABLE[(res ^ buf[i]) & 0xFF] ^ (res >>> 8);

	return res ^ -1;
};

/**
 * Encode 8-bit RGBA pixel data as a PNG file.
 * @param {Uint8Array} data RGBA pixel data (width * height * 4 bytes).
 * @param {number} width
 * @param {number} height
 * @param {boolean} [fast=false] Use the fast filter and a low compression level.
 * @returns {Buffer}
 */
const encode = (data, width, height, fast = false) => {
	const bytesPerPixel = 4;

	let deflated;
	if (fast)
		// Run-length matching is much cheaper than full LZ77 and, on filtered
		// image data, compresses as well or better than a low deflate level.
		deflated = zlib.deflateSync(filterFast(data, width, height, bytesPerPixel), { level: 1, strategy: zlib.constants.Z_RLE });
	else
		deflated = zlib.deflateSync(filter(data, width, height, bytesPerPixel));

	const out = Buffer.allocUnsafe(8 + 25 + deflated.byteLength + 12 + 12);
	let ofs = 0;

	// 8-byte PNG signature.
	ofs = out.writeUInt32BE(0x89504E47, ofs);
	ofs = out.writeUInt32BE(0x0D0A1A0A, ofs);

	// IHDR
	ofs = out.writeUInt32BE(13, ofs);
	const ihdrStart = ofs;
	ofs = out.writeUInt32BE(0x49484452, ofs);
	ofs = out.writeUInt32BE(width, ofs);
	ofs = out.writeUInt32BE(height, ofs);
	ofs = out.writeUInt8(8, ofs); // Bit-depth
	ofs = out.writeUInt8(6, ofs); // Colour type (RGBA)
	ofs = out.writeUInt8(0, ofs); // Compression
	ofs = out.writeUInt8(0, ofs); // Filter
	ofs = out.writeUInt8(0, ofs); // Interlace
	ofs = out.writeInt32BE(crc32(out, ihdrStart, ofs), ofs);

	// IDAT
	ofs = out.writeUInt32BE(deflated.byteLength, ofs);
	const idatStart = ofs;
	ofs = out.writeUInt32BE(0x49444154, ofs);
	ofs += deflated.copy(out, ofs);
	ofs = out.writeInt32BE(crc32(out, idatStart, ofs), ofs);

	// IEND
	ofs = out.writeUInt32BE(0, ofs);
	ofs = out.writeUInt32BE(0x49454E44, ofs);
	out.writeUInt32BE(0xAE426082, ofs);

	return out;
};

module.exports = { encode };
