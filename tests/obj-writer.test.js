// The batched OBJ writer must produce byte-identical files to the original
// line-by-line writer (tests/helpers/obj-writer-reference.js).
require('./helpers/nw-stub');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const OBJWriter = require('../src/js/3D/writers/OBJWriter');
const ReferenceOBJWriter = require('./helpers/obj-writer-reference');
const FileWriter = require('../src/js/file-writer');
const { rng } = require('./helpers/fixtures');

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowexport-obj-')); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

let counter = 0;

/**
 * Build the same model on both writers via `setup`, write both, and compare.
 * @param {function} setup Receives a writer and configures it.
 */
const compare = async (setup) => {
	const id = counter++;
	const a = new OBJWriter(path.join(dir, `new-${id}.obj`));
	const b = new ReferenceOBJWriter(path.join(dir, `ref-${id}.obj`));
	setup(a);
	setup(b);
	await a.write();
	await b.write();

	// The reference writer does not wait for its stream to finish.
	await new Promise(resolve => setTimeout(resolve, 50));

	const got = fs.readFileSync(a.out);
	const expected = fs.readFileSync(b.out);
	assert.equal(got.length, expected.length, 'file sizes differ');
	assert.ok(got.equals(expected), 'file contents differ');
	return got.toString('utf8');
};

const randomModel = (seed, nVerts, nTris, { typed = false } = {}) => {
	const rand = rng(seed);
	const f32 = new Float32Array(nVerts * 3).map(() => rand() * 200 - 100);
	const verts = typed ? f32 : Array.from(f32);
	const normals = Array.from(new Float32Array(nVerts * 3).map(() => rand() * 2 - 1));
	const uv = Array.from(new Float32Array(nVerts * 2).map(() => rand()));
	const tris = Array.from({ length: nTris * 3 }, () => (rand() * nVerts) | 0);
	return { verts, normals, uv, tris };
};

test('simple model with one mesh', async () => {
	await compare((w) => {
		w.setName('Cube');
		w.setVertArray([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
		w.setNormalArray([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
		w.addUVArray([0, 0, 1, 0, 1, 1, 0, 1]);
		w.addMesh('Face', [0, 1, 2, 0, 2, 3], 'mat_face');
	});
});

test('large random model with several meshes and materials', async () => {
	const m = randomModel(1, 5000, 9000);
	const text = await compare((w) => {
		w.setMaterialLibrary('model.mtl');
		w.setVertArray(m.verts);
		w.setNormalArray(m.normals);
		w.addUVArray(m.uv);
		w.addMesh('A', m.tris.slice(0, 9000), 'mat_a');
		w.addMesh('B', m.tris.slice(9000, 18000), null);
		w.addMesh('C', m.tris.slice(18000), 'mat_c');
	});
	assert.ok(text.length > 1 << 20, 'should span several write chunks');
});

test('typed array inputs, unused vertices, no UVs', async () => {
	const m = randomModel(2, 3000, 500, { typed: true });
	await compare((w) => {
		w.setVertArray(m.verts);
		w.setNormalArray(new Float32Array(m.normals));
		w.addMesh('Sparse', new Uint16Array(m.tris), 'm');
	});
});

test('multiple UV layers, flipped UVs and vertex colours', async () => {
	const m = randomModel(3, 400, 300);
	const rand = rng(33);
	const colours = Array.from({ length: 400 * 4 }, () => rand());
	await compare((w) => {
		w.flip_uvs = true;
		w.setVertArray(m.verts);
		w.setNormalArray(m.normals);
		w.addUVArray(m.uv);
		w.addUVArray(m.uv.map(v => 1 - v));
		w.addUVArray(m.uv.map(v => v * 0.5));
		w.setColorArray(colours);
		w.addMesh('Coloured', m.tris, 'mat');
	});
});

test('appended geometry uses vertex offsets', async () => {
	const base = randomModel(4, 200, 100);
	const extra = randomModel(5, 150, 80);
	await compare((w) => {
		w.setVertArray(base.verts);
		w.setNormalArray(base.normals);
		w.addUVArray(base.uv);
		w.addMesh('Body', base.tris, 'body');
		w.appendGeometry(extra.verts, extra.normals, [extra.uv]);
		w.addMesh('Helmet', extra.tris, 'helmet');
	});
});

test('out-of-range triangle indices write NaN exactly as before', async () => {
	const text = await compare((w) => {
		w.setVertArray([0, 0, 0, 1, 0, 0, 1, 1, 0]);
		w.setNormalArray([0, 0, 1, 0, 0, 1, 0, 0, 1]);
		w.addUVArray([0, 0, 1, 0, 1, 1]);
		w.addMesh('Broken', [0, 1, 2, 0, 2, 7], 'm');
	});
	assert.match(text, /NaN/);
});

test('model with no meshes', async () => {
	await compare((w) => {
		w.setVertArray([0, 0, 0]);
		w.setNormalArray([0, 0, 1]);
	});
});

test('write() resolves only after the file is complete', async () => {
	const m = randomModel(6, 20000, 30000);
	const file = path.join(dir, 'complete.obj');
	const w = new OBJWriter(file);
	w.setVertArray(m.verts);
	w.setNormalArray(m.normals);
	w.addUVArray(m.uv);
	w.addMesh('M', m.tris, 'm');
	await w.write();

	// Read immediately: the last face line must already be on disk.
	const text = fs.readFileSync(file, 'utf8');
	assert.ok(text.endsWith('\n'));
	assert.equal(text.trimEnd().split('\n').filter(l => l.startsWith('f ')).length, 30000);
});

test('overwrite=false leaves an existing file alone', async () => {
	const file = path.join(dir, 'keep.obj');
	fs.writeFileSync(file, 'original');
	const w = new OBJWriter(file);
	w.setVertArray([0, 0, 0]);
	await w.write(false);
	assert.equal(fs.readFileSync(file, 'utf8'), 'original');
});

test('LineBuffer output equals one writeLine per line', async () => {
	const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(i % 50)} é`);

	const a = new FileWriter(path.join(dir, 'lb-a.txt'));
	for (const l of lines)
		await a.writeLine(l);
	await a.close();

	const b = new FileWriter(path.join(dir, 'lb-b.txt'));
	const buf = new FileWriter.LineBuffer(b, 1000);
	for (const l of lines)
		if (buf.push(l))
			await buf.flush();
	await buf.flush();
	await b.close();

	assert.ok(fs.readFileSync(path.join(dir, 'lb-a.txt')).equals(fs.readFileSync(path.join(dir, 'lb-b.txt'))));
});

test('FileWriter.close() rejects when writing failed', async () => {
	const missing = path.join(dir, 'no-such-dir', 'x.txt');
	const w = new FileWriter(missing);
	w.writeLine('hello');
	await assert.rejects(w.close());
});
