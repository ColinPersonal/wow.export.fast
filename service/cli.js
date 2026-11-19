#!/usr/bin/env node
// wow-export service command line.
//
//   node service/cli.js start [--root <dir>]       run the gateway (foreground)
//   node service/cli.js token add <name>           create a token (printed once)
//   node service/cli.js token list
//   node service/cli.js token revoke <name>
//   node service/cli.js status                     ask the running gateway for its state
const path = require('path');
const configLib = require('./src/config');
const { TokenStore } = require('./src/auth');

const argv = process.argv.slice(2);
const flag = (name) => {
	const i = argv.indexOf('--' + name);
	if (i < 0)
		return undefined;
	const value = argv[i + 1];
	argv.splice(i, 2);
	return value;
};

const root = flag('root');

const main = async () => {
	const [command, sub, arg] = argv;

	if (command === 'start') {
		const server = require('./src/server');
		const svc = await server.start({ root, echo: true });
		const shutdown = async () => {
			await svc.stop();
			process.exit(0);
		};
		process.on('SIGINT', shutdown);
		process.on('SIGTERM', shutdown);
		process.on('SIGBREAK', shutdown);
		return;
	}

	if (command === 'token') {
		const config = configLib.load(root);
		const tokens = new TokenStore(config.dirs.state);
		if (sub === 'add' && arg) {
			const token = tokens.add(arg);
			console.log(token);
			console.error('Token "' + arg + '" created. It is shown only once; store it as WOW_EXPORT_TOKEN.');
		} else if (sub === 'list') {
			console.table(tokens.list());
		} else if (sub === 'revoke' && arg) {
			console.log(tokens.revoke(arg) ? 'revoked ' + arg : 'no active token named ' + arg);
		} else {
			throw new Error('usage: token add <name> | token list | token revoke <name>');
		}
		return;
	}

	if (command === 'status') {
		const config = configLib.load(root);
		const res = await fetch('http://127.0.0.1:' + config.port + '/health').catch(() => null);
		console.log(res?.ok ? 'gateway is running on port ' + config.port : 'gateway is not running');
		return;
	}

	console.log('usage: node ' + path.relative(process.cwd(), __filename) + ' start | token add|list|revoke | status  [--root <dir>]');
	process.exitCode = command ? 1 : 0;
};

main().catch((e) => {
	console.error(e.message);
	process.exit(1);
});
