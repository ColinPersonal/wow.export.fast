/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Reads the export profiles wow.export writes to runtime.log at the end of
// every export and prints them as a table. This is how to benchmark real
// exports: do the same export in two builds and compare.
//
// runtime.log is recreated each time the app starts, so use --save to keep
// profiles across sessions (appended to bench/results/export-profiles.jsonl).
//
//   node bench/export-profiles.js                 profiles from the current log
//   node bench/export-profiles.js --log <file>    read a different log
//   node bench/export-profiles.js --last 3        only the last 3 exports
//   node bench/export-profiles.js --save "label"  append them to the history file
//   node bench/export-profiles.js --history       show saved profiles
const fs = require('fs');
const os = require('os');
const path = require('path');

const HISTORY = path.join(__dirname, 'results', 'export-profiles.jsonl');

const defaultLog = () => {
	const base = process.platform === 'win32'
		? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'wow.export')
		: process.platform === 'darwin'
			? path.join(os.homedir(), 'Library', 'Application Support', 'wow.export')
			: path.join(os.homedir(), '.config', 'wow.export');
	return path.join(base, 'User Data', 'Default', 'runtime.log');
};

const parseArgs = () => {
	const args = {};
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--log') args.log = argv[++i];
		else if (a === '--last') args.last = parseInt(argv[++i], 10);
		else if (a === '--save') args.save = argv[++i] ?? '';
		else if (a === '--history') args.history = true;
		else if (a === '--json') args.json = true;
		else if (a === '--help' || a === '-h') args.help = true;
		else throw new Error('unknown argument: ' + a);
	}
	return args;
};

const UNITS = { KB: 1024, MB: 1048576, GB: 1073741824 };

/**
 * Parse every export profile from runtime.log text.
 * @param {string} text
 * @returns {object[]}
 */
const parseLog = (text) => {
	const profiles = [];
	let lastStart = null;
	let lastFinish = null;
	let current = null;

	for (const raw of text.split(/\r?\n/)) {
		const m = raw.match(/^\[(\d\d:\d\d:\d\d)\] (.*)$/);
		if (!m) {
			current = null;
			continue;
		}

		const [, time, line] = m;
		let r;

		if ((r = line.match(/^Starting export of (\d+) (.+?) items$/))) {
			lastStart = { time, count: +r[1], unit: r[2] };
			current = null;
		} else if ((r = line.match(/^Finished export \((\d+) succeeded, (\d+) failed\)$/))) {
			lastFinish = { succeeded: +r[1], failed: +r[2] };
		} else if ((r = line.match(/^Export profile: ([\d.]+)s wall time/))) {
			current = {
				started: lastStart?.time ?? null,
				finished: time,
				items: lastStart?.count ?? null,
				unit: lastStart?.unit ?? null,
				succeeded: lastFinish?.succeeded ?? null,
				failed: lastFinish?.failed ?? null,
				wallSeconds: +r[1],
				phases: []
			};
			profiles.push(current);
		} else if (current && (r = line.match(/^\s+(\S.*?)\s+([\d.]+)s\s+(\d+)x(?:\s+([\d.]+) (KB|MB|GB))?$/))) {
			current.phases.push({
				label: r[1],
				seconds: +r[2],
				count: +r[3],
				bytes: r[4] ? Math.round(+r[4] * UNITS[r[5]]) : 0
			});
		} else {
			current = null;
		}
	}

	return profiles;
};

const describe = (p) => {
	const what = p.items !== null ? `${p.items} ${p.unit}` : 'export';
	const failed = p.failed ? `, ${p.failed} failed` : '';
	return `${p.label ? `[${p.label}] ` : ''}${p.date ? p.date + ' ' : ''}${p.started ?? '?'}-${p.finished}  ${what}${failed}  ${p.wallSeconds.toFixed(2)}s wall`;
};

const printProfile = (p) => {
	console.log('\n' + describe(p));
	if (p.items)
		console.log(`  ${(p.items / p.wallSeconds).toFixed(1)} items/s`);

	for (const ph of p.phases) {
		let line = '  ' + ph.label.padEnd(26) + (ph.seconds.toFixed(2) + 's').padStart(10) + (ph.count + 'x').padStart(10);
		if (ph.bytes)
			line += ((ph.bytes / 1048576).toFixed(1) + ' MB').padStart(12);
		console.log(line);
	}
};

const main = () => {
	const args = parseArgs();
	if (args.help) {
		console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter(l => l.startsWith('//')).join('\n'));
		return;
	}

	if (args.history) {
		if (!fs.existsSync(HISTORY)) {
			console.log('No saved profiles yet (' + HISTORY + ')');
			return;
		}

		let saved = fs.readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
		if (args.last)
			saved = saved.slice(-args.last);
		if (args.json)
			return console.log(JSON.stringify(saved, null, '\t'));

		saved.forEach(printProfile);
		return;
	}

	const logFile = args.log ?? defaultLog();
	if (!fs.existsSync(logFile)) {
		console.error('runtime.log not found: ' + logFile);
		process.exitCode = 1;
		return;
	}

	let profiles = parseLog(fs.readFileSync(logFile, 'utf8'));
	if (args.last)
		profiles = profiles.slice(-args.last);

	if (profiles.length === 0) {
		console.log(`No export profiles in ${logFile}. Export something in wow.export, then run this again.`);
		return;
	}

	if (args.json)
		console.log(JSON.stringify(profiles, null, '\t'));
	else {
		console.log(`${profiles.length} export profile(s) from ${logFile}`);
		profiles.forEach(printProfile);
	}

	if (args.save !== undefined) {
		const date = fs.statSync(logFile).mtime.toISOString().slice(0, 10);
		fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
		fs.appendFileSync(HISTORY, profiles.map(p => JSON.stringify({ label: args.save || undefined, date, ...p })).join('\n') + '\n');
		console.log(`\nAppended ${profiles.length} profile(s) to ${path.relative(process.cwd(), HISTORY)}`);
	}
};

if (require.main === module)
	main();

module.exports = { parseLog };
