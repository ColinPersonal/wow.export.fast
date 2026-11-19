// BLTE decoding: the export worker's decoder must produce exactly what the
// main-thread BLTEReader produces, and must decline (hand the data back) for
// anything it does not handle, so the main thread raises the usual errors.
require('./helpers/nw-stub');

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const BufferWrapper = require('../src/js/buffer');
const { BLTEReader } = require('../src/js/casc/blte-reader');
const workerPool = require('../src/js/worker-pool');
const { makeBLTE, ownedCopy, rng } = require('./helpers/fixtures');

workerPool.setScriptPath(path.join(__dirname, '..', 'src', 'js', 'workers', 'export-worker.js'));

const payload = (size, seed = 7) => {
	// Mostly structured with some noise, so zlib does real work but still
	// compresses (as real CASC content does).
	const rand = rng(seed);
	const buf = Buffer.alloc(size);
	for (let i = 0; i < size; i++)
		buf[i] = i % 4 === 0 ? (rand() * 256) | 0 : (i >> 6) & 0xFF;
	return buf;
};

const mainThreadDecode = (data, hash) => {
	const reader = new BLTEReader(new BufferWrapper(Buffer.from(data)), hash);
	reader.processAllBlocks();
	return Buffer.from(reader.raw);
};

const CASES = [
	{ name: 'headerless single plain block', size: 4096, opts: { blocks: 0, mode: 'plain' } },
	{ name: 'headerless single zlib block', size: 65536, opts: { blocks: 0, mode: 'zlib' } },
	{ name: 'one zlib block with header', size: 100000, opts: { blocks: 1 } },
	{ name: 'many zlib blocks', size: 1 << 20, opts: { blocks: 16 } },
	{ name: 'mixed plain and zlib blocks', size: 300000, opts: { blocks: 7, mode: 'mixed' } },
	{ name: 'blocks without per-block hashes', size: 200000, opts: { blocks: 4, blockHashes: false } }
];

for (const c of CASES) {
	test(`worker and main thread agree: ${c.name}`, async () => {
		const input = payload(c.size);
		const { data, hash } = makeBLTE(input, c.opts);

		const expected = mainThreadDecode(data, hash);
		assert.ok(expected.equals(input), 'main-thread reader should reproduce the payload');

		const result = await workerPool.decodeBLTE(ownedCopy(data), hash);
		assert.notEqual(result.decoded, null, 'worker should handle this container');
		assert.ok(result.decoded.equals(expected), 'worker output differs from main thread');
	});
}

test('headerless zlib block that grew when compressed: worker is exact, main thread pads', async () => {
	// Pre-existing main-thread behaviour: a headerless block's output buffer is
	// sized from the compressed length, so when compression made the data
	// larger (random bytes) BLTEReader returns the payload plus trailing zeros.
	// The worker returns the payload exactly. This test pins both behaviours
	// so a change to either is noticed.
	const rand = rng(99);
	const input = Buffer.from(Array.from({ length: 100 }, () => (rand() * 256) | 0));
	const { data, hash } = makeBLTE(input, { blocks: 0, mode: 'zlib' });
	assert.ok(data.length - 9 > input.length, 'fixture should have grown when compressed');

	const main = mainThreadDecode(data, hash);
	assert.ok(main.subarray(0, input.length).equals(input));
	assert.equal(main.length, data.length - 9);
	assert.ok(main.subarray(input.length).every(b => b === 0));

	const result = await workerPool.decodeBLTE(ownedCopy(data), hash);
	assert.ok(result.decoded.equals(input));
});

test('worker accepts a pooled (non-transferable) buffer', async () => {
	const input = payload(50000);
	const { data, hash } = makeBLTE(input, { blocks: 3 });
	// A subarray of a larger buffer cannot be transferred, only copied.
	const pooled = Buffer.concat([Buffer.alloc(13), data]).subarray(13);

	const result = await workerPool.decodeBLTE(pooled, hash);
	assert.ok(result.decoded.equals(input));
	assert.ok(pooled.equals(data), 'caller buffer should be untouched when copied');
});

test('worker declines a wrong encoding key and returns the data intact', async () => {
	const { data } = makeBLTE(payload(20000), { blocks: 2 });
	const result = await workerPool.decodeBLTE(ownedCopy(data), '0'.repeat(32));

	assert.equal(result.decoded, null);
	assert.ok(result.raw.equals(data), 'returned raw data must match what was sent');
	assert.throws(() => mainThreadDecode(result.raw, '0'.repeat(32)), /Invalid MD5 hash/);
});

test('worker declines a corrupted block and the main thread reports it', async () => {
	const { data, hash } = makeBLTE(payload(40000), { blocks: 2 });
	const corrupt = Buffer.from(data);
	corrupt[corrupt.length - 5] ^= 0xFF; // inside the last block, header hash still valid

	const result = await workerPool.decodeBLTE(ownedCopy(corrupt), hash);
	assert.equal(result.decoded, null);
	assert.ok(result.raw.equals(corrupt));
	assert.throws(() => mainThreadDecode(result.raw, hash), /Invalid block data hash/);
});

test('worker declines encrypted blocks', async () => {
	const { data, hash } = makeBLTE(payload(1000), { blocks: 1, mode: 'plain', blockHashes: false });
	const encrypted = Buffer.from(data);
	encrypted[36] = 0x45; // first byte of the only block: 'E' (encrypted)
	// header hash covers only the header, so it is unchanged

	const result = await workerPool.decodeBLTE(ownedCopy(encrypted), hash);
	assert.equal(result.decoded, null);
	assert.ok(result.raw.equals(encrypted));
});

test('worker declines data that is not BLTE', async () => {
	const junk = Buffer.from('definitely not a BLTE container');
	const result = await workerPool.decodeBLTE(ownedCopy(junk), '0'.repeat(32));
	assert.equal(result.decoded, null);
	assert.ok(result.raw.equals(junk));
});

test('BLTEReader.fromDecoded wraps worker output as a readable buffer', async () => {
	const input = payload(10000);
	const { data, hash } = makeBLTE(input, { blocks: 2 });
	const result = await workerPool.decodeBLTE(ownedCopy(data), hash);

	const reader = BLTEReader.fromDecoded(result.decoded);
	assert.equal(reader.byteLength, input.length);
	assert.equal(reader.readUInt32LE(), input.readUInt32LE(0));
	reader.processAllBlocks(); // must be a no-op
	assert.ok(Buffer.from(reader.raw).equals(input));
});

after(() => {
	// Workers are unref()'d, so the process can exit without explicit cleanup.
});

test('raw buffer access decodes every block first', () => {
	// Bulk decoders read the underlying buffer directly; they must never see
	// blocks that have not been decoded yet.
	const payload = Buffer.concat([Buffer.alloc(6000, 0x11), Buffer.alloc(6000, 0x22)]);
	const { data, hash: key } = makeBLTE(payload, { blocks: 2 });

	const reader = new BLTEReader(new BufferWrapper(Buffer.from(data)), key);
	assert.equal(reader.readUInt8(), 0x11, 'reading the first byte only needs the first block');
	assert.equal(reader.blockIndex, 1, 'the second block has not been decoded yet');

	const raw = reader.raw;
	assert.equal(reader.blockIndex, 2, 'taking the raw buffer decodes the rest');
	assert.ok(raw.equals(payload));
});
