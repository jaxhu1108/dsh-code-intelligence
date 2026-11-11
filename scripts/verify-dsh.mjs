import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as AstTool from '../lib/index.js'
import lspConfig from '../lib/lsp-config.cjs'

// Uses built packages from an existing DSH checkout, without starting a host.
// Point DSH_SOURCE_DIR at your checkout when it is not in one of the usual places.
const CANDIDATE_CHECKOUTS = [
  process.env.DSH_SOURCE_DIR,
  '/vol1/pi/deepseek-harness',
  join(homedir(), 'deepseek-harness'),
  join(homedir(), 'src', 'deepseek-harness'),
].filter(Boolean)
const checkout = CANDIDATE_CHECKOUTS.find(candidate => existsSync(join(candidate, 'packages', 'lsp', 'tool-lsp', 'package.json')))
if (checkout === undefined) {
  console.error('test:integration needs a DSH checkout with built packages.')
  console.error('Set DSH_SOURCE_DIR to one, for example:')
  console.error('  DSH_SOURCE_DIR=/path/to/deepseek-harness pnpm run test:integration')
  console.error('Tried: ' + CANDIDATE_CHECKOUTS.join(', '))
  process.exit(1)
}
const requireDsh = createRequire(join(resolve(checkout), 'packages/lsp/tool-lsp/package.json'))
const load = name => import(pathToFileURL(requireDsh.resolve(name)).href)
const [cordis, systemPrompt, runtime, executor, filesystem, subprocess, lsp, stdio, toolLsp, timeout, testkit, agentTestkit] = await Promise.all([
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-tool-executor-native', '@deepseek-ai/dsh-fs-local', '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-lsp', '@deepseek-ai/dsh-lsp-stdio', '@deepseek-ai/dsh-tool-lsp',
  '@deepseek-ai/dsh-tool-call-timeout-policy', '@deepseek-ai/dsh-tool-testkit', '@deepseek-ai/dsh-agent-loop-testkit',
].map(load))

const workspace = await mkdtemp(join(tmpdir(), 'dsh-code-intelligence-integration-'))
const ctx = new cordis.Context()
const source = 'export function greet(name: string): string { return name }\n'
const consumer = "import { greet } from './source'\nconst message = greet('Jax')\n"
const pythonSource = 'def greet(name: str) -> str:\n    return name\n'
const pythonConsumer = 'from source import greet\nresult = greet("Jax")\n'
const kotlinSource = 'fun greet(name: String): String { return name }\n'
let sequence = 0
const agent = { session: { header: { cwd: workspace } } }
const signal = AbortSignal.timeout(180_000)
async function call(name, args, callSignal = signal) {
  const result = await testkit.executeToolFixture(ctx, {
    signal: callSignal, callId: 'verify-' + (++sequence), name, arguments: args, agent,
  })
  assert.equal(result.isError, false, JSON.stringify(result))
  return result
}

try {
  await writeFile(join(workspace, 'source.ts'), source)
  await writeFile(join(workspace, 'consumer.ts'), consumer)
  await writeFile(join(workspace, 'source.py'), pythonSource)
  await writeFile(join(workspace, 'consumer.py'), pythonConsumer)
  await writeFile(join(workspace, 'source.kt'), kotlinSource)
  await writeFile(join(workspace, 'consumer.kt'), 'val message = greet("Jax")\n')
  await writeFile(join(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'commonjs' }, include: ['*.ts'] }))
  agentTestkit.provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(systemPrompt.default)
  await ctx.plugin(runtime.default)
  await ctx.plugin(executor)
  await ctx.plugin(filesystem.default, { cwd: workspace })
  await ctx.plugin(subprocess.default)
  await ctx.plugin(lsp.default)
  await ctx.plugin(stdio, lspConfig)
  await ctx.plugin(timeout)
  await ctx.plugin(toolLsp)
  await ctx.plugin(AstTool)

  const ast = await call('ast_grep', { pattern: 'greet($$$)', path: 'consumer.ts' })
  assert.ok(ast.value, 'executor should expose canonical AST value')
  const matches = JSON.parse(ast.value.stdout)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].text, "greet('Jax')")
  assert.ok(ast.content[0].text.includes("greet('Jax')"))
  console.log('PASS AST query through DSH registration, subprocess, output schema and renderer')

  const definition = await call('lsp', { operation: 'goToDefinition', file_path: 'consumer.ts', line: 2, character: 18 })
  assert.ok(definition.content.some(block => block.text?.includes('source.ts:1:17')), JSON.stringify(definition))
  console.log('PASS TypeScript cross-file definition: consumer.ts:2:18 -> source.ts:1:17')

  const hover = await call('lsp', { operation: 'hover', file_path: 'consumer.ts', line: 2, character: 18 })
  assert.match(JSON.stringify(hover.content), /greet.*name: string/)
  console.log('PASS TypeScript hover returns function signature')

  const references = await call('lsp', { operation: 'findReferences', file_path: 'source.ts', line: 1, character: 18 })
  assert.ok(references.content.some(block => block.text?.includes('consumer.ts:2:17')), JSON.stringify(references))
  console.log('PASS TypeScript references include cross-file call')

  const pythonAst = await call('ast_grep', { pattern: 'def $F($$$) -> $T: $$$', path: 'source.py' })
  assert.equal(JSON.parse(pythonAst.value.stdout).length, 1)
  assert.equal(JSON.parse(pythonAst.value.stdout)[0].language, 'Python')
  console.log('PASS Python AST query with extension-based grammar selection')

  const kotlinAst = await call('ast_grep', { pattern: 'fun $F($$$): $T { $$$ }', path: 'source.kt' })
  assert.equal(JSON.parse(kotlinAst.value.stdout).length, 1)
  assert.equal(JSON.parse(kotlinAst.value.stdout)[0].language, 'Kotlin')
  console.log('PASS Kotlin AST query includes typed function declaration')

  const pythonDefinition = await call('lsp', { operation: 'goToDefinition', file_path: 'consumer.py', line: 2, character: 12 })
  assert.ok(pythonDefinition.content.some(block => block.text?.includes('source.py:1:5')), JSON.stringify(pythonDefinition))
  console.log('PASS Pyright cross-file definition: consumer.py:2:12 -> source.py:1:5')

  const pythonHover = await call('lsp', { operation: 'hover', file_path: 'consumer.py', line: 2, character: 12 })
  assert.match(JSON.stringify(pythonHover.content), /greet.*name: str/)
  console.log('PASS Pyright hover returns a typed Python signature')

  const pythonReferences = await call('lsp', { operation: 'findReferences', file_path: 'source.py', line: 1, character: 6 })
  assert.ok(pythonReferences.content.some(block => block.text?.includes('consumer.py:2:10')), JSON.stringify(pythonReferences))
  console.log('PASS Pyright references include the cross-file Python call')

  if (lspConfig.servers.kotlin) {
    const kotlinDefinition = await call('lsp', { operation: 'goToDefinition', file_path: 'consumer.kt', line: 1, character: 16 })
    assert.ok(kotlinDefinition.content.some(block => block.text?.includes('source.kt:1:5')), JSON.stringify(kotlinDefinition))
    console.log('PASS Kotlin cross-file definition: consumer.kt:1:16 -> source.kt:1:5')

    const kotlinHover = await call('lsp', { operation: 'hover', file_path: 'consumer.kt', line: 1, character: 16 })
    assert.match(JSON.stringify(kotlinHover.content), /greet/)
    assert.match(JSON.stringify(kotlinHover.content), /String/)
    console.log('PASS Kotlin hover returns a typed function signature')

    const kotlinReferences = await call('lsp', { operation: 'findReferences', file_path: 'source.kt', line: 1, character: 6 })
    assert.ok(kotlinReferences.content.some(block => block.text?.includes('consumer.kt:1:15')), JSON.stringify(kotlinReferences))
    console.log('PASS Kotlin references include the cross-file call')
  } else {
    console.log('SKIP Kotlin LSP: install the runtime with pnpm run fetch-kotlin')
  }

  await writeFile(join(workspace, 'large.js'), Array.from({ length: 2000 }, (_, i) => 'console.log(' + i + ')').join('\n'))
  const overflow = await testkit.executeToolFixture(ctx, { signal, callId: 'overflow', name: 'ast_grep', arguments: { pattern: 'console.log($$$)', path: 'large.js' }, agent })
  assert.equal(overflow.isError, true)
  assert.match(JSON.stringify(overflow), /output exceeded/)
  console.log('PASS actual bounded subprocess output rejects incomplete JSON')

  const aborted = new AbortController()
  aborted.abort(new Error('integration cancellation'))
  const cancelled = await testkit.executeToolFixture(ctx, { signal: aborted.signal, callId: 'cancelled', name: 'ast_grep', arguments: { pattern: 'x' }, agent })
  assert.equal(cancelled.isError, true)
  console.log('PASS cancelled tool invocation does not execute a successful query')
} finally {
  await ctx.fiber.dispose()
  await rm(workspace, { recursive: true, force: true })
}
console.log('All DSH integration checks passed; existing web host was untouched.')
