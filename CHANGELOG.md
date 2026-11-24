# Changelog

All notable changes to CodeLadder are documented in this file.

## [0.1.9] - 2026-11-24

### Added

- The panel header now shows how many tokens the current analysis used, with the input / output split in the tooltip. The counter updates after each batch, uses the endpoint's `usage` when it is returned, and is prefixed with `≈` when it has to be estimated from characters (for example with the IDE's built-in model).
- A **Re-analyze** button in the panel header. It ignores the cache, re-parses the current file and regenerates every L1 / L2 explanation; the button is disabled and spins while the run is in progress.
- `codeLadder.autoRefresh.enabled` (default `false`) and `codeLadder.autoRefresh.globs`. When enabled, saving the file currently shown in the panel re-runs the analysis after a short debounce and sends only the changed groups to the model. `globs` limits auto-refresh to matching files (e.g. `src/**/*.py`); leave it empty to apply to every supported file.

### Changed

- Generated explanations are now persisted in workspace state and restored when the extension activates, so reloading the window or upgrading the extension no longer sends the whole file to the model again. The persisted cache is discarded when the configured endpoint or model changes.
- Reading text in the panel is larger, with 15px body copy, 1.8 line height and roomier spacing. When `霞鹜文楷 屏幕阅读版` / `LXGW WenKai Screen` is installed, explanations use it as the reading face, falling back to Noto Sans SC and Microsoft YaHei; titles, tabs, badges and code keep a sans or mono face.

### Fixed

- With auto-refresh on, re-analysis reset the header token count to 0, or to the tokens of the last incremental run. The counter now accumulates the original total plus each incremental run for the current file, and resets only when you open another file. Cache hits no longer overwrite an existing total with 0.
- Clicking an explanation block now jumps to the code and pins the highlight in a single click. The panel's auto-scroll used to move the pointer across other blocks, which cleared the just-applied highlight.
- The four tier cards keep their description line in the two-column narrow layout instead of hiding it.
- A class or function whose docstring / description is separated from the body by blank lines is no longer split into two explanation blocks. The block header and its first body statement now stay in the same L2 group, and the block's line range covers the blank lines, comments and docstring in between so it reads as one contiguous block.

## [0.1.8] - 2026-11-15

### Changed

- A configured endpoint (`codeLadder.llm.baseUrl`, `apiKey` and `model`) now takes precedence over a model the IDE exposes through `vscode.lm`. The IDE model is used only when none of the three is set, so a working configuration is no longer overridden by whatever model the editor happens to register.

### Fixed

- Failure details now name the model and base URL that were actually used. A gateway that only accepts its own model names answers with HTTP 400, and the panel used to hide that mismatch behind a bare status code.
- When the IDE exposes several models, CodeLadder picks a common chat family instead of whichever model came first in the list.

## [0.1.7] - 2026-11-14

### Fixed

- The four tier cards (L1–L4) drew their names in the browser's default button colour, which is black in dark themes, so "intent / steps / logic / code" was unreadable on a dark background. The cards now inherit the theme ink colour.

## [0.1.6] - 2026-11-13

### Fixed

- `try` / `with` / `while` / `match` blocks were treated as one opaque statement, so a 26-line `try` block showed up as a single raw code card in L3 and L4. Each compound statement now emits a one-line header unit (`try:`, `except ValueError:`, `else:`, `finally:`, `case "add":`) and its body is split into normal units.
- `else` branches were swallowed into a single statement unit, which also left the `else:` line uncovered. Else bodies now emit their own header and are walked like any other block.
- `x += 1` was classified as a generic statement; augmented assignments now count as assignments.
- Compound-block L2 titles now include the condition for error branches and `case` clauses (`异常分支 · FileNotFoundError`, `分支 · "add"`).

## [0.1.5] - 2026-11-13

### Fixed

- L3 no longer echoes the source line. Call statements now describe what the call does, multi-line blocks are named by structure (`try / except block`, `with block`, …) with their line count, and `if` / `for` show the bare condition without the keyword and trailing colon.

## [0.1.4] - 2026-11-13

### Fixed

- Long files are explained from head to tail: when the pending groups exceed the input budget, the request is split into several batches instead of silently dropping the groups that do not fit, so L2 no longer stops halfway through the file.

## [0.1.3] - 2026-11-13

### Fixed

- L1 now covers the whole file: module-level code before and after the functions (imports, top-level setup, `__main__` startup flow) gets its own L1 entry, instead of the intent tier showing only a handful of functions.
- L2 blocks never skip lines; each block is one contiguous range.

## [0.1.2] - 2026-11-13

### Changed

- Business context, L1 intent and L2 steps now require a model. Without an available model these tiers show a setup gate instead of template text; deterministic L3 logic, L4 code and the technical background stay available offline.
- L1 is now explained per function / interface / class, and L2 per code block (function body, branch, loop, module level), instead of line by line. L3 and L4 keep per-unit precision.
- The IDE's built-in model is used first when the IDE exposes one; otherwise an OpenAI-compatible endpoint from settings is used.
- Token cost is controlled: unchanged files and units are reused from an in-memory cache, only changed units are sent, the business summary is regenerated only when its fingerprint changes, and requests are truncated to `codeLadder.llm.maxInputChars`.

### Fixed

- The panel no longer presents template-written intent as if it were a model's analysis.

## [0.1.1] - 2026-11-13

### Changed

- Command titles and setting descriptions now follow the IDE display language (English / 简体中文) instead of always showing English.
- The Intent tier (L1) is labelled **Inferred** instead of *AI-generated* when no model is involved, so the badge only reads *AI-written* for content actually produced by a model.

### Fixed

- Fidelity markers no longer claim AI generation in offline, deterministic mode.
- Intent blocks are marked `inferred` instead of `ai`, keeping the three states (`deterministic`, `inferred`, `ai-written`) distinct.

## [0.1.0] - 2026-11-13

First public release.

### Added

- Four-tier projection for a single file: **L1 Intent**, **L2 Steps**, **L3 Logic**, **L4 Code**, each with its own color depth, line badges and fidelity marker.
- Project context card: module role, neighbouring files, reverse references and entry-point detection, built from a deterministic project index. The card collapses on click and remembers its state.
- Two-way highlighting: click a block to jump to its code; move the cursor to light up the matching block.
- Multi-language parsing through tree-sitter wasm: Python, TypeScript/TSX, C, C++, Java, Rust and Go.
- Optional AI enrichment. CodeLadder first asks the IDE for a built-in language model (the `vscode.lm` API); if none is available it falls back to any OpenAI-compatible endpoint configured in settings. Deterministic results are always available offline.
- Bilingual UI and explanations (Chinese / English) with `auto`, `zh` and `en` modes; the default follows the IDE display language and can be switched at runtime.
- Light, dark and high-contrast panel themes that follow the IDE theme.
- Commands: `CodeLadder: Generate Four Tiers`, `CodeLadder: Regenerate`, `CodeLadder: Rebuild Project Index`.

### Notes

- No telemetry, no background network access. Only an explicit AI request (when configured) leaves your machine.
- The extension package ships tree-sitter grammar files for the supported languages, so no external compiler or language server is required.
