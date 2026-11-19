// MCP tools offered to agents. Read-only lookups are answered directly;
// exports become jobs whose files are downloaded over HTTP.
const { z } = require('zod');
const { ServiceError } = require('./util');
const { TERMINAL } = require('./jobs');

const PRODUCT = z.string().regex(/^[a-z0-9_]{1,32}$/).optional()
	.describe('Game product, e.g. "wowf" (WoW Forever, the default, from the local install), "wow" (retail), "wow_classic", "wow_classic_era". Other products are opened from Blizzard\'s CDN, which takes about a minute the first time.');
const FILE = z.union([z.number().int().positive(), z.string().min(1).max(512)])
	.describe('A fileDataID (number) or a file name from the listfile, e.g. "creature/murloc/murloc.m2". Use search to find names.');
const FILES = z.array(FILE).min(1).max(20000);
const FORCE = z.boolean().optional().describe('Export again even if an identical finished result is cached. Defaults to false.');
const WAIT = z.number().int().min(0).max(45).optional().describe('Seconds to wait for the export to finish before returning (default 40). If it is still running, call wait_for_job.');
const LABEL = z.string().max(120).optional().describe('Free text shown in list_jobs.');
const PRIORITY = z.enum(['normal', 'low']).optional().describe('low lets other jobs go first. Defaults to normal.');
const MAP = z.union([z.number().int().min(0), z.string().min(1).max(64)]).describe('Map ID or directory name, e.g. 0 or "azeroth". Use list_maps.');
const TILE = z.string().regex(/^\d{1,2}_\d{1,2}$/, 'Tiles are named "<row>_<column>", e.g. "32_48"');

const INSTRUCTIONS = `wow-export serves World of Warcraft game files and exports from a machine that has the game data.

Workflow:
1. Find what you need: search (file names), list_maps / list_map_tiles (terrain), list_tables / describe_table / query_table (database tables), file_info.
2. Ask for an export (get_file, export_files, export_textures, export_model, export_models, export_map, export_table). Each export is a job. The call waits up to 40 seconds, so small exports come back finished.
3. If the status is "queued" or "running", call wait_for_job with the job_id until it is "done" (or "partial" / "failed" / "cancelled").
4. Download the files: call get_download_script and run the script it returns (it uses curl, verifies every SHA-256 and reads the token from $WOW_EXPORT_TOKEN), or fetch the zip_url / individual file URLs with an "Authorization: Bearer $WOW_EXPORT_TOKEN" header. If local_path is present you are on the same machine and can read the files directly.

Notes:
- Identical requests are served from a cache instantly; pass force: true to export again.
- product selects the game version; the default is WoW Forever ("wowf").
- "partial" means some items failed; see failed[] for each item and its error. Errors have a code and a hint.
- Exports never write into your workspace; you choose where to download them.`;

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] });

const errorResult = (e) => {
	const err = e instanceof ServiceError ? e.toJSON() : { code: 'INTERNAL', message: e.message ?? String(e), retryable: false };
	return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: err }, null, 1) }] };
};

const normaliseFile = (file) => typeof file === 'number' ? file
	: /^\d+$/.test(file.trim()) ? Number(file.trim())
		: file.trim().toLowerCase().replace(/\\/g, '/');

/** Sorted, de-duplicated file list (order does not change the output). */
const normaliseFiles = (files) => {
	const set = new Map();
	for (const f of files.map(normaliseFile))
		set.set(typeof f + ':' + f, f);
	return [...set.values()].sort((a, b) => typeof a === typeof b ? (a < b ? -1 : a > b ? 1 : 0) : typeof a === 'number' ? -1 : 1);
};

const normaliseTiles = (tiles) => {
	if (tiles === undefined || tiles === 'all')
		return 'all';
	return [...new Set(tiles.map(t => t.split('_').map(n => String(Number(n))).join('_')))].sort();
};

const normaliseMap = (map) => typeof map === 'number' ? map : /^\d+$/.test(map) ? Number(map) : map.toLowerCase();

/**
 * Build the tool list for one request.
 * @param {object} svc { jobs, cache, pool, config }
 * @param {object} ctx { token, baseUrl, local }
 */
const buildTools = (svc, ctx) => {
	const { jobs, cache, config } = svc;
	const product = (p) => p ?? config.defaultProduct;

	const fileUrl = (key, rel) => ctx.baseUrl + '/files/' + key + '/' + rel.split('/').map(encodeURIComponent).join('/');

	/** What an agent needs to collect a finished job. */
	const describeJob = async (job) => {
		const out = jobs.snapshot(job);
		if (job.resultKey && (job.status === 'done' || job.status === 'partial')) {
			const manifest = await cache.get(job.resultKey);
			if (manifest === null) {
				out.error = { code: 'NOT_FOUND', message: 'The result has expired from the cache', hint: 'Submit the export again.', retryable: true };
				return out;
			}
			cache.touch(job.resultKey);
			out.download = {
				zip_url: ctx.baseUrl + '/zip/' + job.resultKey,
				manifest_url: ctx.baseUrl + '/manifest/' + job.resultKey,
				auth_header: 'Authorization: Bearer $WOW_EXPORT_TOKEN',
				hint: 'Call get_download_script for a ready-made script that downloads and verifies every file.'
			};
			if (ctx.local)
				out.local_path = cache.filesDir(job.resultKey);
			out.files = manifest.files.slice(0, 20).map(f => ({ path: f.path, size: f.size, url: fileUrl(job.resultKey, f.path) }));
			if (manifest.files.length > 20)
				out.files_truncated = { shown: 20, total: manifest.files.length, hint: 'Use get_manifest for the full list.' };
			if (manifest.result)
				out.result = trimResult(manifest.result);
		}
		return out;
	};

	const trimResult = (result) => {
		const copy = Object.assign({}, result);
		// The manifest already lists files and the engine's own list is relative to staging.
		delete copy.files;
		delete copy.filesTruncated;
		delete copy.outputDirectory;
		delete copy.path;
		delete copy.profile;
		return copy;
	};

	const submit = async (tool, kind, params, args) => {
		const job = await jobs.submit({ tool, kind, params, product: product(args.product), force: args.force, token: ctx.token, label: args.label, priority: args.priority });
		const waited = await jobs.wait(job.id, ctx.token, (args.wait ?? config.waitSeconds) * 1000);
		return describeJob(waited);
	};

	const exportCommon = { product: PRODUCT, force: FORCE, wait: WAIT, label: LABEL, priority: PRIORITY };

	const tools = [];
	const tool = (name, description, inputSchema, handler) => tools.push({ name, description, inputSchema, handler });

	tool('service_status', 'State of the export service: engines, game builds, queue, cache size and free disk space.', {}, async () => {
		const usage = await cache.usage();
		return {
			engines: svc.pool.describe(),
			default_product: config.defaultProduct,
			local_products: Object.keys(config.sources ?? {}),
			queued_jobs: jobs.queueDepth(),
			cache: { results: usage.results, total_gb: +(usage.totalBytes / 1024 ** 3).toFixed(2), budget_gb: config.diskBudgetGB },
			free_disk_gb: +((await cache.freeBytes()) / 1024 ** 3).toFixed(1)
		};
	});

	tool('info', 'Describe the game build that is open for a product (version, product, file count).', { product: PRODUCT },
		(args) => jobs.query(product(args.product), 'info', {}));

	tool('search', 'Search game file names. Returns fileDataIDs and file names for use with the export tools. Covers textures, models, sounds, text files and fonts.', {
		query: z.string().min(1).max(200).describe('Space separated terms that must all appear in the file name, e.g. "murloc skin".'),
		type: z.enum(['any', 'texture', 'model', 'sound', 'text', 'font']).optional().describe('Limit results to one kind of file. Defaults to any.'),
		limit: z.number().int().min(1).max(500).optional().describe('Maximum results (default 50).'),
		offset: z.number().int().min(0).optional().describe('Matches to skip, for paging.'),
		product: PRODUCT
	}, (args) => {
		if (/^\/.*\/[a-z]*$/.test(args.query.trim()))
			throw new ServiceError('INVALID_PARAMS', 'Regular expressions are not supported here', { hint: 'Use space separated terms instead.' });
		return jobs.query(product(args.product), 'search', { query: args.query, type: args.type ?? 'any', limit: args.limit ?? 50, offset: args.offset ?? 0, allowRegex: false });
	});

	tool('file_info', 'Resolve files between fileDataID and name, and check whether they exist in the build.', { files: z.array(FILE).min(1).max(500), product: PRODUCT },
		(args) => jobs.query(product(args.product), 'file_info', { files: args.files.map(normaliseFile) }));

	tool('list_maps', 'List maps (continents, dungeons, raids, battlegrounds) with IDs and directory names.', { query: z.string().max(100).optional().describe('Only maps whose name or directory contains this text.'), product: PRODUCT },
		(args) => jobs.query(product(args.product), 'list_maps', { query: args.query }));

	tool('list_map_tiles', 'List the terrain tiles of a map. Tiles are named "<row>_<column>", like the game\'s ADT files.', { map: MAP, product: PRODUCT },
		(args) => jobs.query(product(args.product), 'list_map_tiles', { map: normaliseMap(args.map) }));

	tool('list_tables', 'List the client database (DB2) tables.', { query: z.string().max(100).optional().describe('Only tables whose name contains this text.'), product: PRODUCT },
		(args) => jobs.query(product(args.product), 'list_tables', { query: args.query }));

	tool('describe_table', 'Columns, types and row count of a DB2 table.', { table: z.string().regex(/^[A-Za-z0-9_]{1,64}$/), product: PRODUCT },
		(args) => jobs.query(product(args.product), 'describe_table', { table: args.table }));

	tool('query_table', 'Read rows from a DB2 table, e.g. Map, AreaTable, CreatureDisplayInfo or ItemSparse.', {
		table: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
		id: z.number().int().optional().describe('Only the row with this ID.'),
		where: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Column/value pairs a row must match exactly.'),
		limit: z.number().int().min(1).max(500).optional().describe('Maximum rows (default 50).'),
		offset: z.number().int().min(0).optional(),
		product: PRODUCT
	}, (args) => jobs.query(product(args.product), 'query_table', { table: args.table, id: args.id, where: args.where, limit: args.limit ?? 50, offset: args.offset ?? 0 }));

	tool('get_file', 'Export one game file, unmodified or (BLP textures) converted to PNG.', {
		file: FILE,
		format: z.enum(['raw', 'png']).optional().describe('raw (default) or png for BLP textures.'),
		...exportCommon
	}, (args) => submit('get_file', 'get_file', { file: normaliseFile(args.file), format: args.format ?? 'raw' }, args));

	tool('export_files', 'Export several game files unmodified (any type: models, textures, sounds, text, fonts...). Sounds with unknown extensions are named .ogg or .mp3 by their contents.', {
		files: FILES,
		...exportCommon
	}, (args) => submit('export_files', 'export_files', { files: normaliseFiles(args.files) }, args));

	tool('export_textures', 'Export textures as PNG, WebP or BLP.', {
		files: FILES,
		format: z.enum(['png', 'webp', 'blp']).optional().describe('Defaults to png.'),
		...exportCommon
	}, (args) => submit('export_textures', 'export_textures', { files: normaliseFiles(args.files), format: args.format ?? 'png' }, args));

	const MODEL_OPTIONS = {
		format: z.enum(['raw', 'obj', 'stl', 'gltf', 'glb']).optional().describe('raw copies the game files; obj, stl, gltf and glb convert. Defaults to glb.'),
		textures: z.boolean().optional().describe('Export textures (default true).'),
		alpha: z.boolean().optional().describe('Keep texture alpha (default true).'),
		animations: z.boolean().optional().describe('Include animations (default true).'),
		animationFilter: z.string().max(500).optional().describe('gltf/glb: comma separated animation IDs to include, e.g. "0,4,5". Empty includes all.'),
		collision: z.boolean().optional().describe('obj: include collision geometry (default false).'),
		uv2: z.boolean().optional().describe('Include a second UV set (default false).'),
		splitWMOGroups: z.boolean().optional().describe('WMO obj: one file per group (default false).'),
		meta: z.boolean().optional().describe('Write JSON metadata next to the model (default false).')
	};

	const modelParams = (args) => {
		const p = { format: args.format ?? 'glb' };
		for (const key of ['textures', 'alpha', 'animations', 'animationFilter', 'collision', 'uv2', 'splitWMOGroups', 'meta']) {
			if (args[key] !== undefined)
				p[key] = args[key];
		}
		return p;
	};

	tool('export_model', 'Export one model (M2, M3 or WMO) with its textures and related files.', { file: FILE, ...MODEL_OPTIONS, ...exportCommon },
		(args) => submit('export_model', 'export_model', Object.assign({ file: normaliseFile(args.file) }, modelParams(args)), args));

	tool('export_models', 'Export several models in one job, with their textures.', { files: FILES, ...MODEL_OPTIONS, ...exportCommon },
		(args) => submit('export_models', 'export_models', Object.assign({ files: normaliseFiles(args.files) }, modelParams(args)), args));

	tool('export_map', 'Export terrain tiles of a map with everything placed on them (models, WMOs, foliage, liquids). Whole continents are many gigabytes; pass specific tiles unless the whole map is needed.', {
		map: MAP,
		tiles: z.union([z.literal('all'), z.array(TILE).min(1).max(1024)]).optional().describe('Tile names such as ["32_48", "32_49"], or "all". Use list_map_tiles.'),
		format: z.enum(['raw', 'obj']).optional().describe('raw (default) copies the game files; obj converts terrain and models (terrain textures are not baked).'),
		models: z.boolean().optional().describe('Include placed M2 doodads (default true).'),
		wmos: z.boolean().optional().describe('Include placed WMOs (default true).'),
		foliage: z.boolean().optional().describe('Include ground foliage (default true).'),
		liquids: z.boolean().optional().describe('Include liquids (default true).'),
		animations: z.boolean().optional().describe('raw: include .anim files of placed models (default false).'),
		...exportCommon
	}, (args) => {
		const params = { map: normaliseMap(args.map), tiles: normaliseTiles(args.tiles), format: args.format ?? 'raw' };
		for (const key of ['models', 'wmos', 'foliage', 'liquids', 'animations']) {
			if (args[key] !== undefined)
				params[key] = args[key];
		}
		return submit('export_map', 'export_map', params, args);
	});

	tool('export_table', 'Export whole DB2 tables as CSV, SQL or the raw DB2 file.', {
		tables: z.array(z.string().regex(/^[A-Za-z0-9_]{1,64}$/)).min(1).max(500),
		format: z.enum(['csv', 'sql', 'db2']).optional().describe('Defaults to csv.'),
		sqlCreateTable: z.boolean().optional().describe('sql: include CREATE TABLE statements (default true).'),
		...exportCommon
	}, (args) => {
		const params = { tables: [...new Set(args.tables)].sort(), format: args.format ?? 'csv' };
		if (args.sqlCreateTable !== undefined)
			params.sqlCreateTable = args.sqlCreateTable;
		return submit('export_table', 'export_table', params, args);
	});

	tool('wait_for_job', 'Wait for a job to finish (up to 45 seconds per call) and return its status and download details.', {
		job_id: z.string().max(64),
		timeout_seconds: z.number().int().min(0).max(45).optional().describe('Default 40.')
	}, async (args) => describeJob(await jobs.wait(args.job_id, ctx.token, (args.timeout_seconds ?? config.waitSeconds) * 1000)));

	tool('get_job', 'Current status of a job, without waiting.', { job_id: z.string().max(64) },
		(args) => describeJob(jobs.get(args.job_id, ctx.token)));

	tool('get_manifest', 'Full file list of a finished job (paged): path, size, SHA-256 and download URL.', {
		job_id: z.string().max(64),
		offset: z.number().int().min(0).optional(),
		limit: z.number().int().min(1).max(500).optional().describe('Default 200.')
	}, async (args) => {
		const job = jobs.get(args.job_id, ctx.token);
		if (!job.resultKey)
			throw new ServiceError('NOT_FOUND', 'Job ' + job.id + ' has no result yet (status ' + job.status + ')', { retryable: !TERMINAL.has(job.status), hint: 'Call wait_for_job first.' });
		const manifest = await cache.get(job.resultKey);
		if (manifest === null)
			throw new ServiceError('NOT_FOUND', 'The result has expired from the cache', { hint: 'Submit the export again.' });
		const offset = args.offset ?? 0;
		const limit = args.limit ?? 200;
		return {
			job_id: job.id,
			total: manifest.files.length,
			total_bytes: manifest.totalBytes,
			offset,
			files: manifest.files.slice(offset, offset + limit).map(f => ({ path: f.path, size: f.size, sha256: f.sha256, url: fileUrl(job.resultKey, f.path) }))
		};
	});

	tool('get_download_script', 'A script that downloads every file of a finished job with curl and verifies each SHA-256. Run it where you want the files; it reads the token from $WOW_EXPORT_TOKEN.', {
		job_id: z.string().max(64),
		shell: z.enum(['bash', 'powershell']).optional().describe('Defaults to bash.'),
		dest: z.string().max(260).optional().describe('Destination directory (default ./wow-export/<job_id>).')
	}, async (args) => {
		const job = jobs.get(args.job_id, ctx.token);
		if (!job.resultKey)
			throw new ServiceError('NOT_FOUND', 'Job ' + job.id + ' has no result yet (status ' + job.status + ')', { retryable: !TERMINAL.has(job.status), hint: 'Call wait_for_job first.' });
		if (await cache.get(job.resultKey) === null)
			throw new ServiceError('NOT_FOUND', 'The result has expired from the cache', { hint: 'Submit the export again.' });
		const scripts = require('./scripts');
		const dest = args.dest ?? ('wow-export/' + job.id);
		const shell = args.shell ?? 'bash';
		return {
			job_id: job.id,
			shell,
			dest,
			script: shell === 'bash' ? scripts.bash(ctx.baseUrl, job.resultKey, dest) : scripts.powershell(ctx.baseUrl, job.resultKey, dest),
			usage: shell === 'bash' ? 'Save as fetch.sh and run: WOW_EXPORT_TOKEN=... bash fetch.sh' : 'Save as fetch.ps1 and run with $env:WOW_EXPORT_TOKEN set.'
		};
	});

	tool('cancel_job', 'Cancel a queued or running job. If other agents asked for the same export, only your request is withdrawn.', { job_id: z.string().max(64) },
		async (args) => describeJob(jobs.cancel(args.job_id, ctx.token)));

	tool('list_jobs', 'Your recent jobs, newest first.', { limit: z.number().int().min(1).max(100).optional() },
		(args) => ({ jobs: jobs.list(ctx.token, args.limit ?? 20).map(j => jobs.snapshot(j)) }));

	return tools;
};

module.exports = { buildTools, INSTRUCTIONS, json, errorResult, normaliseFiles, normaliseTiles, normaliseFile };
