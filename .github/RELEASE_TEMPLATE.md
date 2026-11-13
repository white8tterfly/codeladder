# Release template

Every CodeLadder release uses the same shape, so users and tooling can rely on it.

## Rules

- **Tag** and **title**: `vX.Y.Z`, identical to `version` in `package.json`.
- **Asset**: `codeladder-X.Y.Z.vsix`, built from the same commit as the tag.
- **Body**: copy the template below and replace `{{...}}` placeholders.
- **Section order is fixed**: summary → Highlights → Added → Changed → Fixed → Install → Notes → Full changelog.
- **Omit empty sections entirely** — never leave a heading with no content.
- Keep the body consistent with the matching section in `CHANGELOG.md`.

## Body template

```markdown
{{ONE_LINE_SUMMARY}}

## Highlights

- **{{KEYWORD}}** — {{what it does and why it matters}}.

## Added

- {{new capability}}.

## Changed

- {{behaviour or interface change}}.

## Fixed

- {{bug that is now fixed}}.

## Install

```bash
code --install-extension codeladder-{{VERSION}}.vsix
```

Trae, Qoder and other VS Code-compatible IDEs: download `codeladder-{{VERSION}}.vsix` below and use **Install from VSIX** in the Extensions view.

## Notes

- {{upgrade notes, limitations, known issues}}.

## Full changelog

https://github.com/white8tterfly/codeladder/blob/main/CHANGELOG.md
```

## Checklist

1. Bump `version` in `package.json` and add the matching entry to `CHANGELOG.md`.
2. `npm run compile` — no TypeScript errors.
3. `npx @vscode/vsce package -o codeladder-X.Y.Z.vsix` — no warnings.
4. `git commit`, `git tag -a vX.Y.Z -m "vX.Y.Z"`, `git push origin main --tags`.
5. Create the release from this template and upload the `.vsix` asset.
6. Publish to the markets: `npx @vscode/vsce publish` and `npx ovsx publish codeladder-X.Y.Z.vsix`.
