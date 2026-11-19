#!/usr/bin/env bun
/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Output regression check. Runs a fixed set of real exports through the
// headless service against the live game build and records a content hash of
// every file written. Comparing the manifest from before and after a change
// shows whether the change altered any exported file.
//
//   bun bench/output-manifest.js --write before.json
//   (make changes)
//   bun bench/output-manifest.js --compare before.json
//
// PNG files are hashed by their decoded pixels, so a change of PNG encoder
// settings is not reported as a difference. Requires network access to
// Blizzard's CDN; both runs must be made against the same game build.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const option = (name) => {
	const index = args.indexOf('--' + name);
	return index === -1 ? undefined : args[index + 1];
};

const writeTo = option('write');
const compareTo = option('compare');
const outRoot = path.resolve(option('out') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'wowexport-manifest-')));

if (!writeTo && !compareTo) {
	console.error('Usage: bun bench/output-manifest.js (--write <manifest.json> | --compare <manifest.json>) [--out <directory>]');
	process.exit(2);
}

console.log = (...values) => console.error(...values);

const service = require('../src/js/headless/service');
const { decodePNG } = require('../tests/helpers/fixtures');

const TILES = ['32_49', '33_49'];
const MODELS = ['creature/murloc/murloc.m2', 'creature/wolf/wolf.m2'];
const TEXTURES = ['interface/icons/inv_misc_questionmark.blp', 'interface/icons/inv_sword_04.blp', 'tileset/elwynn/elwynngrassbase.blp', 'tileset/elwynn/elwynndirtbase.blp', 'creature/murloc/sahauginskin.blp', 'creature/murloc/sahauginskinblue.blp'];

const SCENARIOS = [
	['map_raw', (outDir) => service.exportMap({ map: 'azeroth', tiles: TILES, format: 'raw', animations: true, outDir })],
	['map_obj', (outDir) => service.exportMap({ map: 'azeroth', tiles: TILES.slice(0, 1), format: 'obj', outDir })],
	['textures_png', (outDir) => service.exportTextures({ files: TEXTURES, format: 'png', outDir })],
	['model_raw', async (outDir) => { for (const file of MODELS) await service.exportModel({ file, format: 'raw', outDir }); }],
	['model_obj', async (outDir) => { for (const file of MODELS) await service.exportModel({ file, format: 'obj', outDir }); }],
	['model_gltf', async (outDir) => { for (const file of MODELS) await service.exportModel({ file, format: 'gltf', outDir }); }],
	['model_glb', (outDir) => service.exportModel({ file: MODELS[0], format: 'glb', outDir })]
];

const walk = (dir, out = []) => {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory())
			walk(full, out);
		else
			out.push(full);
	}

	return out;
};

const hashFile = (file) => {
	const data = fs.readFileSync(file);
	const hash = crypto.createHash('sha256');

	if (file.endsWith('.png')) {
		// Hash what the image contains rather than how it was compressed.
		const image = decodePNG(data);
		hash.update('png:' + image.width + 'x' + image.height + ':').update(image.pixels);
	} else {
		hash.update(data);
	}

	return hash.digest('hex');
};

(async () => {
	const info = await service.info();
	const manifest = { version: info.version, buildConfig: info.buildConfig, files: {}, seconds: {} };

	for (const [name, run] of SCENARIOS) {
		const outDir = path.join(outRoot, name);
		fs.rmSync(outDir, { recursive: true, force: true });

		const start = Date.now();
		await run(outDir);
		manifest.seconds[name] = Number(((Date.now() - start) / 1000).toFixed(2));

		// The resume record is bookkeeping, not exported content.
		const files = walk(outDir).filter(file => path.basename(file) !== '.wow_export_tiles.json');
		for (const file of files)
			manifest.files[name + '/' + path.relative(outDir, file).replace(/\\/g, '/')] = hashFile(file);

		console.error(name.padEnd(14) + String(files.length).padStart(6) + ' files' + (manifest.seconds[name] + 's').padStart(9));
	}

	if (writeTo) {
		fs.writeFileSync(writeTo, JSON.stringify(manifest, null, '\t'));
		console.error('Wrote manifest of ' + Object.keys(manifest.files).length + ' files to ' + writeTo);
		return 0;
	}

	const baseline = JSON.parse(fs.readFileSync(compareTo, 'utf8'));
	if (baseline.buildConfig !== manifest.buildConfig) {
		console.error('Cannot compare: baseline is game build ' + baseline.version + ', current is ' + manifest.version + '. Regenerate the baseline.');
		return 2;
	}

	const problems = [];
	for (const [file, hash] of Object.entries(baseline.files)) {
		if (!(file in manifest.files))
			problems.push('missing:   ' + file);
		else if (manifest.files[file] !== hash)
			problems.push('different: ' + file);
	}

	for (const file of Object.keys(manifest.files)) {
		if (!(file in baseline.files))
			problems.push('new:       ' + file);
	}

	if (problems.length === 0) {
		console.error('All ' + Object.keys(manifest.files).length + ' exported files match the baseline.');
		return 0;
	}

	console.error(problems.slice(0, 50).join('\n'));
	console.error(problems.length + ' difference(s) from the baseline.');
	return 1;
})().then(code => setTimeout(() => process.exit(code), 50)).catch(e => {
	console.error('Failed: ' + e.message);
	setTimeout(() => process.exit(1), 50);
});
