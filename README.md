# dsh-code-intelligence

**English** · [中文](README.zh.md)

Your code agent deserves better than `grep`. This plugin gives DSH two tools that actually understand code structure: an AST search that matches shapes instead of strings, and real language-server navigation that follows symbols instead of guessing line numbers.

Language-server navigation works out of the box for TypeScript/TSX, JavaScript/JSX and Python. Kotlin needs one extra download. AST search covers whatever ast-grep supports, with no setup at all.

## What you get

Two model-facing tools, registered as global Host rows (the plugin's `cordis.patch.yml` inserts the DSH LSP service, the stdio LSP provider, the official `lsp` tool, and this package itself):

| Tool | What it does |
|---|---|
| `ast_grep` | Read-only structural search powered by [ast-grep](https://ast-grep.github.io). Matches syntax-tree patterns, not regex. **No rewrite — it never touches your files.** |
| `lsp` | Symbol navigation: `goToDefinition`, `findReferences`, `goToImplementation`, `hover`. Positions are 1-based UTF-16. |

The difference in practice: `grep` on a name also matches comments, test fixtures and that one unrelated file that happens to contain the same word. `findReferences` on the definition returns the call sites, because a language server knows what a symbol *is*.

## Requirements

| Thing | Value |
|---|---|
| Plugin version | `0.1.0` |
| Node | `>=22.22.2` |
| DSH | `>=0.2.1-rc.3 <0.3.0-0` |
| License | MIT |

Language servers are pinned dependencies — you install nothing globally:

| Package | Version |
|---|---|
| `@ast-grep/cli` | `0.51.0` |
| `pyright` | `1.1.414` |
| `typescript-language-server` | `6.0.2` |
| `typescript` | `6.0.3` |

Kotlin's language server is a separate, optional download — see [Kotlin](#kotlin-optional-and-experimental).

## Install

Pick one. **Only the first one gives you one-click updates later**, and that turns out to matter more than it sounds — see [Updating](#updating-and-why-npm-matters).

### 1. From npm (recommended)

```bash
pnpm dsh plugin --profile web add dsh-code-intelligence
```

If `dsh` is already on your `PATH`, drop the `pnpm` prefix — `dsh plugin --profile web add dsh-code-intelligence` is the same thing. Everywhere below we use the `pnpm dsh` form because it also works from a checkout.

### 2. From GitHub (source of truth, but a dead end for upgrades)

```bash
pnpm dsh plugin --profile web add github:jaxhu1108/dsh-code-intelligence
```

Git is where the code lives, the issues are filed, and the README you're reading is edited. It is *not* where updates come from: install this way and the plugin works fine, but DSH has no way to check for or apply a newer version. Upgrading means removing and re-adding by hand.

Because `lib/` is committed, a Git install needs no build step. pnpm may still print a note about `@ast-grep/cli` build scripts being ignored — that is expected and harmless. Without its `postinstall`, `ast-grep` resolves its platform binary at runtime instead of at install time: everything works, each call just carries a little extra overhead. If you would rather clear the warning, run `pnpm approve-builds` and allow `@ast-grep/cli`.

### 3. From a local checkout (for development)

```bash
pnpm dsh plugin --profile web add /path/to/dsh-code-intelligence
```

Same caveat: a path isn't a registry, so no one-click update. Use it when you're hacking on the plugin itself — `pnpm run build` copies `index.js` and `lsp-config.cjs` into `lib/`, which is the entry point `package.json` actually exports.

### Local development setup

```bash
pnpm install --frozen-lockfile
pnpm run build
```

## Kotlin (optional, and experimental)

TypeScript and Python need nothing extra. Kotlin needs a runtime that is genuinely too big to ship: the official Kotlin LSP standalone is 862 MB unpacked (the zip alone is 364–387 MB, 386 MB on linux-x64), which is why it isn't in the repository and isn't in the npm package. Fetch it when you want Kotlin:

```bash
pnpm run fetch-kotlin          # download, verify SHA-256, unpack
pnpm run fetch-kotlin --check  # report status only, never downloads
pnpm run fetch-kotlin --force  # re-download even if already installed
```

Both `pnpm run fetch-kotlin --check` and `pnpm run fetch-kotlin -- --check` work — pnpm forwards the separator literally and the script tolerates it. `--check` exits with code 1 when nothing is installed (deliberate, so CI can tell), 0 when a copy is usable. Fetching goes to `https://download.jetbrains.com/kotlin-lsp/262.2310.0/` (which 302s to a signed CDN URL; the bare `download-cdn` host 404s without that signature, so don't hand-build those links). The script checks the archive against the official SHA-256 for your platform and deletes it if the digests disagree.

Needs disk headroom: the archive (364–387 MB) plus 862 MB expanded, so budget about 1.4 GB peak. The script checks free space first and refuses to start if it can't see that much, telling you to point `DSH_KOTLIN_LSP_HOME` at a roomier filesystem.

The script is idempotent — run it twice and the second run just prints where the runtime already is, no re-download. It covers six platforms: `linux-x64`, `linux-aarch64`, `mac-x64`, `mac-aarch64`, `win-x64`, `win-aarch64`, each with its own official digest baked in. An unrecognised platform gets a clear non-zero exit instead of a mysterious failure.

Don't want Kotlin? Then don't run it. The plugin degrades silently: Kotlin simply isn't offered, TypeScript and Python keep working, nothing crashes, no error dialog.

If you downloaded manually, or already have a Kotlin LSP lying around, the plugin looks in this order:

1. `DSH_KOTLIN_LSP_COMMAND` — point it at your own launcher, this wins over everything.
2. `<package dir>/.runtime/kotlin-lsp-262.2310.0/` — the package-local copy, this is what existing setups use.
3. `$DSH_KOTLIN_LSP_HOME` (default `~/.dsh/kotlin-lsp`) — where `pnpm run fetch-kotlin` puts it.
4. Nothing found → Kotlin disables itself.

Unpacking prefers your system `unzip`, and falls back to a built-in Node zip reader when it isn't there — so it works either way, needs no extra dependency, and produces byte-identical files.

Behind a proxy? `fetch-kotlin` uses Node's `fetch`, so export `HTTPS_PROXY` (and `NODE_USE_ENV_PROXY=1` on Node 24+) if your network needs it. Or download the zip yourself and unpack it into `~/.dsh/kotlin-lsp/kotlin-lsp-262.2310.0/`.

## Updating, and why npm matters

This is the part people ask about, so let's be concrete.

**A plugin can only be updated in place when DSH knows it came from a registry under its own name.** That's it — that's the whole rule. When you install `dsh-code-intelligence` from npm, the profile records a plain registry version (a range like `^0.1.0`, or an exact `0.1.0` after an update), DSH can ask the registry "is there anything newer?", and the answer comes back with a button attached.

Install it from `git` or a local `link:` and the profile records a git address or a filesystem path instead. DSH isn't being picky — there's no registry to ask, and no published version list to browse. The package still runs perfectly. It just has no update path, and the UI won't pretend otherwise: the version section doesn't appear at all, because there's nothing honest to put there.

### How to update, in the Web UI

1. Open **Plugins** in the sidebar.
2. Stay on **Installed** and click the plugin's card.
3. Find the **Versions** section. Opening the plugin's page starts a check on its own; **Refresh** re-checks every updatable plugin, after which the toolbar summarises it as **Updates available: 1** or **All plugins are up to date**.
4. A newer version appears with an **Update to x.y.z** button. Click it, confirm the dialog, and it runs: the old version stops, the new one installs, and the panel tells you when it's done.

Already up to date? You'll see **Up to date** with the timestamp of the last check. Registry unreachable? It says so and offers a retry — it does not silently claim you're current.

### What happens when things go wrong

Three questions worth answering up front:

**Does it check compatibility first?** Yes. Before replacing anything, DSH reads the target version's manifest from the registry and compares its declared DSH requirement — `engines.dsh` if present, otherwise its `@deepseek-ai/dsh*` peer dependencies — against the version you're actually running. If the requirement isn't met, the update is refused and **nothing changes** — you don't end up with a broken install. In the version list, that entry shows a "needs …" note and can't be installed from there.

**What if the install itself fails?** On a live (hot-reload) profile, updating means removing the old version and installing the new one. If the installation fails or gets cancelled, the old version is reinstalled from the registry it came from, so you land back where you started. On a profile without hot reload, the new version installs over the old one and the result tells you a restart is needed for it to take effect.

**What if I'm stuck on an older DSH than a plugin needs?** Two honest options: upgrade DSH, or install an older plugin version that still supports your DSH. There is also an escape hatch — an exact-version exemption that says "I know this pair is unsupported, do it anyway":

```bash
# Shape only — substitute your own plugin version and your exact DSH version.
# <pkg>@<plugin-version> --dsh-version <exact DSH version> --accept-risk
pnpm dsh plugin --profile web allow-version dsh-code-intelligence@0.1.0 --dsh-version 0.2.1-rc.3 --accept-risk
pnpm dsh plugin --profile web version-exemptions   # see what's been granted
```

It applies to that exact plugin version on that exact DSH version and nothing else, and it is genuinely risky: incompatible pairs can crash DSH or corrupt data. Grant it only when you mean it.

One more safety net: at startup DSH checks every profile plugin's declared requirements and *disables* rows that don't match, printing the reason to stderr. A mismatch degrades, it doesn't take the whole app down.

### Updating from the command line

```bash
pnpm dsh plugin --profile web add "dsh-code-intelligence@<version>"   # quote it, <version> is a placeholder
```

`dsh plugin` forwards its arguments straight to pnpm in the profile directory, so naming a specific newer version is how you upgrade. Same compatibility refusal applies. What you don't get on this path is the automatic rollback and the progress panel — the Web UI is the nicer road.

## Usage

### `ast_grep`

```js
// TypeScript: find calls of greet(...) in one file
ast_grep({ pattern: 'greet($$$)', path: 'src/consumer.ts' })

// A whole directory needs an explicit language
ast_grep({ pattern: 'function $F($$$) { $$$ }', path: 'src', lang: 'typescript' })

// Python, with a return annotation
ast_grep({ pattern: 'def $F($$$) -> $T: $$$', path: 'src', lang: 'python' })

// Kotlin typed functions must carry the return type in the pattern
ast_grep({ pattern: 'fun $F($$$): $T { $$$ }', path: 'src', lang: 'kotlin' })
```

Arguments are just `pattern`, `path`, `lang`. There is no rewrite option and no way to ask for one.

Language inference: for a single file the extension decides (`.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`/`.mts`/`.cts`, `.py`/`.pyi`, `.rs`, `.go`, `.java`, `.kt`/`.kts`, `.json`, `.yaml`/`.yml`, `.html`, `.css`). Anything unrecognised falls back to JavaScript — so if you're searching a directory, or a language that isn't in that list, pass `lang` explicitly. For a directory the default is JavaScript.

But language *coverage* is broader than that inference table: `lang` is handed to ast-grep, so any language ast-grep itself supports works — just name it.

Paths must stay inside the workspace, relative, no absolute paths. Matching goes through DSH's subprocess service as an argv vector, never through a shell. Output is capped at 120,000 bytes on stdout and 16,000 on stderr; if stdout would overflow, the call **fails loudly** and tells you to narrow the query rather than returning half-parsed JSON. The tool has a 30-second timeout and forwards cancellation.

### `lsp`

```js
lsp({ operation: 'goToDefinition',  file_path: 'src/consumer.ts', line: 2, character: 18 })
lsp({ operation: 'findReferences',  file_path: 'src/source.ts',   line: 1, character: 17 })
lsp({ operation: 'hover',           file_path: 'src/consumer.ts', line: 2, character: 18 })
lsp({ operation: 'goToImplementation', file_path: 'src/service.ts', line: 3, character: 15 })
```

`line` and `character` are 1-based; `character` counts UTF-16 columns. Results depend on the project being configured well enough for the language server to understand it — an empty result usually means "the server couldn't resolve this", not "no such symbol". `goToImplementation` only has something to return when an interface or abstract declaration actually exists to implement.

TypeScript and Python are launched by Node directly — no shell, no global installs — and TypeScript is pointed at the bundled `typescript` package with the syntax-only server disabled (`useSyntaxServer: never`), because the syntax server alone returns import aliases instead of resolving to the real declaration.

## What's verified, and what isn't

We'd rather you know than find out the hard way.

**Actually exercised, on a live DSH host (2026-11-11):** `ast_grep` returns structured matches. TypeScript `goToDefinition` resolves precisely (`consumer.ts:2:24` → `source.ts:1:17`), `hover` returns `(alias) greet(name: string): string`, `findReferences` returns all three occurrences. Python via Pyright resolves `consumer.py` → `source.py:1:5`.

**Also exercised, in the isolated integration suite (14 checks):** AST search through DSH's real registration, subprocess, output schema and renderer; cross-file definition, hover and references for TypeScript, Python *and* Kotlin; the 120,000-byte output limit rejecting a genuinely oversized result; a pre-cancelled call not returning a success.

**Not dynamically verified — treat as untested:**

- `goToImplementation` (implemented, wired up, never exercised end to end).
- Windows and macOS. The code paths exist and the Kotlin fetch script knows those platforms, but nothing has been run on them.
- Cancellation and timeout *while a call is in flight* (pre-cancellation is tested).
- Kotlin's external Gradle/Maven dependency resolution and project JDK selection. The Kotlin server's own changelog claims Maven import support; **this plugin has not verified it.** The Kotlin tests use a tiny hand-made workspace with no build files.

### Kotlin in practice

Be aware of a real difference between test and reality, because it will save you an afternoon.

In the isolated integration suite Kotlin passes everything — cross-file definition, hover, references. That suite runs in a throwaway `/tmp` workspace containing only a handful of tiny hand-written source files, no build files and no unrelated clutter.

On a live host, pointed at a workspace root like `~/.dsh` (which is where session logs and other non-code files live), Kotlin **returned no results** for both `goToDefinition` and `hover`. The server spent a long time indexing: roughly 1 GB resident memory and sustained 20%+ CPU for several minutes, without settling.

Both observations are true. So the honest summary is:

- Kotlin support is **experimental / Alpha**, and **entirely optional**.
- Use it inside a **real Kotlin project directory** — one with `build.gradle.kts` or `pom.xml` — not from the root of a big directory full of unrelated files.
- Expect the first startup to spend a while indexing, using a noticeably large amount of memory.
- TypeScript and Python are the primary, best-validated paths. Kotlin works, but it wants a sensible environment.

Don't read this as "Kotlin is broken" (the integration suite proves it isn't) or as "Kotlin just works everywhere" (the live host says otherwise). It's the middle: real support, sharp edges, pick your working directory with that in mind.

## Companion skill

The plugin is a toolbox; the skill is the judgement about when to open it. `code-intelligence-workflow` teaches the agent to use `lsp`/`ast_grep` for impact analysis and post-change verification on risky edits — public APIs, renames, cross-directory refactors, batch migrations — and to *skip* them for a one-line tweak or a doc change, where the tools add nothing.

It's a single-directory skill: one folder holding a `SKILL.md`. It ships with this repository at [`skill/code-intelligence-workflow/`](skill/code-intelligence-workflow/SKILL.md) and inside the npm package. To switch it on, put that folder where DSH looks for skills — `~/.dsh/skills`, `~/.agents/skills`, or a project's `.dsh/skills` / `.agents/skills`. An npm install leaves it at `node_modules/dsh-code-intelligence/skill/code-intelligence-workflow/`; copy that folder across. The two tools work without it; the skill just makes the agent reach for them at the right moments, and skip them when they'd be noise.

## Development

```bash
pnpm run build      # index.js + lsp-config.cjs → lib/
pnpm test           # 10 unit tests, runs the real AST binary
DSH_SOURCE_DIR=/path/to/deepseek-harness pnpm run test:integration
```

`pnpm test` exercises language inference, explicit `lang`, no-match handling, workspace-relative paths, oversized-output rejection and model rendering. The integration script loads an existing DSH checkout's build, spins up its own Cordis context, and walks the real tool registration, native executor, output schema, subprocess layer, stdio LSP provider and all three language servers; it disposes of its context and temp workspace when it finishes and never starts a web server or touches a running host.

After editing, run `pnpm run build` — `lib/` is the shipped entry point and is committed on purpose, so git installs work without a build step. Keep it byte-identical to the sources.

Latest evidence, dates and remaining gaps live in [VALIDATION.md](VALIDATION.md).

## License

MIT © 2026 Jax Hu. See [LICENSE](LICENSE).
