/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Tile selection for the headless export test runner. Kept free of app
// dependencies so it can be unit tested under plain Node.

const MAP_SIZE = 64;

/**
 * Turn a job's tile spec into tile indices (tileY * 64 + tileX, as used by
 * ADTExporter and WDT tile tables). Tiles are named like their ADT files:
 * "32_48" is <map>_32_48.adt.
 * @param {string|Array|object} spec "all", ["32_48", ...], or { from: "30_46", to: "34_50" }.
 * @param {WDTLoader} wdt
 * @returns {number[]}
 */
const resolveTiles = (spec, wdt) => {
	const parse = (name) => {
		const m = String(name).match(/^(\d+)_(\d+)$/);
		if (!m)
			throw new Error('invalid tile name: ' + name);
		return [parseInt(m[1], 10), parseInt(m[2], 10)];
	};

	if (spec === 'all')
		return wdt.tiles.map((flag, index) => flag ? index : -1).filter(i => i >= 0);

	if (Array.isArray(spec))
		return spec.map(name => { const [a, b] = parse(name); return a * MAP_SIZE + b; });

	if (spec && spec.from && spec.to) {
		const [a0, b0] = parse(spec.from);
		const [a1, b1] = parse(spec.to);
		const out = [];
		for (let a = Math.min(a0, a1); a <= Math.max(a0, a1); a++)
			for (let b = Math.min(b0, b1); b <= Math.max(b0, b1); b++)
				out.push(a * MAP_SIZE + b);
		return out;
	}

	throw new Error('invalid tiles spec: ' + JSON.stringify(spec));
};

/**
 * Name of a tile index, as in its ADT file name ("32_48").
 * @param {number} index
 * @returns {string}
 */
const tileName = (index) => Math.floor(index / MAP_SIZE) + '_' + (index % MAP_SIZE);

module.exports = { resolveTiles, tileName, MAP_SIZE };
