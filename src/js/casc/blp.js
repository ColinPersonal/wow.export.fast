/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>
	License: MIT
 */
const BufferWrapper = require('../buffer');
const PNGWriter = require('../png-writer');
const perf = require('../perf');
const workerPool = require('../worker-pool');
const blpDecode = require('./blp-decode');
const webp = require('webp-wasm');

const BLP_MAGIC = 0x32504c42;

// Textures smaller than this are decoded and encoded on the calling thread;
// a round-trip to a worker costs more than the work itself.
const WORKER_MIN_PIXELS = 128 * 128;

class BLPImage {
	/**
	 * Construct a new BLPImage instance.
	 * @param {BufferWrapper}
	 */
	constructor(data) {
		this.data = data;

		// Check magic value..
		if (this.data.readUInt32LE() !== BLP_MAGIC)
			throw new Error('Provided data is not a BLP file (invalid header magic).');

		// Check the BLP file type..
		let type = this.data.readUInt32LE();
		if (type !== 1)
			throw new Error('Unsupported BLP type: ' + type);

		// Read file flags..
		this.encoding = this.data.readUInt8();
		this.alphaDepth = this.data.readUInt8();
		this.alphaEncoding = this.data.readUInt8();
		this.containsMipmaps = this.data.readUInt8();

		// Read file dimensions..
		this.width = this.data.readUInt32LE();
		this.height = this.data.readUInt32LE();

		// Read mipmap data..
		this.mapOffsets = this.data.readUInt32LE(16);
		this.mapSizes = this.data.readUInt32LE(16);

		// Calculate available mipmaps..
		this.mapCount = 0;
		for (let ofs of this.mapOffsets) {
			if (ofs !== 0)
				this.mapCount++;
		}

		// Read colour palette..
		this.palette = [];
		this.paletteBGRA = null;
		if (this.encoding === 1) {
			for (let i = 0; i < 256; i++)
				this.palette[i] = this.data.readUInt8(4);

			this.paletteBGRA = Uint8Array.from(this.palette.flat());
		}

		this.dataURL = null;
	}

	/**
	 * Encode this image as a data URL and return it.
	 * @param {number} mask
	 * @param {number} mipmap
	 * @returns {string}
	 */
	getDataURL(mask = 0b1111, mipmap = 0) {
		return this.toCanvas(mask, mipmap).toDataURL();
	}

	/**
	 * Return a canvas with this BLP painted onto it.
	 * @param {number} mask
	 * @param {number} mipmap
	 */
	toCanvas(mask = 0b1111, mipmap = 0) {
		const canvas = document.createElement('canvas');

		if (mipmap == 0) {
			canvas.width = this.width;
			canvas.height = this.height;
		} else {
			const scale = Math.pow(2, mipmap);
			canvas.width = this.width / scale;
			canvas.height = this.height / scale;
		}

		this.drawToCanvas(canvas, mipmap, mask);
		return canvas;
	}

	/**
	 * Retrieve this BLP as a PNG image.
	 * @param {number} mask 
	 * @param {number} mipmap 
	 * @returns {BufferWrapper}
	 */
	toPNG(mask = 0b1111, mipmap = 0) {
		return this._toPNGWriter(mask, mipmap).getBuffer();
	}

	/**
	 * Decode this BLP into a PNGWriter ready for encoding.
	 * @param {number} mask
	 * @param {number} mipmap
	 * @returns {PNGWriter}
	 */
	_toPNGWriter(mask = 0b1111, mipmap = 0) {
		const start = perf.now();
		this._prepare(mipmap);

		const png = new PNGWriter(this.scaledWidth, this.scaledHeight);
		this._decodeInto(png.getPixelData(), mask);

		perf.add('blp.decode', perf.now() - start);
		return png;
	}

	/**
	 * Save this BLP as PNG file.
	 * Large textures are decoded and encoded together on a worker thread when
	 * one is available, so only the compressed data crosses threads.
	 * @param {string} file
	 * @param {number} mask
	 * @param {number} mipmap
	 */
	async saveToPNG(file, mask = 0b1111, mipmap = 0) {
		this._prepare(mipmap);

		if (this.scaledLength >= WORKER_MIN_PIXELS && workerPool.isAvailable()) {
			const start = perf.now();
			try {
				const encoded = await workerPool.encodeBLP(this.rawData, this._decodeInfo(), mask, PNGWriter.fastMode);
				perf.add('blp.decode+encode (worker)', perf.now() - start, encoded.byteLength);
				return await new BufferWrapper(encoded).writeToFile(file);
			} catch (e) {
				// Fall through to decoding on this thread.
			}
		}

		return await this._toPNGWriter(mask, mipmap).write(file);
	}

	/**
	 * Convert this BLP to WebP format.
	 * @param {number} mask
	 * @param {number} mipmap
	 * @param {number} quality - Quality setting (1-100), 100 = lossless
	 * @returns {Promise<Buffer>}
	 */
	async toWebP(mask = 0b1111, mipmap = 0, quality = 90) {
		this._prepare(mipmap);

		// Create RGBA pixel data buffer
		const pixelData = Buffer.alloc(this.scaledWidth * this.scaledHeight * 4);
		this._decodeInto(pixelData, mask);

		const imgData = {
			data: pixelData,
			width: this.scaledWidth,
			height: this.scaledHeight
		};

		const options = quality === 100
			? { lossless: true }
			: { quality: quality, lossless: false };

		const webpBuffer = await webp.encode(imgData, options);

		return webpBuffer;
	}

	/**
	 * Save this BLP as WebP file.
	 * @param {string} file
	 * @param {number} mask
	 * @param {number} mipmap
	 * @param {number} quality - Quality setting (1-100), 100 = lossless
	 */
	async saveToWebP(file, mask = 0b1111, mipmap = 0, quality = 90) {
		const webpBuffer = await this.toWebP(mask, mipmap, quality);
		await new BufferWrapper(webpBuffer).writeToFile(file);
	}

	/**
	 * Prepare BLP for processing.
	 * @param {number} mipmap 
	 */
	_prepare(mipmap = 0) {
		// Constrict the requested mipmap to a valid range..
		mipmap = Math.max(0, Math.min(mipmap || 0, this.mapCount - 1));

		// Calculate the scaled dimensions..
		this.scale = Math.pow(2, mipmap);
		this.scaledWidth = Math.max(1, Math.floor(this.width / this.scale));
		this.scaledHeight = Math.max(1, Math.floor(this.height / this.scale));
		this.scaledLength = this.scaledWidth * this.scaledHeight;

		// Extract the raw data we need..
		this.data.seek(this.mapOffsets[mipmap]);
		this.rawData = this.data.readBuffer(this.mapSizes[mipmap], false);
	}

	/**
	 * Describe the prepared mipmap for blp-decode.
	 * @returns {object}
	 */
	_decodeInfo() {
		return {
			encoding: this.encoding,
			alphaDepth: this.alphaDepth,
			alphaEncoding: this.alphaEncoding,
			width: this.scaledWidth,
			height: this.scaledHeight,
			palette: this.paletteBGRA
		};
	}

	/**
	 * Decode the prepared mipmap into an RGBA target.
	 * @param {Uint8Array|Uint8ClampedArray} out
	 * @param {number} mask
	 */
	_decodeInto(out, mask) {
		return blpDecode.decode(this.rawData, this._decodeInfo(), mask, out);
	}

	/**
	 * Draw the contents of this BLP file onto a canvas.
	 * @param {HTMLElement} canvas 
	 * @param {number} mipmap 
	 * @param {number} mask
	 */
	drawToCanvas(canvas, mipmap = 0, mask = 0b1111) {
		this._prepare(mipmap);

		const ctx = canvas.getContext('2d');
		const canvasData = ctx.createImageData(this.scaledWidth, this.scaledHeight);

		this._decodeInto(canvasData.data, mask);

		ctx.putImageData(canvasData, 0, 0);
	}

	/**
	 * Get the contents of this BLP as a BufferWrapper instance.
	 * @param {number} mipmap 
	 * @param {number} mask 
	 * @returns {BufferWrapper}
	 */
	toBuffer(mipmap = 0, mask = 0b1111) {
		this._prepare(mipmap);

		// Zeroed, as truncated DXT data leaves trailing blocks unwritten.
		const out = BufferWrapper.alloc(this.scaledLength * 4, true);
		this._decodeInto(out.raw, mask);
		out.seek(0);
		return out;
	}

	/**
	 * Get the contents of this raw BLP mipmap as a Buffer instance.
	 * @param {number} mipmap 
	 * @param {number} mask 
	 * @returns {Buffer}
	 */
	getRawMipmap(mipmap = 0) {
		this._prepare(mipmap);
		return Buffer.from(this.rawData);
	}

	/**
	 * Get all raw mipmap levels for GPU compressed upload.
	 * @returns {Array<{data: Uint8Array, width: number, height: number}>}
	 */
	get_raw_mipmaps() {
		const mipmaps = [];
		for (let i = 0; i < this.mapCount; i++) {
			this._prepare(i);
			mipmaps.push({
				data: new Uint8Array(this.rawData),
				width: this.scaledWidth,
				height: this.scaledHeight
			});
		}
		return mipmaps;
	}

	/**
	 * Get the contents of this BLP as an RGBA UInt8 array.
	 * @param {number} mipmap 
	 * @param {number} mask
	 */
	toUInt8Array(mipmap = 0, mask = 0b1111) {
		this._prepare(mipmap);

		const arr = new Uint8Array(this.scaledWidth * this.scaledHeight * 4);
		return this._decodeInto(arr, mask);
	}
	
}

module.exports = BLPImage;