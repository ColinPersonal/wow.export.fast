const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startGateway, connect, call, waitFor } = require('./helpers');

describe('recovery', () => {
	test('an engine crash mid-job restarts the engine and retries the job once', async () => {
		const gw = await startGateway();
		const client = await connect(gw);
		try {
			// crash/ kills the engine every time, so the retry fails too.
			const res = await call(client, 'export_files', { files: ['crash/x.bin'], wait: 15 });
			assert.equal(res.status, 'failed', JSON.stringify(res));
			assert.equal(res.error.code, 'ENGINE_UNAVAILABLE');
			assert.equal(res.error.retryable, true);

			const runs = fs.readFileSync(path.join(gw.config.dirs.engines, 'wowf-quick', 'jobs-run.txt'), 'utf8').trim().split('\n').length;
			assert.equal(runs, 2, 'tried twice');

			// The engine comes back and serves the next job.
			const next = await call(client, 'export_files', { files: ['ok/after-crash.bin'], wait: 15 });
			assert.equal(next.status, 'done');
		} finally {
			await client.close();
			await gw.stop();
		}
	});

	test('a hung engine is detected by its heartbeat and replaced', async () => {
		const gw = await startGateway();
		const client = await connect(gw);
		try {
			const res = await call(client, 'export_files', { files: ['hang/x.bin'], wait: 0 });
			const done = await waitFor(async () => {
				const j = await call(client, 'wait_for_job', { job_id: res.job_id, timeout_seconds: 5 });
				return ['failed', 'done'].includes(j.status) ? j : null;
			}, 30000);
			assert.equal(done.status, 'failed');
			assert.equal(done.error.code, 'ENGINE_UNAVAILABLE');

			const next = await call(client, 'export_files', { files: ['ok/after-hang.bin'], wait: 15 });
			assert.equal(next.status, 'done');
		} finally {
			await client.close();
			await gw.stop();
		}
	});

	test('a source that cannot open is reported, not hung on', async () => {
		const gw = await startGateway({ env: { FAKE_ENGINE_FATAL: 'install not found' } });
		const client = await connect(gw);
		try {
			const t = Date.now();
			const res = await call(client, 'list_maps', {});
			assert.equal(res.isError, true);
			assert.equal(res.error.code, 'SOURCE_UNAVAILABLE');
			assert.match(res.error.message, /install not found/);
			assert.ok(Date.now() - t < 10000, 'answered in ' + (Date.now() - t) + 'ms');
		} finally {
			await client.close();
			await gw.stop();
		}
	});

	test('an engine with the wrong secret is refused', async () => {
		const gw = await startGateway({ env: { FAKE_ENGINE_SECRET: 'f'.repeat(64) }, overrides: { warmProducts: [] } });
		const client = await connect(gw);
		try {
			const engine = gw.pool.get('wow', 'main');
			engine.start();
			await new Promise(r => setTimeout(r, 1500));
			assert.notEqual(engine.state, 'ready');
		} finally {
			await client.close();
			await gw.stop();
		}
	});

	test('queued jobs survive a gateway restart', async () => {
		const gw = await startGateway({ env: { FAKE_ENGINE_DELAY_MS: '60000' } });
		const root = gw.root;
		const token = gw.token;
		const client = await connect(gw);
		const res = await call(client, 'export_files', { files: ['ok/survivor.bin'], wait: 0 });
		assert.equal(res.status, 'queued');
		await client.close();
		await gw.stop();

		const again = await startGateway({ root });
		const c2 = await connect(again, token);
		try {
			const done = await call(c2, 'wait_for_job', { job_id: res.job_id, timeout_seconds: 15 });
			assert.equal(done.status, 'done');
			assert.equal(done.summary.file_count, 1);
		} finally {
			await c2.close();
			await again.stop();
		}
	});

	test('a running job interrupted by a gateway stop is rerun after restart', async () => {
		const gw = await startGateway();
		const root = gw.root;
		const token = gw.token;
		const client = await connect(gw);
		const res = await call(client, 'export_files', { files: ['slow/3000/interrupted.bin'], wait: 0 });
		await waitFor(async () => (await call(client, 'get_job', { job_id: res.job_id })).status === 'running');
		await client.close();
		await gw.stop();

		const again = await startGateway({ root });
		const c2 = await connect(again, token);
		try {
			const done = await call(c2, 'wait_for_job', { job_id: res.job_id, timeout_seconds: 20 });
			assert.equal(done.status, 'done');
			assert.deepEqual(fs.readdirSync(again.config.dirs.staging), [], 'no leftover staging');
		} finally {
			await c2.close();
			await again.stop();
		}
	});

	test('a new game build does not reuse old results', async () => {
		const gw = await startGateway({ env: { FAKE_ENGINE_BUILD: '1' } });
		const root = gw.root;
		const token = gw.token;
		const client = await connect(gw);
		const first = await call(client, 'export_files', { files: ['ok/build.bin'] });
		assert.equal(first.status, 'done');
		await client.close();
		await gw.stop();

		const again = await startGateway({ root, env: { FAKE_ENGINE_BUILD: '2' } });
		const c2 = await connect(again, token);
		try {
			// Wait until the new engine has reported its build.
			await waitFor(() => again.pool.get('wowf', 'quick').state === 'ready');
			await call(c2, 'service_status');
			const second = await call(c2, 'export_files', { files: ['ok/build.bin'] });
			assert.equal(second.status, 'done');
			assert.notEqual(second.result_key, first.result_key);
			assert.notEqual(second.cached, true);
		} finally {
			await c2.close();
			await again.stop();
		}
	});

	test('per-token queue limit', async () => {
		const gw = await startGateway({ env: { FAKE_ENGINE_DELAY_MS: '60000' }, overrides: { maxQueuedPerToken: 3 } });
		const client = await connect(gw);
		try {
			for (let i = 0; i < 3; i++)
				assert.equal((await call(client, 'export_files', { files: ['ok/q' + i + '.bin'], wait: 0 })).status, 'queued');
			const over = await call(client, 'export_files', { files: ['ok/q-over.bin'], wait: 0 });
			assert.equal(over.isError, true);
			assert.equal(over.error.code, 'QUOTA_EXCEEDED');
		} finally {
			await client.close();
			await gw.stop();
		}
	});

	test('job size limits', async () => {
		const gw = await startGateway({ overrides: { maxItemsPerJob: 5 } });
		const client = await connect(gw);
		try {
			const res = await call(client, 'export_files', { files: Array.from({ length: 6 }, (_, i) => 'ok/' + i) });
			assert.equal(res.isError, true);
			assert.equal(res.error.code, 'INVALID_PARAMS');
		} finally {
			await client.close();
			await gw.stop();
		}
	});

	test('jobs are refused when the disk is nearly full', async () => {
		const gw = await startGateway({ overrides: { minFreeGB: 1e9 } });
		const client = await connect(gw);
		try {
			const res = await call(client, 'export_files', { files: ['ok/full.bin'] });
			assert.equal(res.isError, true);
			assert.equal(res.error.code, 'QUOTA_EXCEEDED');
		} finally {
			await client.close();
			await gw.stop();
		}
	});

	test('results over the disk budget are evicted, oldest first, but not while downloading', async () => {
		const gw = await startGateway();
		const client = await connect(gw);
		try {
			const a = await call(client, 'export_files', { files: ['big/600000/a.bin'] });
			await new Promise(r => setTimeout(r, 20));
			const b = await call(client, 'export_files', { files: ['big/600000/b.bin'] });
			await new Promise(r => setTimeout(r, 20));
			const c = await call(client, 'export_files', { files: ['big/600000/c.bin'] });

			const releaseB = gw.cache.hold(b.result_key);
			gw.config.diskBudgetGB = 1.3e6 / 1024 ** 3; // room for two results
			await gw.cache.evict();
			releaseB();

			assert.equal(await gw.cache.get(a.result_key), null, 'oldest evicted');
			assert.notEqual(await gw.cache.get(b.result_key), null, 'held result kept');
			assert.notEqual(await gw.cache.get(c.result_key), null);

			const expired = await call(client, 'get_job', { job_id: a.job_id });
			assert.equal(expired.error.code, 'NOT_FOUND');
		} finally {
			await client.close();
			await gw.stop();
		}
	});

	test('other products start an engine on demand', async () => {
		const gw = await startGateway();
		const client = await connect(gw);
		try {
			const res = await call(client, 'export_files', { files: ['ok/retail.bin'], product: 'wow', wait: 15 });
			assert.equal(res.status, 'done');
			assert.equal(res.product, 'wow');
			const status = await call(client, 'service_status');
			assert.ok(status.engines.some(e => e.id === 'wow-main' && e.state === 'ready'));
		} finally {
			await client.close();
			await gw.stop();
		}
	});

	test('a second gateway on the same root refuses to start', async () => {
		const gw = await startGateway();
		try {
			await assert.rejects(startGateway({ root: gw.root }), /Another gateway/);
		} finally {
			await gw.stop();
		}
	});

	test('the service root may not overlap the normal wow.export folder', () => {
		const os = require('os');
		const configLib = require('../src/config');
		assert.throws(() => configLib.load(path.join(os.homedir(), 'wow.export', 'svc')), /overlaps/);
		assert.throws(() => configLib.load(os.homedir()), /overlaps/);
	});
});
