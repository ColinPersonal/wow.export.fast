/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Tool definitions shared by the command line interface and the MCP server.
// Each tool has a JSON schema describing its arguments and a handler which
// calls into the headless export service.
const service = require('./service');

const OUT_DIR = {
	type: 'string',
	description: 'Directory to write files into. Defaults to the WOW_EXPORT_OUT environment variable, or ./wow-export.'
};

const FILE = {
	description: 'A fileDataID (number) or a file name from the listfile, e.g. "creature/murloc/murloc.m2". Use search to find names.',
	anyOf: [{ type: 'integer' }, { type: 'string' }]
};

const tools = [
	{
		name: 'info',
		description: 'Describe the World of Warcraft build the exporter has open (version, product, region) and where files are written by default.',
		inputSchema: { type: 'object', properties: {} },
		handler: () => service.info()
	},
	{
		name: 'search',
		description: 'Search game file names. Returns fileDataIDs and file names for use with the other tools. Covers textures, models, sounds, text files and fonts.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Space separated terms that must all appear in the file name (e.g. "murloc skin"), or a regular expression written as /pattern/.' },
				type: { type: 'string', enum: ['any', 'texture', 'model', 'sound', 'text', 'font'], description: 'Limit results to one kind of file. Defaults to any.' },
				limit: { type: 'integer', description: 'Maximum results to return (default 50, maximum 1000).' },
				offset: { type: 'integer', description: 'Number of matches to skip, for paging.' }
			},
			required: ['query']
		},
		handler: (args) => service.search(args)
	},
	{
		name: 'get_file',
		description: 'Fetch one game file to disk, either unmodified or (for BLP textures) converted to PNG. Returns the path of the written file.',
		inputSchema: {
			type: 'object',
			properties: {
				file: FILE,
				format: { type: 'string', enum: ['raw', 'png'], description: 'raw writes the file as stored by the game; png converts a BLP texture. Defaults to raw.' },
				outDir: OUT_DIR
			},
			required: ['file']
		},
		handler: (args) => service.getFile(args)
	},
	{
		name: 'export_textures',
		description: 'Export several textures in one call. Faster than calling get_file repeatedly.',
		inputSchema: {
			type: 'object',
			properties: {
				files: { type: 'array', items: FILE, description: 'Textures to export, as fileDataIDs or file names.' },
				format: { type: 'string', enum: ['png', 'webp', 'blp'], description: 'Output format. Defaults to png.' },
				outDir: OUT_DIR
			},
			required: ['files']
		},
		handler: (args) => service.exportTextures(args)
	},
	{
		name: 'export_model',
		description: 'Export a model (M2, M3 or WMO) together with its textures and related files (skins, skeleton, bones, animations, WMO groups and doodads).',
		inputSchema: {
			type: 'object',
			properties: {
				file: FILE,
				format: { type: 'string', enum: ['raw', 'obj', 'gltf', 'glb'], description: 'raw copies the game files unmodified; obj, gltf and glb convert the model. Defaults to raw.' },
				animations: { type: 'boolean', description: 'Include animations: .anim files for raw, baked animations for gltf/glb. Defaults to true.' },
				animationFilter: { type: 'string', description: 'For gltf/glb: comma separated animation IDs to include (e.g. "0,4,5"). Empty includes every animation.' },
				outDir: OUT_DIR
			},
			required: ['file']
		},
		handler: (args) => service.exportModel(args)
	},
	{
		name: 'list_maps',
		description: 'List the game\'s maps (continents, dungeons, raids, battlegrounds) with their IDs and directory names.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Only maps whose name or directory contains this text.' }
			}
		},
		handler: (args) => service.listMaps(args)
	},
	{
		name: 'list_map_tiles',
		description: 'List the terrain tiles a map contains. Tiles are named "<row>_<column>", matching the game\'s ADT file names.',
		inputSchema: {
			type: 'object',
			properties: {
				map: { description: 'Map ID or directory name, e.g. 0 or "azeroth".', anyOf: [{ type: 'integer' }, { type: 'string' }] }
			},
			required: ['map']
		},
		handler: (args) => service.listMapTiles(args)
	},
	{
		name: 'export_map',
		description: 'Export terrain tiles of a map with everything placed on them (models, WMOs, foliage, liquids). Exporting a whole continent writes many gigabytes and can take a long time; pass specific tiles unless the whole map is wanted.',
		inputSchema: {
			type: 'object',
			properties: {
				map: { description: 'Map ID or directory name, e.g. 0 or "azeroth".', anyOf: [{ type: 'integer' }, { type: 'string' }] },
				tiles: { description: 'Tile names such as ["32_48", "32_49"], or "all" for every tile. Defaults to all.', anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
				format: { type: 'string', enum: ['raw', 'obj'], description: 'raw copies the game files unmodified. obj converts terrain and models to OBJ (terrain textures are not baked). Defaults to raw.' },
				models: { type: 'boolean', description: 'Include placed M2 doodads. Defaults to true.' },
				wmos: { type: 'boolean', description: 'Include placed WMOs (buildings). Defaults to true.' },
				foliage: { type: 'boolean', description: 'Include ground foliage models. Defaults to true.' },
				liquids: { type: 'boolean', description: 'Include liquid data. Defaults to true.' },
				animations: { type: 'boolean', description: 'Include .anim files for placed models (raw only). Defaults to false.' },
				resume: { type: 'boolean', description: 'Skip tiles and files already written by an earlier export into the same directory. Defaults to false.' },
				outDir: OUT_DIR
			},
			required: ['map']
		},
		handler: (args) => service.exportMap(args)
	},
	{
		name: 'query_table',
		description: 'Read rows from a client database (DB2) table, e.g. Map, AreaTable, CreatureDisplayInfo or ItemSparse.',
		inputSchema: {
			type: 'object',
			properties: {
				table: { type: 'string', description: 'Table name, e.g. "Map".' },
				id: { type: 'integer', description: 'Return only the row with this ID.' },
				where: { type: 'object', description: 'Column/value pairs a row must match exactly, e.g. {"ExpansionID": 2}.' },
				limit: { type: 'integer', description: 'Maximum rows to return (default 50, maximum 1000).' },
				offset: { type: 'integer', description: 'Number of matching rows to skip, for paging.' }
			},
			required: ['table']
		},
		handler: (args) => service.queryTable(args)
	}
];

const byName = new Map(tools.map(tool => [tool.name, tool]));

/**
 * Invoke a tool by name.
 * @param {string} name
 * @param {object} [args]
 */
const call = async (name, args = {}) => {
	const tool = byName.get(name);
	if (tool === undefined)
		throw new Error('Unknown tool: ' + name);

	for (const required of tool.inputSchema.required ?? []) {
		if (args[required] === undefined || args[required] === null)
			throw new Error('Missing required argument "' + required + '" for ' + name);
	}

	return await tool.handler(args);
};

module.exports = { tools, call };
