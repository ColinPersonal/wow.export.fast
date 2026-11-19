/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Small benchmark harness: warms up, then samples a function until it has
// run for a minimum time and number of iterations, and reports median, p95
// and throughput. Results can be saved and compared against a baseline.
const fs = require('fs');
const os = require('os');
const path = require('path');

const RESULTS_DIR = path.join(__dirname, 'results');

const quantile = (sorted, q) => {
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos), hi = Math.ceil(pos);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

/**
 * Measure an (optionally async) function.
 * @param {function} fn Called once per sample.
 * @param {object} [opts]
 * @param {number} [opts.minTime=1000] Minimum total sampling time in ms.
 * @param {number} [opts.minSamples=5]
 * @param {number} [opts.maxSamples=200]
 * @param {number} [opts.warmup=2] Untimed calls before sampling.
 * @returns {Promise<{samples: number, median: number, p95: number, mean: number, min: number}>}
 */
const measure = async (fn, opts = {}) => {
	const minTime = opts.minTime ?? 1000;
	const minSamples = opts.minSamples ?? 5;
	const maxSamples = opts.maxSamples ?? 200;
	const warmup = opts.warmup ?? 2;

	for (let i = 0; i < warmup; i++)
		await fn();

	const times = [];
	const started = performance.now();
	while (times.length < maxSamples && (times.length < minSamples || performance.now() - started < minTime)) {
		const t = performance.now();
		await fn();
		times.push(performance.now() - t);
	}

	times.sort((a, b) => a - b);
	return {
		samples: times.length,
		median: quantile(times, 0.5),
		p95: quantile(times, 0.95),
		mean: times.reduce((a, b) => a + b, 0) / times.length,
		min: times[0]
	};
};

const fmtMs = (ms) => ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : ms >= 10 ? ms.toFixed(1) + ' ms' : ms.toFixed(3) + ' ms';
const fmtRate = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : n.toFixed(1);
const fmtBytes = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(1) + ' KB';

const environment = () => ({
	node: process.version,
	v8: process.versions.v8,
	platform: `${process.platform}-${process.arch}`,
	cpu: os.cpus()[0]?.model?.trim(),
	cores: os.cpus().length,
	memoryGB: +(os.totalmem() / 1073741824).toFixed(1)
});

class Suite {
	constructor(opts = {}) {
		this.opts = opts;
		this.results = [];
	}

	/**
	 * Run and record one benchmark.
	 * @param {string} group Benchmark group, e.g. 'png'.
	 * @param {string} name Case name within the group.
	 * @param {function} fn
	 * @param {object} [meta]
	 * @param {number} [meta.bytes] Bytes processed per call, for MB/s.
	 * @param {number} [meta.items] Items processed per call, for items/s.
	 * @param {object} [meta.extra] Extra values to record (e.g. output size).
	 */
	async add(group, name, fn, meta = {}) {
		const id = `${group} / ${name}`;
		if (this.opts.filter && !id.toLowerCase().includes(this.opts.filter.toLowerCase()))
			return;

		if (this.pendingHeading) {
			console.log('\n' + this.pendingHeading);
			this.pendingHeading = null;
		}

		const stats = await measure(fn, this.opts.measure);
		const result = { id, group, name, ...stats, ...meta.extra };

		if (meta.bytes)
			result.mbPerSec = (meta.bytes / 1048576) / (stats.median / 1000);
		if (meta.items)
			result.itemsPerSec = meta.items / (stats.median / 1000);

		this.results.push(result);
		this.print(result);
		return result;
	}

	print(r) {
		let line = '  ' + r.name.padEnd(46) + fmtMs(r.median).padStart(11) + '  p95 ' + fmtMs(r.p95).padStart(10);
		if (r.mbPerSec !== undefined)
			line += (r.mbPerSec.toFixed(1) + ' MB/s').padStart(14);
		if (r.itemsPerSec !== undefined)
			line += (fmtRate(r.itemsPerSec) + ' ops/s').padStart(16);
		if (r.outputBytes !== undefined)
			line += '  out ' + fmtBytes(r.outputBytes);

		const base = this.baseline?.get(r.id);
		if (base !== undefined) {
			const delta = (r.median - base.median) / base.median * 100;
			const mark = delta <= -5 ? 'faster' : delta >= 5 ? 'SLOWER' : 'same';
			line += `   ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% ${mark}`;
		}

		console.log(line);
	}

	/**
	 * Set the heading for the following cases. It is printed before the first
	 * case that runs, so filtered-out sections stay silent.
	 * @param {string} text
	 */
	heading(text) {
		this.pendingHeading = text;
	}

	/**
	 * Load a saved result file to compare against.
	 * @param {string} name Name passed to --save, or a path to a JSON file.
	 */
	loadBaseline(name) {
		const file = fs.existsSync(name) ? name : path.join(RESULTS_DIR, name + '.json');
		if (!fs.existsSync(file))
			throw new Error('baseline not found: ' + file);

		const data = JSON.parse(fs.readFileSync(file, 'utf8'));
		this.baseline = new Map(data.results.map(r => [r.id, r]));
		console.log(`Comparing against ${path.relative(process.cwd(), file)} (${data.timestamp}, ${data.git ?? 'unknown commit'})`);
		console.log('Note: laptops vary 30%+ between runs (power plan, boost, thermals). Plug in, use the same power mode,\nand re-run before trusting a difference; check both runs show similar p95/median spread.');
	}

	/**
	 * Write results to bench/results/<name>.json.
	 * @param {string} name
	 * @param {object} info Extra run info (e.g. git commit).
	 */
	save(name, info = {}) {
		fs.mkdirSync(RESULTS_DIR, { recursive: true });
		const file = path.join(RESULTS_DIR, name + '.json');
		const data = { timestamp: new Date().toISOString(), ...info, environment: environment(), results: this.results };
		fs.writeFileSync(file, JSON.stringify(data, null, '\t'));
		console.log(`\nSaved ${this.results.length} results to ${path.relative(process.cwd(), file)}`);
	}
}

module.exports = { Suite, measure, environment, fmtMs, fmtBytes };
