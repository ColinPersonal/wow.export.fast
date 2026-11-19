/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Minimal stand-in for the NW.js `nw` global, so app modules that read it at
// load time (constants, log, core) can be required under plain Node. The data
// path points at a throwaway temp directory so nothing touches the real
// user data or runtime log.
const fs = require('fs');
const os = require('os');
const path = require('path');

if (globalThis.nw === undefined) {
	const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wowexport-test-'));

	globalThis.nw = {
		__dirname: path.resolve(__dirname, '..', '..', 'src'),
		App: {
			dataPath,
			manifest: { version: '0.0.0-test' }
		},
		Shell: { openItem: () => {}, openExternal: () => {} }
	};
}

module.exports = globalThis.nw;
