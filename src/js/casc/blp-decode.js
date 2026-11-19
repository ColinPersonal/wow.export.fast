/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>
	License: MIT
 */

// Dependency-free BLP pixel decoding. This file is loaded both by the main
// application (casc/blp.js) and by export worker threads, so it must not
// require anything.

const DXT1 = 0x1;
const DXT3 = 0x2;
const DXT5 = 0x4;

const ENCODING_PALETTE = 1;
const ENCODING_DXT = 2;
const ENCODING_BGRA = 3;

/**
 * Get the DXT variant flags for a BLP.
 * @param {number} alphaDepth
 * @param {number} alphaEncoding
 * @returns {number}
 */
const dxtFlags = (alphaDepth, alphaEncoding) => alphaDepth > 1 ? (alphaEncoding === 7 ? DXT5 : DXT3) : DXT1;

/**
 * Decode DXT1/3/5 compressed data into RGBA.
 * Values for interpolated colours are left fractional, exactly as the original
 * implementation did: a Buffer/Uint8Array target truncates them, while a
 * canvas Uint8ClampedArray rounds them.
 * @param {Uint8Array} raw Compressed mipmap data.
 * @param {number} width
 * @param {number} height
 * @param {number} flags DXT1, DXT3 or DXT5.
 * @param {number} mask Channel mask (RGBA bits).
 * @param {Uint8Array|Uint8ClampedArray} out RGBA target (width * height * 4).
 */
const decodeDXT = (raw, width, height, flags, mask, out) => {
	const isDXT1 = (flags & DXT1) !== 0;
	const isDXT3 = (flags & DXT3) !== 0;
	const isDXT5 = (flags & DXT5) !== 0;
	const blockBytes = isDXT1 ? 8 : 16;

	const col = new Float64Array(16); // 4 colours x RGBA
	const alpha = new Int32Array(8);

	const mR = (mask & 0b1) !== 0;
	const mG = (mask & 0b10) !== 0;
	const mB = (mask & 0b100) !== 0;
	const mA = (mask & 0b1000) !== 0;

	const n = raw.length;
	let pos = 0;

	for (let y = 0; y < height; y += 4) {
		for (let x = 0; x < width; x += 4) {
			if (pos === n)
				continue;

			const ci = isDXT1 ? pos : pos + 8;
			const a = raw[ci] | (raw[ci + 1] << 8);
			const b = raw[ci + 2] | (raw[ci + 3] << 8);

			const r0 = (a >> 11) & 0x1F, g0 = (a >> 5) & 0x3F, b0 = a & 0x1F;
			const r1 = (b >> 11) & 0x1F, g1 = (b >> 5) & 0x3F, b1 = b & 0x1F;

			col[0] = (r0 << 3) | (r0 >> 2);
			col[1] = (g0 << 2) | (g0 >> 4);
			col[2] = (b0 << 3) | (b0 >> 2);
			col[3] = 255;
			col[4] = (r1 << 3) | (r1 >> 2);
			col[5] = (g1 << 2) | (g1 >> 4);
			col[6] = (b1 << 3) | (b1 >> 2);
			col[7] = 255;

			const threeColour = isDXT1 && a <= b;
			for (let i = 0; i < 3; i++) {
				const c = col[i];
				const d = col[i + 4];

				if (threeColour) {
					col[i + 8] = (c + d) / 2;
					col[i + 12] = 0;
				} else {
					col[i + 8] = (2 * c + d) / 3;
					col[i + 12] = (c + 2 * d) / 3;
				}
			}

			col[11] = 255;
			col[15] = threeColour ? 0 : 255;

			let alphaLo = 0, alphaHi = 0;
			if (isDXT5) {
				const a0 = raw[pos];
				const a1 = raw[pos + 1];
				alpha[0] = a0;
				alpha[1] = a1;

				if (a0 <= a1) {
					for (let i = 1; i < 5; i++)
						alpha[i + 1] = (((5 - i) * a0 + i * a1) / 5) | 0;

					alpha[6] = 0;
					alpha[7] = 255;
				} else {
					for (let i = 1; i < 7; i++)
						alpha[i + 1] = (((7 - i) * a0 + i * a1) / 7) | 0;
				}

				// 48 bits of 3-bit indices, read as two 24-bit halves.
				alphaLo = raw[pos + 2] | (raw[pos + 3] << 8) | (raw[pos + 4] << 16);
				alphaHi = raw[pos + 5] | (raw[pos + 6] << 8) | (raw[pos + 7] << 16);
			}

			for (let i = 0; i < 16; i++) {
				const pX = i & 3;
				const pY = i >> 2;
				const sX = x + pX;
				const sY = y + pY;

				if (sX >= width || sY >= height)
					continue;

				const o = ((raw[ci + 4 + pY] >> (pX << 1)) & 0x3) << 2;

				let av;
				if (isDXT3) {
					const quant = raw[pos + (i >> 1)];
					if ((i & 1) === 0) {
						const low = quant & 0x0F;
						av = low | (low << 4);
					} else {
						const high = quant & 0xF0;
						av = high | (high >> 4);
					}
				} else if (isDXT5) {
					av = alpha[i < 8 ? (alphaLo >> (3 * i)) & 0x7 : (alphaHi >> (3 * (i - 8))) & 0x7];
				} else {
					av = col[o + 3];
				}

				const p = (width * sY + sX) << 2;
				out[p] = mR ? col[o] : 0;
				out[p + 1] = mG ? col[o + 1] : 0;
				out[p + 2] = mB ? col[o + 2] : 0;
				out[p + 3] = mA ? av : 255;
			}

			pos += blockBytes;
		}
	}

	return out;
};

/**
 * Read a palettised pixel's alpha.
 * @param {Uint8Array} raw
 * @param {number} pixels Number of pixels (alpha data follows the indices).
 * @param {number} alphaDepth
 * @param {number} index
 * @returns {number}
 */
const paletteAlpha = (raw, pixels, alphaDepth, index) => {
	switch (alphaDepth) {
		case 1:
			return (raw[pixels + (index >> 3)] & (0x01 << (index & 7))) === 0 ? 0x00 : 0xFF;

		case 4: {
			// Two pixels per byte: even pixels use the low nibble, odd the high.
			const byte = raw[pixels + (index >> 1)];
			return (index & 1) === 0 ? (byte & 0x0F) << 4 : byte & 0xF0;
		}

		case 8:
			return raw[pixels + index];

		default:
			return 0xFF;
	}
};

/**
 * Decode palettised data into RGBA.
 * @param {Uint8Array} raw
 * @param {number} pixels width * height.
 * @param {Uint8Array} palette 256 BGRA entries (1024 bytes).
 * @param {number} alphaDepth
 * @param {number} mask
 * @param {Uint8Array|Uint8ClampedArray} out
 */
const decodePalette = (raw, pixels, palette, alphaDepth, mask, out) => {
	const mR = (mask & 0b1) !== 0;
	const mG = (mask & 0b10) !== 0;
	const mB = (mask & 0b100) !== 0;
	const mA = (mask & 0b1000) !== 0;

	for (let i = 0; i < pixels; i++) {
		const ofs = i << 2;
		const c = raw[i] << 2;

		out[ofs] = mR ? palette[c + 2] : 0;
		out[ofs + 1] = mG ? palette[c + 1] : 0;
		out[ofs + 2] = mB ? palette[c] : 0;
		out[ofs + 3] = mA ? paletteAlpha(raw, pixels, alphaDepth, i) : 255;
	}

	return out;
};

/**
 * Convert BGRA data into RGBA.
 * @param {Uint8Array} raw
 * @param {number} mask
 * @param {Uint8Array|Uint8ClampedArray} out
 */
const decodeBGRA = (raw, mask, out) => {
	const mR = (mask & 0b1) !== 0;
	const mG = (mask & 0b10) !== 0;
	const mB = (mask & 0b100) !== 0;
	const mA = (mask & 0b1000) !== 0;

	const n = Math.min(raw.length, out.length) & ~3;
	for (let ofs = 0; ofs < n; ofs += 4) {
		out[ofs] = mR ? raw[ofs + 2] : 0;
		out[ofs + 1] = mG ? raw[ofs + 1] : 0;
		out[ofs + 2] = mB ? raw[ofs] : 0;
		out[ofs + 3] = mA ? raw[ofs + 3] : 255;
	}

	return out;
};

/**
 * Decode a BLP mipmap into RGBA.
 * @param {Uint8Array} raw Raw mipmap data.
 * @param {object} info
 * @param {number} info.encoding 1 = palette, 2 = DXT, 3 = BGRA.
 * @param {number} info.alphaDepth
 * @param {number} info.alphaEncoding
 * @param {number} info.width Mipmap width.
 * @param {number} info.height Mipmap height.
 * @param {Uint8Array} [info.palette] 1024-byte BGRA palette for encoding 1.
 * @param {number} mask Channel mask (RGBA bits).
 * @param {Uint8Array|Uint8ClampedArray} out RGBA target (width * height * 4).
 */
const decode = (raw, info, mask, out) => {
	switch (info.encoding) {
		case ENCODING_PALETTE:
			return decodePalette(raw, info.width * info.height, info.palette, info.alphaDepth, mask, out);

		case ENCODING_DXT:
			return decodeDXT(raw, info.width, info.height, dxtFlags(info.alphaDepth, info.alphaEncoding), mask, out);

		case ENCODING_BGRA:
			return decodeBGRA(raw, mask, out);
	}

	return out;
};

module.exports = { decode, decodeDXT, decodePalette, decodeBGRA, paletteAlpha, dxtFlags, DXT1, DXT3, DXT5 };
