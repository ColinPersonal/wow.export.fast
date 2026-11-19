const fs = require('fs');
const os = require('os');
const path = require('path');

// Keep the headless runtime's cache and configuration out of the home directory.
process.env.WOW_EXPORT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wowexport-headless-test-'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');

const mcp = require('../src/js/headless/mcp-server');
const { tools, call } = require('../src/js/headless/tools');

const context = { version: 'test' };

test('headless runtime marks itself and provides the globals the app expects', () => {
	assert.equal(globalThis.WOW_EXPORT_HEADLESS, true);
	assert.equal(typeof globalThis.nw.App.dataPath, 'string');
	assert.equal(typeof globalThis.requestAnimationFrame, 'function');
});

test('memory mapping falls back to buffered reads when the native add-on is missing', () => {
	const mmap = require('../src/js/mmap');
	const file = path.join(process.env.WOW_EXPORT_DATA_DIR, 'mapped.bin');
	fs.writeFileSync(file, Buffer.from([1, 2, 3, 4]));

	const mapped = mmap.create_virtual_file();
	assert.equal(mapped.mapFile(file, { protection: 'readonly' }), true);
	assert.equal(mapped.isMapped, true);
	assert.deepEqual([...mapped.data], [1, 2, 3, 4]);

	const missing = mmap.create_virtual_file();
	assert.equal(missing.mapFile(file + '.missing'), false);
	assert.ok(missing.lastError.length > 0);

	mmap.release_virtual_files();
	assert.equal(mapped.isMapped, false);
});

test('every tool has a name, description, object schema and handler', () => {
	const names = new Set();
	for (const tool of tools) {
		assert.match(tool.name, /^[a-z_]+$/);
		assert.ok(!names.has(tool.name), 'duplicate tool ' + tool.name);
		names.add(tool.name);

		assert.ok(tool.description.length > 20);
		assert.equal(tool.inputSchema.type, 'object');
		assert.equal(typeof tool.handler, 'function');

		for (const required of tool.inputSchema.required ?? [])
			assert.ok(required in tool.inputSchema.properties, tool.name + ' requires undeclared ' + required);
	}

	for (const expected of ['info', 'search', 'get_file', 'export_textures', 'export_model', 'list_maps', 'list_map_tiles', 'export_map', 'query_table'])
		assert.ok(names.has(expected), 'missing tool ' + expected);
});

test('calling a tool validates its name and required arguments before doing any work', async () => {
	await assert.rejects(call('nope'), /Unknown tool/);
	await assert.rejects(call('get_file', {}), /Missing required argument "file"/);
	await assert.rejects(call('export_map', { tiles: ['1_1'] }), /Missing required argument "map"/);
});

test('MCP initialize negotiates a protocol version and advertises tools', async () => {
	const result = await mcp.handle({ method: 'initialize', params: { protocolVersion: '2024-11-05' } }, context);
	assert.equal(result.protocolVersion, '2024-11-05');
	assert.deepEqual(result.capabilities, { tools: {} });
	assert.equal(result.serverInfo.name, 'wow-export');

	const fallback = await mcp.handle({ method: 'initialize', params: { protocolVersion: '1999-01-01' } }, context);
	assert.equal(fallback.protocolVersion, '2025-06-18');
});

test('MCP tools/list returns schemas without handlers', async () => {
	const result = await mcp.handle({ method: 'tools/list' }, context);
	assert.equal(result.tools.length, tools.length);

	for (const tool of result.tools)
		assert.deepEqual(Object.keys(tool).sort(), ['description', 'inputSchema', 'name']);
});

test('MCP reports unknown methods and tools as protocol errors, tool failures as results', async () => {
	await assert.rejects(mcp.handle({ method: 'nope/nope' }, context), e => e.code === -32601);
	await assert.rejects(mcp.handle({ method: 'tools/call', params: { name: 'nope' } }, context), e => e.code === -32602);

	const failed = await mcp.handle({ method: 'tools/call', params: { name: 'get_file', arguments: {} } }, context);
	assert.equal(failed.isError, true);
	assert.match(failed.content[0].text, /Missing required argument/);
});

test('MCP stdio transport answers requests, ignores notifications and exits when input closes', async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const lines = [];

	output.on('data', chunk => lines.push(...String(chunk).split('\n').filter(Boolean)));

	const done = mcp.serve({ input, output });

	input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
	input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
	input.write('this is not json\n');
	input.write(JSON.stringify({ jsonrpc: '2.0', id: 'b', method: 'missing' }) + '\n');
	input.end();

	await done;

	const messages = lines.map(line => JSON.parse(line));
	assert.equal(messages.length, 3);
	assert.deepEqual(messages.find(m => m.id === 1), { jsonrpc: '2.0', id: 1, result: {} });
	assert.equal(messages.find(m => m.id === null).error.code, -32700);
	assert.equal(messages.find(m => m.id === 'b').error.code, -32601);
});
