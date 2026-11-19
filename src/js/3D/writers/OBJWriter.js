/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>
	License: MIT
 */
const path = require('path');
const constants = require('../../constants');
const generics = require('../../generics');
const FileWriter = require('../../file-writer');
const { LineBuffer } = FileWriter;

class OBJWriter {
	/**
	 * Construct a new OBJWriter instance.
	 * @param {string} out Output path to write to.
	 */
	constructor(out) {
		this.out = out;

		this.verts = [];
		this.normals = [];
		this.uvs = [];
		this.colors = null;
		this.flip_uvs = false;

		this.meshes = [];
		this.name = 'Mesh';

		// track vertex offsets for appending additional models
		this.vertex_offset = 0;
	}
	
	/**
	 * Set the name of the material library.
	 * @param {string} name 
	 */
	setMaterialLibrary(name) {
		this.mtl = name;
	}

	/**
	 * Set the name of this model.
	 * @param {string} name 
	 */
	setName(name) {
		this.name = name;
	}

	/**
	 * Set the vertex array for this writer.
	 * @param {Array} verts 
	 */
	setVertArray(verts) {
		this.verts = verts;
	}

	/**
	 * Set the normals array for this writer.
	 * @param {Array} normals 
	 */
	setNormalArray(normals) {
		this.normals = normals;
	}

	/**
	 * Add a UV array for this writer.
	 * @param {Array} uv 
	 */
	addUVArray(uv) {
		this.uvs.push(uv);
	}

	/**
	 * Set the vertex color array (RGBA floats, 4 per vertex).
	 * @param {Array} colors
	 */
	setColorArray(colors) {
		this.colors = colors;
	}

	/**
	 * Add a mesh to this writer.
	 * @param {string} name
	 * @param {Array} triangles
	 * @param {string} matName
	 */
	addMesh(name, triangles, matName) {
		this.meshes.push({ name, triangles, matName, vertexOffset: this.vertex_offset });
	}

	/**
	 * Append additional geometry from another model.
	 * Call this after setting base model data and adding its meshes.
	 * @param {Float32Array|Array} verts - vertex array (x,y,z triplets)
	 * @param {Float32Array|Array} normals - normal array (x,y,z triplets)
	 * @param {Array<Float32Array|Array>} uvArrays - array of UV arrays
	 */
	appendGeometry(verts, normals, uvArrays) {
		// calculate current vertex count before appending
		const current_vertex_count = this.verts.length / 3;
		this.vertex_offset = current_vertex_count;

		// append vertices
		if (verts) {
			if (Array.isArray(this.verts))
				this.verts = [...this.verts, ...verts];
			else
				this.verts = Float32Array.from([...this.verts, ...verts]);
		}

		// append normals
		if (normals) {
			if (Array.isArray(this.normals))
				this.normals = [...this.normals, ...normals];
			else
				this.normals = Float32Array.from([...this.normals, ...normals]);
		}

		// append uvs (match layer count)
		if (uvArrays) {
			for (let i = 0; i < uvArrays.length; i++) {
				if (i >= this.uvs.length)
					this.uvs.push([]);

				const uv = uvArrays[i];
				if (uv) {
					if (Array.isArray(this.uvs[i]))
						this.uvs[i] = [...this.uvs[i], ...uv];
					else
						this.uvs[i] = Float32Array.from([...this.uvs[i], ...uv]);
				}
			}
		}
	}

	/**
	 * Write the OBJ file (and associated MTLs).
	 * @param {boolean} overwrite
	 */
	async write(overwrite = true) {
		// If overwriting is disabled, check file existence.
		if (!overwrite && await generics.fileExists(this.out))
			return;

		await generics.createDirectory(path.dirname(this.out));
		const writer = new FileWriter(this.out);

		// Lines are collected and written in large chunks; awaiting a stream
		// write per line made this several times slower.
		const out = new LineBuffer(writer);

		// Write header.
		out.push('# Exported using wow.export v' + constants.VERSION);
		out.push('o ' + this.name);

		// Link material library.
		if (this.mtl)
			out.push('mtllib ' + this.mtl);

		// collect used indices (accounting for vertex offsets from appended geometry)
		let maxIndex = Math.max(this.verts.length / 3, this.normals.length / 3, this.colors ? this.colors.length / 4 : 0);
		for (const uv of this.uvs)
			maxIndex = Math.max(maxIndex, uv.length / 2);

		for (const mesh of this.meshes) {
			const offset = mesh.vertexOffset || 0;
			for (const index of mesh.triangles)
				if (index + offset > maxIndex)
					maxIndex = index + offset;
		}

		const size = Math.ceil(maxIndex) + 1;
		const used = new Uint8Array(size);
		for (const mesh of this.meshes) {
			const offset = mesh.vertexOffset || 0;
			for (const index of mesh.triangles) {
				const j = index + offset;
				if (j >= 0 && j < size && Number.isInteger(j))
					used[j] = 1;
			}
		}

		// Index remaps. NaN marks an index with no written element, which
		// (as with the previous Map lookups) prints as "NaN" in face lines.
		const vertMap = new Float64Array(size).fill(NaN);
		const normalMap = new Float64Array(size).fill(NaN);
		const uvMap = new Float64Array(size).fill(NaN);

		// Write verts.
		const verts = this.verts;
		for (let i = 0, j = 0, u = 0, n = verts.length; i < n; j++, i+= 3) {
			if (used[j] === 1) {
				vertMap[j] = u++;
				if (out.push('v ' + verts[i] + ' ' + verts[i + 1] + ' ' + verts[i + 2]))
					await out.flush();
			}
		}

		// Write normals.
		const normals = this.normals;
		for (let i = 0, j = 0, u = 0, n = normals.length; i < n; j++, i += 3) {
			if (used[j] === 1) {
				normalMap[j] = u++;
				if (out.push('vn ' + normals[i] + ' ' + normals[i + 1] + ' ' + normals[i + 2]))
					await out.flush();
			}
		}

		// Write vertex colors (non-standard, used by wow.export Blender addon).
		if (this.colors) {
			const colors = this.colors;
			for (let i = 0, j = 0, n = colors.length; i < n; j++, i += 4) {
				if (used[j] === 1 && out.push('vc ' + colors[i] + ' ' + colors[i + 1] + ' ' + colors[i + 2] + ' ' + colors[i + 3]))
					await out.flush();
			}
		}

		// Write UVs
		const layerCount = this.uvs.length;
		const hasUV = layerCount > 0;
		if (hasUV) {
			for (let uvIndex = 0; uvIndex < layerCount; uvIndex++) {
				const uv = this.uvs[uvIndex];

				let prefix = 'vt';

				// Use non-standard properties (vt2, vt3, etc) for additional UV layers.
				if (uvIndex > 0)
					prefix += (uvIndex + 1);

				for (let i = 0, j = 0, u = 0, n = uv.length; i < n; j++, i += 2) {
					if (used[j] === 1) {
						// Build the index reference using just the first layer
						// since it will be identical for all other layers.
						if (uvIndex === 0)
							uvMap[j] = u++;

						const v = this.flip_uvs ? (1 - uv[i + 1]) : uv[i + 1];
						if (out.push(prefix + ' ' + uv[i] + ' ' + v))
							await out.flush();
					}
				}
			}
		}

		// Look up a remapped index; anything outside the remap (negative or
		// fractional indices) prints as NaN, as the previous Map lookup did.
		const remap = (map, idx) => (idx >= 0 && idx < size && Number.isInteger(idx) ? map[idx] : NaN) + 1;

		// Write meshes.
		for (const mesh of this.meshes) {
			out.push('g ' + mesh.name);
			out.push('s 1');

			if (mesh.matName)
				out.push('usemtl ' + mesh.matName);

			const triangles = mesh.triangles;
			const offset = mesh.vertexOffset || 0;

			for (let i = 0, n = triangles.length; i < n; i += 3) {
				const idxA = triangles[i] + offset;
				const idxB = triangles[i + 1] + offset;
				const idxC = triangles[i + 2] + offset;

				const pointA = remap(vertMap, idxA) + '/' + (hasUV ? remap(uvMap, idxA) : '') + '/' + remap(normalMap, idxA);
				const pointB = remap(vertMap, idxB) + '/' + (hasUV ? remap(uvMap, idxB) : '') + '/' + remap(normalMap, idxB);
				const pointC = remap(vertMap, idxC) + '/' + (hasUV ? remap(uvMap, idxC) : '') + '/' + remap(normalMap, idxC);

				if (out.push('f ' + pointA + ' ' + pointB + ' ' + pointC))
					await out.flush();
			}
		}

		await out.flush();
		await writer.close();
	}
}

module.exports = OBJWriter;