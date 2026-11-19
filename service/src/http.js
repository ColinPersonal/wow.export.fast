// HTTP front door: MCP endpoint and authenticated downloads.
//
//   GET  /health                 liveness (no token)
//   POST /mcp                    MCP (Streamable HTTP, stateless, JSON responses)
//   GET  /files/<key>/<path>     one file of a result (Range supported)
//   GET  /zip/<key>              whole result as a zip stream
//   GET  /manifest/<key>         result manifest (JSON)
//   GET  /list/<key>?format=     file list for download scripts (curl | sha256sum | tsv)
//
// Every route except /health needs "Authorization: Bearer <token>", also for
// requests from this machine: tunnelled requests arrive from 127.0.0.1 too.
const fs = require('fs');
const http = require('http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const archiver = require('archiver');
const { RateLimiter } = require('./auth');
const { buildTools, INSTRUCTIONS, json, errorResult } = require('./tools');
const scripts = require('./scripts');
const { ServiceError } = require('./util');
const { KEY_RE } = require('./cache');

const MAX_BODY = 1024 * 1024;
const MAX_DOWNLOADS_PER_TOKEN = 16;
const VERSION = require('../package.json').version ?? '0.0.0';

const send = (res, status, body, headers = {}) => {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	const text = typeof body === 'string' ? body : JSON.stringify(body);
	res.writeHead(status, Object.assign({ 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' }, headers));
	res.end(text);
};

const sendError = (res, e) => {
	const status = e.status ?? (e.code === 'NOT_FOUND' ? 404 : e.code === 'INVALID_PARAMS' ? 400 : e.code === 'RATE_LIMITED' ? 429 : 500);
	send(res, status, { error: e instanceof ServiceError ? e.toJSON() : { code: 'INTERNAL', message: 'Internal error' } });
};

const readBody = (req) => new Promise((resolve, reject) => {
	let size = 0;
	let tooLarge = Number(req.headers['content-length'] ?? 0) > MAX_BODY;
	const chunks = [];
	if (tooLarge)
		reject(new ServiceError('INVALID_PARAMS', 'Request body too large', { status: 413 }));

	req.on('data', (chunk) => {
		size += chunk.length;
		if (tooLarge) {
			// Keep reading (and discarding) so the client sees the 413; give up on abuse.
			if (size > 64 * MAX_BODY)
				req.destroy();
			return;
		}
		if (size > MAX_BODY) {
			tooLarge = true;
			chunks.length = 0;
			reject(new ServiceError('INVALID_PARAMS', 'Request body too large', { status: 413 }));
			return;
		}
		chunks.push(chunk);
	});
	req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
	req.on('error', reject);
});

class HttpFront {
	/**
	 * @param {object} svc { config, log, tokens, jobs, cache, pool }
	 */
	constructor(svc) {
		this.svc = svc;
		this.config = svc.config;
		this.log = svc.log;
		this.limiter = new RateLimiter(this.config.requestsPerSecondPerToken);
		this.downloads = new Map();

		const port = this.config.port;
		this.localHosts = new Set(['localhost:' + port, '127.0.0.1:' + port, '[::1]:' + port]);
		this.publicHost = null;
		if (this.config.publicUrl)
			this.publicHost = new URL(this.config.publicUrl).host.toLowerCase();
	}

	/**
	 * Where links in responses should point, from the Host the client used.
	 * Unknown hosts are refused (DNS rebinding protection).
	 */
	origin(req) {
		const host = String(req.headers.host ?? '').toLowerCase();
		if (this.localHosts.has(host))
			return { baseUrl: 'http://' + host, local: true };
		if (this.publicHost !== null && host === this.publicHost)
			return { baseUrl: this.config.publicUrl.replace(/\/+$/, ''), local: false };
		return null;
	}

	async listen() {
		this.server = http.createServer((req, res) => {
			this.handle(req, res).catch((e) => {
				this.log.error('request %s %s failed: %s', req.method, req.url, e.stack ?? e.message);
				sendError(res, e);
			});
		});
		this.server.headersTimeout = 30000;
		this.server.requestTimeout = 0;
		this.server.keepAliveTimeout = 5000;

		await new Promise((resolve, reject) => {
			this.server.once('error', reject);
			this.server.listen(this.config.port, this.config.host, resolve);
		});
		this.port = this.server.address().port;
		if (this.config.port === 0) {
			this.localHosts = new Set(['localhost:' + this.port, '127.0.0.1:' + this.port, '[::1]:' + this.port]);
		}
	}

	close() {
		return new Promise(resolve => {
			this.server?.close(() => resolve());
			this.server?.closeAllConnections?.();
		});
	}

	async handle(req, res) {
		const url = new URL(req.url, 'http://x');
		const pathname = url.pathname;

		if (pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD'))
			return send(res, 200, { ok: true });

		const origin = this.origin(req);
		if (origin === null)
			return send(res, 421, { error: { code: 'INVALID_HOST', message: 'Unknown host' } });

		const token = this.svc.tokens.verify(req.headers.authorization);
		if (token === null) {
			// Same answer for missing, wrong and revoked tokens.
			return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'A valid bearer token is required' } }, { 'WWW-Authenticate': 'Bearer' });
		}

		if (pathname === '/mcp')
			return this.handleMcp(req, res, token, origin);

		const match = pathname.match(/^\/(files|zip|manifest|list)\/([^/]+)(?:\/(.*))?$/);
		if (match === null || (req.method !== 'GET' && req.method !== 'HEAD'))
			return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });

		const [, route, key, rest] = match;
		if (!KEY_RE.test(key))
			return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown result' } });

		const manifest = await this.svc.cache.get(key);
		if (manifest === null)
			return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown or expired result' } });

		// Results belong to the jobs that made them; any valid token may download
		// a result whose key it knows (keys are unguessable 256-bit hashes).
		this.svc.cache.touch(key);

		if (route === 'manifest')
			return send(res, 200, manifest);

		if (route === 'list') {
			const format = url.searchParams.get('format') ?? 'tsv';
			if (!['curl', 'sha256sum', 'tsv'].includes(format))
				return send(res, 400, { error: { code: 'INVALID_PARAMS', message: 'format must be curl, sha256sum or tsv' } });
			return send(res, 200, scripts.list(manifest, origin.baseUrl, format));
		}

		const active = this.downloads.get(token) ?? 0;
		if (active >= MAX_DOWNLOADS_PER_TOKEN)
			return send(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many downloads at once', retryable: true } }, { 'Retry-After': '1' });

		this.downloads.set(token, active + 1);
		const release = this.svc.cache.hold(key);
		const done = () => {
			release();
			const n = (this.downloads.get(token) ?? 1) - 1;
			if (n <= 0)
				this.downloads.delete(token);
			else
				this.downloads.set(token, n);
		};
		res.on('close', done);

		if (route === 'zip')
			return this.sendZip(req, res, key, manifest);

		let rel;
		try {
			rel = decodeURIComponent(rest ?? '');
		} catch {
			return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown file' } });
		}

		const { full, entry } = await this.svc.cache.resolveFile(key, rel);
		return this.sendFile(req, res, full, entry);
	}

	sendFile(req, res, full, entry) {
		const headers = {
			'Content-Type': 'application/octet-stream',
			'Accept-Ranges': 'bytes',
			'ETag': '"' + entry.sha256 + '"',
			'X-Content-SHA256': entry.sha256,
			'Cache-Control': 'private, max-age=86400'
		};

		const range = req.headers.range;
		let start = 0;
		let end = entry.size - 1;
		let status = 200;

		if (typeof range === 'string' && entry.size > 0) {
			const m = range.match(/^bytes=(\d*)-(\d*)$/);
			if (m === null || (m[1] === '' && m[2] === ''))
				return send(res, 416, { error: { code: 'INVALID_PARAMS', message: 'Unsupported range' } }, { 'Content-Range': 'bytes */' + entry.size });

			if (m[1] === '') {
				start = Math.max(0, entry.size - Number(m[2]));
			} else {
				start = Number(m[1]);
				if (m[2] !== '')
					end = Math.min(end, Number(m[2]));
			}

			if (start > end || start >= entry.size)
				return send(res, 416, { error: { code: 'INVALID_PARAMS', message: 'Range not satisfiable' } }, { 'Content-Range': 'bytes */' + entry.size });

			status = 206;
			headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + entry.size;
		}

		headers['Content-Length'] = entry.size === 0 ? 0 : end - start + 1;
		res.writeHead(status, headers);

		if (req.method === 'HEAD' || entry.size === 0)
			return res.end();

		const stream = fs.createReadStream(full, { start, end });
		stream.on('error', () => res.destroy());
		stream.pipe(res);
	}

	sendZip(req, res, key, manifest) {
		res.writeHead(200, {
			'Content-Type': 'application/zip',
			'Content-Disposition': 'attachment; filename="wow-export-' + key.slice(0, 12) + '.zip"',
			'Cache-Control': 'no-store'
		});

		if (req.method === 'HEAD')
			return res.end();

		const zip = new archiver.ZipArchive({ zlib: { level: 1 }, forceZip64: manifest.totalBytes > 3.5 * 1024 ** 3 });
		zip.on('error', (e) => {
			this.log.warn('zip of %s failed: %s', key, e.message);
			res.destroy();
		});
		res.on('close', () => zip.abort());
		zip.pipe(res);

		const base = this.svc.cache.filesDir(key);
		for (const f of manifest.files)
			zip.file(require('path').join(base, ...f.path.split('/')), { name: f.path });

		zip.finalize();
	}

	async handleMcp(req, res, token, origin) {
		if (!this.limiter.take(token))
			return send(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many requests', retryable: true } }, { 'Retry-After': '1' });

		if (req.method !== 'POST')
			return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }, { Allow: 'POST' });

		let body;
		try {
			body = JSON.parse(await readBody(req));
		} catch (e) {
			if (e instanceof ServiceError)
				return sendError(res, e);
			return send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
		}

		const server = new McpServer({ name: 'wow-export', version: VERSION }, { instructions: INSTRUCTIONS });
		const ctx = { token, baseUrl: origin.baseUrl, local: origin.local };

		for (const t of buildTools(this.svc, ctx)) {
			server.registerTool(t.name, { description: t.description, inputSchema: t.inputSchema }, async (args) => {
				try {
					return json(await t.handler(args ?? {}));
				} catch (e) {
					if (!(e instanceof ServiceError))
						this.log.error('tool %s failed: %s', t.name, e.stack ?? e.message);
					return errorResult(e);
				}
			});
		}

		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
		res.on('close', () => {
			transport.close().catch(() => {});
			server.close().catch(() => {});
		});

		await server.connect(transport);
		await transport.handleRequest(req, res, body);
	}
}

module.exports = { HttpFront };
