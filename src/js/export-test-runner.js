/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Headless export test runner. When wow.export is started with
// --export-test=<job.json> it skips the normal UI flow, opens the given
// installation, exports the requested map tiles and writes a JSON report,
// then exits. Driven by tests/export-scale/run.js.
//
// Isolation: the driver starts the app with its own --user-data-dir, so this
// run has its own config, runtime.log, CASC cache and single-instance lock,
// and the job sets an export directory separate from normal use. Nothing
// here touches the regular wow.export data directory or export folder.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const util = require('util');
const log = require('./log');
const generics = require('./generics');
const listfile = require('./casc/listfile');
const db2 = require('./casc/db2');
const CASCLocal = require('./casc/casc-source-local');
const ExportHelper = require('./casc/export-helper');
const WDTLoader = require('./3D/loaders/WDTLoader');
const ADTExporter = require('./3D/exporters/ADTExporter');
const InstallType = require('./install-type');
const constants = require('./constants');
const cdnResolver = require('./casc/cdn-resolver');
const { resolveTiles, tileName } = require('./export-test-tiles');

const ARG_PREFIX = '--export-test=';

/**
 * @returns {?string} Job file path if the app was started in test mode.
 */
const getJobPath = () => {
	const arg = nw.App.argv.find(a => a.startsWith(ARG_PREFIX));
	return arg ? arg.slice(ARG_PREFIX.length).replace(/^"|"$/g, '') : null;
};

/**
 * Find a map's ID and directory from either.
 * @param {object} job
 */
const resolveMap = async (job) => {
	const want = job.map.toString().toLowerCase();

	for (const [id, entry] of await db2.Map.getAllRows()) {
		if (String(id) !== want && entry.Directory.toLowerCase() !== want)
			continue;

		// Mirror tab_maps.initialize(): make the WDT resolvable by name.
		const wdtPath = `world/maps/${entry.Directory}/${entry.Directory}.wdt`;
		if (entry.WdtFileDataID && !listfile.existsByID(entry.WdtFileDataID))
			listfile.addEntry(entry.WdtFileDataID, wdtPath);

		return { id, dir: entry.Directory.toLowerCase(), name: entry.MapName_lang };
	}

	throw new Error('map not found: ' + job.map);
};

/**
 * Sample process memory while a job runs.
 */
const memorySampler = () => {
	let peakRSS = 0;
	let peakHeap = 0;
	const sample = () => {
		const m = process.memoryUsage();
		peakRSS = Math.max(peakRSS, m.rss);
		peakHeap = Math.max(peakHeap, m.heapUsed);
	};
	sample();
	const timer = setInterval(sample, 250);
	return () => {
		clearInterval(timer);
		sample();
		return { peakRSS, peakHeap };
	};
};

/**
 * Export the tiles of one job.
 * @param {object} core
 * @param {object} job
 * @param {string} outputRoot
 */
const runJob = async (core, job, outputRoot) => {
	const config = core.view.config;
	const format = (job.format ?? 'OBJ').toUpperCase();
	if (format !== 'OBJ' && format !== 'RAW')
		throw new Error('unsupported format: ' + format);

	// Per-job settings. Each job exports into its own folder under the run's
	// output directory.
	Object.assign(config, job.config ?? {});
	config.exportMapFormat = format;
	config.exportDirectory = path.join(outputRoot, job.name);

	const quality = job.quality ?? config.exportMapQuality ?? 0;
	const map = await resolveMap(job);

	const wdtData = await core.view.casc.getFileByName(util.format('world/maps/%s/%s.wdt', map.dir, map.dir));
	const wdt = new WDTLoader(wdtData);
	wdt.load();

	const requested = resolveTiles(job.tiles, wdt);
	const tiles = requested.filter(index => wdt.tiles?.[index]);
	const missing = requested.filter(index => !wdt.tiles?.[index]);

	const limit = job.maxTiles ?? Infinity;
	if (tiles.length > limit)
		tiles.length = limit;

	log.write('[export-test] job %s: map %s (%d), %d tiles (%d not on map), format %s, quality %d', job.name, map.dir, map.id, tiles.length, missing.length, format, quality);

	const dir = ExportHelper.getExportPath(path.join('maps', map.dir));
	const helper = new ExportHelper(tiles.length, 'tile');
	const results = [];
	const tileConcurrency = job.tileConcurrency ?? Math.min(4, ExportHelper.getConcurrency());
	const stopSampling = memorySampler();

	helper.start();
	const started = performance.now();

	await generics.queue(tiles, async (index) => {
		const tileStart = performance.now();
		const result = { tile: tileName(index), ok: false, ms: 0 };

		try {
			const adt = new ADTExporter(map.id, map.dir, index);
			const out = await adt.export(dir, quality, undefined, helper);
			if (out === undefined)
				throw new Error('export cancelled');

			result.ok = true;
			result.output = out.path;
			result.type = out.type;
			helper.mark(path.join('maps', map.dir, result.tile), true);
		} catch (e) {
			result.error = e.message;
			helper.mark(path.join('maps', map.dir, result.tile), false, e.message, e.stack);
		}

		result.ms = Math.round(performance.now() - tileStart);
		results.push(result);
	}, tileConcurrency);

	const wallMs = Math.round(performance.now() - started);
	helper.finish(false);
	ADTExporter.clearCache();

	const memory = stopSampling();
	const ok = results.filter(r => r.ok).length;

	log.write('[export-test] job %s finished: %d/%d tiles in %dms', job.name, ok, results.length, wallMs);

	return {
		name: job.name,
		map: map.dir,
		mapID: map.id,
		format,
		quality,
		exportDirectory: config.exportDirectory,
		mapDirectory: dir,
		tileConcurrency,
		exportConcurrency: ExportHelper.getConcurrency(),
		requestedTiles: requested.length,
		missingTiles: missing.map(tileName),
		tiles: results.sort((a, b) => a.tile.localeCompare(b.tile)),
		succeeded: ok,
		failed: results.length - ok,
		wallMs,
		tilesPerSecond: results.length ? +(results.length / (wallMs / 1000)).toFixed(3) : 0,
		peakRSS: memory.peakRSS,
		peakHeap: memory.peakHeap
	};
};

/**
 * Run the export test described by the job file, write the report and exit.
 * @param {object} core
 * @param {string} jobPath
 */
const run = async (core, jobPath) => {
	const report = { started: new Date().toISOString(), jobFile: jobPath, jobs: [], ok: false };
	let reportPath = path.join(path.dirname(jobPath), 'report.json');
	let exitCode = 1;

	try {
		const spec = JSON.parse(await fsp.readFile(jobPath, 'utf8'));
		if (spec.report)
			reportPath = spec.report;

		if (!spec.install || !spec.outputDir || !Array.isArray(spec.jobs))
			throw new Error('job file needs install, outputDir and jobs');

		report.version = nw.App.manifest.version;
		report.install = spec.install;
		report.product = spec.product ?? null;
		report.outputDir = spec.outputDir;

		// Safety: never export into the user's normal export folder.
		const normalDir = path.resolve(core.view.config.exportDirectory || '');
		const outDir = path.resolve(spec.outputDir);
		if (normalDir && (outDir === normalDir || outDir.startsWith(normalDir + path.sep)))
			throw new Error('outputDir must not be inside the normal export directory: ' + normalDir);

		await fsp.mkdir(outDir, { recursive: true });

		const config = core.view.config;
		config.allowCacheCollection = false;
		config.overwriteFiles = true;
		Object.assign(config, spec.config ?? {});

		// Files missing from a local install are fetched from the CDN, which needs
		// a region. The source select screen normally sets this up; we skip it.
		const regionTag = spec.region ?? constants.PATCH.DEFAULT_REGION;
		const region = constants.PATCH.REGIONS.find(r => r.tag === regionTag);
		if (!region)
			throw new Error('unknown CDN region: ' + regionTag);

		const regionNode = {
			tag: region.tag,
			name: region.name,
			url: region.tag === 'cn' ? constants.PATCH.HOST_CHINA : util.format(constants.PATCH.HOST, region.tag),
			delay: null
		};
		core.view.cdnRegions = [regionNode];
		core.view.selectedCDNRegion = regionNode;
		core.view.lockCDNRegion = true;
		cdnResolver.startPreResolution(region.tag);
		report.region = region.tag;

		log.write('[export-test] opening %s (%s)', spec.install, spec.product ?? 'first product');
		const casc = new CASCLocal(spec.install);
		await casc.init();

		const buildIndex = spec.product ? casc.builds.findIndex(b => b.Product === spec.product) : 0;
		if (buildIndex < 0)
			throw new Error('product not found in install: ' + spec.product + ' (have ' + casc.builds.map(b => b.Product).join(', ') + ')');

		const loadStart = performance.now();
		await casc.load(buildIndex);
		core.view.installType = InstallType.CASC;
		report.cascLoadMs = Math.round(performance.now() - loadStart);
		report.build = casc.build?.Version ?? casc.build?.BuildKey ?? null;

		for (const job of spec.jobs) {
			if (!job.name || !job.map || job.tiles === undefined)
				throw new Error('each job needs name, map and tiles');

			try {
				report.jobs.push(await runJob(core, job, outDir));
			} catch (e) {
				log.write('[export-test] job %s failed: %s', job.name, e.stack ?? e.message);
				report.jobs.push({ name: job.name, error: e.message });
			}
		}

		report.ok = report.jobs.every(j => !j.error && j.failed === 0);
		exitCode = report.ok ? 0 : 2;
	} catch (e) {
		log.write('[export-test] fatal: %s', e.stack ?? e.message);
		report.error = e.message;
	}

	report.finished = new Date().toISOString();

	try {
		await fsp.mkdir(path.dirname(reportPath), { recursive: true });
		await fsp.writeFile(reportPath, JSON.stringify(report, null, '\t'));
	} catch (e) {
		log.write('[export-test] unable to write report %s: %s', reportPath, e.message);
	}

	// Give the runtime log a moment to flush before exiting.
	setTimeout(() => process.exit(exitCode), 500);
};

module.exports = { getJobPath, run };
