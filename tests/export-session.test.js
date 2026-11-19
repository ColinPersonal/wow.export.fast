const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const session = require('../src/js/export-session');

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
	let resolve, reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
};

beforeEach(() => {
	// Leave every test with no active session and the default I/O limit.
	while (session.isActive())
		session.end();
	session.setIOLimit(16);
});

test('outside a session once() always runs the function', async () => {
	let calls = 0;
	await session.once('a', async () => calls++);
	await session.once('a', async () => calls++);
	assert.equal(calls, 2);
	assert.equal(session.has('a'), false);
});

test('inside a session once() runs each key a single time', async () => {
	session.begin();
	let calls = 0;
	const r1 = await session.once('a', async () => ++calls);
	const r2 = await session.once('a', async () => ++calls);
	await session.once('b', async () => ++calls);
	session.end();

	assert.equal(calls, 2);
	assert.equal(r1, 1);
	assert.equal(r2, 1, 'second caller should get the first result');
});

test('concurrent callers for the same key share one in-flight promise', async () => {
	session.begin();
	const gate = deferred();
	let calls = 0;

	const work = () => session.once('shared', async () => { calls++; await gate.promise; return 'done'; });
	const all = Promise.all([work(), work(), work()]);
	await tick();
	assert.equal(calls, 1);

	gate.resolve();
	assert.deepEqual(await all, ['done', 'done', 'done']);
	session.end();
});

test('a failed key is released so a later call can retry', async () => {
	session.begin();
	await assert.rejects(session.once('k', async () => { throw new Error('boom'); }), /boom/);
	await tick();
	assert.equal(session.has('k'), false);

	const result = await session.once('k', async () => 'retried');
	assert.equal(result, 'retried');
	session.end();
});

test('a synchronous throw in fn() becomes a rejection, not a throw', async () => {
	session.begin();
	const p = session.once('sync', () => { throw new Error('sync boom'); });
	assert.ok(p instanceof Promise);
	await assert.rejects(p, /sync boom/);
	session.end();
});

test('nested sessions share the outer session and clear on the last end()', async () => {
	session.begin();
	await session.once('x', async () => 1);
	session.begin();
	assert.equal(session.has('x'), true);
	session.end();
	assert.equal(session.isActive(), true);
	assert.equal(session.has('x'), true);
	session.end();
	assert.equal(session.isActive(), false);
	assert.equal(session.has('x'), false);
});

test('end() with no active session is a no-op', () => {
	session.end();
	session.end();
	assert.equal(session.isActive(), false);
	session.begin();
	assert.equal(session.isActive(), true);
	session.end();
});

test('reset() discards a leaked session and starts a fresh one', async () => {
	session.begin();
	session.begin();
	await session.once('leaked', async () => 1);
	session.reset();
	assert.equal(session.isActive(), true);
	assert.equal(session.has('leaked'), false);
	session.end();
	assert.equal(session.isActive(), false);
});

test('io() never runs more than the limit at once', async () => {
	session.setIOLimit(3);
	let active = 0, peak = 0;

	const job = async () => {
		active++;
		peak = Math.max(peak, active);
		await tick();
		await tick();
		active--;
	};

	await Promise.all(Array.from({ length: 20 }, () => session.io(job)));
	assert.equal(peak, 3);
	assert.equal(active, 0);
});

test('io() hands slots to waiters in FIFO order', async () => {
	session.setIOLimit(1);
	const order = [];
	await Promise.all([1, 2, 3, 4, 5].map(n => session.io(async () => { await tick(); order.push(n); })));
	assert.deepEqual(order, [1, 2, 3, 4, 5]);
});

test('io() releases its slot when the operation fails', async () => {
	session.setIOLimit(1);
	await assert.rejects(session.io(async () => { throw new Error('io fail'); }), /io fail/);
	// If the slot leaked this would hang and the test would time out.
	assert.equal(await session.io(async () => 'ok'), 'ok');
});

test('io() returns the operation result', async () => {
	assert.equal(await session.io(async () => 42), 42);
	assert.equal(await session.io(() => 'sync value'), 'sync value');
});

test('setIOLimit() clamps to at least 1 and truncates fractions', async () => {
	session.setIOLimit(0);
	let active = 0, peak = 0;
	const job = async () => { active++; peak = Math.max(peak, active); await tick(); active--; };
	await Promise.all([job, job, job].map(j => session.io(j)));
	assert.equal(peak, 1);

	session.setIOLimit(2.9);
	peak = 0;
	await Promise.all([job, job, job, job].map(j => session.io(j)));
	assert.equal(peak, 2);
});
