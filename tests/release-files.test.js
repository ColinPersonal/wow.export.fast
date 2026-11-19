// Release builds bundle the app sources, but worker threads load their script
// from disk. These checks make sure every release build ships the worker
// files, and that those files only depend on things that are shipped too.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const ROOT = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'build.json'), 'utf8'));

// Files loaded directly from disk by worker threads.
const WORKER_FILES = ['src/js/workers/export-worker.js', 'src/js/png-encode.js'];

const requiresOf = (file) => {
	const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
	return [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
};

const isBuiltin = (name) => builtinModules.includes(name.replace(/^node:/, ''));

for (const build of config.builds) {
	// Debug builds link ./src in place, so every file is already on disk.
	if (build.sourceMethod === 'LINK')
		continue;

	test(`${build.name} ships the worker files`, () => {
		for (const file of WORKER_FILES)
			assert.ok(file in build.include, `${file} missing from ${build.name} include list`);
	});
}

for (const file of WORKER_FILES) {
	test(`${file} only requires node built-ins or other shipped worker files`, () => {
		for (const dep of requiresOf(file)) {
			if (isBuiltin(dep))
				continue;

			const resolved = path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, file)), dep)).replace(/\\/g, '/');
			const withExt = resolved.endsWith('.js') ? resolved : resolved + '.js';
			assert.ok(WORKER_FILES.includes(withExt), `${file} requires ${dep}, which is not shipped next to it`);
		}
	});
}
