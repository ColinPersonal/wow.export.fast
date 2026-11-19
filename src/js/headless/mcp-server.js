/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Minimal Model Context Protocol server over stdio, exposing the headless
// export tools. Messages are newline-delimited JSON-RPC 2.0, as defined by
// the MCP stdio transport. Implemented directly to avoid a dependency.
const readline = require('readline');

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = [
	'Exports World of Warcraft game files (textures, models, maps, database tables, sounds) to local disk, from a local installation (WOW_EXPORT_INSTALL) or Blizzard\'s CDN.',
	'Use search to find file names or fileDataIDs, then get_file, export_files, export_textures, export_model(s), export_map or export_table to write files. Errors start with a code such as NOT_FOUND or INVALID_PARAMS.',
	'Tools return the paths of the files they wrote; read those files from disk rather than expecting file contents in the result.',
	'The first call opens the game build, which takes around 20 seconds with a warm cache and a few minutes on a fresh machine.'
].join(' ');

/**
 * Handle one JSON-RPC request.
 * @returns {Promise<object|undefined>} The result, or undefined for notifications.
 */
const handle = async (message, context) => {
	const { tools, call } = require('./tools');

	switch (message.method) {
		case 'initialize': {
			const requested = message.params?.protocolVersion;
			return {
				protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: 'wow-export', version: context.version },
				instructions: INSTRUCTIONS
			};
		}

		case 'ping':
			return {};

		case 'tools/list':
			return { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };

		case 'tools/call': {
			const name = message.params?.name;
			if (!tools.some(tool => tool.name === name))
				throw Object.assign(new Error('Unknown tool: ' + name), { code: -32602 });

			// Tool failures are reported in the result so the model can read and react to them.
			try {
				const result = await call(name, message.params?.arguments ?? {});
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], structuredContent: result, isError: false };
			} catch (e) {
				return { content: [{ type: 'text', text: 'Error' + (typeof e.code === 'string' ? ' ' + e.code : '') + ': ' + e.message }], isError: true };
			}
		}

		default:
			throw Object.assign(new Error('Method not found: ' + message.method), { code: -32601 });
	}
};

/**
 * Serve MCP requests on stdin/stdout until stdin closes.
 * @param {object} [options]
 * @param {stream.Readable} [options.input]
 * @param {stream.Writable} [options.output]
 */
const serve = ({ input = process.stdin, output = process.stdout } = {}) => {
	// stdout carries protocol messages only.
	console.log = (...args) => console.error(...args);

	const context = { version: require('./runtime').constants.VERSION };
	const send = (message) => output.write(JSON.stringify(message) + '\n');

	let pending = 0;
	let closed = false;
	let finish;
	const done = new Promise(resolve => finish = resolve);

	const lines = readline.createInterface({ input, crlfDelay: Infinity });

	lines.on('line', async (line) => {
		if (line.trim().length === 0)
			return;

		let message;
		try {
			message = JSON.parse(line);
		} catch (e) {
			return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
		}

		// Notifications (no id) and responses to our own requests need no reply.
		if (message.id === undefined || message.id === null || message.method === undefined)
			return;

		pending++;
		try {
			send({ jsonrpc: '2.0', id: message.id, result: await handle(message, context) });
		} catch (e) {
			send({ jsonrpc: '2.0', id: message.id, error: { code: e.code ?? -32603, message: e.message } });
		} finally {
			if (--pending === 0 && closed)
				finish();
		}
	});

	lines.on('close', () => {
		closed = true;
		if (pending === 0)
			finish();
	});

	return done;
};

module.exports = { serve, handle };
