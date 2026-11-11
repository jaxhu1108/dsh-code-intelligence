const { dirname, join } = require('node:path')
const { existsSync } = require('node:fs')
const { homedir } = require('node:os')

// Node launches each server directly: no shell, .bin shim, or global dependency.
const typescript = {
  command: process.execPath,
  args: [join(dirname(require.resolve('typescript-language-server/package.json')), 'lib', 'cli.mjs'), '--stdio'],
  initializationOptions: {
    tsserver: { path: require.resolve('typescript/lib/tsserver.js'), useSyntaxServer: 'never' },
  },
  extensionToLanguage: {
    '.ts': 'typescript', '.tsx': 'typescriptreact',
    '.js': 'javascript', '.jsx': 'javascriptreact',
    '.mts': 'typescript', '.cts': 'typescript',
    '.mjs': 'javascript', '.cjs': 'javascript',
  },
}

const python = {
  command: process.execPath,
  args: [require.resolve('pyright/langserver.index.js'), '--stdio'],
  extensionToLanguage: { '.py': 'python', '.pyi': 'python' },
}

const KOTLIN_VERSION = '262.2310.0'

// Resolved by path, not by require.resolve: the downloaded runtime lives outside
// this package, so nothing here may depend on module resolution reaching it.
function packageRootPath() {
  try {
    return dirname(require.resolve('dsh-code-intelligence/package.json'))
  } catch {
    // Built layout is <packageRoot>/lib/lsp-config.cjs; source layout is the root.
    const here = __dirname
    return existsSync(join(here, 'package.json')) ? here : dirname(here)
  }
}

function launcherNames() {
  // Windows runs the .cmd shim; every other platform runs the shell script.
  return process.platform === 'win32' ? ['kotlin-lsp.cmd', 'kotlin-lsp.sh'] : ['kotlin-lsp.sh']
}

function launcherIn(directory) {
  for (const name of launcherNames()) {
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function cacheRoot() {
  const configured = process.env.DSH_KOTLIN_LSP_HOME
  if (configured && configured.trim()) {
    const value = configured.trim()
    if (value === '~') return homedir()
    if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
    return value
  }
  return join(homedir(), '.dsh', 'kotlin-lsp')
}

// Lookup order, highest priority first:
//   1. DSH_KOTLIN_LSP_COMMAND  — the user points at their own installation
//   2. <packageRoot>/.runtime  — local development and the pre-existing setup
//   3. $DSH_KOTLIN_LSP_HOME    — what `pnpm run fetch-kotlin` populates
//   4. null                    — Kotlin disables itself silently, nothing else breaks
function resolveKotlinCommand() {
  const override = process.env.DSH_KOTLIN_LSP_COMMAND
  if (override && override.trim()) return override.trim()

  const local = launcherIn(join(packageRootPath(), '.runtime', `kotlin-lsp-${KOTLIN_VERSION}`))
  if (local) return local

  return launcherIn(join(cacheRoot(), `kotlin-lsp-${KOTLIN_VERSION}`))
}

const kotlinCommand = resolveKotlinCommand()
const kotlinArgs = process.env.DSH_KOTLIN_LSP_ARGS ? JSON.parse(process.env.DSH_KOTLIN_LSP_ARGS) : ['--stdio']
if (!Array.isArray(kotlinArgs) || kotlinArgs.some(arg => typeof arg !== 'string')) {
  throw new Error('DSH_KOTLIN_LSP_ARGS must be a JSON array of strings')
}
const kotlin = kotlinCommand ? {
  command: kotlinCommand,
  args: kotlinArgs,
  // Java uses passwd's stale /home path unless explicitly aligned with this host's home.
  env: { JAVA_TOOL_OPTIONS: [process.env.JAVA_TOOL_OPTIONS, '-Duser.home=' + JSON.stringify(homedir())].filter(Boolean).join(' ') },
  initializationOptions: {},
  configuration: {},
  extensionToLanguage: { '.kt': 'kotlin', '.kts': 'kotlin' },
} : null

module.exports = {
  servers: {
    typescript,
    python,
    ...(kotlin ? { kotlin } : {}),
  },
}
