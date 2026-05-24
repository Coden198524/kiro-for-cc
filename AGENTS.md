# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript VS Code extension for Kiro for Agent Code. Core code lives in `src/`, with `src/extension.ts` as the activation entry point. Feature logic is under `src/features/`, tree providers under `src/providers/`, runtime provider integration under `src/runtime/`, helpers under `src/utils/`, and prompt loading under `src/services/`. Prompt templates live in `src/prompts/` and `src/resources/`; generated modules go to `src/prompts/target/`. Static assets are in `icons/`, `media/`, and `screenshots/`. Tests are under `tests/`.

## Build, Test, and Development Commands

- `npm install`: install project dependencies.
- `npm run compile`: build prompts, then compile TypeScript into `dist/`.
- `npm run watch`: run TypeScript and prompt-template watchers for local development.
- `npm run build-prompts`: regenerate `src/prompts/target/` from prompt sources.
- `npm run package-web`: production Webpack build used before publishing.
- `npm run package`: create a `.vsix` extension package with `vsce`.
- `npm test`: run the Jest test suite.
- `npm run test:coverage`: generate coverage reports.

Use VS Code's `F5` Extension Development Host for manual debugging.

## Coding Style & Naming Conventions

Use TypeScript with `strict` mode enabled. Follow nearby files: single quotes, semicolons, named exports where practical, `PascalCase` for classes/providers, and `camelCase` for functions, variables, and command handlers. VS Code commands use `kfc.{feature}.{action}`, for example `kfc.spec.create`. Keep file operations based on `vscode.Uri` and workspace-relative paths. Do not hand-edit `src/prompts/target/`; update prompt sources and run `npm run build-prompts`.

## Testing Guidelines

Jest with `ts-jest` is the test framework. Name tests `*.test.ts` and place them near their domain under `tests/unit/` or `tests/integration/`. The VS Code API is mocked through `tests/__mocks__/vscode.ts`. Snapshot tests live in `tests/integration/__snapshots__/`; update them intentionally with `npm test -- -u`. Coverage excludes `src/extension.ts` and generated prompt targets, so add focused tests for managers, providers, utilities, and prompt behavior.

## Commit & Pull Request Guidelines

Recent history uses short imperative subjects, often with `fix:` or `chore:`. Prefer messages like `fix: improve path normalization` or `chore: bump version to 0.2.9`. Pull requests should describe behavior changes, list test commands, link issues, and include screenshots or GIFs for visible UI changes.

## Agent-Specific Instructions

Keep changes scoped. Preserve user-facing command IDs and contribution points in `package.json` unless the change explicitly requires migration. After modifying prompts, resources, or package contributions, run the relevant build and tests before handing off.
