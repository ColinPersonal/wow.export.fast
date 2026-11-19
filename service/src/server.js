// Wires the gateway together.
const fs = require('fs');
const path = require('path');
const util = require('util');
const configLib = require('./config');
const { TokenStore } = require('./auth');
const { ResultCache } = require('./cache');
const { EnginePool } = require('./engines');
const { JobService } = require('./jobs');
const { HttpFront } = require('./http');

/** Plain line logger to <root>/logs/gateway.log (and optionally stderr). */
const makeLogger = (dir, { echo = false } = {}) => {
	const stream = fs.createWriteStream(path.join(dir, 'gateway.log'), { flags: 'a' });
	const write = (level) => (fmt, ...args) => {
		const line = new Date().toISOString() + ' ' + level + ' ' + util.format(fmt, ...args) + '\n';
		stream.write(line);
		if (echo)
			process.stderr.write(line);
	};
	return { info: write('INFO'), warn: write('WARN'), error: write('ERROR'), close: () => new Promise(r => stream.end(r)) };
};

/**
 * Start the gateway.
 * @param {object} [options]
 * @param {string} [options.root] Service root directory.
 * @param {object} [options.overrides] Config overrides (tests).
 * @param {function} [options.engineCommand] Engine command override (tests).
 * @param {boolean} [options.echo] Also log to stderr.
 */
const start = async (options = {}) => {
	const config = configLib.load(options.root, options.overrides);
	const log = makeLogger(config.dirs.logs, { echo: options.echo });

	// One gateway per root.
	const lockFile = path.join(config.dirs.state, 'gateway.lock');
	let lock;
	try {
		lock = fs.openSync(lockFile, 'wx');
	} catch {
		const pid = Number(fs.readFileSync(lockFile, 'utf8')) || 0;
		let alive = false;
		try {
			// A lock held by this very process means another gateway instance here.
			process.kill(pid, 0);
			alive = true;
		} catch {
			// stale lock
		}
		if (alive)
			throw new Error('Another gateway (pid ' + pid + ') is running for ' + config.root);
		fs.rmSync(lockFile, { force: true });
		lock = fs.openSync(lockFile, 'wx');
	}
	fs.writeSync(lock, String(process.pid));
	fs.closeSync(lock);

	const tokens = new TokenStore(config.dirs.state);
	const cache = new ResultCache(config, log);
	const pool = new EnginePool(config, log, { command: options.engineCommand });
	await pool.listen();

	const jobs = new JobService({ config, log, pool, cache });
	jobs.restore();

	const svc = { config, log, tokens, cache, pool, jobs };
	const front = new HttpFront(svc);
	await front.listen();

	pool.startWarm();

	const timers = [
		setInterval(() => cache.flushAccess().catch(() => {}), 60000),
		setInterval(() => cache.evict().catch(e => log.warn('eviction failed: %s', e.message)), 15 * 60000)
	];
	for (const t of timers)
		t.unref();

	log.info('gateway listening on %s:%d (root %s, code %s)', config.host, front.port, config.root, jobs.codeHash);

	let stopping = null;
	const stop = () => {
		if (stopping === null) {
			stopping = (async () => {
				for (const t of timers)
					clearInterval(t);
				await front.close();
				await pool.close();
				await cache.flushAccess().catch(() => {});
				fs.rmSync(lockFile, { force: true });
				log.info('gateway stopped');
				await log.close();
			})();
		}
		return stopping;
	};

	return Object.assign(svc, { front, port: front.port, stop });
};

module.exports = { start, makeLogger };
