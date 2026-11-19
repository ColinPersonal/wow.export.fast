/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>
	License: MIT
 */
const fs = require('fs');

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
	 * Write a line to the file.
	 * @param {string} line 
	 */
	async writeLine(line) {	
		if (this.blocked)
			await new Promise(resolve => this.resolver = resolve);
		
		const result = this.stream.write(line + '\n');
		if (!result) {
			this.blocked = true;
			this.stream.once('drain', () => this._drain());
		}
	}

	_drain() {
		this.blocked = false;
		this.resolver?.();
	}

	/**
	 * Finish writing. The returned promise resolves once everything written
	 * has been flushed to disk and the file is closed, so callers which need
	 * the file to be complete should await it. It never rejects.
	 * @returns {Promise<void>}
	 */
	close() {
		return new Promise(resolve => {
			this.stream.once('close', resolve);
			this.stream.once('error', resolve);
			this.stream.end();
		});
	}
}

module.exports = FileWriter;