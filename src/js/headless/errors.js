/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Error codes reported by the headless export service. Callers (the export
// service gateway, MCP clients) branch on the code; the message is for people.

const CODES = Object.freeze({
	INVALID_PARAMS: 'INVALID_PARAMS',
	NOT_FOUND: 'NOT_FOUND',
	NOT_ON_MAP: 'NOT_ON_MAP',
	UNSUPPORTED: 'UNSUPPORTED',
	EXPORT_FAILED: 'EXPORT_FAILED',
	CANCELLED: 'CANCELLED',
	BUSY: 'BUSY',
	SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
	INTERNAL: 'INTERNAL'
});

class ServiceError extends Error {
	/**
	 * @param {string} code One of CODES.
	 * @param {string} message
	 */
	constructor(code, message) {
		super(message);
		this.name = 'ServiceError';
		this.code = code;
	}
}

/**
 * Create a ServiceError.
 * @param {string} code
 * @param {string} message
 */
const fail = (code, message) => new ServiceError(code, message);

/**
 * Describe any thrown value as { code, message }. Errors without a known
 * code are reported as INTERNAL.
 * @param {*} e
 * @returns {{code: string, message: string}}
 */
const describe = (e) => {
	const code = typeof e?.code === 'string' && CODES[e.code] !== undefined ? e.code : CODES.INTERNAL;
	const message = e?.message ? String(e.message) : String(e);
	return { code, message };
};

module.exports = { CODES, ServiceError, fail, describe };
