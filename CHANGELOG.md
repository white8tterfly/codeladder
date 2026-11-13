# Changelog

All notable changes to CodeLadder are documented in this file.

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
