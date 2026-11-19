/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Export worker thread. Performs CPU-heavy, self-contained work for the main
// thread: PNG encoding, BLP decoding and BLTE (CASC) block
// verification/decompression.
// This file is shipped as-is in release builds (it is not bundled), so it may
// only depend on node built-ins and other files shipped alongside it.
const { parentPort } = require('worker_threads');
const zlib = require('zlib');
const crypto = require('crypto');
const pngEncode = require('../png-encode');
const blpDecode = require('../casc/blp-decode');

const BLTE_MAGIC = 0x45544c42;
const EMPTY_HASH = '00000000000000000000000000000000';

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

/**
 * Decode a BLTE container made only of plain and zlib-compressed blocks.
 * Returns null if the data needs handling this worker does not implement
 * (e.g. encrypted blocks) or fails verification; the main thread then decodes
 * it itself so that errors are raised from the usual code path.
 * @param {Buffer} buf
 * @param {string} hash Expected encoding key.
 * @returns {Buffer|null}
 */
const decodeBLTE = (buf, hash) => {
	const size = buf.length;
	if (size < 8 || buf.readUInt32LE(0) !== BLTE_MAGIC)
		return null;

	const headerSize = buf.readInt32BE(4);
	const hashCheck = headerSize > 0 ? md5(buf.subarray(0, headerSize)) : md5(buf);
	if (hashCheck !== hash)
		return null;

	let numBlocks = 1;
	let ofs = 8;

	if (headerSize > 0) {
		if (size < 12)
			return null;

		numBlocks = buf[9] << 16 | buf[10] << 8 | buf[11];
		if (buf[8] !== 0x0F || numBlocks === 0)
			return null;

		if (headerSize !== 24 * numBlocks + 12 || size < headerSize)
			return null;

		ofs = 12;
	}

	const blocks = new Array(numBlocks);
	for (let i = 0; i < numBlocks; i++) {
		if (headerSize !== 0) {
			blocks[i] = {
				compSize: buf.readInt32BE(ofs),
				hash: buf.toString('hex', ofs + 8, ofs + 24)
			};

			ofs += 24;
		} else {
			blocks[i] = { compSize: size - 8, hash: EMPTY_HASH };
		}
	}

	const parts = new Array(numBlocks);
	let total = 0;

	for (let i = 0; i < numBlocks; i++) {
		const block = blocks[i];
		const end = ofs + block.compSize;
		if (block.compSize < 1 || end > size)
			return null;

		if (block.hash !== EMPTY_HASH && md5(buf.subarray(ofs, end)) !== block.hash)
			return null;

		const flag = buf[ofs];
		let part;

		if (flag === 0x4E) // Plain
			part = buf.subarray(ofs + 1, end);
		else if (flag === 0x5A) // Compressed
			part = zlib.inflateSync(buf.subarray(ofs + 1, end));
		else // Encrypted, or something we don't handle here.
			return null;

		parts[i] = part;
		total += part.length;
		ofs = end;
	}

	// Assemble into a dedicated ArrayBuffer so it can be transferred back.
	const out = Buffer.from(new ArrayBuffer(total));
	let outOfs = 0;
	for (const part of parts) {
		part.copy(out, outOfs);
		outOfs += part.length;
	}

	return out;
};

parentPort.on('message', (msg) => {
	try {
		if (msg.type === 'png') {
			const encoded = pngEncode.encode(msg.pixels, msg.width, msg.height, msg.fast);

			// Copy into a dedicated ArrayBuffer (the encoder's buffer may be pooled).
			const out = new Uint8Array(encoded.length);
			out.set(encoded);

			parentPort.postMessage({ id: msg.id, ok: true, data: out }, [out.buffer]);
		} else if (msg.type === 'blp') {
			const { info } = msg;
			const pixels = Buffer.alloc(info.width * info.height * 4);
			blpDecode.decode(msg.raw, info, msg.mask, pixels);

			const encoded = pngEncode.encode(pixels, info.width, info.height, msg.fast);
			const out = new Uint8Array(encoded.length);
			out.set(encoded);

			parentPort.postMessage({ id: msg.id, ok: true, data: out }, [out.buffer]);
		} else if (msg.type === 'blte') {
			const raw = Buffer.from(msg.raw.buffer, msg.raw.byteOffset, msg.raw.byteLength);

			let decoded = null;
			try {
				decoded = decodeBLTE(raw, msg.hash);
			} catch (e) {
				decoded = null;
			}

			if (decoded !== null) {
				const view = new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
				parentPort.postMessage({ id: msg.id, ok: true, data: view }, [decoded.buffer]);
			} else {
				// Hand the input back so the main thread can decode it itself.
				parentPort.postMessage({ id: msg.id, ok: true, data: null, raw: msg.raw }, [msg.raw.buffer]);
			}
		} else {
			parentPort.postMessage({ id: msg.id, ok: false, error: 'unknown task type: ' + msg.type });
		}
	} catch (e) {
		parentPort.postMessage({ id: msg.id, ok: false, error: e.message });
	}
});
