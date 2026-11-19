# Headless exporter (CLI and MCP server)

wow.export's data and export layers can run without the desktop application. This gives scripts and AI agents a way to ask for game files: search file names, fetch textures, export models and maps, and read database tables. Files are fetched from Blizzard's CDN and written to local disk.

## Requirements

- [Bun](https://bun.sh) 1.2 or above. No `bun install` is needed for the common cases.
- Network access to these hosts:
  - `us.version.battle.net` (or the patch server of your region)
  - `level3.blizzard.com`, `level3.ssl.blizzard.com`, `us.cdn.blizzard.com`, `cdn.blizzard.com`
  - `archive.wow.tools` (CDN fallback)
  - `www.kruithne.net`, `github.com`, `raw.githubusercontent.com` (listfile, encryption keys, table definitions)
- Proxy environment variables (`HTTPS_PROXY`) are honoured.

The first run downloads the build's indexes and the listfile (roughly 550 MB) into the data directory. After that, opening the build takes about 20 seconds.

## Command line

```
bun src/js/headless/cli.js <command> [--argument value ...]
bun src/js/headless/cli.js help
```

Results are printed to stdout as JSON. Every export reports the files it wrote.

```
# Find files.
bun src/js/headless/cli.js search --query "murloc" --type model

# One file, unmodified or as PNG.
bun src/js/headless/cli.js get_file --file interface/icons/inv_sword_04.blp --format png

# A model with its textures, skins, skeleton and animations.
bun src/js/headless/cli.js export_model --file creature/murloc/murloc.m2 --format glb

# Two terrain tiles with everything placed on them.
bun src/js/headless/cli.js export_map --map azeroth --tiles 32_48,32_49

# A whole continent, resumable if interrupted.
bun src/js/headless/cli.js export_map --map azeroth --resume

# Database rows.
bun src/js/headless/cli.js query_table --table Map --where '{"ExpansionID": 2}'
```

| Command | Purpose |
|---|---|
| `info` | The game build that is open, and the default output directory. |
| `search` | Search file names (textures, models, sounds, text, fonts). |
| `get_file` | Fetch one file, raw or (BLP) as PNG. |
| `export_textures` | Export several textures as PNG, WebP or BLP. |
| `export_model` | Export an M2, M3 or WMO as raw files, OBJ, glTF or GLB. |
| `list_maps` | List maps with their IDs and directory names. |
| `list_map_tiles` | List the terrain tiles of a map. |
| `export_map` | Export terrain tiles with their models, WMOs, foliage and liquids. |
| `query_table` | Read rows from a DB2 table. |

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `WOW_EXPORT_OUT` | `./wow-export` | Where exported files are written. Each command also accepts `--outDir`. |
| `WOW_EXPORT_DATA_DIR` | `~/.wow.export-headless` | Cache, configuration and runtime log. |
| `WOW_EXPORT_PRODUCT` | `wow` | Game product (`wow`, `wowt`, `wow_classic`, ...). |
| `WOW_EXPORT_REGION` | `us` | CDN region. |

## MCP server

```
bun src/js/headless/cli.js mcp
```

This serves the same commands as tools over the Model Context Protocol stdio transport. The repository's `.mcp.json` registers it as `wow-export`, so agents working in this repository get the tools automatically. To use it from another project, add this to that project's `.mcp.json`, with the path to a checkout of this repository:

```json
{
	"mcpServers": {
		"wow-export": {
			"command": "bun",
			"args": ["/path/to/wow.export.fast/src/js/headless/cli.js", "mcp"]
		}
	}
}
```

Tools return the paths of the files they wrote, not the file contents. The agent reads the files from disk.

## What is not available headless

These features need a browser (WebGL or canvas) and only work in the desktop application:

- Baked terrain textures. `export_map --format obj` writes the terrain mesh without them.
- Minimap and WMO minimap compositing.
- Character customisation textures.
- Game object placement on map tiles.

## Checking that changes do not alter output

`bench/output-manifest.js` runs a fixed set of real exports and records a content hash for every file written.

```
bun bench/output-manifest.js --write before.json
# make changes
bun bench/output-manifest.js --compare before.json
```

PNG files are hashed by their decoded pixels. Both runs must be made against the same game build.
