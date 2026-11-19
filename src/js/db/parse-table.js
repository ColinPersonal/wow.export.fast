/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Read a whole DB2 table into headers and row arrays, as used by the data
// tab and the headless exporter for CSV/SQL output.
const WDCReader = require('./WDCReader');

/**
 * Parse a DB2 table.
 * @param {string} table_name Table name, e.g. "Map".
 * @returns {Promise<{headers: string[], rows: Array<Array>, schema: Map}>}
 */
const parse_table = async (table_name) => {
	const db2_reader = new WDCReader('DBFilesClient/' + table_name + '.db2');
	await db2_reader.parse();

	const all_headers = [...db2_reader.schema.keys()];
	const id_index = all_headers.findIndex(header => header.toUpperCase() === 'ID');
	if (id_index > 0) {
		const id_header = all_headers.splice(id_index, 1)[0];
		all_headers.unshift(id_header);
	}

	const rows = await db2_reader.getAllRows();
	const parsed = Array(rows.size);

	let index = 0;
	for (const row of rows.values()) {
		const row_values = Object.values(row);
		if (id_index > 0) {
			const id_value = row_values.splice(id_index, 1)[0];
			row_values.unshift(id_value);
		}

		// coerce BigInt to Number to avoid JSON.stringify crash in Vue rendering
		for (let i = 0; i < row_values.length; i++) {
			const val = row_values[i];
			if (typeof val === 'bigint')
				row_values[i] = Number(val);
			else if (Array.isArray(val))
				for (let j = 0; j < val.length; j++)
					if (typeof val[j] === 'bigint')
						val[j] = Number(val[j]);
		}

		parsed[index++] = row_values;
	}

	return { headers: all_headers, rows: parsed, schema: db2_reader.schema };
};

module.exports = parse_table;
