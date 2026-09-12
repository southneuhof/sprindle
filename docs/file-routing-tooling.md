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

The manifest compiler rejects static local import cycles in bundle and source
mode. For example, `auth.ts -> db.ts -> domains.ts -> auth.ts` is an error.
Move shared declarations to a module that does not import the service. Source
manifests keep one module identity with direct application source imports and
need the existing TypeScript loader. Production still uses the shared ESM
application build. The check uses static import statements. It does not detect
cycles through dynamic imports or `require` calls.

Routes can use direct relative imports from sibling TypeScript source trees.
The manifest compiler keeps the selected sibling `.ts` and `.d.ts` files in the
private consumer contract. The normal build, check, and development commands do
not change. An alias can refer to a sibling file after a direct relative import
has found that file. Alias-only sibling discovery, `.mts` and `.cts` declarations,
and separate dependency versions for sibling trees are not supported.

Declaration emission starts from route files, inherited scope files, and ambient
TypeScript sources. TypeScript follows their imports, re-exports, path aliases,
and type-only dependencies. The full staged project stays available for module
resolution, and project diagnostics still check the full configured project.

Production builds reuse an unchanged private consumer declaration after a
TypeScript file-resolution probe validates all local, framework, compiler, and
external type inputs. Missing or damaged metadata and contract files cause a
normal declaration rebuild. The build keeps the last valid contract if that
rebuild fails. This reuse is automatic and adds no command or public cache option.

Bundled manifest analysis and output use one bundle pass.
