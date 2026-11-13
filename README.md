# CodeLadder · Four-tier Code Reading

**Read code like climbing a ladder.**

CodeLadder explains a source file in four connected tiers — from plain-language intent all the way down to the exact lines of code — so people who don't write code can still understand what a program does, how it flows, and where each statement lives.

Works with **Python, TypeScript, C, C++, Java, Rust and Go**.

---

## Who it's for

- **AI-assisted developers who ship code they can't fully read.** Vibe coding gets you working software fast — CodeLadder lets you climb back into the black box you merged, tier by tier, and understand it before you touch it again.
- **Anyone learning an unfamiliar codebase.** New hires, students, reviewers and maintainers can start from the file's intent and walk down to individual statements, without reading every line first.

---

## Why CodeLadder?

Most "explain this code" tools give you one long answer in a chat window, disconnected from the file. CodeLadder keeps the explanation and the code side by side, and lets you move between them in both directions.

- **Four tiers, one source of truth.** Every tier points back to real line ranges in the file.
- **Project-aware.** Before explaining a file, CodeLadder reads the project index: what the file defines, what it imports, and who imports it.
- **Deterministic first.** Structure comes from the syntax tree, not from a model. AI is optional and only rewrites the wording.
- **Click to jump, move to follow.** Click a block on the right to select the code on the left; move the cursor on the left to highlight the matching block.
- **Bilingual.** Chinese and English, switchable at runtime.

---

## Install

| IDE | How to install |
| --- | --- |
| **VS Code** | Extensions view → search `CodeLadder`, or `code --install-extension codeladder.codeladder` |
| **Trae** | Extensions view → search `CodeLadder` (Trae's gallery reads Open VSX), or `trae-cn --install-extension codeladder-0.1.1.vsix` from the [latest release](https://github.com/white8tterfly/codeladder/releases/latest) |
| **Qoder** | Extensions view → `...` → **Install from VSIX**, or `qoder --install-extension codeladder-0.1.1.vsix` |
| **Other VS Code-compatible IDEs** | Download the `.vsix` from the releases page and install it from the Extensions view |

---

## Quick start

1. Open a folder in VS Code or Trae (the folder becomes the project CodeLadder reads).
2. Open any supported source file, for example `service.py` or `payment.java`.
3. Run **CodeLadder: Generate Four Tiers** from:
   - the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`),
   - the editor title bar,
   - or the editor right-click menu.
4. Use the tab bar to switch between **L1 Intent**, **L2 Steps**, **L3 Logic** and **L4 Code**.
5. Click any explanation block to jump to and highlight its code; move the cursor in the editor to see the matching block light up.

---

## The four tiers

| Tier | Name | What you read | Where it comes from |
| --- | --- | --- | --- |
| **L1** | Intent | One explanation per function / interface / class, plus top-level segments (imports, setup, `__main__` startup) so every code line is covered | Model-written (a model is required) |
| **L2** | Steps | One explanation per code block (function body, branch, loop, module level), not per line | Model-written (a model is required) |
| **L3** | Logic | The structural shape: function signature, condition, loop source, return value, call expression | 100% syntax tree, no guessing |
| **L4** | Code | The original code snippet with line badges | The source file itself |

Each block carries a fidelity badge:

- **✔ Deterministic** — produced entirely from the syntax tree and project index.
- **✦ AI generated** — wording was refined by your configured model; the underlying structure and line ranges are still deterministic.

---

## Features

### Four-tier projection

Every semantic unit — a function, class, loop, branch, assignment, call, import or comment — becomes a block in all four tiers. Tiers are not separate summaries; they are four zoom levels of the same unit.

### Project context before explanation

When a file belongs to a project, CodeLadder scans the workspace first:

- the module name and file role,
- the classes and functions it defines,
- the modules it imports,
- the files that import it and which names they use,
- whether the file contains a program entry (`main`, `if __name__ == "__main__"`, and so on).

The context card at the top of the panel summarizes this, so the explanation is grounded in how the file is actually used — not just what it looks like in isolation.

### Two-way highlighting

- Click a block on the right: the matching lines are selected and highlighted on the left, even when the file is in another editor tab.
- Move the cursor on the left: the corresponding block is focused on the right.
- Multi-line units highlight every line they cover.

### Optional AI enrichment

CodeLadder works fully offline for the deterministic tiers (L3 logic, L4 code and the technical background). The business context and L1/L2 are model-written: configure an OpenAI-compatible endpoint, and the model is asked to explain each group, anchored to the AST-derived groups. If no model is available or the request fails, these tiers are blocked with a setup prompt instead of falling back to templates.

### Bilingual, switchable at runtime

The panel, tier names, project context and generated explanation follow the `CodeLadder › Language` setting:

- `auto` (default): Chinese IDE → Chinese, otherwise English,
- `zh`: always Chinese,
- `en`: always English.

Changing the setting while the panel is open regenerates the current file in the new language.

### Multi-language support

The same four-tier model applies to every supported language. Each language has its own tree-sitter grammar and its own import resolution rules (relative imports, `#include`, Java packages, Rust `crate::`, Go package paths).

---

## Commands

| Command | ID | Description |
| --- | --- | --- |
| **CodeLadder: Generate Four Tiers** | `codeReadable.explain` | Parse the active file and open the four-tier panel |
| **CodeLadder: Regenerate** | `codeReadable.refresh` | Re-run the explanation for the active file |
| **CodeLadder: Rebuild Project Index** | `codeReadable.rebuildIndex` | Rescan the workspace and rebuild the project index |

The index updates automatically when a supported file is saved.

---

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `codeLadder.language` | `auto` | Explanation and panel language: `auto`, `zh`, `en` |
| `codeLadder.llm.baseUrl` | empty | OpenAI-compatible base URL at domain level, e.g. `https://api.deepseek.com` — CodeLadder appends `/chat/completions` itself |
| `codeLadder.llm.apiKey` | empty | API key for the model endpoint |
| `codeLadder.llm.model` | empty | Model name, e.g. `deepseek-chat` |
| `codeLadder.llm.maxInputChars` | `24000` | Maximum code characters sent per request; overflow is left for the next run |

**A model is required for the semantic layers.** CodeLadder asks the IDE for a built-in language model first (the `vscode.lm` API); when the host exposes one — for example a Copilot Chat model — no API key is needed. Otherwise set the endpoint settings above. Without a model, the business context and the L1/L2 tiers are not generated at all: the panel shows a setup prompt and keeps only L3 structure and L4 code, which come from the syntax tree. The API key is stored in plain text in your settings file, so only use it on a personal device.

---

## Supported languages

| Language | File types | Extracted structure |
| --- | --- | --- |
| Python | `.py` | modules, classes, functions, fields, assignments, calls, `if` / `for`, returns, imports, docstrings |
| TypeScript | `.ts`, `.tsx` | imports, classes, interfaces, types, functions, methods, fields, variables, calls, control flow |
| C | `.c`, `.h` | includes, structs, functions, declarations, calls, loops, branches, returns |
| C++ | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.hxx` | classes, namespaces, templates, methods, fields, includes, control flow |
| Java | `.java` | packages, imports, classes, interfaces, enums, records, methods, constructors, fields, calls |
| Rust | `.rs` | `use` declarations, structs, enums, traits, impl blocks, functions, `let`, macros, control flow |
| Go | `.go` | packages, imports, types, functions, methods, fields, `var` / `:=`, calls, loops, branches |

---

## How it works

1. **Parse** — the file is parsed with a tree-sitter grammar compiled to WebAssembly.
2. **Derive units** — the syntax tree is converted into semantic units with exact line ranges.
3. **Index the project** — supported files in the workspace are scanned for symbols, imports and reverse references.
4. **Project the deterministic tiers** — L3 logic, L4 code and the technical context come straight from the syntax tree and the project index.
5. **Generate the semantic layers** — the model writes the business context and one explanation per L1 function/class group and per L2 code block, from the code plus project facts. Results are merged back by group index; line numbers and unit boundaries always stay AST-derived. If no model is available or the request fails, these layers are blocked with a setup prompt instead of falling back to templates.

### Token control

- **Reuse first.** Results are cached per file and language. Running the command again on an unchanged file makes **no model call**.
- **Incremental.** Groups are keyed by their code content (line shifts don't invalidate them). Only new or changed groups are sent; unchanged L1/L2 are reused.
- **Summary fingerprint.** The business context is regenerated only when the file's docstring, module facts, dependency/usage facts or unit skeleton change — not on every internal edit.
- **Budget.** Only the code for the requested groups is sent (the outline is cheap). `maxInputChars` caps the payload; groups that don't fit are left for the next run, and the status bar tells you how many were covered.
- **Deduplicated.** Identical requests already in flight share one call, so double-clicks or a language switch don't double-bill.
- **Reset on config change.** Changing the model settings clears the cache, so old model output is never presented as new model output.

---

## Privacy

- Parsing, indexing and the deterministic tiers run entirely on your machine.
- The semantic layers send the current file and project facts to the configured model endpoint; nothing is sent before you run the command.
- The project index is kept in memory only; nothing is written to disk.

---

## Requirements

- VS Code 1.85 or newer, or a compatible IDE such as Trae.
- A language model exposed by the IDE, or an OpenAI-compatible endpoint configured in settings. Business context and L1/L2 cannot be generated without one.
- No Python, Java, Rust or Go toolchain is required — grammars are bundled with the extension.

---

## Troubleshooting

- **“CodeLadder: open a supported source file first.”** — the active editor is not a supported language; open a `.py`, `.ts`, `.tsx`, `.c`, `.h`, `.cpp`, `.java`, `.rs` or `.go` file.
- **Business context and L1/L2 say “No model” or “Model request failed”.** — configure `codeLadder.llm.baseUrl`, `apiKey` and `model`, then click **Retry** in the panel. L3 structure and L4 code stay available without a model.
- **The panel shows an HTTP error.** — the error text is shown verbatim (status code and response snippet); check the endpoint URL, key, model name and network.
- **The context card is empty.** — the workspace has not been indexed yet, or the file sits outside the workspace folder. Run **Rebuild Project Index**.
- **Blocks point at the wrong lines after editing.** — run **Regenerate**; the panel always reflects the last generation.
- **First run is slow on a large repository.** — indexing is capped (2000 files, 512 KB per file) and cached in memory; later runs reuse it.

---

## Release notes

### 0.1.1

- Fidelity badges are now honest: L1 reads *Inferred* offline and *AI-written* only when a model produced it.
- Command titles and setting descriptions follow the IDE display language (English / 简体中文).

### 0.1.0

- Four-tier projection (L1 intent / L2 steps / L3 logic / L4 code).
- Project index with symbols, imports and reverse references.
- Two-way highlighting between panel and editor.
- Python, TypeScript, C, C++, Java, Rust and Go support.
- Optional OpenAI-compatible LLM enrichment.
- Chinese / English UI with runtime switching.
