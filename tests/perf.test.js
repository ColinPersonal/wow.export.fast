const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const perf = require('../src/js/perf');

const labels = (lines) => lines.slice(1).map(l => l.trim().split(/\s+/)[0]);

beforeEach(() => {
	// reset() forces depth to 1 and end() brings it to 0, closing any run a
	// previous test left open.
	perf.reset();
	perf.end();
});

test('nothing is recorded outside a run', () => {
	perf.add('outside', 5);
	perf.count('outside.count');
	perf.begin();
	const lines = perf.end();
	assert.deepEqual(labels(lines), []);
});

test('end() returns summary only for the outermost run', () => {
	perf.begin();
	perf.begin();
	perf.add('inner', 1);
	assert.equal(perf.end(), null);
	const lines = perf.end();
	assert.ok(Array.isArray(lines));
	assert.deepEqual(labels(lines), ['inner']);
	assert.equal(perf.end(), null, 'extra end() is a no-op');
});

test('add() accumulates time, count and bytes per label', () => {
	perf.begin();
	perf.add('png.encode', 1000, 2 * 1048576);
	perf.add('png.encode', 500, 1048576);
	const lines = perf.end();
	const line = lines.find(l => l.includes('png.encode'));
	assert.match(line, /1\.50s/);
	assert.match(line, /\b2x/);
	assert.match(line, /3\.0 MB/);
});

test('count() increments without adding time', () => {
	perf.begin();
	perf.count('dedupe.skipped');
	perf.count('dedupe.skipped', 4);
	const line = perf.end().find(l => l.includes('dedupe.skipped'));
	assert.match(line, /0\.00s/);
	assert.match(line, /\b5x/);
});

test('summary lists labels slowest first', () => {
	perf.begin();
	perf.add('fast', 10);
	perf.add('slow', 900);
	perf.add('middle', 100);
	assert.deepEqual(labels(perf.end()), ['slow', 'middle', 'fast']);
});

test('time() records async work and still records when it throws', async () => {
	perf.begin();
	assert.equal(await perf.time('ok', async () => 7), 7);
	await assert.rejects(perf.time('fails', async () => { throw new Error('x'); }));
	const found = labels(perf.end());
	assert.ok(found.includes('ok'));
	assert.ok(found.includes('fails'));
});

test('timeSync() records sync work and passes through results', () => {
	perf.begin();
	assert.equal(perf.timeSync('sync', () => 'v'), 'v');
	assert.throws(() => perf.timeSync('sync.fail', () => { throw new Error('y'); }));
	const found = labels(perf.end());
	assert.ok(found.includes('sync'));
	assert.ok(found.includes('sync.fail'));
});

test('time() outside a run just runs the function', async () => {
	assert.equal(await perf.time('none', async () => 3), 3);
	assert.equal(perf.timeSync('none', () => 4), 4);
});

test('a new run clears the previous run stats', () => {
	perf.begin();
	perf.add('old', 1);
	perf.end();
	perf.begin();
	perf.add('new', 1);
	assert.deepEqual(labels(perf.end()), ['new']);
});

test('reset() recovers from a leaked nested run', () => {
	perf.begin();
	perf.begin();
	perf.add('leaked', 1);
	perf.reset();
	perf.add('fresh', 1);
	const lines = perf.end();
	assert.ok(Array.isArray(lines), 'reset() should leave depth at 1');
	assert.deepEqual(labels(lines), ['fresh']);
});

test('summary header reports wall time', () => {
	perf.begin();
	const [header] = perf.end();
	assert.match(header, /^Export profile: \d+\.\d\ds wall time/);
});
