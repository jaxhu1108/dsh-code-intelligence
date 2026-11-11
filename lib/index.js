import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const require = createRequire(import.meta.url)
const AST_GREP = join(dirname(require.resolve('@ast-grep/cli/package.json')), process.platform === 'win32' ? 'ast-grep.exe' : 'ast-grep')
const MAX_STDOUT_BYTES = 120000
const MAX_STDERR_BYTES = 16000
const GRACE_MS = 2000
const TIMEOUT_MS = 30000

export const name = 'dsh-code-intelligence'
export const inject = ['tools', 'subprocess', 'workingDirectory']

const LANGUAGE_BY_EXTENSION = new Map([
  ['.ts', 'typescript'], ['.tsx', 'tsx'], ['.js', 'javascript'], ['.jsx', 'javascript'],
  ['.mjs', 'javascript'], ['.cjs', 'javascript'], ['.mts', 'typescript'], ['.cts', 'typescript'],
  ['.py', 'python'], ['.pyi', 'python'], ['.rs', 'rust'], ['.go', 'go'], ['.java', 'java'], ['.kt', 'kotlin'], ['.kts', 'kotlin'],
  ['.json', 'json'], ['.yaml', 'yaml'], ['.yml', 'yaml'], ['.html', 'html'], ['.css', 'css'],
])

function inferLanguage(target) {
  return LANGUAGE_BY_EXTENSION.get(extname(target).toLowerCase()) ?? 'javascript'
}

function nonEmptyString(name, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('ast_grep: ' + name + ' must be a non-empty string')
  }
  if (value.includes('\0')) throw new Error('ast_grep: ' + name + ' contains a NUL byte')
  return value
}

function validateArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('ast_grep: arguments must be an object')
  }
  nonEmptyString('pattern', args.pattern)
  if (args.path !== undefined) nonEmptyString('path', args.path)
  if (args.lang !== undefined) nonEmptyString('lang', args.lang)
}

function present(_args, value) {
  const body = value.stdout.trim() || '(no matches)'
  const stderr = value.stderr.trim()
  return [{
    type: 'text',
    text: 'ast-grep [' + value.language + '] ' + value.path + '\n' + body + (stderr ? '\n[stderr] ' + stderr : ''),
  }]
}

export function apply(ctx) {
  ctx.tools.register({
    name: 'ast_grep',
    description: 'Read-only structural code search powered by ast-grep. Use patterns such as console.log($$$), def $NAME($$$): $$$, or fun $NAME($$$): $TYPE { $$$ }. Kotlin declarations with return types must include the return type in the pattern. It never rewrites files.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: { type: 'string', description: 'ast-grep pattern, for example console.log($$$)' },
        path: { type: 'string', description: 'workspace-relative file or directory; defaults to .' },
        lang: { type: 'string', description: 'Explicit ast-grep language (for example typescript, javascript, python, kotlin). For a single source file, omit to use its extension; for a directory, omit for JavaScript or pass lang for another language.' },
      },
      required: ['pattern'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          language: { type: 'string' },
          exitCode: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
        },
        required: ['path', 'language', 'exitCode', 'stdout', 'stderr'],
      },
      render: present,
    },
    timeoutMs: TIMEOUT_MS,
    async execute(args, exec) {
      validateArgs(args)
      const pattern = args.pattern
      const targetInput = args.path ?? '.'
      const language = args.lang ?? inferLanguage(targetInput)
      exec.signal.throwIfAborted()
      const workdir = exec.agent === undefined
        ? process.cwd()
        : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      if (isAbsolute(targetInput)) throw new Error('ast_grep: path must be workspace-relative')
      const target = resolve(workdir, targetInput)
      const workspaceRelative = relative(workdir, target)
      if (workspaceRelative === '..' || workspaceRelative.startsWith('..' + sep)) {
        throw new Error('ast_grep: path must stay within the workspace')
      }
      const argv = [AST_GREP, 'run', '--pattern', pattern, '--json=compact', '--color=never']
      argv.push('--lang', language)
      argv.push('--', target)
      let handle
      try {
        handle = ctx.subprocess.spawn({
          argv,
          cwd: workdir,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: MAX_STDOUT_BYTES },
            stderr: { maxBytes: MAX_STDERR_BYTES },
          },
          graceMs: GRACE_MS,
          signal: exec.signal,
        })
      } catch (error) {
        if (exec.signal.aborted) throw new Error('ast_grep was cancelled', { cause: error })
        throw new Error('ast_grep could not start', { cause: error })
      }
      let outcome
      try {
        outcome = await handle.done
      } catch (error) {
        throw new Error('ast_grep subprocess failed before reporting an outcome', { cause: error })
      }
      const stdout = handle.collected.stdout?.readFrom(0)
      const stderr = handle.collected.stderr?.readFrom(0)
      if (stdout === undefined || stderr === undefined) throw new Error('ast_grep: subprocess did not collect output')
      exec.signal.throwIfAborted()
      if (outcome.signal !== null || outcome.exitCode === null) {
        throw new Error('ast_grep was killed by signal ' + (outcome.signal ?? 'unknown'))
      }
      if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
        throw new Error('ast_grep failed with exit ' + outcome.exitCode + ': ' + (stderr.text || stdout.text))
      }
      if (stdout.lossy) {
        throw new Error('ast_grep: output exceeded the ' + MAX_STDOUT_BYTES + '-byte limit. Narrow the path or pattern and retry.')
      }
      return { path: targetInput, language, exitCode: outcome.exitCode, stdout: stdout.text, stderr: stderr.text }
    },
  })
}
