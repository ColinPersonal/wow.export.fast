/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Headless export service. A small, UI-free API over the application's data
// and export layers, shared by the command line interface, the MCP server and
// the export service engine (engine.js). Every operation writes files beneath
// an output directory and returns a plain, JSON-serialisable description of
// what was produced.
//
// Errors carry a `code` (see errors.js) so callers can tell bad input from
// missing files and export failures.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const util = require('util');
const runtime = require('./runtime');
const { CODES, fail } = require('./errors');
const { audioFileName } = require('./sniff');

const MAP_SIZE = 64;
const MAX_LISTED_FILES = 200;
const MAX_BATCH = 20000;

const SEARCH_TYPES = {
	texture: 'listfileTextures',
	model: 'listfileModels',
	sound: 'listfileSounds',
	text: 'listfileText',
	font: 'listfileFonts'
};

const MODEL_FORMATS = { raw: 'RAW', obj: 'OBJ', stl: 'STL', gltf: 'GLTF', glb: 'GLB' };
const TABLE_FORMATS = { csv: 'CSV', sql: 'SQL', db2: 'DB2' };
const HEIGHTMAP_BIT_DEPTHS = [8, 16, 32];

let cascPromise = null;
let openOptions = {};
let jobQueue = Promise.resolve();

// The job currently running (see runJob), or null.
let activeJob = null;

// --- written file tracking -------------------------------------------------

let activeWrites = null;
let trackingInstalled = false;

const recordWrite = (file) => {
	if (activeWrites !== null && typeof file === 'string' && file.startsWith(activeWrites.root))
		activeWrites.files.add(file);
};

/**
 * Observe the file writes made by the exporters so that each operation can
 * report exactly which files it produced, and the progress, failures and
 * cancellation of the export helpers they use.
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

	// Exporters report each finished item through ExportHelper.mark(); that
	// drives job progress and the list of failed items.
	const ExportHelper = require('../casc/export-helper');
	const mark = ExportHelper.prototype.mark;
	ExportHelper.prototype.mark = function(item, state, error, stackTrace) {
		activeJob?.item(item, state, error, CODES.EXPORT_FAILED, this.count);
		return mark.call(this, item, state, error, stackTrace);
	};

	// ExportHelper.start() clears the cancelled flag; keep it set for a job
	// that was cancelled before its exporter started.
	const isCancelled = ExportHelper.prototype.isCancelled;
	ExportHelper.prototype.isCancelled = function() {
		if (activeJob?.cancelled)
			runtime.core.view.exportCancelled = true;

		return isCancelled.call(this);
	};
};

// --- helpers ---------------------------------------------------------------

const getDefaultOutputDirectory = () => path.resolve(process.env.WOW_EXPORT_OUT || path.join(process.cwd(), 'wow-export'));

/**
 * Open the game data source. Subsequent calls reuse the same instance.
 * With an installation directory (options.install or WOW_EXPORT_INSTALL) the
 * build is read from that local installation, with files it lacks fetched
 * from the CDN; otherwise the build is opened from the CDN.
 * @param {object} [options]
 * @param {string} [options.region=us]
 * @param {string} [options.product=wow]
 * @param {string} [options.install] Local installation directory.
 */
const open = (options = {}) => {
	if (cascPromise === null) {
		const install = options.install ?? process.env.WOW_EXPORT_INSTALL ?? null;
		openOptions = {
			region: options.region ?? process.env.WOW_EXPORT_REGION ?? 'us',
			product: options.product ?? process.env.WOW_EXPORT_PRODUCT ?? 'wow',
			install: install || null
		};
		installTracking();

		const opening = openOptions.install ? runtime.openLocal(openOptions) : runtime.openRemote(openOptions);
		cascPromise = opening.then(casc => {
			// The app resolves worker scripts relative to its working directory.
			require('../worker-pool').setScriptPath(path.join(__dirname, '..', 'workers', 'export-worker.js'));
			return casc;
		}, e => {
			throw Object.assign(fail(CODES.SOURCE_UNAVAILABLE, 'Unable to open game data (' + openOptions.product + (openOptions.install ? ' from ' + openOptions.install : ' from the CDN') + '): ' + e.message), { cause: e });
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
			throw fail(CODES.INVALID_PARAMS, 'Invalid fileDataID: ' + file);

		return { fileDataID: file, fileName: listfile.getByID(file) ?? listfile.formatUnknownFile(file) };
	}

	if (typeof file !== 'string' || file.trim().length === 0)
		throw fail(CODES.INVALID_PARAMS, 'A file must be given as a fileDataID or a file name');

	const fileName = file.trim().toLowerCase().replace(/\\/g, '/');
	const fileDataID = listfile.getByFilename(fileName);
	if (!(fileDataID > 0))
		throw fail(CODES.NOT_FOUND, 'File not found in listfile: ' + fileName + ' (use search to find the right name)');

	return { fileDataID, fileName };
};

/**
 * True if the open build contains the file.
 * @param {object} casc
 * @param {number} fileDataID
 */
const inBuild = (casc, fileDataID) => casc.rootEntries?.has(fileDataID) ?? true;

/**
 * Resolve every file of a batch. Files that cannot be resolved or are not in
 * the open build are reported through job.item() as NOT_FOUND and left out.
 * @returns {Array<{fileDataID: number, fileName: string, input: *}>}
 */
const resolveBatch = (casc, files, job) => {
	if (!Array.isArray(files) || files.length === 0)
		throw fail(CODES.INVALID_PARAMS, 'A non-empty list of files is required');

	if (files.length > MAX_BATCH)
		throw fail(CODES.INVALID_PARAMS, 'Too many files in one request (' + files.length + ', maximum ' + MAX_BATCH + ')');

	const resolved = [];
	const seen = new Set();

	for (const input of files) {
		let entry;
		try {
			entry = resolveFile(input);
			if (!inBuild(casc, entry.fileDataID))
				throw fail(CODES.NOT_FOUND, 'File ' + entry.fileDataID + ' (' + entry.fileName + ') is not in this build');
		} catch (e) {
			job.item(String(input), false, e.message, e.code ?? CODES.NOT_FOUND, files.length);
			continue;
		}

		if (seen.has(entry.fileDataID))
			continue;

		seen.add(entry.fileDataID);
		resolved.push(Object.assign(entry, { input }));
	}

	return resolved;
};

/**
 * State of one running job: progress, failed items and cancellation.
 */
const createJob = (onProgress) => {
	let lastProgress = 0;

	const job = {
		done: 0,
		total: 0,
		failed: [],
		cancelled: false,

		/**
		 * Record a finished item.
		 * @param {string} item
		 * @param {boolean} ok
		 * @param {string} [error]
		 * @param {string} [code]
		 * @param {number} [total]
		 */
		item(item, ok, error, code = CODES.EXPORT_FAILED, total) {
			job.done++;
			if (total > job.total)
				job.total = total;

			if (!ok)
				job.failed.push({ item: String(item), code, error: String(error ?? 'export failed') });

			job.progress(String(item));
		},

		progress(current, force = false) {
			if (typeof onProgress !== 'function')
				return;

			const now = Date.now();
			if (!force && now - lastProgress < 250 && job.done < job.total)
				return;

			lastProgress = now;
			try {
				onProgress(job.done, Math.max(job.total, job.done), current);
			} catch {
				// progress reporting never fails a job
			}
		},

		throwIfCancelled() {
			if (job.cancelled)
				throw fail(CODES.CANCELLED, 'Export was cancelled');
		}
	};

	return job;
};

/**
 * Run an export job. Jobs run one at a time, as the exporters share global
 * configuration and progress state.
 * @param {object} options
 * @param {string} [options.outDir] Output directory for this job.
 * @param {object} [options.config] Configuration overrides for this job.
 * @param {function} [options.onProgress] Called with (done, total, current item).
 * @param {function} fn Receives ({ casc, core, outDir, job }).
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
		activeJob = createJob(options.onProgress);
		const state = activeJob;
		const start = Date.now();

		try {
			const result = await fn({ casc, core, outDir, job: state }) ?? {};
			const files = [...activeWrites.files].sort();

			let bytes = 0;
			for (const file of files) {
				try {
					bytes += (await fsp.stat(file)).size;
				} catch {
					// file was replaced or removed during the export
				}
			}

			state.progress(null, true);

			return Object.assign(result, {
				outputDirectory: outDir,
				fileCount: files.length,
				totalBytes: bytes,
				seconds: Number(((Date.now() - start) / 1000).toFixed(2)),
				files: files.slice(0, MAX_LISTED_FILES).map(file => path.relative(outDir, file).replace(/\\/g, '/')),
				filesTruncated: files.length > MAX_LISTED_FILES,
				failed: state.failed,
				cancelled: state.cancelled,
				profile: perf.summary()
			});
		} finally {
			activeWrites = null;
			activeJob = null;
			core.view.exportCancelled = false;

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

/**
 * Cancel the running job, if any. Exporters stop at their next check; the
 * job's result then has `cancelled: true`.
 * @returns {boolean} True if a job was running.
 */
const cancel = () => {
	if (activeJob === null)
		return false;

	activeJob.cancelled = true;
	runtime.core.view.exportCancelled = true;
	return true;
};

/**
 * True while a job is running.
 */
const isBusy = () => activeJob !== null;

const startHelper = (count, unit) => {
	const ExportHelper = require('../casc/export-helper');
	const helper = new ExportHelper(count, unit);
	helper.start();

	return helper;
};

const lower = (value, fallback) => (typeof value === 'string' ? value : fallback).toLowerCase();

// --- operations ------------------------------------------------------------

/**
 * Describe the opened game build.
 */
const info = async () => {
	const casc = await open();
	return {
		product: openOptions.product,
		region: openOptions.region,
		source: openOptions.install ? 'local' : 'cdn',
		install: openOptions.install,
		// CDN builds name their version VersionsName; .build.info calls it Version.
		version: casc.build?.VersionsName ?? casc.build?.Version ?? null,
		buildConfig: casc.build?.BuildConfig ?? casc.build?.BuildKey ?? null,
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
 * @param {boolean} [options.allowRegex=true] Accept /regex/ queries. Services exposed over a network pass false.
 */
const search = async ({ query, type = 'any', limit = 50, offset = 0, allowRegex = true } = {}) => {
	await open();

	if (typeof query !== 'string' || query.trim().length === 0)
		throw fail(CODES.INVALID_PARAMS, 'A search query is required');

	if (type !== 'any' && SEARCH_TYPES[type] === undefined)
		throw fail(CODES.INVALID_PARAMS, 'Unknown search type "' + type + '" (expected one of: any, ' + Object.keys(SEARCH_TYPES).join(', ') + ')');

	const listfile = require('../casc/listfile');
	const view = runtime.core.view;

	let matcher;
	const regex = query.trim().match(/^\/(.+)\/([a-z]*)$/);
	if (regex && allowRegex) {
		let pattern;
		try {
			pattern = new RegExp(regex[1], regex[2].includes('i') ? regex[2] : regex[2] + 'i');
		} catch (e) {
			throw fail(CODES.INVALID_PARAMS, 'Invalid regular expression: ' + e.message);
		}
		matcher = (entry) => pattern.test(entry);
	} else {
		// Without regex support a /pattern/ is matched as plain text.
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
 * Resolve files to fileDataIDs and names and report whether the open build
 * contains them.
 * @param {object} options
 * @param {Array<number|string>} options.files
 */
const fileInfo = async ({ files } = {}) => {
	const casc = await open();

	if (!Array.isArray(files) || files.length === 0)
		throw fail(CODES.INVALID_PARAMS, 'A non-empty list of files is required');

	if (files.length > 1000)
		throw fail(CODES.INVALID_PARAMS, 'At most 1000 files per call');

	const results = files.map(input => {
		try {
			const { fileDataID, fileName } = resolveFile(input);
			const listfile = require('../casc/listfile');
			return { input, fileDataID, fileName, named: listfile.getByID(fileDataID) !== undefined, inBuild: inBuild(casc, fileDataID) };
		} catch (e) {
			return { input, error: { code: e.code ?? CODES.INTERNAL, message: e.message } };
		}
	});

	return { count: results.length, files: results };
};

/**
 * Fetch a single file.
 * @param {object} options
 * @param {number|string} options.file fileDataID or file name.
 * @param {string} [options.format=raw] raw, or png (BLP textures only).
 * @param {string} [options.outDir]
 */
const getFile = ({ file, format = 'raw', outDir, onProgress } = {}) => {
	if (format !== 'raw' && format !== 'png')
		throw fail(CODES.INVALID_PARAMS, 'Unknown format "' + format + '" (expected raw or png)');

	return runJob({ outDir, onProgress, config: { overwriteFiles: true } }, async ({ casc, outDir, job }) => {
		const { fileDataID, fileName } = resolveFile(file);
		if (!inBuild(casc, fileDataID))
			throw fail(CODES.NOT_FOUND, 'File ' + fileDataID + ' (' + fileName + ') is not in this build');

		const data = await casc.getFile(fileDataID);

		let outFile = path.join(outDir, fileName);
		if (format === 'png') {
			if (!fileName.endsWith('.blp'))
				throw fail(CODES.UNSUPPORTED, 'Only BLP textures can be converted to PNG: ' + fileName);

			const BLPFile = require('../casc/blp');
			outFile = outFile.slice(0, -4) + '.png';
			await new BLPFile(data).saveToPNG(outFile, 0b1111);
		} else {
			await data.writeToFile(outFile);
		}

		job.item(fileName, true, null, null, 1);
		return { fileDataID, fileName, format, path: outFile };
	});
};

/**
 * Export several files unmodified. Sounds named .unk_sound (or unnamed) are
 * given an .ogg or .mp3 extension when their content is recognised.
 * @param {object} options
 * @param {Array<number|string>} options.files
 * @param {string} [options.outDir]
 */
const exportFiles = ({ files, outDir, onProgress } = {}) => {
	return runJob({ outDir, onProgress, config: { overwriteFiles: true } }, async ({ casc, outDir, job }) => {
		const resolved = resolveBatch(casc, files, job);
		job.total = files.length;

		const generics = require('../generics');
		const ExportHelper = require('../casc/export-helper');
		const written = [];

		await generics.queue(resolved, async (entry) => {
			if (job.cancelled)
				return;

			try {
				const data = await casc.getFile(entry.fileDataID);
				let name = entry.fileName;

				if (name.toLowerCase().endsWith('.unk_sound') || path.extname(name) === '') {
					const head = data.raw.subarray(0, 4);
					const sniffed = audioFileName(path.extname(name) === '' ? name + '.unk_sound' : name, head);
					if (!sniffed.endsWith('.unk_sound'))
						name = sniffed;
				}

				const out = path.join(outDir, name);
				await data.writeToFile(out);
				written.push({ fileDataID: entry.fileDataID, fileName: entry.fileName, path: out });
				job.item(name, true, null, null, files.length);
			} catch (e) {
				job.item(entry.fileName, false, e.message, e.code ?? CODES.EXPORT_FAILED, files.length);
			}
		}, ExportHelper.getConcurrency());

		job.throwIfCancelled();
		written.sort((a, b) => a.fileName.localeCompare(b.fileName));
		return { requested: files.length, exported: written.length, exportedFiles: written.slice(0, MAX_LISTED_FILES) };
	});
};

/**
 * Export several textures at once.
 * @param {object} options
 * @param {Array<number|string>} options.files
 * @param {string} [options.format=png] png, webp or blp.
 * @param {number} [options.channelMask] RGBA channel bit mask (default 0b1111).
 * @param {boolean} [options.skipMissing=false] Report files that cannot be found as failed items instead of failing the whole call.
 * @param {string} [options.outDir]
 */
const exportTextures = ({ files, format = 'png', channelMask, skipMissing = false, outDir, onProgress } = {}) => {
	if (!Array.isArray(files) || files.length === 0)
		throw fail(CODES.INVALID_PARAMS, 'A list of texture files is required');

	const formats = { png: 'PNG', webp: 'WEBP', blp: 'BLP' };
	if (formats[format] === undefined)
		throw fail(CODES.INVALID_PARAMS, 'Unknown texture format "' + format + '" (expected png, webp or blp)');

	const config = { exportTextureFormat: formats[format], overwriteFiles: true };
	if (channelMask !== undefined && channelMask !== null) {
		if (!Number.isInteger(channelMask) || channelMask < 0 || channelMask > 0b1111)
			throw fail(CODES.INVALID_PARAMS, 'channelMask must be an integer from 0 to 15');
		config.exportChannelMask = channelMask;
	}

	return runJob({ outDir, onProgress, config }, async ({ casc, job }) => {
		let ids;
		if (skipMissing) {
			ids = resolveBatch(casc, files, job).map(entry => entry.fileDataID);
		} else {
			ids = files.map(file => resolveFile(file).fileDataID);
		}

		job.total = files.length;
		if (ids.length > 0)
			await require('../ui/texture-exporter').exportFiles(ids, false);

		job.throwIfCancelled();
		return { requested: files.length, format };
	});
};

/**
 * Export one model into the current job. Shared by exportModel and exportModels.
 * @returns {Promise<{type: string, path: string}>}
 */
const exportOneModel = async ({ casc, core, fileDataID, fileName, format, helper }) => {
	const constants = require('../constants');
	const ExportHelper = require('../casc/export-helper');

	const data = await casc.getFile(fileDataID);
	const out = ExportHelper.getExportPath(fileName);
	const converted = (ext) => ExportHelper.replaceExtension(out, ext);
	const manifest = [];

	const magic = data.readUInt32LE();
	data.seek(0);

	let exporter;
	let type;
	const lowerName = fileName.toLowerCase();

	if (magic === constants.MAGIC.MD21 || lowerName.endsWith('.m2')) {
		exporter = new (require('../3D/exporters/M2Exporter'))(data, [], fileDataID);
		type = 'm2';
	} else if (magic === constants.MAGIC.M3DT || lowerName.endsWith('.m3')) {
		exporter = new (require('../3D/exporters/M3Exporter'))(data, [], fileDataID);
		type = 'm3';
	} else if (lowerName.endsWith('.wmo')) {
		exporter = new (require('../3D/exporters/WMOExporter'))(data, fileDataID);
		type = 'wmo';
	} else {
		throw fail(CODES.UNSUPPORTED, 'Not a model file (expected .m2, .m3 or .wmo): ' + fileName);
	}

	const config = core.view.config;
	let primary;

	try {
		if (format === 'raw') {
			primary = out;
			await exporter.exportRaw(out, helper, manifest);
		} else if (format === 'obj') {
			primary = converted('.obj');
			if (type === 'wmo')
				await exporter.exportAsOBJ(primary, helper, manifest, config.modelsExportSplitWMOGroups === true);
			else
				await exporter.exportAsOBJ(primary, config.modelsExportCollision, helper, manifest);
		} else if (format === 'stl') {
			primary = converted('.stl');
			if (type === 'wmo')
				await exporter.exportAsSTL(primary, helper, manifest);
			else
				await exporter.exportAsSTL(primary, config.modelsExportCollision, helper, manifest);
		} else {
			primary = converted('.' + format);
			await exporter.exportAsGLTF(primary, helper, format);
		}
	} finally {
		if (type === 'wmo')
			require('../3D/exporters/WMOExporter').clearCache();
	}

	return { type, path: primary };
};

const modelConfig = ({ animations = true, animationFilter = '', textures = true, alpha, collision, uv2, splitWMOGroups, meta } = {}) => {
	const config = {
		overwriteFiles: true,
		modelsExportTextures: textures !== false,
		modelsExportSkin: true,
		modelsExportSkel: true,
		modelsExportBone: true,
		modelsExportAnim: !!animations,
		modelsExportAnimations: !!animations,
		modelsExportAnimationFilter: String(animationFilter ?? ''),
		modelsExportWMOGroups: true
	};

	if (alpha !== undefined) config.modelsExportAlpha = !!alpha;
	if (collision !== undefined) config.modelsExportCollision = !!collision;
	if (uv2 !== undefined) config.modelsExportUV2 = !!uv2;
	if (splitWMOGroups !== undefined) config.modelsExportSplitWMOGroups = !!splitWMOGroups;
	if (meta !== undefined) {
		config.exportM2Meta = !!meta;
		config.exportWMOMeta = !!meta;
	}

	return config;
};

/**
 * Export a model (M2, M3 or WMO) with its textures and related files.
 * @param {object} options
 * @param {number|string} options.file
 * @param {string} [options.format=raw] raw, obj, stl, gltf or glb.
 * @param {boolean} [options.animations=true] Include animations (raw: .anim files; gltf/glb: baked animations).
 * @param {string} [options.animationFilter] Comma separated animation IDs to include (gltf/glb only).
 * @param {string} [options.outDir]
 */
const exportModel = ({ file, format = 'raw', animations = true, animationFilter = '', outDir, onProgress, ...options } = {}) => {
	format = lower(format, 'raw');
	if (MODEL_FORMATS[format] === undefined)
		throw fail(CODES.INVALID_PARAMS, 'Unknown model format "' + format + '" (expected ' + Object.keys(MODEL_FORMATS).join(', ') + ')');

	const config = modelConfig({ animations, animationFilter, ...options });

	return runJob({ outDir, onProgress, config }, async ({ casc, core }) => {
		const { fileDataID, fileName } = resolveFile(file);
		if (!inBuild(casc, fileDataID))
			throw fail(CODES.NOT_FOUND, 'File ' + fileDataID + ' (' + fileName + ') is not in this build');

		const helper = startHelper(1, 'model');

		try {
			const { type, path: primary } = await exportOneModel({ casc, core, fileDataID, fileName, format, helper });
			helper.mark(fileName, true);
			return { fileDataID, fileName, type, format, path: primary };
		} finally {
			helper.finish();
		}
	});
};

/**
 * Export several models (M2, M3 or WMO) with their textures and related files.
 * Models that fail are listed in `failed`; the others are still exported.
 * @param {object} options
 * @param {Array<number|string>} options.files
 * @param {string} [options.format=obj] raw, obj, stl, gltf or glb.
 * @param {boolean} [options.textures=true]
 * @param {boolean} [options.alpha] Keep texture alpha.
 * @param {boolean} [options.collision] Include collision geometry (obj/stl).
 * @param {boolean} [options.animations=true]
 * @param {string} [options.animationFilter]
 * @param {boolean} [options.uv2] Include the second UV set.
 * @param {boolean} [options.splitWMOGroups] Write each WMO group to its own OBJ.
 * @param {boolean} [options.meta] Write M2/WMO metadata JSON.
 * @param {string} [options.outDir]
 */
const exportModels = ({ files, format = 'obj', outDir, onProgress, ...options } = {}) => {
	format = lower(format, 'obj');
	if (MODEL_FORMATS[format] === undefined)
		throw fail(CODES.INVALID_PARAMS, 'Unknown model format "' + format + '" (expected ' + Object.keys(MODEL_FORMATS).join(', ') + ')');

	const config = modelConfig(options);

	return runJob({ outDir, onProgress, config }, async ({ casc, core, job }) => {
		const resolved = resolveBatch(casc, files, job);
		job.total = files.length;

		const exported = [];
		const helper = startHelper(resolved.length, 'model');

		try {
			// Models share texture de-duplication and WMO caches, so they run in order.
			for (const entry of resolved) {
				if (job.cancelled)
					break;

				try {
					const { type, path: primary } = await exportOneModel({ casc, core, fileDataID: entry.fileDataID, fileName: entry.fileName, format, helper });
					exported.push({ fileDataID: entry.fileDataID, fileName: entry.fileName, type, path: primary });
					job.item(entry.fileName, true, null, null, files.length);
				} catch (e) {
					job.item(entry.fileName, false, e.message, e.code ?? CODES.EXPORT_FAILED, files.length);
				}
			}
		} finally {
			helper.finish();
		}

		job.throwIfCancelled();
		return { requested: files.length, format, exported: exported.length, models: exported.slice(0, MAX_LISTED_FILES) };
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
	if (map === undefined || map === null || String(map).trim() === '')
		throw fail(CODES.INVALID_PARAMS, 'A map ID or directory name is required');

	const { maps } = await listMaps();

	let entry;
	if (typeof map === 'number' || /^\d+$/.test(String(map)))
		entry = maps.find(e => e.id === Number(map));
	else
		entry = maps.find(e => String(e.directory).toLowerCase() === String(map).toLowerCase());

	if (entry === undefined)
		throw fail(CODES.NOT_FOUND, 'Unknown map: ' + map + ' (use list_maps to find the map ID or directory)');

	return entry;
};

const loadMapTiles = async (casc, map) => {
	const WDTLoader = require('../3D/loaders/WDTLoader');
	const dir = String(map.directory).toLowerCase();

	let data;
	try {
		data = await casc.getFileByName(util.format('world/maps/%s/%s.wdt', dir, dir));
	} catch (e) {
		throw fail(CODES.NOT_FOUND, 'Map ' + map.directory + ' has no WDT in this build: ' + e.message);
	}

	const wdt = new WDTLoader(data);
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
	if (typeof tile === 'number') {
		if (!Number.isInteger(tile) || tile < 0 || tile >= MAP_SIZE * MAP_SIZE)
			throw fail(CODES.INVALID_PARAMS, 'Invalid tile index ' + tile);
		return tile;
	}

	const match = String(tile).match(/^(\d+)[_, ](\d+)$/);
	if (!match || Number(match[1]) >= MAP_SIZE || Number(match[2]) >= MAP_SIZE)
		throw fail(CODES.INVALID_PARAMS, 'Invalid tile "' + tile + '" (expected "<row>_<column>", e.g. "32_48")');

	return Number(match[1]) * MAP_SIZE + Number(match[2]);
};

/**
 * Turn a tile selection into tile indices and check them against the map.
 * @returns {number[]}
 */
const selectTiles = (tiles, available, entry) => {
	const availableSet = new Set(available.tiles);

	let selected;
	if (tiles === 'all' || tiles === undefined || tiles === null) {
		selected = available.tiles;
	} else {
		selected = [...new Set((Array.isArray(tiles) ? tiles : String(tiles).split(/[\s;]+/).filter(Boolean)).map(parseTile))];

		const missing = selected.filter(index => !availableSet.has(index));
		if (missing.length > 0)
			throw fail(CODES.NOT_ON_MAP, 'Map ' + entry.directory + ' has no terrain tile(s): ' + missing.map(tileName).join(', ') + ' (use list_map_tiles)');
	}

	if (selected.length === 0)
		throw fail(CODES.NOT_ON_MAP, 'Map ' + entry.directory + ' has no terrain tiles to export');

	return selected;
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
 * Export heightmaps of terrain tiles as PNG, normalised across the selection.
 */
const exportHeightmaps = async ({ casc, entry, selected, resolution, bitDepth, job }) => {
	const ADTExporter = require('../3D/exporters/ADTExporter');
	const PNGWriter = require('../png-writer');
	const ExportHelper = require('../casc/export-helper');
	const { extract_height_data_from_tile, fill_heightmap_pixels } = require('../3D/heightmap');

	const mapDir = String(entry.directory).toLowerCase();
	const dir = ExportHelper.getExportPath(path.join('maps', mapDir, 'heightmaps'));

	// Heights are normalised over every selected tile, so tiles line up.
	const heights = new Map();
	let min = Infinity;
	let max = -Infinity;

	for (const index of selected) {
		job.throwIfCancelled();

		const data = await extract_height_data_from_tile(new ADTExporter(entry.id, mapDir, index), resolution);
		if (!data?.heights) {
			job.item('heightmap_' + tileName(index) + '.png', false, 'no height data available', CODES.EXPORT_FAILED, selected.length);
			continue;
		}

		for (const h of data.heights) {
			if (h < min) min = h;
			if (h > max) max = h;
		}

		heights.set(index, data.heights);
	}

	for (const [index, tileHeights] of heights) {
		job.throwIfCancelled();

		const file = path.join(dir, 'heightmap_' + tileName(index) + '.png');
		try {
			const writer = new PNGWriter(resolution, resolution);
			fill_heightmap_pixels(writer, tileHeights, min, max - min, bitDepth);
			await writer.write(file);
			job.item(path.relative(dir, file), true, null, null, selected.length);
		} catch (e) {
			job.item(path.relative(dir, file), false, e.message, CODES.EXPORT_FAILED, selected.length);
		}
	}

	return { path: dir, heightRange: heights.size > 0 ? { min, max } : null, resolution, bitDepth };
};

/**
 * Export terrain tiles of a map, with the models placed on them.
 * @param {object} options
 * @param {number|string} options.map Map ID or directory name.
 * @param {Array<string>|string} [options.tiles=all] Tile names ("32_48"), or "all".
 * @param {string} [options.format=raw] raw, obj (terrain mesh without baked textures) or heightmap.
 * @param {boolean} [options.models=true] Include placed M2 doodads.
 * @param {boolean} [options.wmos=true] Include placed WMOs.
 * @param {boolean} [options.foliage=true]
 * @param {boolean} [options.liquids=true]
 * @param {boolean} [options.animations=false] Include .anim files of placed models (raw only).
 * @param {boolean} [options.resume=false] Skip tiles completed by an earlier export into the same directory.
 * @param {number} [options.heightmapResolution=256] Pixels per tile side (heightmap only).
 * @param {number} [options.heightmapBitDepth=16] 8, 16 or 32 (heightmap only).
 * @param {string} [options.outDir]
 */
const exportMap = ({ map, tiles = 'all', format = 'raw', models = true, wmos = true, foliage = true, liquids = true, animations = false, resume = false, heightmapResolution = 256, heightmapBitDepth = 16, outDir, onProgress } = {}) => {
	format = lower(format, 'raw');
	if (format !== 'raw' && format !== 'obj' && format !== 'heightmap')
		throw fail(CODES.INVALID_PARAMS, 'Unknown map format "' + format + '" (expected raw, obj or heightmap)');

	if (format === 'heightmap') {
		if (!Number.isInteger(heightmapResolution) || heightmapResolution < 1 || heightmapResolution > 4096)
			throw fail(CODES.INVALID_PARAMS, 'heightmapResolution must be an integer from 1 to 4096');

		if (!HEIGHTMAP_BIT_DEPTHS.includes(heightmapBitDepth))
			throw fail(CODES.INVALID_PARAMS, 'heightmapBitDepth must be 8, 16 or 32');
	}

	const config = {
		exportMapFormat: format === 'obj' ? 'OBJ' : 'RAW',
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

	return runJob({ outDir, onProgress, config }, async ({ casc, job }) => {
		const generics = require('../generics');
		const ExportHelper = require('../casc/export-helper');
		const ADTExporter = require('../3D/exporters/ADTExporter');

		const entry = await resolveMap(map);
		const available = await loadMapTiles(casc, entry);
		const selected = selectTiles(tiles, available, entry);
		job.total = selected.length;

		if (format === 'heightmap') {
			const result = await exportHeightmaps({ casc, entry, selected, resolution: heightmapResolution, bitDepth: heightmapBitDepth, job });
			return Object.assign({ map: entry, format, tilesRequested: selected.length, tilesExported: selected.length - job.failed.length }, result);
		}

		const mapDir = String(entry.directory).toLowerCase();
		const dir = ExportHelper.getExportPath(path.join('maps', mapDir));
		const helper = startHelper(selected.length, 'tile');
		const failed = [];

		// Resuming relies on a record of completed tiles kept beside the export.
		const stateFile = path.join(dir, '.wow_export_tiles.json');
		const signature = format + ':' + (casc.build?.BuildConfig ?? casc.build?.BuildKey ?? '') + ':' + [models, wmos, foliage, liquids, animations].map(e => e ? 1 : 0).join('');

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

				if (job.cancelled)
					return;

				try {
					const out = await new ADTExporter(entry.id, mapDir, index).export(dir, 0, undefined, helper);
					if (!out)
						throw fail(CODES.CANCELLED, 'export was cancelled');

					helper.mark(tileName(index), true);
					completed.add(index);

					if (++sinceSave >= 16) {
						sinceSave = 0;
						await saveState();
					}
				} catch (e) {
					if (job.cancelled)
						return;

					failed.push({ tile: tileName(index), error: e.message });
					helper.mark(tileName(index), false, e.message);
				}
			}, format === 'raw' ? Math.min(4, ExportHelper.getConcurrency()) : 1);

			await saveState();
		} finally {
			ADTExporter.clearCache();
			helper.finish();
		}

		job.throwIfCancelled();

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

// --- database tables -------------------------------------------------------

let tableNames = null;

/**
 * Names of the DB2 tables with known definitions.
 * @returns {Promise<string[]>}
 */
const getTableNames = async () => {
	if (tableNames === null || tableNames.length === 0) {
		const manifest = require('../casc/dbd-manifest');
		await manifest.prepareManifest();
		tableNames = manifest.getAllTableNames();
	}

	return tableNames;
};

/**
 * Resolve a table name (any case) to the name the definitions use.
 * @param {string} table
 * @returns {Promise<string>}
 */
const resolveTable = async (table) => {
	if (typeof table !== 'string' || !/^[A-Za-z0-9_]+$/.test(table))
		throw fail(CODES.INVALID_PARAMS, 'A table name is required (letters, digits and underscores only)');

	const names = await getTableNames();
	if (names.includes(table))
		return table;

	const match = names.find(name => name.toLowerCase() === table.toLowerCase());
	if (match !== undefined)
		return match;

	// Without a definitions manifest, fall back to the listfile.
	const listfile = require('../casc/listfile');
	if (names.length === 0 && listfile.getByFilename('dbfilesclient/' + table.toLowerCase() + '.db2') > 0)
		return table;

	throw fail(CODES.NOT_FOUND, 'Unknown table: ' + table + ' (use list_tables to find table names)');
};

/**
 * List DB2 table names.
 * @param {object} [options]
 * @param {string} [options.query] Only tables whose name contains this text.
 */
const listTables = async ({ query } = {}) => {
	await open();

	const needle = typeof query === 'string' && query.length > 0 ? query.toLowerCase() : null;
	const names = (await getTableNames()).filter(name => needle === null || name.toLowerCase().includes(needle));
	return { count: names.length, tables: names };
};

const describeType = (schemaType) => {
	const [symbol, arrayLength] = Array.isArray(schemaType) ? schemaType : [schemaType, 0];
	const type = String(symbol?.description ?? symbol).replace(/^dbField/, '');
	return arrayLength > 0 ? { type, arrayLength } : { type };
};

/**
 * Describe a DB2 table: its columns and row count.
 * @param {object} options
 * @param {string} options.table
 */
const describeTable = async ({ table } = {}) => {
	await open();

	const name = await resolveTable(table);
	const WDCReader = require('../db/WDCReader');
	const reader = new WDCReader('DBFilesClient/' + name + '.db2');

	try {
		await reader.parse();
	} catch (e) {
		throw fail(CODES.EXPORT_FAILED, 'Unable to read table ' + name + ': ' + e.message);
	}

	// Columns in the order CSV and SQL exports use: ID first.
	const columns = [...reader.schema.entries()].map(([column, type]) => Object.assign({ name: column }, describeType(type)));
	const idIndex = columns.findIndex(column => column.name.toUpperCase() === 'ID');
	if (idIndex > 0)
		columns.unshift(columns.splice(idIndex, 1)[0]);

	return { table: name, rowCount: reader.size, columnCount: columns.length, columns };
};

/**
 * Export DB2 tables as CSV, SQL or the raw DB2 file.
 * @param {object} options
 * @param {string[]} options.tables
 * @param {string} [options.format=csv] csv, sql or db2.
 * @param {boolean} [options.sqlCreateTable=true] Include DROP/CREATE TABLE statements (sql only).
 * @param {string} [options.outDir]
 */
const exportTable = ({ tables, format = 'csv', sqlCreateTable = true, outDir, onProgress } = {}) => {
	format = lower(format, 'csv');
	if (TABLE_FORMATS[format] === undefined)
		throw fail(CODES.INVALID_PARAMS, 'Unknown table format "' + format + '" (expected csv, sql or db2)');

	if (typeof tables === 'string')
		tables = [tables];

	if (!Array.isArray(tables) || tables.length === 0)
		throw fail(CODES.INVALID_PARAMS, 'A list of table names is required');

	return runJob({ outDir, onProgress, config: { overwriteFiles: true } }, async ({ job }) => {
		const parse_table = require('../db/parse-table');
		const dataExporter = require('../ui/data-exporter');
		const manifest = require('../casc/dbd-manifest');
		const ExportHelper = require('../casc/export-helper');

		job.total = tables.length;
		const exported = [];

		for (const table of tables) {
			if (job.cancelled)
				break;

			let name;
			try {
				name = await resolveTable(table);
			} catch (e) {
				job.item(String(table), false, e.message, e.code ?? CODES.NOT_FOUND, tables.length);
				continue;
			}

			const helper = new ExportHelper(1, 'table');
			const failedBefore = job.failed.length;

			try {
				if (format === 'db2') {
					const fileDataID = manifest.getByTableName(name) ?? require('../casc/listfile').getByFilename('dbfilesclient/' + name.toLowerCase() + '.db2');
					if (!(fileDataID > 0))
						throw fail(CODES.NOT_FOUND, 'No DB2 file known for table ' + name);

					await dataExporter.exportRawDB2(name, fileDataID, { helper });
				} else {
					const { headers, rows, schema } = await parse_table(name);
					if (rows.length === 0) {
						job.item(name, false, 'table has no rows', CODES.NOT_FOUND, tables.length);
						continue;
					}

					if (format === 'csv')
						await dataExporter.exportDataTable(headers, rows, name, { helper });
					else
						await dataExporter.exportDataTableSQL(headers, rows, name, schema, sqlCreateTable !== false, { helper });
				}

				// The data exporter reports through helper.mark(), which records progress and failures.
				if (job.failed.length === failedBefore)
					exported.push({ table: name, file: name + '.' + format });
			} catch (e) {
				job.item(name, false, e.message, e.code ?? CODES.EXPORT_FAILED, tables.length);
			}
		}

		job.throwIfCancelled();
		return { requested: tables.length, format, exported: exported.length, tables: exported };
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

	const name = await resolveTable(table);
	const db2 = require('../casc/db2');
	const reader = db2[name];

	const serialise = (row) => JSON.parse(JSON.stringify(row, (key, value) => typeof value === 'bigint' ? value.toString() : value));

	if (where !== undefined && where !== null && (typeof where !== 'object' || Array.isArray(where)))
		throw fail(CODES.INVALID_PARAMS, 'where must be an object of column/value pairs');

	try {
		if (id !== undefined && id !== null) {
			const row = await reader.getRow(Number(id));
			return { table: name, total: row ? 1 : 0, count: row ? 1 : 0, rows: row ? [Object.assign({ ID: Number(id) }, serialise(row))] : [] };
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

		return { table: name, total, offset, count: rows.length, rows };
	} catch (e) {
		if (e.code !== undefined && CODES[e.code] !== undefined)
			throw e;

		throw fail(CODES.EXPORT_FAILED, 'Unable to read table ' + name + ': ' + e.message);
	}
};

module.exports = {
	open,
	info,
	search,
	fileInfo,
	getFile,
	exportFiles,
	exportTextures,
	exportModel,
	exportModels,
	listMaps,
	listMapTiles,
	exportMap,
	listTables,
	describeTable,
	exportTable,
	queryTable,
	cancel,
	isBusy,
	getDefaultOutputDirectory
};
