// Test helpers: a gateway on a temporary root with fake engines, and an MCP client.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const server = require('../src/server');
const { TokenStore } = require('../src/auth');

const FAKE = path.join(__dirname, 'fake-engine.js');

/**
 * Start a gateway for a test.
 * @param {object} [options]
 * @param {object} [options.overrides] Config overrides.
 * @param {object} [options.env] Environment for fake engines.
 * @param {string} [options.root] Reuse a root (restart tests).
 */
const startGateway = async (options = {}) => {
	const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'wxs-test-'));
	const env = options.env ?? {};
	const overrides = Object.assign({
		port: 0,
		warmProducts: ['wowf'],
		sources: { wowf: { type: 'local', install: 'C:\\fake', region: 'us' } },
		heartbeatTimeoutSeconds: 2,
		waitSeconds: 5,
		diskBudgetGB: 75,
		minFreeGB: 0
	}, options.overrides ?? {});

	const svc = await server.start({
		root,
		overrides,
		engineCommand: (spec, specFile) => ({ command: process.execPath, args: [FAKE, '--config', specFile], env: typeof env === 'function' ? env(spec) : env })
	});

	const tokens = new TokenStore(svc.config.dirs.state);
	const token = tokens.add('test-' + Math.random().toString(36).slice(2, 8));
	const base = 'http://127.0.0.1:' + svc.port;

	return Object.assign(svc, { root, token, base, tokens });
};

/** Connected MCP client for a gateway. */
const connect = async (gw, token = gw.token, host) => {
	const client = new Client({ name: 'test', version: '1.0.0' });
	const headers = { Authorization: 'Bearer ' + token };
	if (host)
		headers.Host = host;
	const transport = new StreamableHTTPClientTransport(new URL(gw.base + '/mcp'), { requestInit: { headers } });
	await client.connect(transport);
	return client;
};

/** Call a tool and parse its JSON text result. */
const call = async (client, name, args = {}) => {
	const res = await client.callTool({ name, arguments: args });
	const text = res.content?.[0]?.text ?? '{}';
	const body = JSON.parse(text);
	return Object.assign(body, { isError: !!res.isError });
};

const waitFor = async (fn, ms = 10000, step = 50) => {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		const v = await fn();
		if (v)
			return v;
		await new Promise(r => setTimeout(r, step));
	}
	throw new Error('timed out waiting');
};

const authed = (gw, url, init = {}) => fetch(gw.base + url, Object.assign({}, init, { headers: Object.assign({ Authorization: 'Bearer ' + gw.token }, init.headers ?? {}) }));

module.exports = { startGateway, connect, call, waitFor, authed };
