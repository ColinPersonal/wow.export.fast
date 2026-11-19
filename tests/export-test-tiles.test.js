const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { resolveTiles, tileName } = require('../src/js/export-test-tiles');

const wdt = { tiles: Array.from({ length: 4096 }, (_, i) => (i % 3 === 0 ? 1 : 0)) };

test('tile names map to tileY * 64 + tileX, as ADT file names do', () => {
	assert.deepEqual(resolveTiles(['32_48', '0_0', '63_63'], wdt), [32 * 64 + 48, 0, 4095]);
	assert.equal(tileName(32 * 64 + 48), '32_48');
	assert.equal(tileName(4095), '63_63');
});

test('ranges are inclusive and order-independent', () => {
	const a = resolveTiles({ from: '31_47', to: '32_48' }, wdt);
	const b = resolveTiles({ from: '32_48', to: '31_47' }, wdt);
	assert.deepEqual(a, b);
	assert.deepEqual(a.map(tileName), ['31_47', '31_48', '32_47', '32_48']);
});

test('"all" returns every tile present in the WDT', () => {
	const all = resolveTiles('all', wdt);
	assert.equal(all.length, Math.ceil(4096 / 3));
	assert.ok(all.every(i => wdt.tiles[i]));
});

test('invalid specs are rejected', () => {
	assert.throws(() => resolveTiles(['32-48'], wdt), /invalid tile name/);
	assert.throws(() => resolveTiles({ from: '1_1' }, wdt), /invalid tiles spec/);
	assert.throws(() => resolveTiles(42, wdt), /invalid tiles spec/);
});

test('bundled suites are valid and their tiles resolve', () => {
	const dir = path.join(__dirname, 'export-scale', 'suites');
	for (const file of fs.readdirSync(dir)) {
		const suite = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
		assert.ok(Array.isArray(suite.jobs) && suite.jobs.length > 0, file);

		const names = new Set();
		for (const job of suite.jobs) {
			assert.ok(job.name && job.map && job.tiles !== undefined, `${file}: job needs name, map and tiles`);
			assert.ok(!names.has(job.name), `${file}: duplicate job name ${job.name}`);
			names.add(job.name);
			assert.ok(['OBJ', 'RAW'].includes((job.format ?? 'OBJ').toUpperCase()), `${file}: ${job.name} format`);
			assert.ok(resolveTiles(job.tiles, wdt).length > 0, `${file}: ${job.name} has no tiles`);
		}
	}
});
