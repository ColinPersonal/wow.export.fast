// Gateway settings: <root>/service.json merged over defaults.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isInside } = require('./util');

const REPO = path.resolve(__dirname, '..', '..');

const DEFAULTS = {
	host: '127.0.0.1',
	port: 8787,
	// Public base URL used in download links for requests that arrive through
	// the tunnel (e.g. https://pc.tailnet.ts.net). Local requests get local links.
	publicUrl: null,
	repo: REPO,
	bun: path.join(os.homedir(), '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun'),
	defaultProduct: 'wowf',
	defaultRegion: 'us',
	// Products opened from a local installation. Anything else comes from the CDN.
	sources: {
		wowf: { type: 'local', install: 'C:\\Program Files (x86)\\World of Warcraft', region: 'us' }
	},
	// Products whose engines are started with the gateway and kept running.
	warmProducts: ['wowf'],
	engineConfig: { exportConcurrency: 8 },
	engineMemoryMB: 12000,
	engineIdleStopMinutes: 30,
	engineRecycleHours: 6,
	heartbeatTimeoutSeconds: 20,
	// Jobs at or under these sizes run in the quick lane.
	quickMaxItems: 25,
	quickMaxTiles: 4,
	maxTilesPerJob: 1024,
	maxItemsPerJob: 20000,
	maxQueuedPerToken: 10,
	requestsPerSecondPerToken: 20,
	diskBudgetGB: 75,
	minFreeGB: 50,
	retentionDays: 14,
	waitSeconds: 40,
	jobRetries: 1
};

/** Folders of the user's normal wow.export that the service must never use. */
const protectedDirs = () => {
	const dirs = [path.join(os.homedir(), 'wow.export')];
	if (process.env.LOCALAPPDATA)
		dirs.push(path.join(process.env.LOCALAPPDATA, 'wow.export'));
	return dirs;
};

/**
 * Load settings for a service root.
 * @param {string} [root]
 * @param {object} [overrides]
 */
const load = (root, overrides = {}) => {
	root = path.resolve(root ?? process.env.WOW_EXPORT_SERVICE_ROOT ?? path.join(os.homedir(), 'wow.export-service'));

	for (const dir of protectedDirs()) {
		if (isInside(root, dir) || isInside(dir, root))
			throw new Error('Service root ' + root + ' overlaps the normal wow.export folder ' + dir);
	}

	let file = {};
	const file_path = path.join(root, 'service.json');
	if (fs.existsSync(file_path))
		file = JSON.parse(fs.readFileSync(file_path, 'utf8'));

	const config = Object.assign({}, DEFAULTS, file, overrides);
	config.root = root;
	config.dirs = {
		root,
		staging: path.join(root, 'staging'),
		results: path.join(root, 'results'),
		engines: path.join(root, 'engines'),
		logs: path.join(root, 'logs'),
		state: path.join(root, 'state')
	};

	for (const dir of Object.values(config.dirs))
		fs.mkdirSync(dir, { recursive: true });

	return config;
};

/** Source description for a product: local install or CDN. */
const sourceFor = (config, product) => {
	const local = config.sources?.[product];
	if (local?.type === 'local')
		return { type: 'local', install: local.install, product, region: local.region ?? config.defaultRegion };

	return { type: 'remote', product, region: config.defaultRegion };
};

module.exports = { load, sourceFor, protectedDirs, DEFAULTS, REPO };
