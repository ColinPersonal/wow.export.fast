/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Single access point for the WebP encoder. In the application the encoder is
// always present. Headless runs can work without installing dependencies, in
// which case WebP output is reported as unavailable when it is requested.
let webp;

try {
	webp = require('webp-wasm');
} catch (e) {
	if (!globalThis.WOW_EXPORT_HEADLESS)
		throw e;

	webp = {
		encode: async () => {
			throw new Error('WebP encoding is unavailable: the webp-wasm package is not installed (run "bun install")');
		}
	};
}

module.exports = webp;
