/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Full map tile export tests. Starts a built wow.export in headless test mode
// (see src/js/export-test-runner.js), exports the tiles a suite describes from
// a real WoW installation, then checks the output and reports timings.
//
// Everything is kept apart from normal use of wow.export:
//  - the app runs with its own data directory (config, runtime.log, CASC
//    cache), so it can run while your normal wow.export is open and never
//    changes its settings;
//  - exports go to ~/wow.export-tests (not your export directory).
//
//   node tests/export-scale/run.js                    smoke suite
//   node tests/export-scale/run.js --suite standard   16 tiles per format
//   node tests/export-scale/run.js --suite scale      100 baked + 400 raw tiles
//   node tests/export-scale/run.js --suite path/to/suite.json
//
// Options:
//   --install <dir>     WoW install (default: the one your app last opened)
//   --product <id>      wow, wow_classic_era, wowf, ... (default: same)
//   --exe <path>        wow.export build (default: bin/win-x64/wow.export.exe)
//   --root <dir>        test area (default: ~/wow.export-tests)
//   --concurrency <n>   export concurrency setting for the run
//   --clean             delete exported files after checking them (keeps reports)
//   --timeout <min>     give up after this many minutes (default 240)
//   --label <text>      note stored with the run in the history
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { parseLog } = require('../../bench/export-profiles');

const REPO = path.join(__dirname, '..', '..');
const SUITES = path.join(__dirname, 'suites');

const parseArgs = () => {
	const args = { suite: 'smoke', timeout: 240, clean: false };
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			if (i + 1 >= argv.length)
				throw new Error(a + ' needs a value');
			return argv[++i];
		};

		if (a === '--suite') args.suite = next();
		else if (a === '--install') args.install = next();
		else if (a === '--product') args.product = next();
		else if (a === '--exe') args.exe = next();
		else if (a === '--root') args.root = next();
		else if (a === '--concurrency') args.concurrency = parseInt(next(), 10);
		else if (a === '--timeout') args.timeout = parseFloat(next());
		else if (a === '--label') args.label = next();
		else if (a === '--clean') args.clean = true;
		else if (a === '--help' || a === '-h') args.help = true;
		else throw new Error('unknown argument: ' + a);
	}
	return args;
};

/** Settings of the user's normal wow.export (read only). */
const normalAppConfig = () => {
	const base = process.platform === 'win32' ? process.env.LOCALAPPDATA : path.join(os.homedir(), '.config');
	const file = path.join(base ?? '', 'wow.export', 'User Data', 'Default', 'config.json');
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return {};
	}
};

const isInside = (child, parent) => {
	const rel = path.relative(path.resolve(parent), path.resolve(child));
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const fmtBytes = (b) => b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
const fmtSec = (ms) => (ms / 1000).toFixed(1) + 's';

/** Walk a directory, returning file count and total bytes. */
const dirStats = (dir) => {
	let files = 0, bytes = 0;
	const walk = (d) => {
		let entries;
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = path.join(d, e.name);
			if (e.isDirectory())
				walk(p);
			else {
				files++;
				bytes += fs.statSync(p).size;
			}
		}
	};
	walk(dir);
	return { files, bytes };
};

/** Count OBJ vertex and face lines without loading the file as a string. */
const objCounts = (file) => {
	const buf = fs.readFileSync(file);
	let v = 0, f = 0;
	let lineStart = true;
	for (let i = 0; i < buf.length; i++) {
		const c = buf[i];
		if (lineStart) {
			if (c === 0x76 && buf[i + 1] === 0x20) v++; // "v "
			else if (c === 0x66 && buf[i + 1] === 0x20) f++; // "f "
		}
		lineStart = c === 0x0A;
	}
	return { vertices: v, faces: f, bytes: buf.length };
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const isPNG = (file) => {
	try {
		const fd = fs.openSync(file, 'r');
		const head = Buffer.alloc(8);
		fs.readSync(fd, head, 0, 8, 0);
		fs.closeSync(fd);
		return head.equals(PNG_SIGNATURE);
	} catch {
		return false;
	}
};

/**
 * Check the files a job produced. Returns a list of problems.
 * @param {object} job Job result from the app's report.
 */
const checkJob = (job) => {
	const problems = [];
	if (job.error) {
		problems.push('job failed: ' + job.error);
		return problems;
	}

	for (const tile of job.tiles) {
		if (!tile.ok) {
			problems.push(`${tile.tile}: export failed: ${tile.error}`);
			continue;
		}

		if (job.format === 'RAW') {
			// Raw exports copy the tile's ADT files into the map folder.
			const files = fs.existsSync(job.mapDirectory) ? fs.readdirSync(job.mapDirectory) : [];
			const adts = files.filter(f => f.toLowerCase().includes('_' + tile.tile) && f.toLowerCase().endsWith('.adt'));
			tile.rawFiles = adts.length;
			if (adts.length === 0)
				problems.push(`${tile.tile}: no ADT files in ${job.mapDirectory}`);
			continue;
		}

		if (!tile.output || !fs.existsSync(tile.output)) {
			problems.push(`${tile.tile}: output missing: ${tile.output}`);
			continue;
		}

		if (job.format === 'OBJ') {
			const counts = objCounts(tile.output);
			tile.objVertices = counts.vertices;
			tile.objFaces = counts.faces;
			if (counts.vertices === 0 || counts.faces === 0)
				problems.push(`${tile.tile}: OBJ has ${counts.vertices} vertices and ${counts.faces} faces`);

			const mtl = tile.output.replace(/\.obj$/i, '.mtl');
			if (job.quality !== 0 && !fs.existsSync(mtl))
				problems.push(`${tile.tile}: material library missing`);

			if (job.quality > 0) {
				const tex = path.join(path.dirname(tile.output), 'tex_' + tile.tile + '.png');
				if (fs.existsSync(tex)) {
					if (!isPNG(tex))
						problems.push(`${tile.tile}: baked texture is not a valid PNG`);
				} else if (!fs.readdirSync(path.dirname(tile.output)).some(f => f.startsWith('tex_' + tile.tile + '_'))) {
					problems.push(`${tile.tile}: baked texture missing`);
				}
			}
		}
	}

	return problems;
};

const main = async () => {
	const args = parseArgs();
	if (args.help) {
		console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter(l => l.startsWith('//')).join('\n'));
		return 0;
	}

	const suitePath = fs.existsSync(args.suite) ? path.resolve(args.suite) : path.join(SUITES, args.suite + '.json');
	if (!fs.existsSync(suitePath))
		throw new Error('suite not found: ' + args.suite + ' (have ' + fs.readdirSync(SUITES).map(f => f.replace(/\.json$/, '')).join(', ') + ')');
	const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8'));
	const suiteName = path.basename(suitePath, '.json');

	const normal = normalAppConfig();
	const recent = Array.isArray(normal.recentLocal) ? normal.recentLocal[0] : undefined;
	const install = args.install ?? suite.install ?? recent?.path;
	const product = args.product ?? suite.product ?? (args.install ? undefined : recent?.product);
	if (!install)
		throw new Error('no install given; pass --install "<WoW folder>"');

	const exe = path.resolve(args.exe ?? path.join(REPO, 'bin', 'win-x64', process.platform === 'win32' ? 'wow.export.exe' : 'wow.export'));
	if (!fs.existsSync(exe))
		throw new Error('wow.export build not found: ' + exe + ' (build it with: bun ./build.js win-x64)');

	const root = path.resolve(args.root ?? path.join(os.homedir(), 'wow.export-tests'));
	const normalExportDir = normal.exportDirectory || path.join(os.homedir(), 'wow.export');
	if (isInside(root, normalExportDir) || isInside(normalExportDir, root))
		throw new Error(`test root ${root} overlaps your normal export directory ${normalExportDir}; pick another --root`);

	const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + suiteName;
	const runDir = path.join(root, 'runs', runId);
	const dataDir = path.join(root, 'appdata'); // kept between runs so the CASC cache is reused
	fs.mkdirSync(runDir, { recursive: true });
	fs.mkdirSync(dataDir, { recursive: true });

	const config = { ...(suite.config ?? {}) };
	if (args.concurrency)
		config.exportConcurrency = args.concurrency;

	const job = {
		install,
		product,
		region: suite.region ?? normal.sourceSelectUserRegion ?? undefined,
		outputDir: path.join(runDir, 'exports'),
		report: path.join(runDir, 'report.json'),
		config,
		jobs: suite.jobs
	};

	const jobFile = path.join(runDir, 'job.json');
	fs.writeFileSync(jobFile, JSON.stringify(job, null, '\t'));

	console.log(`Suite      ${suiteName}: ${suite.description ?? ''}`);
	console.log(`Install    ${install} (${product ?? 'first product'})`);
	console.log(`Build      ${exe}`);
	console.log(`Output     ${runDir}`);
	console.log(`App data   ${dataDir} (separate from your normal wow.export)`);

	// The runtime log is per data directory and recreated each start; note
	// where it is so it can be copied into the run folder afterwards.
	const runtimeLog = path.join(dataDir, 'Default', 'runtime.log');

	const started = Date.now();
	const exitCode = await new Promise((resolve) => {
		const child = spawn(exe, [`--user-data-dir=${dataDir}`, '--disable-auto-update', `--export-test=${jobFile}`], {
			cwd: path.dirname(exe),
			stdio: 'ignore',
			windowsHide: false
		});

		const timer = setTimeout(() => {
			console.error(`\nTimed out after ${args.timeout} minutes; stopping the app.`);
			child.kill();
		}, args.timeout * 60000);

		const ticker = setInterval(() => process.stdout.write(`\rRunning... ${fmtSec(Date.now() - started)}   `), 1000);

		child.on('exit', (code) => {
			clearTimeout(timer);
			clearInterval(ticker);
			process.stdout.write('\n');
			resolve(code);
		});
		child.on('error', (e) => {
			clearTimeout(timer);
			clearInterval(ticker);
			console.error('Failed to start wow.export: ' + e.message);
			resolve(-1);
		});
	});

	if (fs.existsSync(runtimeLog))
		fs.copyFileSync(runtimeLog, path.join(runDir, 'runtime.log'));

	if (!fs.existsSync(job.report)) {
		console.error(`No report was written (app exit code ${exitCode}). See ${path.join(runDir, 'runtime.log')}`);
		return 1;
	}

	const report = JSON.parse(fs.readFileSync(job.report, 'utf8'));
	if (report.error)
		console.error('Run failed: ' + report.error);

	const profiles = fs.existsSync(path.join(runDir, 'runtime.log'))
		? parseLog(fs.readFileSync(path.join(runDir, 'runtime.log'), 'utf8'))
		: [];

	console.log(`\nwow.export ${report.version ?? '?'}, build ${report.build ?? '?'}, CASC load ${fmtSec(report.cascLoadMs ?? 0)}, total ${fmtSec(Date.now() - started)}\n`);
	console.log('Job                   Tiles   OK  Failed     Wall   Tiles/s   Slowest   Output              Peak RSS');

	let allProblems = 0;
	const summary = [];
	for (const [i, j] of report.jobs.entries()) {
		const problems = checkJob(j);
		allProblems += problems.length;

		const out = j.exportDirectory ? dirStats(j.exportDirectory) : { files: 0, bytes: 0 };
		const slowest = j.tiles?.length ? Math.max(...j.tiles.map(t => t.ms)) : 0;

		console.log(
			(j.name ?? '?').padEnd(20) +
			String(j.tiles?.length ?? 0).padStart(7) +
			String(j.succeeded ?? 0).padStart(5) +
			String(j.failed ?? 0).padStart(8) +
			fmtSec(j.wallMs ?? 0).padStart(9) +
			String(j.tilesPerSecond ?? 0).padStart(10) +
			fmtSec(slowest).padStart(10) +
			`   ${out.files} files, ${fmtBytes(out.bytes)}`.padEnd(22) +
			fmtBytes(j.peakRSS ?? 0).padStart(10)
		);

		if (j.missingTiles?.length)
			console.log(`  ${j.missingTiles.length} requested tile(s) are not on this map and were skipped`);

		for (const p of problems.slice(0, 10))
			console.log('  PROBLEM ' + p);
		if (problems.length > 10)
			console.log(`  ... and ${problems.length - 10} more`);

		const profile = profiles.filter(p => p.unit === 'tile')[i];
		summary.push({
			name: j.name, format: j.format, quality: j.quality, tiles: j.tiles?.length ?? 0,
			succeeded: j.succeeded, failed: j.failed, wallMs: j.wallMs, tilesPerSecond: j.tilesPerSecond,
			slowestTileMs: slowest, outputFiles: out.files, outputBytes: out.bytes, peakRSS: j.peakRSS,
			problems: problems.length, error: j.error, phases: profile?.phases
		});
	}

	// Compare with the previous run of this suite.
	const historyFile = path.join(root, 'history.jsonl');
	const history = fs.existsSync(historyFile)
		? fs.readFileSync(historyFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
		: [];
	const previous = history.filter(h => h.suite === suiteName && h.ok).at(-1);
	if (previous) {
		console.log(`\nCompared with ${previous.runId}${previous.label ? ' (' + previous.label + ')' : ''}:`);
		for (const s of summary) {
			const p = previous.jobs.find(j => j.name === s.name);
			if (!p || !p.wallMs || p.tiles !== s.tiles)
				continue;
			const delta = (s.wallMs - p.wallMs) / p.wallMs * 100;
			console.log(`  ${s.name.padEnd(20)} ${fmtSec(p.wallMs)} -> ${fmtSec(s.wallMs)}  (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%)`);
		}
	}

	// Exports log per-file failures (a texture or model that could not be
	// read) without failing the tile, so check the log too.
	const logFailures = new Map();
	const logFile = path.join(runDir, 'runtime.log');
	if (fs.existsSync(logFile)) {
		for (const line of fs.readFileSync(logFile, 'utf8').split(/\r?\n/)) {
			const m = line.match(/^\[[\d:]+\] (Failed to (?:export|load) [^:]*?)(?: \d+)?(?: for [^:]+)?: (.*)$/);
			if (!m)
				continue;
			const key = m[1].replace(/ \d+$/, '') + ': ' + m[2].replace(/[0-9a-f]{32}/g, '<key>').replace(/\d{3,}/g, '<n>');
			logFailures.set(key, (logFailures.get(key) ?? 0) + 1);
		}
	}

	const logFailureCount = [...logFailures.values()].reduce((a, b) => a + b, 0);
	if (logFailureCount > 0) {
		console.log(`
${logFailureCount} file-level failure(s) in the runtime log:`);
		for (const [msg, n] of [...logFailures].sort((a, b) => b[1] - a[1]).slice(0, 8))
			console.log(`  ${String(n).padStart(6)}  ${msg}`);
	}

	const ok = !report.error && allProblems === 0 && logFailureCount === 0 && report.jobs.every(j => !j.error && j.failed === 0);
	fs.appendFileSync(historyFile, JSON.stringify({
		runId, suite: suiteName, label: args.label, ok, version: report.version, build: report.build,
		install, product, cascLoadMs: report.cascLoadMs, logFailures: logFailureCount, jobs: summary
	}) + '\n');

	if (args.clean && fs.existsSync(job.outputDir)) {
		fs.rmSync(job.outputDir, { recursive: true, force: true });
		console.log('\nRemoved exported files (--clean); report and log kept.');
	}

	console.log(`\n${ok ? 'PASSED' : 'FAILED'}  report: ${job.report}`);
	return ok ? 0 : 1;
};

main().then(code => { process.exitCode = code; }).catch((e) => {
	console.error(e.message);
	process.exitCode = 1;
});
