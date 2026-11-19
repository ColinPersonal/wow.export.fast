/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Newline-delimited JSON framing for the engine protocol (service/PROTOCOL.md).

/**
 * Split a byte stream into JSON messages, one per line.
 * @param {function(object)} onMessage
 * @param {function(Error, string)} [onError] Called with unparseable lines.
 * @param {number} [maxLine] Lines longer than this are rejected (bytes).
 * @returns {function(Buffer|string)} Feed function.
 */
const createParser = (onMessage, onError = () => {}, maxLine = 64 * 1024 * 1024) => {
	let pending = '';

	return (chunk) => {
		pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

		let index;
		while ((index = pending.indexOf('\n')) !== -1) {
			const line = pending.slice(0, index).trim();
			pending = pending.slice(index + 1);

			if (line.length === 0)
				continue;

			let message;
			try {
				message = JSON.parse(line);
			} catch (e) {
				onError(e, line);
				continue;
			}

			if (message === null || typeof message !== 'object' || Array.isArray(message)) {
				onError(new Error('message is not an object'), line);
				continue;
			}

			onMessage(message);
		}

		if (pending.length > maxLine) {
			onError(new Error('line too long'), pending.slice(0, 200));
			pending = '';
		}
	};
};

/**
 * Encode a message as one line. BigInt values become strings.
 * @param {object} message
 * @returns {string}
 */
const encode = (message) => JSON.stringify(message, (key, value) => typeof value === 'bigint' ? value.toString() : value) + '\n';

module.exports = { createParser, encode };
