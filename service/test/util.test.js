const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { moveDir } = require('../src/util');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wxs-util-'));

test('moveDir waits out a briefly held file', async () => {
	const root = tempDir();
	const from = path.join(root, 'staging');
	fs.mkdirSync(from);
	fs.writeFileSync(path.join(from, 'a.bin'), 'hello');
	const fd = fs.openSync(path.join(from, 'a.bin'), 'r');
	setTimeout(() => fs.closeSync(fd), 300);
	await moveDir(from, path.join(root, 'files'));
	assert.equal(fs.readFileSync(path.join(root, 'files', 'a.bin'), 'utf8'), 'hello');
	assert.ok(!fs.existsSync(from));
	fs.rmSync(root, { recursive: true, force: true });
});

test('moveDir copies when the folder stays locked', async () => {
	const root = tempDir();
	const from = path.join(root, 'staging');
	fs.mkdirSync(path.join(from, 'sub'), { recursive: true });
	fs.writeFileSync(path.join(from, 'sub', 'b.bin'), 'world');
	const fd = fs.openSync(path.join(from, 'sub', 'b.bin'), 'r');
	try {
		await moveDir(from, path.join(root, 'files'), { attempts: 3, firstDelayMs: 10 });
		assert.equal(fs.readFileSync(path.join(root, 'files', 'sub', 'b.bin'), 'utf8'), 'world');
	} finally {
		fs.closeSync(fd);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('moveDir passes other errors through', async () => {
	const root = tempDir();
	await assert.rejects(moveDir(path.join(root, 'missing'), path.join(root, 'x')), { code: 'ENOENT' });
	fs.rmSync(root, { recursive: true, force: true });
});
