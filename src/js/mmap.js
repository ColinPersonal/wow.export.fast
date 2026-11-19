/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>
	License: MIT
 */
const path = require('path');
const log = require('./log');
const constants = require('./constants');

const fs = require('fs');

/**
 * Stand-in for the native add-on's MmapObject which reads the whole file into
 * memory. Used where the native add-on is not available (headless runs).
 */
class BufferedFileObject {
	constructor() {
		this.data = null;
		this.isMapped = false;
		this.lastError = '';
	}

	mapFile(file) {
		try {
			this.data = fs.readFileSync(file);
			this.isMapped = true;
			return true;
		} catch (e) {
			this.lastError = e.message;
			return false;
		}
	}

	unmap() {
		this.data = null;
		this.isMapped = false;
	}
}

let mmap_native;
try {
	mmap_native = require(path.join(constants.INSTALL_PATH, 'mmap.node'));
} catch (e) {
	// Only fall back when running outside the packaged application; inside
	// it, a missing add-on is a broken install and should fail loudly.
	if (!globalThis.WOW_EXPORT_HEADLESS)
		throw e;

	mmap_native = { MmapObject: BufferedFileObject };
}

const virtual_files = new Set();

/**
 * create memory-mapped file object and track it for cleanup.
 * @returns {object} mmap object
 */
const create_virtual_file = () => {
	const mmap_obj = new mmap_native.MmapObject();
	virtual_files.add(mmap_obj);
	return mmap_obj;
};

/**
 * release all tracked memory-mapped files.
 * swallows errors to ensure all files are attempted.
 */
const release_virtual_files = () => {
	try {
		for (const mmap_obj of virtual_files) {
			try {
				if (mmap_obj.isMapped)
					mmap_obj.unmap();
			} catch (e) {
				// swallow individual unmap errors
			}
		}

		const count = virtual_files.size;
		virtual_files.clear();
		log.write('released %d memory-mapped files', count);
	} catch (e) {
		log.write('error during virtual file cleanup: %s', e.message);
	}
};

module.exports = {
	create_virtual_file,
	release_virtual_files
};
