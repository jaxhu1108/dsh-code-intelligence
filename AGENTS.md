# dsh-code-intelligence

- cordis.patch.yml inserts four global Host rows: the DSH LSP service, stdio provider, official model tool, and this package. Never use scope: agent-default.
- index.js and lsp-config.cjs are sources; pnpm run build copies them into lib. Keep sources and release entries identical.
- AST resolves the platform executable from @ast-grep/cli. LSP launches the language-server CLI through Node; lsp-config exports explicit tsserver.path and useSyntaxServer: never for complete semantic navigation.
- DSH owns its native LSP packages; do not add private DSH peer packages that pnpm will fetch from the public registry.
- ast_grep remains read-only, accepts workspace-relative paths, and executes an argv vector through the DSH subprocess service. Never interpolate model input into shell commands or enable rewrite options.
- Keep stdout/stderr bounded, fail on lossy stdout, and forward the tool cancellation signal.
- Never restart or kill the DSH host. A successful isolated integration run does not prove activation in the current host; test that separately and document a stale runtime honestly.

Validation: run pnpm run build, pnpm test, and DSH_SOURCE_DIR=<existing-checkout> pnpm run test:integration. The integration script creates and disposes its own Cordis Context and temporary workspace; it must not launch another web server or connect to the existing host's lifecycle controls.

Latest validation and activation status belong in VALIDATION.md.
