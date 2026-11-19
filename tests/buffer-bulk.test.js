const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const BufferWrapper = require('../src/js/buffer');

// Reference implementation: one prototype call per element, as BufferWrapper
// did before the bulk fast paths were added.
function read_one_by_one(raw, ofs, method, byteLength, count, extraArg) {
	const out = new Array(count);
	for (let i = 0; i < count; i++) {
		out[i] = extraArg === undefined ? raw[method](ofs + i * byteLength) : raw[method](ofs + i * byteLength, extraArg);
	}
	return out;
}

// [BufferWrapper method, Buffer method, byteLength, Buffer method takes byteLength as second arg]
const READERS = [
	['readInt8', 'readInt8', 1],
	['readUInt8', 'readUInt8', 1],
	['readInt16LE', 'readInt16LE', 2],
	['readUInt16LE', 'readUInt16LE', 2],
	['readInt16BE', 'readInt16BE', 2],
	['readUInt16BE', 'readUInt16BE', 2],
	['readInt24LE', 'readIntLE', 3, true],
	['readUInt24BE', 'readUIntBE', 3, true],
	['readInt32LE', 'readInt32LE', 4],
	['readUInt32LE', 'readUInt32LE', 4],
	['readInt32BE', 'readInt32BE', 4],
	['readUInt32BE', 'readUInt32BE', 4],
	['readInt48LE', 'readIntLE', 6, true],
	['readInt64LE', 'readBigInt64LE', 8],
	['readUInt64BE', 'readBigUInt64BE', 8],
	['readFloatLE', 'readFloatLE', 4],
	['readFloatBE', 'readFloatBE', 4],
	['readDoubleLE', 'readDoubleLE', 8],
	['readDoubleBE', 'readDoubleBE', 8]
];

function random_buffer(size, seed) {
	const out = Buffer.alloc(size);
	let x = seed;
	for (let i = 0; i < size; i++) {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0;
		out[i] = x >>> 24;
	}
	return out;
}

// Bytes that decode to interesting float values: NaN, +-Infinity, -0, denormals.
function special_float_buffer() {
	const buf = Buffer.alloc(8 * 16);
	const floats = [NaN, Infinity, -Infinity, -0, 0, 1.401298464324817e-45, -3.4028234663852886e38, 0.1];
	floats.forEach((f, i) => buf.writeFloatLE(f, i * 4));
	floats.forEach((f, i) => buf.writeFloatBE(f, 32 + i * 4));
	floats.forEach((f, i) => buf.writeDoubleLE(f, 64 + i * 8));
	buf.writeUInt32LE(0x7FC00001, 0); // NaN with payload
	buf.writeUInt32LE(0xFF800001, 4); // signalling-ish NaN
	return buf;
}

function same(a, b, msg) {
	assert.equal(a.length, b.length, msg);
	assert.ok(Array.isArray(a), msg + ': result must be a plain Array');
	for (let i = 0; i < a.length; i++) {
		assert.equal(typeof a[i], typeof b[i], `${msg} [${i}] type`);
		assert.ok(Object.is(a[i], b[i]), `${msg} [${i}]: ${a[i]} !== ${b[i]}`);
	}
}

test('bulk reads match one-at-a-time reads for every element type and offset', () => {
	const sources = [random_buffer(203, 1), random_buffer(203, 99), special_float_buffer()];

	for (const raw of sources) {
		for (const [method, rawMethod, byteLength, takesLength] of READERS) {
			for (const start of [0, 1, 2, 3, 5, 7]) {
				const maxCount = Math.floor((raw.length - start) / byteLength);
				for (const count of [0, 1, 3, 4, 17, maxCount].filter(c => c <= maxCount)) {
					const wrapper = new BufferWrapper(raw);
					wrapper.seek(start);

					const result = wrapper[method](count);
					const expected = read_one_by_one(raw, start, rawMethod, byteLength, count, takesLength ? byteLength : undefined);
					same(result, expected, `${method}(${count}) @${start}`);
					assert.equal(wrapper.offset, start + count * byteLength, `${method} offset`);
				}
			}
		}
	}
});

test('bulk reads on a sub-view Buffer (non-zero byteOffset) use the right bytes', () => {
	const backing = random_buffer(300, 7);
	const view = backing.subarray(13, 213); // odd byteOffset into the ArrayBuffer

	for (const [method, rawMethod, byteLength, takesLength] of READERS) {
		const wrapper = new BufferWrapper(view);
		wrapper.seek(3);
		const result = wrapper[method](11);
		same(result, read_one_by_one(view, 3, rawMethod, byteLength, 11, takesLength ? byteLength : undefined), method);
	}
});

test('bulk reads still see the new data after setCapacity replaces the buffer', () => {
	const wrapper = BufferWrapper.alloc(16, true);
	wrapper.writeFloatLE(1.5);
	wrapper.seek(0);
	same(wrapper.readFloatLE(1), [1.5], 'before');

	wrapper.setCapacity(32, true);
	wrapper.seek(16);
	wrapper.writeFloatLE(2.25);
	wrapper.seek(0);
	same(wrapper.readFloatLE(5), [1.5, 0, 0, 0, 2.25], 'after');
});

test('generic readIntLE/readUIntBE with a count go through the same paths', () => {
	const raw = random_buffer(64, 5);
	for (const byteLength of [1, 2, 3, 4, 5, 6]) {
		for (const [method, rawMethod] of [['readIntLE', 'readIntLE'], ['readUIntLE', 'readUIntLE'], ['readIntBE', 'readIntBE'], ['readUIntBE', 'readUIntBE']]) {
			const wrapper = new BufferWrapper(raw);
			wrapper.seek(1);
			const count = Math.floor(60 / byteLength);
			same(wrapper[method](byteLength, count), read_one_by_one(raw, 1, rawMethod, byteLength, count, byteLength), `${method}(${byteLength})`);
		}
	}
});

test('single-value reads are unchanged', () => {
	const raw = random_buffer(32, 3);
	const wrapper = new BufferWrapper(raw);
	assert.equal(wrapper.readUInt8(), raw.readUInt8(0));
	assert.equal(wrapper.readInt16LE(), raw.readInt16LE(1));
	assert.equal(wrapper.readFloatLE(), raw.readFloatLE(3));
	assert.equal(wrapper.readUInt32BE(), raw.readUInt32BE(7));
});

test('reading past the end throws the same error and does not move the offset', () => {
	for (const [method, , byteLength] of READERS) {
		const wrapper = BufferWrapper.alloc(10, true);
		wrapper.seek(1);
		const count = Math.floor(9 / byteLength) + 1;
		assert.throws(() => wrapper[method](count), {
			message: `Buffer operation out-of-bounds: ${count * byteLength} > 9`
		}, method);
		assert.equal(wrapper.offset, 1, method);
	}
});

test('writeFloatArrayLE writes the same bytes as writeFloatLE per element', () => {
	const values = [0, -0, 1, -1, 0.1, NaN, Infinity, -Infinity, 1e-46, 3.5e38, 1.401298464324817e-45, Math.PI, '2.5', undefined];
	const floats32 = Float32Array.from([1.25, -7, 0.3]);

	for (const input of [values, floats32, []]) {
		for (const pad of [0, 1, 3]) {
			const size = pad + input.length * 4 + 2;
			const a = BufferWrapper.alloc(size, true);
			const b = BufferWrapper.alloc(size, true);
			a.fill(0, pad);
			b.fill(0, pad);

			for (const v of input)
				a.writeFloatLE(v);
			b.writeFloatArrayLE(input);

			assert.equal(b.offset, a.offset);
			assert.deepEqual(b.raw, a.raw);
		}
	}
});

test('writeUInt*Array writes the same bytes as the per-element writers', () => {
	const cases = [
		['writeUInt8', 'writeUInt8Array', 1, [0, 1, 127, 128, 255, 3.7, NaN, '9', undefined, 200]],
		['writeUInt16LE', 'writeUInt16ArrayLE', 2, [0, 1, 255, 256, 65535, 4660, 12.9, NaN]],
		['writeUInt32LE', 'writeUInt32ArrayLE', 4, [0, 1, 65536, 0x7FFFFFFF, 0x80000000, 0xFFFFFFFF, 123456789, 5.5, NaN]]
	];

	for (const [single, bulk, size, values] of cases) {
		for (const input of [values, Uint8Array.from([1, 2, 250]), []]) {
			for (const pad of [0, 1, 3]) {
				const length = pad + input.length * size + 1;
				const a = BufferWrapper.alloc(length, true);
				const b = BufferWrapper.alloc(length, true);
				a.fill(0, pad);
				b.fill(0, pad);

				for (const v of input)
					a[single](v);
				b[bulk](input);

				assert.equal(b.offset, a.offset, bulk);
				assert.deepEqual(b.raw, a.raw, bulk);
			}
		}
	}
});

test('writeUInt*Array throws the same range errors at the same point', () => {
	const cases = [
		['writeUInt8', 'writeUInt8Array', [1, 2, 256, 3]],
		['writeUInt8', 'writeUInt8Array', [1, -1]],
		['writeUInt16LE', 'writeUInt16ArrayLE', [1, 70000, 2]],
		['writeUInt32LE', 'writeUInt32ArrayLE', [5, 2 ** 32]]
	];

	for (const [single, bulk, values] of cases) {
		const a = BufferWrapper.alloc(32, true);
		const b = BufferWrapper.alloc(32, true);

		let errA;
		try {
			for (const v of values)
				a[single](v);
		} catch (e) {
			errA = e;
		}

		assert.ok(errA, 'reference must throw');
		assert.throws(() => b[bulk](values), (e) => e.constructor === errA.constructor && e.message === errA.message && e.code === errA.code);
		assert.equal(b.offset, a.offset, bulk);
		assert.deepEqual(b.raw, a.raw, bulk);
	}
});

test('bulk writes past the end throw like the per-element writers', () => {
	const a = BufferWrapper.alloc(7, true);
	const b = BufferWrapper.alloc(7, true);
	const values = [1.5, 2.5];

	let errA;
	try {
		for (const v of values)
			a.writeFloatLE(v);
	} catch (e) {
		errA = e;
	}

	assert.throws(() => b.writeFloatArrayLE(values), { message: errA.message });
	assert.equal(b.offset, a.offset);
	assert.deepEqual(b.raw, a.raw);

	const c = BufferWrapper.alloc(3, true);
	assert.throws(() => c.writeUInt16ArrayLE([1, 2]), { message: 'Buffer operation out-of-bounds: 2 > 1' });
	assert.equal(c.offset, 2);
});

test('BufferWrapper.concat output is unchanged', () => {
	const parts = [Buffer.from([1, 2, 3]), Buffer.from([]), Buffer.from([4, 5])].map(b => new BufferWrapper(b));
	const combined = BufferWrapper.concat(parts);
	assert.deepEqual([...combined.raw], [1, 2, 3, 4, 5]);
	assert.equal(crypto.createHash('md5').update(combined.raw).digest('hex'), crypto.createHash('md5').update(Buffer.from([1, 2, 3, 4, 5])).digest('hex'));
});
