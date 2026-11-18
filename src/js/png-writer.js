/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>
	License: MIT
 */
const BufferWrapper = require('./buffer');
const pngEncode = require('./png-encode');
const perf = require('./perf');
const workerPool = require('./worker-pool');

// Images smaller than this are encoded directly; a round-trip to a worker
// thread costs more than encoding them.
const WORKER_MIN_PIXELS = 128 * 128;

class PNGWriter {
	/**
	 * When enabled, PNG files are encoded several times faster at the
	 * cost of slightly larger files. Set from the user configuration.
	 * @type {boolean}
	 */
	static fastMode = true;

	/**
	 * Construct a new PNGWriter instance.
	 * @param {number} width
	 * @param {number} height
	 */
	constructor(width, height) {
		this.width = width;
		this.height = height;
		this.bytesPerPixel = 4;
		this.bitDepth = 8;
		this.colorType = 6; // RGBA
		this.data = Buffer.alloc(width * height * 4);
	}

	/**
	 * Get the internal pixel data for this PNG.
	 */
	getPixelData() {
		return this.data;
	}

	/**
	 * Encode this PNG synchronously on the calling thread.
	 * @returns {BufferWrapper}
	 */
	getBuffer() {
		const start = perf.now();
		const buf = new BufferWrapper(pngEncode.encode(this.data, this.width, this.height, PNGWriter.fastMode));
		perf.add('png.encode', perf.now() - start, buf.byteLength);

		return buf;
	}

	/**
	 * Encode this PNG, using a worker thread when one is available.
	 * @returns {Promise<BufferWrapper>}
	 */
	async getBufferAsync() {
		if (this.width * this.height >= WORKER_MIN_PIXELS && workerPool.isAvailable()) {
			const start = perf.now();
			try {
				const encoded = await workerPool.encodePNG(this.data, this.width, this.height, PNGWriter.fastMode);
				perf.add('png.encode (worker)', perf.now() - start, encoded.byteLength);

				return new BufferWrapper(encoded);
			} catch (e) {
				// Fall through to encoding on this thread.
			}
		}

		return this.getBuffer();
	}

	/**
	 * Write this PNG to a file.
	 * @param {string} file 
	 */
	async write(file) {
		const buf = await this.getBufferAsync();
		return await buf.writeToFile(file);
	}
}

module.exports = PNGWriter;
