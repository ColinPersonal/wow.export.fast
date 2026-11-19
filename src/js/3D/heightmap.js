/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Terrain heightmap sampling, shared by the maps tab and the headless exporter.
const util = require('util');
const core = require('../core');
const log = require('../log');
const listfile = require('../casc/listfile');
const ADTLoader = require('./loaders/ADTLoader');

/**
 * Sample height at a specific position within a chunk using bilinear interpolation.
 * @param {Object} chunk
 * @param {number} localX
 * @param {number} localY
 * @returns {number}
 */
const sample_chunk_height = (chunk, localX, localY) => {
	const vx = localX * 8;
	const vy = localY * 8;

	const x0 = Math.floor(vx);
	const y0 = Math.floor(vy);
	const x1 = Math.min(8, x0 + 1);
	const y1 = Math.min(8, y0 + 1);

	const get_vert_idx = (x, y) => {
		let index = 0;
		for (let row = 0; row < y * 2; row++)
			index += (row % 2) ? 8 : 9;

		const is_short = !!(y * 2 % 2);
		index += is_short ? Math.min(x, 7) : Math.min(x, 8);
		return index;
	};

	const h00 = chunk.vertices[get_vert_idx(x0, y0)] + chunk.position[2];
	const h10 = chunk.vertices[get_vert_idx(x1, y0)] + chunk.position[2];
	const h01 = chunk.vertices[get_vert_idx(x0, y1)] + chunk.position[2];
	const h11 = chunk.vertices[get_vert_idx(x1, y1)] + chunk.position[2];

	const fx = vx - x0;
	const fy = vy - y0;

	const h0 = h00 * (1 - fx) + h10 * fx;
	const h1 = h01 * (1 - fx) + h11 * fx;

	return h0 * (1 - fy) + h1 * fy;
};

/**
 * Extract height data from a terrain tile.
 * @param {ADTExporter} adt
 * @param {number} resolution
 * @returns {Object|null}
 */
const extract_height_data_from_tile = async (adt, resolution) => {
	const map_dir = adt.mapDir;
	const tile_x = adt.tileX;
	const tile_y = adt.tileY;
	const prefix = util.format('world/maps/%s/%s', map_dir, map_dir);
	const tile_prefix = prefix + '_' + adt.tileY + '_' + adt.tileX;

	try {
		const root_fid = listfile.getByFilename(tile_prefix + '.adt');
		if (!root_fid) {
			log.write('cannot find fileDataID for %s.adt', tile_prefix);
			return null;
		}

		const root_file = await core.view.casc.getFile(root_fid);
		const root_adt = new ADTLoader(root_file);

		root_adt.loadRoot();

		if (!root_adt.chunks || root_adt.chunks.length === 0) {
			log.write('no chunks found in ADT file %s', tile_prefix);
			return null;
		}

		const heights = new Float32Array(resolution * resolution);
		for (let py = 0; py < resolution; py++) {
			for (let px = 0; px < resolution; px++) {
				const chunk_x = Math.floor(px * 16 / resolution);
				const chunk_y = Math.floor(py * 16 / resolution);
				const chunk_index = chunk_y * 16 + chunk_x;

				if (chunk_index >= root_adt.chunks.length)
					continue;

				const chunk = root_adt.chunks[chunk_index];
				if (!chunk || !chunk.vertices)
					continue;

				const local_x = (px * 16 / resolution) - chunk_x;
				const local_y = (py * 16 / resolution) - chunk_y;

				const height = sample_chunk_height(chunk, local_x, local_y);

				// rotate 90° CW to align with terrain mesh coordinate system
				const height_idx = (resolution - 1 - px) * resolution + py;
				heights[height_idx] = height;
			}
		}

		return {
			heights: heights,
			resolution: resolution,
			tileX: tile_x,
			tileY: tile_y
		};

	} catch (e) {
		log.write('error extracting height data from tile %s: %s', tile_prefix, e.message);
		return null;
	}
};

/**
 * Configure a PNGWriter for a heightmap and fill its pixels, normalising
 * heights to [min, min + range]. Same encoding as the maps tab: 8 or 16-bit
 * greyscale, or 32-bit (a float32 per pixel stored in RGBA bytes).
 * @param {PNGWriter} writer Writer sized resolution x resolution.
 * @param {Float32Array} heights
 * @param {number} min
 * @param {number} range
 * @param {number} bit_depth 8, 16 or 32.
 */
const fill_heightmap_pixels = (writer, heights, min, range, bit_depth) => {
	const scale = range > 0 ? range : 1;

	if (bit_depth === 32) {
		writer.bytesPerPixel = 4;
		writer.bitDepth = 8;
		writer.colorType = 6;

		const pixel_data = writer.getPixelData();
		const float_view = new Float32Array(1);
		const byte_view = new Uint8Array(float_view.buffer);

		for (let j = 0; j < heights.length; j++) {
			float_view[0] = (heights[j] - min) / scale;
			const offset = j * 4;
			pixel_data[offset] = byte_view[0];
			pixel_data[offset + 1] = byte_view[1];
			pixel_data[offset + 2] = byte_view[2];
			pixel_data[offset + 3] = byte_view[3];
		}
	} else if (bit_depth === 16) {
		writer.bytesPerPixel = 2;
		writer.bitDepth = 16;
		writer.colorType = 0;

		const pixel_data = writer.getPixelData();
		for (let j = 0; j < heights.length; j++) {
			const gray_value = Math.floor(((heights[j] - min) / scale) * 65535);
			pixel_data[j * 2] = (gray_value >> 8) & 0xFF;
			pixel_data[j * 2 + 1] = gray_value & 0xFF;
		}
	} else {
		writer.bytesPerPixel = 1;
		writer.bitDepth = 8;
		writer.colorType = 0;

		const pixel_data = writer.getPixelData();
		for (let j = 0; j < heights.length; j++)
			pixel_data[j] = Math.floor(((heights[j] - min) / scale) * 255);
	}
};

module.exports = { sample_chunk_height, extract_height_data_from_tile, fill_heightmap_pixels };
