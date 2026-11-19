class M2Track {
	/**
	 * Construct a new M2Track instance.
	 * @param {number} globalSeq
	 * @param {number} interpolation
	 * @param {Array} timestamps
	 * @param {Array} values
	 * @param {Array} timestampOffsets - array of {count, offset} per animation
	 * @param {Array} valueOffsets - array of {count, offset} per animation
	 */
	constructor(globalSeq, interpolation, timestamps, values, timestampOffsets = null, valueOffsets = null) {
		this.globalSeq = globalSeq;
		this.interpolation = interpolation;
		this.timestamps = timestamps;
		this.values = values;
		this.timestampOffsets = timestampOffsets;
		this.valueOffsets = valueOffsets;
	}
}

// Byte size of each element for the data types read_m2_values() understands.
const M2_VALUE_SIZES = Object.assign(Object.create(null), { uint32: 4, int16: 2, float3: 12, float4: 16, compquat: 8, uint8: 1 });

/**
 * Read `count` consecutive elements of `dataType` from the current offset.
 * Equivalent to reading them one at a time (same values, same array shapes,
 * same errors at the same element), but scalar types are bulk-read when the
 * whole run is in bounds.
 * @param {BufferWrapper} buf
 * @param {string} dataType
 * @param {number} count
 * @param {string} unknownMessage Error prefix thrown for an unknown type (only when count > 0).
 * @returns {Array}
 */
function read_m2_values(buf, dataType, count, unknownMessage) {
	// Nothing is read (or validated) for an empty run.
	if (count === 0)
		return Array(0);

	const size = M2_VALUE_SIZES[dataType];
	if (size === undefined) {
		if (count > 0)
			throw new Error(`${unknownMessage}: ${dataType}`);

		return Array(count);
	}

	// Fast path: the whole run fits, so a bulk read cannot fail part-way.
	const inBounds = buf.remainingBytes >= count * size;

	switch (dataType) {
		case 'uint32':
			if (inBounds)
				return buf.readUInt32LE(count);
			break;

		case 'int16':
			if (inBounds)
				return buf.readInt16LE(count);
			break;

		case 'uint8':
			if (inBounds)
				return buf.readUInt8(count);
			break;

		case 'float3': {
			const out = Array(count);
			for (let j = 0; j < count; j++)
				out[j] = buf.readFloatLE(3);
			return out;
		}

		case 'float4': {
			const out = Array(count);
			for (let j = 0; j < count; j++)
				out[j] = buf.readFloatLE(4);
			return out;
		}

		case 'compquat': {
			const out = Array(count);
			for (let j = 0; j < count; j++) {
				const q = buf.readUInt16LE(4);
				q[0] = (q[0] - 32767) / 32768;
				q[1] = (q[1] - 32767) / 32768;
				q[2] = (q[2] - 32767) / 32768;
				q[3] = (q[3] - 32767) / 32768;
				out[j] = q;
			}
			return out;
		}
	}

	// Out-of-bounds scalar run: read one at a time so the error matches exactly.
	const out = Array(count);
	for (let j = 0; j < count; j++) {
		if (dataType === 'uint32')
			out[j] = buf.readUInt32LE();
		else if (dataType === 'int16')
			out[j] = buf.readInt16LE();
		else
			out[j] = buf.readUInt8();
	}

	return out;
}

// See https://wowdev.wiki/M2#Standard_animation_block
function read_m2_array_array(data, ofs, dataType, useAnims = false, animFiles = new Map(), storeOffsets = false, sequences = null) {
	const arrCount = data.readUInt32LE();
	const arrOfs = data.readUInt32LE();

	const base = data.offset;
	data.seek(ofs + arrOfs);

	const arr = Array(arrCount);
	const offsets = storeOffsets ? Array(arrCount) : null;

	for (let i = 0; i < arrCount; i++) {
		const subArrCount = data.readUInt32LE();
		const subArrOfs = data.readUInt32LE();
		const subBase = data.offset;

		if (storeOffsets)
			offsets[i] = { count: subArrCount, offset: subArrOfs };

		// data lives in external .anim file, skip reading from M2 buffer
		if (sequences && i < sequences.length && (sequences[i].flags & 0x20) === 0) {
			arr[i] = [];
			data.seek(subBase);
			continue;
		}

		data.seek(ofs + subArrOfs);

		if (useAnims && animFiles.has(i)) {
			const animFile = animFiles.get(i);

			// Values live in the .anim file at subArrOfs. They are contiguous, so
			// seek once and read sequentially (same positions as seeking per element).
			if (subArrCount > 0 && M2_VALUE_SIZES[dataType] !== undefined)
				animFile.seek(subArrOfs);

			arr[i] = read_m2_values(animFile, dataType, subArrCount, 'Unhandled data type');
		} else {
			arr[i] = read_m2_values(data, dataType, subArrCount, 'Unknown data type');
		}

		data.seek(subBase);
	}

	data.seek(base);

	if (storeOffsets)
		return { arr, offsets };

	return arr;
}

// See https://wowdev.wiki/M2#Standard_animation_block
function read_m2_track(data, ofs, dataType, useAnims = false, animFiles = new Map(), storeOffsets = false, sequences = null) {
	const interpolation = data.readUInt16LE();
	const globalSeq = data.readUInt16LE();

	let timestamps, values;
	let timestampOffsets = null, valueOffsets = null;

	if (useAnims) {
		timestamps = read_m2_array_array(data, ofs, 'uint32', useAnims, animFiles, false, sequences);
		values = read_m2_array_array(data, ofs, dataType, useAnims, animFiles, false, sequences);
	} else if (storeOffsets) {
		const tsResult = read_m2_array_array(data, ofs, 'uint32', false, animFiles, true, sequences);
		timestamps = tsResult.arr;
		timestampOffsets = tsResult.offsets;

		const valResult = read_m2_array_array(data, ofs, dataType, false, animFiles, true, sequences);
		values = valResult.arr;
		valueOffsets = valResult.offsets;
	} else {
		timestamps = read_m2_array_array(data, ofs, 'uint32', false, new Map(), false, sequences);
		values = read_m2_array_array(data, ofs, dataType, false, new Map(), false, sequences);
	}

	return new M2Track(globalSeq, interpolation, timestamps, values, timestampOffsets, valueOffsets);
}

/**
 * Patch a single animation slot in a track using external .anim data.
 * @param {M2Track} track
 * @param {number} animIndex
 * @param {BufferWrapper} animBuffer
 * @param {string} valueType
 */
function patch_track_animation(track, animIndex, animBuffer, valueType) {
	if (!track.timestampOffsets || !track.valueOffsets)
		return;

	if (animIndex >= track.timestampOffsets.length)
		return;

	const tsInfo = track.timestampOffsets[animIndex];
	const valInfo = track.valueOffsets[animIndex];

	// bounds check: ensure offsets fit within the .anim buffer
	const VALUE_SIZES = { uint32: 4, int16: 2, float3: 12, float4: 16, compquat: 8, uint8: 1 };
	const valElemSize = VALUE_SIZES[valueType] ?? 0;
	const tsEnd = tsInfo.offset + tsInfo.count * 4;
	const valEnd = valInfo.offset + valInfo.count * valElemSize;

	if (tsEnd > animBuffer.byteLength || valEnd > animBuffer.byteLength)
		return;

	// read timestamps from .anim buffer (contiguous: seek once, read sequentially)
	if (tsInfo.count > 0)
		animBuffer.seek(tsInfo.offset);

	track.timestamps[animIndex] = read_m2_values(animBuffer, 'uint32', tsInfo.count);

	// read values from .anim buffer
	let values;
	if (M2_VALUE_SIZES[valueType] === undefined) {
		// unknown value type: nothing is read
		values = Array(valInfo.count);
	} else {
		if (valInfo.count > 0)
			animBuffer.seek(valInfo.offset);

		values = read_m2_values(animBuffer, valueType, valInfo.count);
	}

	track.values[animIndex] = values;
}

// See https://wowdev.wiki/Common_Types#CAaBox
function read_caa_bb(data) {
	return { min: data.readFloatLE(3), max: data.readFloatLE(3) };
}

module.exports = { M2Track, read_m2_array_array, read_m2_track, read_caa_bb, patch_track_animation }