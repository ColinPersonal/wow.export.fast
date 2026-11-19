/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>
	License: MIT
 */
const fs = require('fs');
const { finished } = require('stream/promises');

class FileWriter {
	/**
	 * Construct a new FileWriter instance.
	 * @param {string} file 
	 * @param {string} encoding 
	 */
	constructor(file, encoding = 'utf8') {
		try {
			this.stream = fs.createWriteStream(file, { flags: 'w', encoding });
		} catch (e) {
			if (e.code === 'EISDIR') {
				fs.rmSync(file, { recursive: true });
				this.stream = fs.createWriteStream(file, { flags: 'w', encoding });
			} else {
				throw e;
			}
		}

		this.blocked = false;
		this.resolver = null;
	}

	/**
	 * Write text to the file, waiting if the stream is backed up.
	 * @param {string} text
	 */
	async write(text) {
		if (this.blocked)
			await new Promise(resolve => this.resolver = resolve);

		const result = this.stream.write(text);
		if (!result) {
			this.blocked = true;
			this.stream.once('drain', () => this._drain());
		}
	}

	/**
	 * Write a line to the file.
	 * For many lines, prefer a LineBuffer: one write per line is slow.
	 * @param {string} line
	 */
	async writeLine(line) {
		return this.write(line + '\n');
	}

	_drain() {
		this.blocked = false;
		this.resolver?.();
	}

	/**
	 * Close the file. The returned promise resolves once everything has been
	 * flushed to disk (and rejects if writing failed); callers that do not
	 * need to wait may ignore it.
	 * @returns {Promise<void>}
	 */
	close() {
		this.stream.end();

		const done = finished(this.stream);
		done.catch(() => {}); // avoid unhandled rejections for callers that don't wait
		return done;
	}
}

/**
 * Collects lines in memory and writes them to a FileWriter in large chunks.
 * Usage: `if (lines.push(text)) await lines.flush();` then a final
 * `await lines.flush()`. Output is identical to calling writeLine() per line.
 */
class LineBuffer {
	/**
	 * @param {FileWriter} writer
	 * @param {number} [limit] Approximate characters to collect before a flush.
	 */
	constructor(writer, limit = 1 << 20) {
		this.writer = writer;
		this.limit = limit;
		this.lines = [];
		this.size = 0;
	}

	/**
	 * Add a line.
	 * @param {string} line
	 * @returns {boolean} True when the buffer is full and should be flushed.
	 */
	push(line) {
		this.lines.push(line);
		this.size += line.length + 1;
		return this.size >= this.limit;
	}

	/**
	 * Write out everything collected so far.
	 */
	async flush() {
		if (this.lines.length === 0)
			return;

		const text = this.lines.join('\n') + '\n';
		this.lines = [];
		this.size = 0;
		await this.writer.write(text);
	}
}

module.exports = FileWriter;
module.exports.LineBuffer = LineBuffer;