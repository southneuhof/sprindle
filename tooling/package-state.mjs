import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { parse as parseJsonc } from 'jsonc-parser'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const schema = 1
const lockWaitMs = 120_000
const lockPollMs = 100
const lockName = 'build-lock'
const generatedDirectories = new Set(['dist-tooling', 'dist-types', 'node_modules', '.git', '.sprindle-package'])
const buildDependencies = ['@babel/parser', '@types/node', 'chokidar', 'drizzle-orm', 'esbuild', 'hono', 'jsonc-parser', 'typescript', 'vitest', 'zod']
const toolEntries = ['build.mjs', 'check.mjs', 'dev.mjs', 'language-server.mjs', 'package.mjs', 'package-state.mjs']
const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
const packageRootFromModule = resolve(sourceRoot)

function hash(content) {
  return createHash('sha256').update(content).digest('hex')
}

function relativePath(root, file) {
  return relative(root, file).split(sep).join('/')
}

function packageForDependency(requireFromPackage, name) {
  const packagePath = name.split('/')
  for (const searchRoot of requireFromPackage.resolve.paths(name) ?? []) {
    const manifest = join(searchRoot, ...packagePath, 'package.json')
    if (existsSync(manifest)) {
      const value = JSON.parse(readFileSync(manifest, 'utf8'))
      if (value.name === name) return { name, version: value.version }
    }
  }
  const entry = requireFromPackage.resolve(name)
  let directory = dirname(entry)
  while (directory !== dirname(directory)) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      const value = JSON.parse(readFileSync(manifest, 'utf8'))
      if (value.name === name) return { name, version: value.version }
    }
    directory = dirname(directory)
  }
  throw new Error(`Cannot resolve the installed ${name} package identity.`)
}

function dependencyForInput(file) {
  if (!file.split(sep).includes('node_modules')) return undefined
  let directory = dirname(file)
  while (directory !== dirname(directory)) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      const value = JSON.parse(readFileSync(manifest, 'utf8'))
      if (typeof value.name === 'string' && typeof value.version === 'string') return { name: value.name, version: value.version }
    }
    directory = dirname(directory)
  }
  return undefined
}

function localExtendedConfigs(file, seen = new Set()) {
  const configPath = resolve(file)
  if (seen.has(configPath)) return []
  seen.add(configPath)
  const config = parseJsonc(readFileSync(configPath, 'utf8'))
  const extended = typeof config.extends === 'string' ? [config.extends] : config.extends ?? []
  const parents = extended.filter((value) => value.startsWith('.') || value.startsWith('/')).map((value) => {
    const target = resolve(dirname(configPath), value)
    return target.endsWith('.json') ? target : `${target}.json`
  })
  return [configPath, ...parents.flatMap((parent) => localExtendedConfigs(parent, seen))]
}

function typescriptInputs(root) {
  const requireFromPackage = createRequire(join(root, 'package.json'))
  const configPath = join(root, 'tsconfig.json')
  const compiler = join(root, 'node_modules/typescript/bin/tsc')
  const result = spawnSync(process.execPath, [
    compiler,
    '-p',
    configPath,
    '--emitDeclarationOnly',
    '--declaration',
    '--noEmit',
    'false',
    '--composite',
    'false',
    '--incremental',
    'false',
    '--listFilesOnly',
  ], { cwd: root, encoding: 'utf8' })
  if (result.error) throw new Error('Cannot list Sprindle compiler inputs.', { cause: result.error })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Cannot list Sprindle compiler inputs (${result.signal ?? result.status}).`)
  const compilerFiles = result.stdout.split(/\r?\n/).filter(Boolean).map((file) => resolve(file))
  const sourceDirectory = `${resolve(root, 'src')}${sep}`
  const files = compilerFiles.filter((file) => file.startsWith(sourceDirectory))
  const dependencies = new Map(buildDependencies.map((name) => {
    const identity = packageForDependency(requireFromPackage, name)
    return [`${identity.name}@${identity.version}`, identity]
  }))
  for (const file of compilerFiles) {
    const identity = dependencyForInput(file)
    if (identity) dependencies.set(`${identity.name}@${identity.version}`, identity)
  }
  return { files, configs: localExtendedConfigs(configPath), requireFromPackage, dependencies: [...dependencies.values()] }
}

function workspaceInputs(root) {
  const workspaceRoot = resolve(root, '../..')
  return [
    join(root, 'package.json'),
    join(root, 'tsconfig.json'),
    join(workspaceRoot, 'package.json'),
    join(workspaceRoot, 'pnpm-workspace.yaml'),
    join(workspaceRoot, 'pnpm-lock.yaml'),
    join(workspaceRoot, '.npmrc'),
  ].filter((file) => existsSync(file))
}

function inputFiles(root, selectedFiles, configs) {
  return [...new Set([
    ...selectedFiles,
    ...configs,
    ...toolEntries.map((name) => join(root, 'tooling', name)),
    ...workspaceInputs(root),
  ])].sort()
}

function inputDescriptor(root, files, dependencyIdentities) {
  const inputs = files.map((file) => {
    if (!existsSync(file)) throw new Error(`Sprindle package input is missing: ${relativePath(root, file)}`)
    return { path: relativePath(root, file), sha256: hash(readFileSync(file)) }
  })
  const dependencies = [...dependencyIdentities].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0)
  const runtime = {
    node: process.version,
    nodeModules: process.versions.modules,
    platform: process.platform,
    architecture: process.arch,
  }
  const fingerprint = hash(JSON.stringify({ schema, inputs, dependencies, runtime }))
  return { inputs, dependencies, runtime, fingerprint }
}

export function packageInputState(root = packageRootFromModule) {
  const packageRoot = resolve(root)
  const selected = typescriptInputs(packageRoot)
  const files = inputFiles(packageRoot, selected.files, selected.configs)
  const state = inputDescriptor(packageRoot, files, selected.dependencies)
  const watchPaths = [...new Set([
    join(packageRoot, 'src'),
    join(packageRoot, 'tooling'),
    ...selected.configs,
    ...workspaceInputs(packageRoot),
  ])]
  return { ...state, watchPaths }
}

function outputFiles(directory) {
  if (!existsSync(directory)) return undefined
  const files = []
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Sprindle output contains a symbolic link: ${file}`)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile()) files.push(file)
      else throw new Error(`Sprindle output contains an unsupported file: ${file}`)
    }
  }
  visit(directory)
  return files
}

function outputDescriptor(toolingDirectory, typesDirectory, excludeReceipt = false) {
  const toolingFiles = outputFiles(toolingDirectory)
  const typeFiles = outputFiles(typesDirectory)
  if (!toolingFiles || !typeFiles) throw new Error('Sprindle package output directory is missing.')
  const describe = (directory, files, name) => files
    .filter((file) => !(excludeReceipt && file === join(toolingDirectory, 'package-state.json')))
    .map((file) => ({
      path: `${name}/${relativePath(directory, file)}`,
      sha256: hash(readFileSync(file)),
      mode: statSync(file).mode & 0o777,
    }))
  return [...describe(toolingDirectory, toolingFiles, 'dist-tooling'), ...describe(typesDirectory, typeFiles, 'dist-types')].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

export function packageIsCurrent(root = packageRootFromModule, inputState = packageInputState(root)) {
  const packageRoot = resolve(root)
  const receiptPath = join(packageRoot, 'dist-tooling/package-state.json')
  if (!existsSync(receiptPath)) return false
  let receipt
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  } catch {
    return false
  }
  if (
    receipt.schema !== schema ||
    receipt.fingerprint !== inputState.fingerprint ||
    JSON.stringify(receipt.inputs) !== JSON.stringify(inputState.inputs) ||
    JSON.stringify(receipt.dependencies) !== JSON.stringify(inputState.dependencies) ||
    JSON.stringify(receipt.runtime) !== JSON.stringify(inputState.runtime) ||
    !Array.isArray(receipt.outputs)
  ) return false
  try {
    const actual = outputDescriptor(join(packageRoot, 'dist-tooling'), join(packageRoot, 'dist-types'), true)
    return JSON.stringify(actual) === JSON.stringify(receipt.outputs)
  } catch {
    return false
  }
}

export function writeReceipt(stageTooling, stageTypes, inputState) {
  const outputs = outputDescriptor(stageTooling, stageTypes)
  const receipt = {
    schema,
    fingerprint: inputState.fingerprint,
    inputs: inputState.inputs,
    dependencies: inputState.dependencies,
    runtime: inputState.runtime,
    outputs,
  }
  writeFileSync(join(stageTooling, 'package-state.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}

function lockOwner(lockDirectory) {
  try {
    const owner = JSON.parse(readFileSync(join(lockDirectory, 'owner.json'), 'utf8'))
    if (owner.schema !== schema || !Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string' || typeof owner.root !== 'string') return undefined
    return owner
  } catch {
    return undefined
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

function removeAbandonedLock(lockDirectory, root) {
  const owner = lockOwner(lockDirectory)
  if (!owner || resolve(owner.root) !== root || processIsAlive(owner.pid)) return false
  const recoveryDirectory = join(lockDirectory, 'recovery')
  try {
    mkdirSync(recoveryDirectory)
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
  const current = lockOwner(lockDirectory)
  if (!current || current.token !== owner.token || current.pid !== owner.pid || processIsAlive(current.pid)) {
    rmSync(recoveryDirectory, { recursive: true, force: true })
    return false
  }
  const entries = readdirSync(lockDirectory).sort()
  if (entries.some((entry) => !['owner.json', 'recovery'].includes(entry))) {
    rmSync(recoveryDirectory, { recursive: true, force: true })
    throw new Error(`Cannot recover the abandoned Sprindle package lock because it contains unexpected files: ${lockDirectory}.`)
  }
  rmSync(lockDirectory, { recursive: true, force: true })
  return true
}

export async function acquirePackageLock(root) {
  const packageRoot = resolve(root)
  const metadataDirectory = join(packageRoot, '.sprindle-package')
  const lockDirectory = join(metadataDirectory, lockName)
  mkdirSync(metadataDirectory, { recursive: true })
  const started = Date.now()
  const token = randomUUID()
  while (Date.now() - started < lockWaitMs) {
    try {
      mkdirSync(lockDirectory)
      try {
        writeFileSync(join(lockDirectory, 'owner.json'), `${JSON.stringify({ schema, pid: process.pid, root: packageRoot, token, startedAt: Date.now() })}\n`, { flag: 'wx' })
      } catch (error) {
        rmSync(lockDirectory, { recursive: true, force: true })
        throw error
      }
      return () => {
        const owner = lockOwner(lockDirectory)
        if (owner?.token === token && owner.pid === process.pid) rmSync(lockDirectory, { recursive: true, force: true })
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (removeAbandonedLock(lockDirectory, packageRoot)) continue
      const remaining = lockWaitMs - (Date.now() - started)
      if (remaining <= 0) break
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(lockPollMs, remaining)))
    }
  }
  throw new Error(`Timed out after 120 seconds waiting for the Sprindle package lock at ${lockDirectory}.`)
}

export function isGeneratedPackagePath(root, path) {
  const packageRoot = resolve(root)
  const relativeToRoot = relative(packageRoot, resolve(path))
  if (!relativeToRoot || relativeToRoot.startsWith(`..${sep}`) || relativeToRoot === '..') return false
  return relativeToRoot.split(sep).some((part) => generatedDirectories.has(part))
}
