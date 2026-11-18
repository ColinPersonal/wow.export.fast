/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */
const core = require('../../core');
const constants = require('../../constants');
const exportSession = require('../../export-session');
const M2Exporter = require('./M2Exporter');
const M3Exporter = require('./M3Exporter');

/**
 * Export a placed model (doodad, map object, foliage) to the given path.
 * Within an export run each output path is only produced once, regardless of
 * how many tiles or WMOs reference the model, and concurrent requests for the
 * same path share a single export.
 * @param {number} fileDataID
 * @param {string} outPath
 * @param {boolean} isRaw
 * @param {ExportHelper} helper
 */
const exportPlacedModel = (fileDataID, outPath, isRaw, helper) => {
	return exportSession.once('model:' + outPath, async () => {
		const config = core.view.config;
		const data = await core.view.casc.getFile(fileDataID);

		const magic = data.readUInt32LE();
		data.seek(0);

		let exporter;
		if (magic === constants.MAGIC.MD21)
			exporter = new M2Exporter(data, undefined, fileDataID);
		else if (magic === constants.MAGIC.M3DT)
			exporter = new M3Exporter(data, undefined, fileDataID);
		else
			return;

		if (isRaw)
			await exporter.exportRaw(outPath, helper);
		else
			await exporter.exportAsOBJ(outPath, config.modelsExportCollision, helper);
	});
};

module.exports = { exportPlacedModel };
