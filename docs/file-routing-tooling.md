# File routing tooling

The normal project build creates `.sprindle/routes.mjs` and its private consumer declaration. Development watches route files and their local dependencies. It starts the API server only after the first valid compile. A valid add, move, edit, or delete restarts the server. An invalid edit keeps the last valid server active and restarts it after recovery.

Install the project language support with:

```sh
pnpm setup:editor
```

This command builds the checked-in Sprindle VS Code extension and installs it in the current user's VS Code extension directory. Set `SPRINDLE_VSCODE_EXTENSIONS_DIR` to install into an isolated directory. The repository recommendation then matches the installed extension ID. Developers do not run a route generator or expose generated imports.

VS Code 1.136.1 on macOS is the tested editor host. The extension discovers one TypeScript project and its route directory. It refuses a second project instead of mixing project state. It updates diagnostics, completion, and definitions for saved and unsaved route changes. Rename refuses changes when it cannot prove complete edits.

Verification commands:

```sh
pnpm --filter @southneuhof/sprindle test:tooling
pnpm --filter @southneuhof/sprindle test:editor-install
pnpm --filter @southneuhof/sprindle test:editor
```
