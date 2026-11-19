/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Headless export service. A small, UI-free API over the application's data
// and export layers, shared by the command line interface and the MCP server.
// Every operation writes files beneath an output directory and returns a
// plain, JSON-serialisable description of what was produced.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const util = require('util');
const runtime = require('./runtime');

const MAP_SIZE = 64;
const MAX_LISTED_FILES = 200;

const SEARCH_TYPES = {
	texture: 'listfileTextures',
	model: 'listfileModels',
	sound: 'listfileSounds',
	text: 'listfileText',
	font: 'listfileFonts'
};

let cascPromise = null;
let openOptions = {};
let jobQueue = Promise.resolve();

// --- written file tracking -------------------------------------------------

let activeWrites = null;
let trackingInstalled = false;

const recordWrite = (file) => {
	if (activeWrites !== null && typeof file === 'string' && file.startsWith(activeWrites.root))
		activeWrites.files.add(file);
};

/**
 * Observe the file writes made by the exporters so that each operation can
 * report exactly which files it produced.
 */
const installTracking = () => {
	if (trackingInstalled)
		return;

	trackingInstalled = true;

	const BufferWrapper = require('../buffer');
	const writeToFile = BufferWrapper.prototype.writeToFile;
	BufferWrapper.prototype.writeToFile = function(file) {
		recordWrite(file);
		return writeToFile.call(this, file);
	};

	const createWriteStream = fs.createWriteStream;
	fs.createWriteStream = function(file, ...args) {
		recordWrite(file);
		return createWriteStream.call(this, file, ...args);
	};

	const writeFile = fsp.writeFile;
	fsp.writeFile = function(file, ...args) {
		recordWrite(file);
		return writeFile.call(this, file, ...args);
	};
};

// --- helpers ---------------------------------------------------------------

const getDefaultOutputDirectory = () => path.resolve(process.env.WOW_EXPORT_OUT || path.join(process.cwd(), 'wow-export'));

/**
 * Open the game data source. Subsequent calls reuse the same instance.
 * @param {object} [options]
 * @param {string} [options.region=us]
 * @param {string} [options.product=wow]
 */
const open = (options = {}) => {
	if (cascPromise === null) {
		openOptions = { region: options.region ?? process.env.WOW_EXPORT_REGION ?? 'us', product: options.product ?? process.env.WOW_EXPORT_PRODUCT ?? 'wow' };
		installTracking();

		cascPromise = runtime.openRemote(openOptions).then(casc => {
			// The app resolves worker scripts relative to its working directory.
			require('../worker-pool').setScriptPath(path.join(__dirname, '..', 'workers', 'export-worker.js'));
			return casc;
		});

		cascPromise.catch(() => cascPromise = null);
	}

	return cascPromise;
};

/**
 * Resolve a file reference (fileDataID or listfile name) to both forms.
 * @param {number|string} file
 * @returns {{fileDataID: number, fileName: string}}
 */
const resolveFile = (file) => {
	const listfile = require('../casc/listfile');

	if (typeof file === 'string' && /^\d+$/.test(file.trim()))
		file = Number(file);

	if (typeof file === 'number') {
		if (!Number.isInteger(file) || file <= 0)
			throw new Error('Invalid fileDataID: ' + file);

		return { fileDataID: file, fileName: listfile.getByID(file) ?? listfile.formatUnknownFile(file) };
	}

	if (typeof file !== 'string' || file.trim().length === 0)
		throw new Error('A file must be given as a fileDataID or a file name');

	const fileName = file.trim().toLowerCase().replace(/\\/g, '/');
	const fileDataID = listfile.getByFilename(fileName);
	if (!(fileDataID > 0))
		throw new Error('File not found in listfile: ' + fileName + ' (use search to find the right name)');

	return { fileDataID, fileName };
};

/**
 * Run an export job. Jobs run one at a time, as the exporters share global
 * configuration and progress state.
 * @param {object} options
 * @param {string} [options.outDir] Output directory for this job.
 * @param {object} [options.config] Configuration overrides for this job.
 * @param {function} fn Receives ({ casc, core, outDir }).
 */
const runJob = (options, fn) => {
	const job = jobQueue.then(async () => {
		const casc = await open();
		const core = runtime.core;
		const perf = require('../perf');

		const outDir = path.resolve(options.outDir || getDefaultOutputDirectory());
		const previous = Object.assign({}, core.view.config);

		Object.assign(core.view.config, options.config ?? {}, { exportDirectory: outDir });
		core.view.exportCancelled = false;

		activeWrites = { root: outDir, files: new Set() };
		const start = Date.now();

		try {
			const result = await fn({ casc, core, outDir }) ?? {};
			const files = [...activeWrites.files].sort();

			let bytes = 0;
			for (const file of files) {
				try {
					bytes += (await fsp.stat(file)).size;
				} catch {
					// file was replaced or removed during the export
				}
			}

			return Object.assign(result, {
				outputDirectory: outDir,
				fileCount: files.length,
				totalBytes: bytes,
				seconds: Number(((Date.now() - start) / 1000).toFixed(2)),
				files: files.slice(0, MAX_LISTED_FILES).map(file => path.relative(outDir, file).replace(/\\/g, '/')),
				filesTruncated: files.length > MAX_LISTED_FILES,
				profile: perf.summary()
			});
		} finally {
			activeWrites = null;

			// Restore configuration so one job's options do not leak into the next.
			for (const key of Object.keys(core.view.config))
				delete core.view.config[key];

			Object.assign(core.view.config, previous);
		}
	});

	// Keep the queue alive after a failed job.
	jobQueue = job.catch(() => {});
	return job;
};

const startHelper = (count, unit) => {
	const ExportHelper = require('../casc/export-helper');
	const helper = new ExportHelper(count, unit);
	helper.start();

	return helper;
};

// --- operations ------------------------------------------------------------

/**
 * Describe the opened game build.
 */
const info = async () => {
	const casc = await open();
	return {
		product: openOptions.product,
		region: openOptions.region,
		version: casc.build?.VersionsName ?? null,
		buildConfig: casc.build?.BuildConfig ?? null,
		fileCount: casc.rootEntries?.size ?? 0,
		defaultOutputDirectory: getDefaultOutputDirectory()
	};
};

/**
 * Search the listfile.
 * @param {object} options
 * @param {string} options.query Space separated terms which must all appear in the file name, or a /regex/.
 * @param {string} [options.type=any] texture, model, sound, text, font or any.
 * @param {number} [options.limit=50]
 * @param {number} [options.offset=0]
 */
const search = async ({ query, type = 'any', limit = 50, offset = 0 } = {}) => {
	await open();

	if (typeof query !== 'string' || query.trim().length === 0)
		throw new Error('A search query is required');

	if (type !== 'any' && SEARCH_TYPES[type] === undefined)
		throw new Error('Unknown search type "' + type + '" (expected one of: any, ' + Object.keys(SEARCH_TYPES).join(', ') + ')');

	const listfile = require('../casc/listfile');
	const view = runtime.core.view;

	let matcher;
	const regex = query.trim().match(/^\/(.+)\/([a-z]*)$/);
	if (regex) {
		const pattern = new RegExp(regex[1], regex[2].includes('i') ? regex[2] : regex[2] + 'i');
		matcher = (entry) => pattern.test(entry);
	} else {
		const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
		matcher = (entry) => terms.every(term => entry.includes(term));
	}

	limit = Math.max(1, Math.min(1000, Number(limit) || 50));
	offset = Math.max(0, Number(offset) || 0);

	const results = [];
	let total = 0;

	for (const key of type === 'any' ? Object.values(SEARCH_TYPES) : [SEARCH_TYPES[type]]) {
		for (const entry of view[key] ?? []) {
			if (!matcher(entry))
				continue;

			if (total >= offset && results.length < limit) {
				const parsed = listfile.parseFileEntry(entry);
				results.push({ fileDataID: parsed.file_data_id, fileName: parsed.file_path });
			}

			total++;
		}
	}

	return { query, type, total, offset, count: results.length, results };
};

/**
 * Fetch a single file.
 * @param {object} options
 * @param {number|string} options.file fileDataID or file name.
 * @param {string} [options.format=raw] raw, or png (BLP textures only).
 * @param {string} [options.outDir]
 */
const getFile = ({ file, format = 'raw', outDir } = {}) => {
	if (format !== 'raw' && format !== 'png')
		throw new Error('Unknown format "' + format + '" (expected raw or png)');

	return runJob({ outDir, config: { overwriteFiles: true } }, async ({ casc, outDir }) => {
		const { fileDataID, fileName } = resolveFile(file);
		const data = await casc.getFile(fileDataID);

		let outFile = path.join(outDir, fileName);
		if (format === 'png') {
			if (!fileName.endsWith('.blp'))
				throw new Error('Only BLP textures can be converted to PNG: ' + fileName);

			const BLPFile = require('../casc/blp');
			outFile = outFile.slice(0, -4) + '.png';
			await new BLPFile(data).saveToPNG(outFile, 0b1111);
		} else {
			await data.writeToFile(outFile);
		}

		return { fileDataID, fileName, format, path: outFile };
	});
};

/**
 * Export several textures at once.
 * @param {object} options
 * @param {Array<number|string>} options.files
 * @param {string} [options.format=png] png, webp or blp.
 * @param {string} [options.outDir]
 */
const exportTextures = ({ files, format = 'png', outDir } = {}) => {
	if (!Array.isArray(files) || files.length === 0)
		throw new Error('A list of texture files is required');

	const formats = { png: 'PNG', webp: 'WEBP', blp: 'BLP' };
	if (formats[format] === undefined)
		throw new Error('Unknown texture format "' + format + '" (expected png, webp or blp)');

	return runJob({ outDir, config: { exportTextureFormat: formats[format], overwriteFiles: true } }, async () => {
		const ids = files.map(file => resolveFile(file).fileDataID);
		await require('../ui/texture-exporter').exportFiles(ids, false);

		return { requested: ids.length, format };
	});
};

/**
 * Export a model (M2, M3 or WMO) with its textures and related files.
 * @param {object} options
 * @param {number|string} options.file
 * @param {string} [options.format=raw] raw, obj, gltf or glb.
 * @param {boolean} [options.animations=true] Include animations (raw: .anim files; gltf/glb: baked animations).
 * @param {string} [options.animationFilter] Comma separated animation IDs to include (gltf/glb only).
 * @param {string} [options.outDir]
 */
const exportModel = ({ file, format = 'raw', animations = true, animationFilter = '', outDir } = {}) => {
	if (!['raw', 'obj', 'gltf', 'glb'].includes(format))
		throw new Error('Unknown model format "' + format + '" (expected raw, obj, gltf or glb)');

	const config = {
		overwriteFiles: true,
		modelsExportTextures: true,
		modelsExportSkin: true,
		modelsExportSkel: true,
		modelsExportBone: true,
		modelsExportAnim: !!animations,
		modelsExportAnimations: !!animations,
		modelsExportAnimationFilter: String(animationFilter ?? ''),
		modelsExportWMOGroups: true
	};

	return runJob({ outDir, config }, async ({ casc, core }) => {
		const constants = require('../constants');
		const ExportHelper = require('../casc/export-helper');

		const { fileDataID, fileName } = resolveFile(file);
		const data = await casc.getFile(fileDataID);
		const helper = startHelper(1, 'model');

		try {
			const out = ExportHelper.getExportPath(fileName);
			const converted = (ext) => ExportHelper.replaceExtension(out, ext);
			const manifest = [];

			const magic = data.readUInt32LE();
			data.seek(0);

			let exporter;
			let type;

			if (magic === constants.MAGIC.MD21 || fileName.endsWith('.m2')) {
				exporter = new (require('../3D/exporters/M2Exporter'))(data, [], fileDataID);
				type = 'm2';
			} else if (magic === constants.MAGIC.M3DT || fileName.endsWith('.m3')) {
				exporter = new (require('../3D/exporters/M3Exporter'))(data, [], fileDataID);
				type = 'm3';
			} else if (fileName.endsWith('.wmo')) {
				exporter = new (require('../3D/exporters/WMOExporter'))(data, fileDataID);
				type = 'wmo';
			} else {
				throw new Error('Not a model file (expected .m2, .m3 or .wmo): ' + fileName);
			}

			let primary;
			if (format === 'raw') {
				primary = out;
				await exporter.exportRaw(out, helper, manifest);
			} else if (format === 'obj') {
				primary = converted('.obj');
				if (type === 'wmo')
					await exporter.exportAsOBJ(primary, helper, manifest);
				else
					await exporter.exportAsOBJ(primary, core.view.config.modelsExportCollision, helper, manifest);
			} else {
				primary = converted('.' + format);
				await exporter.exportAsGLTF(primary, helper, format);
			}

			if (type === 'wmo')
				require('../3D/exporters/WMOExporter').clearCache();

			helper.mark(fileName, true);
			return { fileDataID, fileName, type, format, path: primary };
		} finally {
			helper.finish();
		}
	});
};

/**
 * List the maps known to the game.
 * @param {object} [options]
 * @param {string} [options.query] Only maps whose name or directory contains this text.
 */
const listMaps = async ({ query } = {}) => {
	await open();

	const db2 = require('../casc/db2');
	const needle = typeof query === 'string' ? query.toLowerCase() : null;
	const maps = [];

	for (const [id, row] of await db2.Map.getAllRows()) {
		const entry = { id, directory: row.Directory, name: row.MapName_lang, expansion: row.ExpansionID };
		if (needle === null || String(entry.directory).toLowerCase().includes(needle) || String(entry.name).toLowerCase().includes(needle))
			maps.push(entry);
	}

	return { count: maps.length, maps };
};

const resolveMap = async (map) => {
	const { maps } = await listMaps();

	let entry;
	if (typeof map === 'number' || /^\d+$/.test(String(map)))
		entry = maps.find(e => e.id === Number(map));
	else
		entry = maps.find(e => String(e.directory).toLowerCase() === String(map).toLowerCase());

	if (entry === undefined)
		throw new Error('Unknown map: ' + map + ' (use list_maps to find the map ID or directory)');

	return entry;
};

const loadMapTiles = async (casc, map) => {
	const WDTLoader = require('../3D/loaders/WDTLoader');
	const dir = String(map.directory).toLowerCase();

	const wdt = new WDTLoader(await casc.getFileByName(util.format('world/maps/%s/%s.wdt', dir, dir)));
	wdt.load();

	const tiles = [];
	for (let index = 0; index < (wdt.tiles?.length ?? 0); index++) {
		if (wdt.tiles[index] === 1)
			tiles.push(index);
	}

	return { tiles, hasGlobalWMO: wdt.worldModelPlacement !== undefined };
};

// Tiles are named as the game names them: <row>_<column>, e.g. "32_48".
const tileName = (index) => Math.floor(index / MAP_SIZE) + '_' + (index % MAP_SIZE);

const parseTile = (tile) => {
	if (typeof tile === 'number')
		return tile;

	const match = String(tile).match(/^(\d+)[_, ](\d+)$/);
	if (!match || Number(match[1]) >= MAP_SIZE || Number(match[2]) >= MAP_SIZE)
		throw new Error('Invalid tile "' + tile + '" (expected "<row>_<column>", e.g. "32_48")');

	return Number(match[1]) * MAP_SIZE + Number(match[2]);
};

/**
 * List the terrain tiles a map contains.
 * @param {object} options
 * @param {number|string} options.map Map ID or directory name.
 */
const listMapTiles = async ({ map } = {}) => {
	const casc = await open();
	const entry = await resolveMap(map);
	const { tiles, hasGlobalWMO } = await loadMapTiles(casc, entry);

	return { map: entry, tileCount: tiles.length, hasGlobalWMO, tiles: tiles.map(tileName) };
};

/**
 * Export terrain tiles of a map, with the models placed on them.
 * @param {object} options
 * @param {number|string} options.map Map ID or directory name.
 * @param {Array<string>|string} [options.tiles=all] Tile names ("32_48"), or "all".
 * @param {string} [options.format=raw] raw, or obj (terrain mesh without baked textures).
 * @param {boolean} [options.models=true] Include placed M2 doodads.
 * @param {boolean} [options.wmos=true] Include placed WMOs.
 * @param {boolean} [options.foliage=true]
 * @param {boolean} [options.liquids=true]
 * @param {boolean} [options.animations=false] Include .anim files of placed models (raw only).
 * @param {boolean} [options.resume=false] Skip tiles completed by an earlier export into the same directory.
 * @param {string} [options.outDir]
 */
const exportMap = ({ map, tiles = 'all', format = 'raw', models = true, wmos = true, foliage = true, liquids = true, animations = false, resume = false, outDir } = {}) => {
	if (format !== 'raw' && format !== 'obj')
		throw new Error('Unknown map format "' + format + '" (expected raw or obj)');

	const config = {
		exportMapFormat: format === 'raw' ? 'RAW' : 'OBJ',
		overwriteFiles: !resume,
		mapsIncludeM2: !!models,
		mapsIncludeWMO: !!wmos,
		mapsIncludeWMOSets: true,
		mapsIncludeFoliage: !!foliage,
		mapsIncludeLiquid: !!liquids,
		mapsIncludeGameObjects: false,
		modelsExportTextures: true,
		modelsExportSkin: true,
		modelsExportSkel: true,
		modelsExportBone: true,
		modelsExportAnim: !!animations,
		modelsExportWMOGroups: true
	};

	return runJob({ outDir, config }, async ({ casc, core }) => {
		const generics = require('../generics');
		const ExportHelper = require('../casc/export-helper');
		const ADTExporter = require('../3D/exporters/ADTExporter');

		const entry = await resolveMap(map);
		const available = await loadMapTiles(casc, entry);
		const availableSet = new Set(available.tiles);

		let selected;
		if (tiles === 'all' || tiles === undefined || tiles === null) {
			selected = available.tiles;
		} else {
			selected = (Array.isArray(tiles) ? tiles : String(tiles).split(/[\s;]+/).filter(Boolean)).map(parseTile);

			const missing = selected.filter(index => !availableSet.has(index));
			if (missing.length > 0)
				throw new Error('Map ' + entry.directory + ' has no tile(s): ' + missing.map(tileName).join(', '));
		}

		if (selected.length === 0)
			throw new Error('Map ' + entry.directory + ' has no terrain tiles to export');

		const mapDir = String(entry.directory).toLowerCase();
		const dir = ExportHelper.getExportPath(path.join('maps', mapDir));
		const helper = startHelper(selected.length, 'tile');
		const failed = [];

		// Resuming relies on a record of completed tiles kept beside the export.
		const stateFile = path.join(dir, '.wow_export_tiles.json');
		const signature = format + ':' + (casc.build?.BuildConfig ?? '') + ':' + [models, wmos, foliage, liquids, animations].map(e => e ? 1 : 0).join('');

		let completed = new Set();
		if (resume) {
			try {
				const state = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
				if (state.signature === signature && Array.isArray(state.tiles))
					completed = new Set(state.tiles);
			} catch {
				// nothing to resume from
			}
		}

		const saveState = async () => {
			await fsp.mkdir(dir, { recursive: true });
			await fsp.writeFile(stateFile, JSON.stringify({ signature, tiles: [...completed] }));
		};

		let skipped = 0;
		let sinceSave = 0;

		try {
			// Raw tiles share nothing but the de-duplicated asset exports, so several run at once.
			await generics.queue(selected, async (index) => {
				if (completed.has(index)) {
					skipped++;
					helper.mark(tileName(index), true);
					return;
				}

				try {
					const out = await new ADTExporter(entry.id, mapDir, index).export(dir, 0, undefined, helper);
					if (!out)
						throw new Error('export was cancelled');

					helper.mark(tileName(index), true);
					completed.add(index);

					if (++sinceSave >= 16) {
						sinceSave = 0;
						await saveState();
					}
				} catch (e) {
					failed.push({ tile: tileName(index), error: e.message });
					helper.mark(tileName(index), false, e.message);
				}
			}, format === 'raw' ? Math.min(4, ExportHelper.getConcurrency()) : 1);

			await saveState();
		} finally {
			ADTExporter.clearCache();
			helper.finish();
		}

		return {
			map: entry,
			format,
			tilesRequested: selected.length,
			tilesExported: selected.length - failed.length - skipped,
			tilesSkipped: skipped,
			tilesFailed: failed,
			path: dir
		};
	});
};

/**
 * Read rows from a client database (DB2) table.
 * @param {object} options
 * @param {string} options.table Table name, e.g. "Map" or "CreatureDisplayInfo".
 * @param {number} [options.id] Return only the row with this ID.
 * @param {object} [options.where] Column/value pairs a row must match exactly.
 * @param {number} [options.limit=50]
 * @param {number} [options.offset=0]
 */
const queryTable = async ({ table, id, where, limit = 50, offset = 0 } = {}) => {
	await open();

	if (typeof table !== 'string' || !/^[A-Za-z0-9_]+$/.test(table))
		throw new Error('A table name is required (letters, digits and underscores only)');

	const db2 = require('../casc/db2');
	const reader = db2[table];

	const serialise = (row) => JSON.parse(JSON.stringify(row, (key, value) => typeof value === 'bigint' ? value.toString() : value));

	if (id !== undefined && id !== null) {
		const row = await reader.getRow(Number(id));
		return { table, total: row ? 1 : 0, count: row ? 1 : 0, rows: row ? [Object.assign({ ID: Number(id) }, serialise(row))] : [] };
	}

	limit = Math.max(1, Math.min(1000, Number(limit) || 50));
	offset = Math.max(0, Number(offset) || 0);

	const conditions = Object.entries(where ?? {});
	const rows = [];
	let total = 0;

	for (const [rowID, row] of await reader.getAllRows()) {
		// Loose comparison so that "5" matches 5 when filters arrive as strings.
		if (!conditions.every(([column, value]) => row[column] == value))
			continue;

		if (total >= offset && rows.length < limit)
			rows.push(Object.assign({ ID: rowID }, serialise(row)));

		total++;
	}

	return { table, total, offset, count: rows.length, rows };
};

module.exports = {
	open,
	info,
	search,
	getFile,
	exportTextures,
	exportModel,
	listMaps,
	listMapTiles,
	exportMap,
	queryTable,
	getDefaultOutputDirectory
};
