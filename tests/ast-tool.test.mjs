import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { apply } from '../index.js'

let workspace
let tool
let spawnSpecs
let forceLossy = false

function outputReader(stream) {
  return {
    readFrom() {
      return { text: stream.text, nextOffset: Buffer.byteLength(stream.text), lossy: stream.lossy ?? false }
    },
  }
}

function setup() {
  spawnSpecs = []
  forceLossy = false
  const ctx = {
    tools: { register(definition) { tool = definition } },
    workingDirectory: { ensure: async () => workspace },
    subprocess: {
      spawn(spec) {
        spawnSpecs.push(spec)
        const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
        const stdout = []
        const stderr = []
        child.stdout.on('data', chunk => stdout.push(chunk))
        child.stderr.on('data', chunk => stderr.push(chunk))
        const done = new Promise((resolveDone, rejectDone) => {
          child.once('error', rejectDone)
          child.once('close', (exitCode, signal) => resolveDone({ exitCode, signal }))
        })
        spec.signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true })
        return {
          done,
          collected: {
            stdout: outputReader({ get text() { return Buffer.concat(stdout).toString('utf8') }, get lossy() { return forceLossy } }),
            stderr: outputReader({ get text() { return Buffer.concat(stderr).toString('utf8') } }),
          },
        }
      },
    },
  }
  apply(ctx)
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-code-intelligence-'))
  await mkdir(join(workspace, 'src'))
  await writeFile(join(workspace, 'src', 'a.js'), 'function greet(name) { return name }\n')
  await writeFile(join(workspace, 'src', 'b.ts'), 'function greet(name: string) { return name }\n')
  await writeFile(join(workspace, 'src', 'greet.py'), 'def greet(name):\n    return name\n')
  await writeFile(join(workspace, 'src', 'Greet.kt'), 'fun greet(name: String): String { return name }\n')
  setup()
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

test('searches JavaScript in a directory when lang is omitted', async () => {
  const result = await tool.execute({ pattern: 'function greet($$$) { $$$ }', path: 'src' }, { agent: { id: 'test' }, signal: new AbortController().signal })
  const matches = JSON.parse(result.stdout)
  assert.deepEqual(new Set(matches.map(match => match.file)), new Set([join(workspace, 'src', 'a.js')]))
  assert.equal(result.language, 'javascript')
  assert.deepEqual(spawnSpecs[0].argv.slice(1, 6), ['run', '--pattern', 'function greet($$$) { $$$ }', '--json=compact', '--color=never'])
  assert.equal(spawnSpecs[0].signal instanceof AbortSignal, true)
})

test('infers TypeScript for a source file path', async () => {
  const result = await tool.execute({ pattern: 'function $F(name: string) { $$$ }', path: 'src/b.ts' }, { agent: { id: 'test' }, signal: new AbortController().signal })
  assert.equal(result.language, 'typescript')
  assert.equal(JSON.parse(result.stdout)[0].file, join(workspace, 'src', 'b.ts'))
})

test('infers Python for a source file and matches its function body', async () => {
  const result = await tool.execute({ pattern: 'def $F($$$): $$$', path: 'src/greet.py' }, { agent: { id: 'test' }, signal: new AbortController().signal })
  assert.equal(result.language, 'python')
  assert.equal(JSON.parse(result.stdout)[0].file, join(workspace, 'src', 'greet.py'))
})

test('infers Kotlin for a source file and matches typed function declarations', async () => {
  const result = await tool.execute({ pattern: 'fun $F($$$): $T { $$$ }', path: 'src/Greet.kt' }, { agent: { id: 'test' }, signal: new AbortController().signal })
  assert.equal(result.language, 'kotlin')
  assert.equal(JSON.parse(result.stdout)[0].file, join(workspace, 'src', 'Greet.kt'))
})

test('returns exit code 1 for a valid query with no matches', async () => {
  const result = await tool.execute({ pattern: 'noSuchFunction($$$)', path: 'src' }, { agent: { id: 'test' }, signal: new AbortController().signal })
  assert.equal(result.exitCode, 1)
  assert.equal(result.stdout, '[]\n')
})

test('searches Python and Kotlin explicitly in a directory', async () => {
  const python = await tool.execute({ pattern: 'def $F($$$): $$$', path: 'src', lang: 'python' }, { agent: { id: 'test' }, signal: new AbortController().signal })
  const kotlin = await tool.execute({ pattern: 'fun $F($$$): $T { $$$ }', path: 'src', lang: 'kotlin' }, { agent: { id: 'test' }, signal: new AbortController().signal })
  assert.deepEqual(JSON.parse(python.stdout).map(match => match.file), [join(workspace, 'src', 'greet.py')])
  assert.deepEqual(JSON.parse(kotlin.stdout).map(match => match.file), [join(workspace, 'src', 'Greet.kt')])
})

test('searches TypeScript when lang is explicit', async () => {
  const result = await tool.execute({ pattern: 'function $F(name: string) { $$$ }', path: 'src', lang: 'typescript' }, { agent: { id: 'test' }, signal: new AbortController().signal })
  const matches = JSON.parse(result.stdout)
  assert.deepEqual(new Set(matches.map(match => match.file)), new Set([join(workspace, 'src', 'b.ts')]))
  assert.equal(result.language, 'typescript')
})

test('rejects absolute and workspace-escaping paths', async () => {
  await assert.rejects(tool.execute({ pattern: 'x', path: resolve(workspace, 'src') }, { agent: { id: 'test' }, signal: new AbortController().signal }), /workspace-relative/)
  await assert.rejects(tool.execute({ pattern: 'x', path: '../outside' }, { agent: { id: 'test' }, signal: new AbortController().signal }), /within the workspace/)
})

test('fails rather than returning truncated search output', async () => {
  forceLossy = true
  await assert.rejects(tool.execute({ pattern: 'function greet($$$) { $$$ }', path: 'src' }, { agent: { id: 'test' }, signal: new AbortController().signal }), /output exceeded/)
})

test('renders compact structured matches for the model', async () => {
  const result = await tool.execute({ pattern: 'function greet($$$) { $$$ }', path: 'src' }, { agent: { id: 'test' }, signal: new AbortController().signal })
  const rendered = tool.output.render({ path: 'src' }, result)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /ast-grep \[javascript\] src/)
})
