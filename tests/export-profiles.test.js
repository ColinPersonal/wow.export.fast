const { test } = require('node:test');
const assert = require('node:assert/strict');
const perf = require('../src/js/perf');
const { parseLog } = require('../bench/export-profiles');

const asLog = (lines, time = '12:00:00') => lines.map(l => `[${time}] ${l}`).join('\n');

test('parses a profile produced by perf.summary()', () => {
	perf.reset();
	perf.add('png.encode', 1500, 3 * 1048576);
	perf.add('casc.read', 250);
	perf.count('dedupe.skipped', 12);
	const summary = perf.end();

	const text = [
		asLog(['Starting export of 42 textures items'], '10:00:00'),
		asLog(['Finished export (41 succeeded, 1 failed)', ...summary], '10:00:05')
	].join('\n');

	const [p] = parseLog(text);
	assert.equal(p.items, 42);
	assert.equal(p.unit, 'textures');
	assert.equal(p.succeeded, 41);
	assert.equal(p.failed, 1);
	assert.equal(p.started, '10:00:00');
	assert.equal(p.finished, '10:00:05');

	const byLabel = Object.fromEntries(p.phases.map(ph => [ph.label, ph]));
	assert.equal(byLabel['png.encode'].seconds, 1.5);
	assert.equal(byLabel['png.encode'].count, 1);
	assert.equal(byLabel['png.encode'].bytes, 3 * 1048576);
	assert.equal(byLabel['casc.read'].bytes, 0);
	assert.equal(byLabel['dedupe.skipped'].count, 12);
});

test('handles labels containing spaces and parentheses', () => {
	perf.reset();
	perf.add('png.encode (worker)', 100, 2048);
	const text = asLog(['Starting export of 1 model items', 'Finished export (1 succeeded, 0 failed)', ...perf.end()]);
	const [p] = parseLog(text);
	assert.equal(p.phases[0].label, 'png.encode (worker)');
	assert.equal(p.phases[0].bytes, 2048);
});

test('separates multiple exports and ignores unrelated lines', () => {
	const one = () => { perf.reset(); perf.add('a', 10); return perf.end(); };
	const text = asLog([
		'components loaded: x',
		'Starting export of 2 model items',
		'Finished export (2 succeeded, 0 failed)',
		...one(),
		'Loading local CASC file 123',
		'Starting export of 5 map tile items',
		'Finished export (5 succeeded, 0 failed)',
		...one(),
		'Something else afterwards'
	]);

	const profiles = parseLog(text);
	assert.equal(profiles.length, 2);
	assert.equal(profiles[0].unit, 'model');
	assert.equal(profiles[1].unit, 'map tile');
	assert.equal(profiles[1].items, 5);
	assert.deepEqual(profiles.map(p => p.phases.length), [1, 1]);
});

test('returns nothing for a log without exports', () => {
	assert.deepEqual(parseLog(asLog(['wow.export has started'])), []);
	assert.deepEqual(parseLog(''), []);
});
