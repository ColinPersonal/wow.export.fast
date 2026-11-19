const { test } = require('node:test');
const assert = require('node:assert/strict');

const { export_fixture } = require('./helpers/gltf-model-fixture');

// SHA-256 of every file GLTFWriter wrote for the fixture model, captured with
// the original element-by-element writer (before the bulk write paths and the
// concat-free GLB packing). Any change here means the exported bytes changed.
const EXPECTED = {
	gltf_false: {
		'fixture_model.bin': '971c3c7ceccc66adaac4862eda362b61a146943c95128897462df12ea21ee427',
		'fixture_model.gltf': '07af1962ed2538bf06a927702174fe471a983400705098ff7e35359780690455',
		'fixture_model_anim0-0.bin': '3657ab93b32daf96bd38bd272257f4dab8cd873e68ebed2dccfe2a7883ec587a',
		'fixture_model_anim4-1.bin': 'c63031fff2e37cb7f08730df82bcb342c732542b2a43a7cdbf3f51c098b804eb'
	},
	gltf_true: {
		'fixture_model.bin': '971c3c7ceccc66adaac4862eda362b61a146943c95128897462df12ea21ee427',
		'fixture_model.gltf': '3da5ee443c7e7b46ee65b96a11370f8388d119205f9edbe0abbaf535b67f372a',
		'fixture_model_anim0-0.bin': '3657ab93b32daf96bd38bd272257f4dab8cd873e68ebed2dccfe2a7883ec587a',
		'fixture_model_anim4-1.bin': 'c63031fff2e37cb7f08730df82bcb342c732542b2a43a7cdbf3f51c098b804eb'
	},
	glb_false: {
		'fixture_model.glb': 'f2c95fa374f36fe2f626bb65381dde20ae16ce1db9fce25d6bf982b22b9d9aed'
	},
	glb_true: {
		'fixture_model.glb': '3896aa4b41d10b094b00ddaaeb3efc63ce44b0c3ffd084f5f051d962c86e75e5'
	}
};

for (const format of ['gltf', 'glb']) {
	for (const bonePrefix of [false, true]) {
		test(`GLTFWriter ${format} output is byte-identical (bone prefix: ${bonePrefix})`, async () => {
			const hashes = await export_fixture(format, bonePrefix);
			assert.deepEqual(hashes, EXPECTED[format + '_' + bonePrefix]);
		});
	}
}

test('GLBWriter packs a list of bin parts exactly like their concatenation', () => {
	const BufferWrapper = require('../src/js/buffer');
	const GLBWriter = require('../src/js/3D/writers/GLBWriter');

	const parts = [[1, 2, 3], [], [4, 5, 6, 7, 8], [9]].map(a => BufferWrapper.from(a));
	const json = JSON.stringify({ asset: { version: '2.0' }, x: 'odd' });

	const from_parts = new GLBWriter(json, parts).pack();
	const from_concat = new GLBWriter(json, BufferWrapper.concat(parts)).pack();

	assert.deepEqual(from_parts.raw, from_concat.raw);
	assert.equal(from_parts.offset, from_parts.byteLength, 'every byte is written');
	assert.equal(from_parts.byteLength % 4, 0);
});
