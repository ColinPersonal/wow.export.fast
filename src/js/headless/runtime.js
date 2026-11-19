/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Headless runtime: lets the data and export layers run without NW.js or a
// browser window (CLI, MCP server, tests). This module must be required
// before any other application module, as several of them read the globals
// set up here at load time.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = process.env.WOW_EXPORT_DATA_DIR || path.join(os.homedir(), '.wow.export-headless');

fs.mkdirSync(DATA_DIR, { recursive: true });

if (globalThis.nw === undefined) {
	const manifest = JSON.parse(fs.readFileSync(path.join(SRC_DIR, '..', 'package.json'), 'utf8'));

	globalThis.nw = {
		__dirname: SRC_DIR,
		App: {
			dataPath: DATA_DIR,
			manifest: { version: manifest.version + '-headless' },
			argv: []
		},
		Shell: { openItem: () => {}, openExternal: () => {} }
	};
}

// Lets modules that need a native add-on know to use their fallbacks.
globalThis.WOW_EXPORT_HEADLESS = true;

// Treat headless runs as release builds: nothing is echoed to stdout, which
// must stay clean for the stdio MCP transport.
if (globalThis.BUILD_RELEASE === undefined)
	globalThis.BUILD_RELEASE = true;

// The UI waits on animation frames to repaint; there is nothing to paint here.
if (globalThis.requestAnimationFrame === undefined)
	globalThis.requestAnimationFrame = (callback) => setImmediate(callback);

const core = require('../core');
const config = require('../config');
const constants = require('../constants');
const log = require('../log');
const generics = require('../generics');

let initialized = null;

/**
 * Prepare application state (view, configuration, encryption keys).
 * @param {object} [overrides] Configuration values to apply on top of the defaults.
 */
const init = (overrides = {}) => {
	if (initialized === null) {
		initialized = (async () => {
			const view = core.makeNewView();

			// Stand-ins for the reactive view methods the data layer touches.
			// Nothing is reactive here, but watchers registered with `immediate`
			// expect to be called once with the current value.
			view.$watch = (expression, callback, options) => {
				if (options?.immediate && typeof expression === 'string')
					callback(expression.split('.').reduce((value, key) => value?.[key], view));

				return () => {};
			};
			view.restartApplication = () => {};
			core.view = view;

			await config.load();

			// The application locates its defaults relative to the NW.js executable,
			// which does not exist here; read them from the source tree instead.
			const defaults = await generics.readJSON(path.join(SRC_DIR, 'default_config.jsonc'), true) ?? {};
			for (const [key, value] of Object.entries(defaults)) {
				if (!(key in core.view.config))
					core.view.config[key] = Array.isArray(value) ? value.slice(0) : value;
			}

			if (!core.view.config.exportDirectory)
				core.view.config.exportDirectory = path.join(DATA_DIR, 'export');

			Object.assign(core.view.config, overrides);

			await require('../casc/tact-keys').load();
		})();
	} else {
		initialized = initialized.then(() => Object.assign(core.view.config, overrides));
	}

	return initialized;
};

/**
 * Open a game build from Blizzard's CDN.
 * @param {object} [options]
 * @param {string} [options.region=us]
 * @param {string} [options.product=wow]
 * @returns {Promise<CASC>}
 */
const openRemote = async ({ region = 'us', product = 'wow' } = {}) => {
	await init();

	const CASCRemote = require('../casc/casc-source-remote');
	const casc = new CASCRemote(region);
	await casc.init();

	const buildIndex = casc.builds.findIndex(build => build?.Product === product);
	if (buildIndex === -1)
		throw new Error('Product "' + product + '" is not available in region "' + region + '"');

	await casc.load(buildIndex);
	return casc;
};

/**
 * Open a game build from a local installation. Files the installation does
 * not have are fetched from the CDN of the given region.
 * @param {object} options
 * @param {string} options.install Installation directory (contains .build.info).
 * @param {string} [options.product=wow]
 * @param {string} [options.region=us] CDN region used for missing files.
 * @returns {Promise<CASC>}
 */
const openLocal = async ({ install, product = 'wow', region = 'us' } = {}) => {
	await init();

	if (typeof install !== 'string' || install.length === 0)
		throw new Error('A local installation directory is required');

	// The source select screen normally picks the CDN region used for files
	// missing from the installation.
	const regionInfo = constants.PATCH.REGIONS.find(r => r.tag === region);
	if (regionInfo === undefined)
		throw new Error('Unknown CDN region "' + region + '"');

	const regionNode = {
		tag: regionInfo.tag,
		name: regionInfo.name,
		url: regionInfo.tag === 'cn' ? constants.PATCH.HOST_CHINA : require('util').format(constants.PATCH.HOST, regionInfo.tag),
		delay: null
	};
	core.view.cdnRegions = [regionNode];
	core.view.selectedCDNRegion = regionNode;
	core.view.lockCDNRegion = true;
	require('../casc/cdn-resolver').startPreResolution(regionInfo.tag);

	const CASCLocal = require('../casc/casc-source-local');
	const casc = new CASCLocal(install);
	await casc.init();

	const buildIndex = casc.builds.findIndex(build => build?.Product === product);
	if (buildIndex === -1)
		throw new Error('Product "' + product + '" is not installed in ' + install + ' (installed: ' + casc.builds.map(b => b?.Product).join(', ') + ')');

	await casc.load(buildIndex);
	return casc;
};

module.exports = { init, openRemote, openLocal, core, constants, log, DATA_DIR };
