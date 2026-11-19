## Contributing

Contributions to wow.export are welcome, please file a pull-request with adequate details.

Pull-requests are expected to be complete. If a pull-request requires significant work by a maintainer to merge then it will be rejected - consider making a feature suggestion instead!

> [!IMPORTANT] Pull-requests that add third-party libraries, use external services or adjust the build pipeline without first consulting the #wow-export-dev channel will be rejected.

Development of wow.export is actively discussed in [#wow-export-dev](https://discord.gg/kC3EzAYBtf). While participation is not mandatory for pull-requests, those wishing to contribute frequently are expected to be present.

If you plan to make a large contribution, it is expected that you would open a self-assigned tracking issue and co-ordinate with the active maintainers before starting.

Open-issues that have an assignee and are not listed as "Backlog" on the roadmap are currently championed by a maintainer. Contributors should not target these issues.

## Roadmap

The developers maintain a [public roadmap](https://github.com/users/Kruithne/projects/1/views/9) to help give insight and organization to the development process. Before contributing, it's recommended to consult this.

## Building (Developers Only)

### Prerequisites
- **Bun** 1.2 or above (required)
- **Node.js** v24.9.0 or above (required for native add-ons)
- **Python 2.7.18** (required for node-gyp)
  - Windows: Install via `choco install python2 -y`
  - macOS: Install via pyenv: `pyenv install 2.7.18`
  - Linux: Install via apt: `sudo apt install python2 python2-dev`
- **nw-gyp** (required for building native add-ons): `npm install -g nw-gyp@latest`
- **Build tools** (platform-specific):
  - Windows: Visual Studio Build Tools with C++ support
  - Linux: `build-essential` package (`sudo apt-get install build-essential`)
  - macOS: Xcode Command Line Tools

### Build Steps
```
git clone https://github.com/Kruithne/wow.export.git
cd wow.export
bun install

# This will list available builds.
bun ./build.js

# This will compile -all- available builds.
bun ./build.js *

# Substitute <BUILD> for the build(s) you wish to compile, space-delimitated.
bun ./build.js <BUILD1> <BUILD2> ...
```

**Note**: The build process will automatically download nw.js headers and handle native add-on compilation if any are present in the `node_addons/` directory.

## Tests and Benchmarks (Developers Only)

Tests and benchmarks run on plain Node.js (v24+, the same V8 engine NW.js uses), with no extra dependencies and no WoW install needed. They cover the export pipeline pieces that run outside the app: PNG encoding, the export worker pool and its BLTE decoder, the export session (de-duplication and I/O limiting) and the export profiler.

```
# Run the tests.
npm test

# Run the benchmarks (bench:quick for a shorter run).
npm run bench

# Save a run, then compare a later run (e.g. after a change) against it.
node bench/run.js --save before
node bench/run.js --compare before

# Only run matching cases, or include real exported PNGs.
node bench/run.js --filter blte
node bench/run.js --images <folder of exported PNGs>
```

Benchmark results are written to `bench/results/`, which is not committed.

To benchmark real exports, export something in wow.export (the app writes a timing profile to `runtime.log` after every export), then:

```
# Show the export profiles from the current runtime.log.
npm run bench:profiles

# runtime.log is cleared when the app starts, so save profiles to compare later.
node bench/export-profiles.js --save "before change"
node bench/export-profiles.js --history
```

### Full tile export tests

These export real map tiles from a local WoW installation using a built wow.export (`bun ./build.js win-x64` first), then check the output and report timings. They are separate from `npm test` because they need the game and take minutes to hours.

```
# One tile in each format (a few minutes, mostly first-run setup).
npm run test:exports

# 16 tiles per format, with models, WMOs, foliage and liquids.
npm run test:exports -- --suite standard

# 100 baked tiles and 400 raw tiles; large output. --clean removes exports afterwards.
npm run test:exports -- --suite scale --clean
```

The app runs in a headless test mode with its own data directory, so it can run while you use wow.export normally and never changes your settings, runtime log or export folder. Everything goes under `~/wow.export-tests`: `runs/<run>/` holds each run's exports, `report.json` and `runtime.log`, and `history.jsonl` keeps every run's timings so each run is compared with the previous one of the same suite. The install and product default to the ones you last opened in wow.export; use `--install` and `--product` to choose others. Suites are JSON files in `tests/export-scale/suites/`; tiles are named like their ADT files (`"32_48"`), as lists, `{ "from": "31_47", "to": "34_50" }` ranges, or `"all"`.

## Debugging (Developers Only)
> **Note**: Debugging is currently only supported on Windows.

To debug wow.export, compile a `win-x64-debug` build using the build script. This will produce a bare-bones build using the SDK framework and without any production polish. Upon starting the debug version, DevTools will be automatically launched alongside the application.

For the debug build, source code will not be compiled, rather a symlink is created. This means changes to the source code are instantly reflected in the application, simply run `chrome.runtime.reload()` in DevTools console to refresh sources (pressing F5 does not drop references and will lead to memory leaks).