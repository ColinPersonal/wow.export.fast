#!/usr/bin/env bun
/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Command line interface to the headless export service.
//
//   bun src/js/headless/cli.js <command> [--name value ...]
//   bun src/js/headless/cli.js <command> --json '{"name": "value"}'
//   bun src/js/headless/cli.js mcp        (run as an MCP server over stdio)
//
// Results are printed to stdout as JSON; progress and errors go to stderr.

const argv = process.argv.slice(2);
const command = argv[0];

// Application modules may print diagnostics; keep stdout for results only.
console.log = (...args) => console.error(...args);

const usage = () => {
	const { tools } = require('./tools');

	const lines = ['Usage: wow-export <command> [--argument value ...] [--json \'{...}\']', '', 'Commands:'];
	for (const tool of tools) {
		lines.push('  ' + tool.name.padEnd(16) + tool.description.split('. ')[0].replace(/\.$/, '') + '.');

		for (const [name, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
			const required = (tool.inputSchema.required ?? []).includes(name) ? ' (required)' : '';
			lines.push('      --' + name.padEnd(18) + (schema.enum ? schema.enum.join(' | ') : (schema.type ?? 'value')) + required);
		}
	}

	lines.push('  ' + 'mcp'.padEnd(16) + 'Run as a Model Context Protocol server over stdio.');
	lines.push('', 'Environment:', '  WOW_EXPORT_OUT        Default output directory (default: ./wow-export)', '  WOW_EXPORT_DATA_DIR   Cache and configuration directory (default: ~/.wow.export-headless)', '  WOW_EXPORT_PRODUCT    Game product to open (default: wow)', '  WOW_EXPORT_REGION     CDN region (default: us)');

	return lines.join('\n');
};

/**
 * Parse "--name value" pairs, coercing values according to the tool's schema.
 */
const parseArguments = (tool, args) => {
	const properties = tool.inputSchema.properties ?? {};
	const out = {};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg.startsWith('--'))
			throw new Error('Unexpected argument: ' + arg);

		let name = arg.slice(2);
		let value;

		const eq = name.indexOf('=');
		if (eq !== -1) {
			value = name.slice(eq + 1);
			name = name.slice(0, eq);
		}

		if (name === 'json') {
			Object.assign(out, JSON.parse(value ?? args[++i]));
			continue;
		}

		const schema = properties[name];
		if (schema === undefined)
			throw new Error('Unknown argument --' + name + ' for ' + tool.name);

		const types = schema.type ? [schema.type] : (schema.anyOf ?? []).map(e => e.type);

		if (types.includes('boolean') && value === undefined && (args[i + 1] === undefined || args[i + 1].startsWith('--'))) {
			out[name] = true;
			continue;
		}

		value ??= args[++i];
		if (value === undefined)
			throw new Error('Missing value for --' + name);

		if (types.includes('boolean'))
			out[name] = !['false', '0', 'no', 'off'].includes(value.toLowerCase());
		else if (types.includes('integer') && /^-?\d+$/.test(value))
			out[name] = Number(value);
		else if (types.includes('array') && value !== 'all')
			out[name] = value.split(',').map(e => /^\d+$/.test(e.trim()) ? Number(e) : e.trim()).filter(e => e !== '');
		else if (types.includes('object'))
			out[name] = JSON.parse(value);
		else
			out[name] = value;
	}

	return out;
};

(async () => {
	if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
		process.stdout.write(usage() + '\n');
		return 0;
	}

	if (command === 'mcp') {
		await require('./mcp-server').serve();
		return 0;
	}

	const { tools, call } = require('./tools');
	const tool = tools.find(e => e.name === command || e.name === command.replace(/-/g, '_'));
	if (tool === undefined) {
		process.stderr.write('Unknown command: ' + command + '\n\n' + usage() + '\n');
		return 2;
	}

	const result = await call(tool.name, parseArguments(tool, argv.slice(1)));
	process.stdout.write(JSON.stringify(result, null, '\t') + '\n');
	return 0;
})().then(code => {
	// Give buffered log writes a moment to flush before exiting.
	setTimeout(() => process.exit(code), 50);
}).catch(e => {
	process.stderr.write('Error: ' + e.message + '\n');
	setTimeout(() => process.exit(1), 50);
});
