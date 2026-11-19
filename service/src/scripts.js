// Download scripts handed to agents. They never contain the token: it is read
// from $WOW_EXPORT_TOKEN at run time.

const shQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";

const bash = (baseUrl, key, dest) => `#!/usr/bin/env bash
# Downloads a wow-export result and verifies every file's SHA-256.
set -euo pipefail
: "\${WOW_EXPORT_TOKEN:?Set WOW_EXPORT_TOKEN to your wow-export token}"
BASE=${shQuote(baseUrl)}
KEY=${shQuote(key)}
DEST=${shQuote(dest)}
AUTH="Authorization: Bearer \${WOW_EXPORT_TOKEN}"

mkdir -p "$DEST"
cd "$DEST"
curl -fsS -H "$AUTH" "$BASE/list/$KEY?format=curl" -o .wow-export-curl.cfg
curl -fsS -H "$AUTH" "$BASE/list/$KEY?format=sha256sum" -o .wow-export.sha256

if curl --help all 2>/dev/null | grep -q -- '--parallel'; then
	curl --fail --silent --show-error --retry 3 --create-dirs --parallel --parallel-max 8 -H "$AUTH" -K .wow-export-curl.cfg
else
	curl --fail --silent --show-error --retry 3 --create-dirs -H "$AUTH" -K .wow-export-curl.cfg
fi

if command -v sha256sum >/dev/null 2>&1; then
	sha256sum -c --quiet .wow-export.sha256
else
	shasum -a 256 -c --quiet .wow-export.sha256
fi

rm -f .wow-export-curl.cfg
echo "OK: $(wc -l < .wow-export.sha256 | tr -d ' ') files downloaded and verified in $(pwd)"
`;

const powershell = (baseUrl, key, dest) => `# Downloads a wow-export result and verifies every file's SHA-256.
$ErrorActionPreference = 'Stop'
if (-not $env:WOW_EXPORT_TOKEN) { throw 'Set $env:WOW_EXPORT_TOKEN to your wow-export token' }
$Base = ${psQuote(baseUrl)}
$Key = ${psQuote(key)}
$Dest = ${psQuote(dest)}
$Headers = @{ Authorization = "Bearer $($env:WOW_EXPORT_TOKEN)" }

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$List = (Invoke-WebRequest -UseBasicParsing -Headers $Headers -Uri "$Base/list/$Key?format=tsv").Content -split "\`n" | Where-Object { $_ }
$Count = 0
foreach ($Line in $List) {
	$Hash, $Size, $UrlPath, $Path = $Line -split "\`t"
	$Out = Join-Path $Dest $Path
	New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null
	Invoke-WebRequest -UseBasicParsing -Headers $Headers -Uri "$Base/files/$Key/$UrlPath" -OutFile $Out
	if ((Get-FileHash -Algorithm SHA256 $Out).Hash.ToLower() -ne $Hash) { throw "Checksum mismatch: $Path" }
	$Count++
}
"OK: $Count files downloaded and verified in $((Resolve-Path $Dest).Path)"
`;

const encodePath = (rel) => rel.split('/').map(encodeURIComponent).join('/');

const curlQuote = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/**
 * File lists served at /list/<key>.
 * @param {object} manifest
 * @param {string} baseUrl
 * @param {'curl'|'sha256sum'|'tsv'} format
 */
const list = (manifest, baseUrl, format) => {
	const lines = [];
	for (const f of manifest.files) {
		if (format === 'curl')
			lines.push('url = ' + curlQuote(baseUrl + '/files/' + manifest.key + '/' + encodePath(f.path)), 'output = ' + curlQuote(f.path));
		else if (format === 'sha256sum')
			lines.push(f.sha256 + '  ' + f.path);
		else
			lines.push([f.sha256, f.size, encodePath(f.path), f.path].join('\t'));
	}
	return lines.join('\n') + (lines.length ? '\n' : '');
};

module.exports = { bash, powershell, list, encodePath };
