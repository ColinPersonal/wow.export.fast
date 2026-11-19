/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Builds a small but feature-complete model (skinned, animated, multiple UV
// sets, 8/16/32-bit index meshes, equipment, an embedded texture) and runs it
// through GLTFWriter, so tests can compare the exported bytes against known
// good hashes.
require('./nw-stub');

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const core = require('../../src/js/core');
const BufferWrapper = require('../../src/js/buffer');
const GLTFWriter = require('../../src/js/3D/writers/GLTFWriter');

// Small deterministic PRNG (mulberry32) so the fixture never changes.
function rng(seed) {
	return () => {
		seed |= 0; seed = seed + 0x6D2B79F5 | 0;
		let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
		t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}

function make_track(rand, animCount, width, keys) {
	const timestamps = [];
	const values = [];
	for (let a = 0; a < animCount; a++) {
		const ts = [];
		const vs = [];
		for (let k = 0; k < keys; k++) {
			ts.push(Math.floor(rand() * 3000));
			const v = [];
			for (let c = 0; c < width; c++)
				v.push(Math.fround(rand() * 4 - 2));
			vs.push(v);
		}
		timestamps.push(ts);
		values.push(vs);
	}
	return { globalSeq: 65535, interpolation: 1, timestamps, values };
}

function build_writer(out) {
	const rand = rng(1234);
	const writer = new GLTFWriter(out, 'fixture_model');

	const vertCount = 97;
	const vertices = [];
	const normals = [];
	const uv = [];
	const uv2 = [];
	const boneIndices = [];
	const boneWeights = [];

	for (let i = 0; i < vertCount; i++) {
		vertices.push(Math.fround(rand() * 200 - 100), Math.fround(rand() * 50) * -1, Math.fround(rand() * 1e-3));
		normals.push(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1); // not fround: exercises float32 rounding
		uv.push(rand(), 1 - rand());
		uv2.push(rand() * 3, rand() * -3);
		boneIndices.push(i % 3, (i + 1) % 3, 0, 0);
		boneWeights.push(255 - (i % 200), i % 200, 0, 0);
	}

	// A few special values.
	vertices[0] = -0;
	vertices[1] = 1.401298464324817e-45; // smallest denormal
	vertices[2] = 3.4028234663852886e38; // float max
	normals[0] = 0.1; // not exactly representable

	writer.setVerticesArray(vertices);
	writer.setNormalArray(normals);
	writer.addUVArray(uv);
	writer.addUVArray(uv2);
	writer.setBoneIndexArray(boneIndices);
	writer.setBoneWeightArray(boneWeights);

	const animations = [
		{ id: 0, variationIndex: 0, duration: 2000 },
		{ id: 4, variationIndex: 1, duration: 1500 }
	];
	writer.setAnimations(animations);

	const bones = [];
	for (let b = 0; b < 3; b++) {
		bones.push({
			boneID: b === 0 ? 0 : -1,
			flags: 0,
			parentBone: b - 1,
			subMeshID: 0,
			boneNameCRC: 0,
			translation: make_track(rand, animations.length, 3, 4 + b),
			rotation: make_track(rand, animations.length, 4, 3 + b),
			scale: make_track(rand, animations.length, 3, 2 + b),
			pivot: [rand(), rand(), rand()]
		});
	}
	writer.setBonesArray(bones);

	const small = [];
	for (let i = 0; i < 33; i++)
		small.push(i % vertCount);
	writer.addMesh('small', small, 'mat_a');

	const medium = [];
	for (let i = 0; i < 31; i++)
		medium.push(i === 5 ? 40000 : i * 7);
	writer.addMesh('medium', medium, 'mat_a');

	const large = [];
	for (let i = 0; i < 29; i++)
		large.push(i === 2 ? 300 : (i === 9 ? 100000 : i));
	writer.addMesh('large', large, 'mat_missing');

	writer.setTextureMap(new Map([[123, { matPathRelative: 'tex/a.png', matName: 'mat_a' }]]));
	const tex = BufferWrapper.alloc(37, true);
	for (let i = 0; i < 37; i++)
		tex.writeUInt8((i * 31) & 0xFF);
	writer.setTextureBuffers(new Map([[123, tex]]));

	const eqVerts = new Float32Array(15);
	const eqNorms = new Float32Array(15);
	const eqUV = new Float32Array(10);
	for (let i = 0; i < 15; i++) {
		eqVerts[i] = rand() * 10;
		eqNorms[i] = rand();
	}
	for (let i = 0; i < 10; i++)
		eqUV[i] = rand();

	writer.addEquipmentModel({
		name: 'equip',
		vertices: eqVerts,
		normals: eqNorms,
		uv: eqUV,
		boneIndices: new Uint8Array([0, 1, 0, 0, 1, 2, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0]),
		boneWeights: new Uint8Array([255, 0, 0, 0, 128, 127, 0, 0, 200, 55, 0, 0, 255, 0, 0, 0, 1, 254, 0, 0]),
		meshes: [{ name: 'eq_mesh', triangles: [0, 1, 2, 2, 3, 4, 4, 0, 1], matName: 'mat_a' }]
	});

	return writer;
}

/**
 * Export the fixture model and return { relativeFile: sha256 } for every file written.
 * @param {string} format 'gltf' or 'glb'
 * @param {boolean} bonePrefix
 */
async function export_fixture(format, bonePrefix) {
	core.view = {
		config: {
			enableAbsoluteGLTFPaths: false,
			modelsExportAnimations: true,
			modelsExportWithBonePrefix: bonePrefix
		}
	};

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowexport-gltf-'));
	try {
		const writer = build_writer(path.join(dir, 'fixture_model.m2'));
		await writer.write(true, format);

		const hashes = {};
		for (const file of fs.readdirSync(dir).sort())
			hashes[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex');

		return hashes;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

module.exports = { export_fixture };
