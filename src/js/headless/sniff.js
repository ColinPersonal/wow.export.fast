/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

// Recognise sound files the listfile names .unk_sound (or does not name at
// all) by their first bytes.

/**
 * Detect the audio container of a buffer.
 * @param {Uint8Array} bytes First bytes of the file (at least 4).
 * @returns {?string} '.ogg', '.mp3' or null.
 */
const detectAudioExtension = (bytes) => {
	if (!bytes || bytes.length < 3)
		return null;

	// Ogg pages start with "OggS".
	if (bytes.length >= 4 && bytes[0] === 0x4F && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53)
		return '.ogg';

	// MP3: an ID3v2 tag, or an MPEG audio frame sync (11 set bits).
	if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
		return '.mp3';

	if (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0)
		return '.mp3';

	return null;
};

/**
 * File name to write a sound to: .unk_sound names get the detected extension.
 * @param {string} fileName
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const audioFileName = (fileName, bytes) => {
	if (!fileName.toLowerCase().endsWith('.unk_sound'))
		return fileName;

	const ext = detectAudioExtension(bytes);
	return ext === null ? fileName : fileName.slice(0, -'.unk_sound'.length) + ext;
};

module.exports = { detectAudioExtension, audioFileName };
