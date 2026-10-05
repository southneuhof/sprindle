# File routing tooling

The normal producer writes a stable typed entry at `.sprindle/routes.ts` and
an immutable source graph under `.sprindle/source/<version>/`. Runtime builds
use the same graph to write `.sprindle/routes.mjs`. API development writes its
runtime output to `.sprindle-dev/routes.mjs` and updates the same typed entry.
The SDK imports the typed entry through the API package export. Authors keep
the existing file-route and scope syntax and do not run a separate type
generator. Development starts the API server after the first valid compile.
A valid route add, move, edit, or delete restarts it. An invalid edit keeps
the last valid server active and restarts it after recovery.

Install the project language support with:

```sh
pnpm setup:editor
```

This command builds the checked-in Sprindle VS Code extension and installs it in the current user's VS Code extension directory. Set `SPRINDLE_VSCODE_EXTENSIONS_DIR` to install into an isolated directory. The repository recommendation then matches the installed extension ID. Developers do not run a route generator or expose generated imports.

VS Code `1.136.1` on macOS is the tested editor host. The extension discovers one TypeScript project and its route directory. It refuses a second project instead of mixing project state. It updates diagnostics, completion, and definitions for saved and unsaved route changes. Rename refuses changes when it cannot prove complete edits.

Verification commands:

```sh
pnpm --filter @southneuhof/sprindle test:tooling
pnpm --filter @southneuhof/sprindle test:editor-install
pnpm --filter @southneuhof/sprindle test:editor
```

The source graph keeps ordinary modules at their original paths. It projects
only route and scope files that need contextual bindings. Runtime source maps
point back to the authored path, line, and column. The source producer uses
structural parsing and runtime bundling. It does not run TypeScript semantic
analysis or a separate RPC declaration emitter. The editor and frontend
TypeScript services keep semantic diagnostics, completion, and navigation.

The generator rejects static local import cycles in bundle and source mode. A
cycle through dynamic imports or `require` calls is not a static import cycle.
CommonJS `require` inputs remain runtime dependencies.

The graph preserves imported ordinary types and ambient contributors at their
original paths. The frontend checker must resolve those imports as the backend
does. A consumer project with a different `moduleSuffixes` setting can select a
different file for an unsuffixed import when files such as `choice.ts` and
`choice.consumer.ts` both exist. Carta uses ordinary shared source resolution.
Its architecture check rejects nonempty `moduleSuffixes` settings in the API,
web app and test, SDK, Loom, and utilities configs. It also rejects platform
entries in Vite's extension list and platform-named variants in application and
shared source. The check does not compare all package export conditions or
aliases and does not prove every independent consumer config resolves the same
files. Each independent consumer must resolve ordinary imports consistently.

The public `@southneuhof/sprindle` declarations and editor TypeScript API remain
separate from application route inference. A future route producer can replace
the JavaScript and TypeScript source analyzer while keeping the stable typed
source entry and immutable graph as its delivery boundary.

Bundled manifest analysis and output use one bundle pass.

On the recorded Apple M1 run, the full Vue type-check took a `7.77` second
median with TypeScript `6.0.2` and no incremental state. The pre-migration median
was `6.78` seconds. The exact final-code normal-launcher pairs have a pooled
warm edit-to-HTTP median of `1.076` seconds, `45.50` milliseconds slower than
baseline. Cold readiness median is `35.85` milliseconds slower and p95 is
`120.42` milliseconds faster. These results pass the unchanged limits. Two
earlier post-review pairs had a cold outlier and a slow warm median. Their raw
reports remain in the evidence folder and are not pooled with the final code.

The retained isolated source-runtime warm median exceeds its `50` millisecond
limit by `52.22` milliseconds. The project accepts this isolated case as an
explicit exception because typed source publication and validation preserve
the shared runtime and SDK contract. Its failed check remains visible.
`plans/unified-generator/final.json` is an evidence aggregate. It combines the
fresh normal-launcher pair with retained isolated-runtime and Vue samples and a
fresh SDK service. It is not one fresh runtime benchmark. Raw reports remain
beside it. These measurements describe one host and are not CI thresholds.

The final aggregate reports maximum resident sets of `284.92 MB` for the
normal-launcher candidate cold run and `273.73 MB` for its warm process. The
fresh TypeScript 6 application service used `1.06 GB`; the external type-only
service used `762.40 MB`. The Vue memory samples are retained from the prior
full frontend run.

Sprindle watches route files and current compile inputs with Chokidar `3.6`.
Chokidar uses `fsevents` on macOS and shares a native parent stream. Chokidar
falls back to polling on macOS if `fsevents` is not available. The macOS CI
proof requires the native backend and a file limit of `128`.
