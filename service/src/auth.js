// Bearer tokens. Stored hashed in <root>/state/tokens.json; the plain token is
// shown once when created.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sha256 } = require('./util');

const TOKEN_PREFIX = 'wxs_';

class TokenStore {
	constructor(stateDir) {
		this.file = path.join(stateDir, 'tokens.json');
		this.tokens = [];
		this.mtime = 0;
		this.reload();
	}

	reload() {
		try {
			const stat = fs.statSync(this.file);
			if (stat.mtimeMs === this.mtime)
				return;
			this.tokens = JSON.parse(fs.readFileSync(this.file, 'utf8'));
			this.mtime = stat.mtimeMs;
		} catch (e) {
			if (e.code !== 'ENOENT')
				throw e;
			this.tokens = [];
		}
	}

	save() {
		const tmp = this.file + '.tmp';
		fs.writeFileSync(tmp, JSON.stringify(this.tokens, null, '\t'));
		fs.renameSync(tmp, this.file);
		this.mtime = fs.statSync(this.file).mtimeMs;
	}

	/**
	 * Create a token. Returns the plain token, which is not stored.
	 * @param {string} name
	 */
	add(name) {
		if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name))
			throw new Error('Token names use letters, digits, ".", "_" and "-" (max 64)');

		this.reload();
		if (this.tokens.some(t => t.name === name && !t.revoked))
			throw new Error('A token named ' + name + ' already exists');

		const token = TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url');
		this.tokens.push({ name, hash: sha256(token), created: new Date().toISOString(), revoked: false });
		this.save();
		return token;
	}

	revoke(name) {
		this.reload();
		let found = false;
		for (const t of this.tokens) {
			if (t.name === name && !t.revoked) {
				t.revoked = true;
				t.revokedAt = new Date().toISOString();
				found = true;
			}
		}
		if (found)
			this.save();
		return found;
	}

	list() {
		this.reload();
		return this.tokens.map(({ name, created, revoked, revokedAt }) => ({ name, created, revoked, revokedAt }));
	}

	/**
	 * Check an Authorization header. Returns the token's name, or null.
	 * @param {string|undefined} header
	 */
	verify(header) {
		if (typeof header !== 'string')
			return null;

		const match = header.match(/^Bearer\s+(\S+)\s*$/i);
		if (!match || match[1].length > 200)
			return null;

		this.reload();
		const hash = Buffer.from(sha256(match[1]), 'hex');

		let name = null;
		// Compare against every token so timing does not reveal which one matched.
		for (const t of this.tokens) {
			const candidate = Buffer.from(t.hash, 'hex');
			if (candidate.length === hash.length && crypto.timingSafeEqual(candidate, hash) && !t.revoked)
				name = t.name;
		}

		return name;
	}
}

/** Token bucket rate limiter, keyed by token name. */
class RateLimiter {
	constructor(perSecond, burst = perSecond * 3) {
		this.perSecond = perSecond;
		this.burst = burst;
		this.buckets = new Map();
	}

	take(key) {
		const now = Date.now();
		let bucket = this.buckets.get(key);
		if (bucket === undefined) {
			bucket = { tokens: this.burst, at: now };
			this.buckets.set(key, bucket);
		}

		bucket.tokens = Math.min(this.burst, bucket.tokens + (now - bucket.at) / 1000 * this.perSecond);
		bucket.at = now;

		if (bucket.tokens < 1)
			return false;

		bucket.tokens -= 1;
		return true;
	}
}

module.exports = { TokenStore, RateLimiter, TOKEN_PREFIX };
