import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageInputState } from '../tooling/package-state.mjs'

const schema = 2
const editorRootFromModule = dirname(fileURLToPath(import.meta.url))
export const editorInstallDirectoryName = 'southneuhof.sprindle-language-0.0.0'

function hash(content) {
  return createHash('sha256').update(content).digest('hex')
}

function relativePath(root, file) {
  return relative(root, file).split(sep).join('/')
}

function readPackageIdentity(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') throw new Error('A copied editor dependency has an invalid package identity.')
  return { name: manifest.name, version: manifest.version }
}

export function editorDependencies(editorRoot = editorRootFromModule) {
  const resolvedEditorRoot = resolve(editorRoot)
  const packageRoot = resolve(resolvedEditorRoot, '..')
  const platformName = `typescript-${process.platform}-${process.arch}`
  const store = resolve(resolvedEditorRoot, '../../../node_modules/.pnpm')
  const nativePrefix = `@typescript+${platformName}@`
  const nativeEntry = readdirSync(store).find((entry) => entry.startsWith(nativePrefix))
  if (!nativeEntry) throw new Error(`Missing @typescript/${platformName}.`)
  const sources = [
    ['typescript', realpathSync(join(packageRoot, 'node_modules/typescript'))],
    [`@typescript/${platformName}`, realpathSync(join(store, nativeEntry, `node_modules/@typescript/${platformName}`))],
    ['@babel/parser', realpathSync(join(packageRoot, 'node_modules/@babel/parser'))],
    ...['hono', 'zod', 'jsonc-parser'].map((name) => [name, realpathSync(join(packageRoot, 'node_modules', name))]),
  ]
  return sources.map(([name, source]) => ({
    name,
    source,
    identity: { ...readPackageIdentity(source), resolved: relativePath(packageRoot, source) },
  }))
}

export function editorInputState(editorRoot = editorRootFromModule, currentPackageInputState) {
  const resolvedEditorRoot = resolve(editorRoot)
  const packageRoot = resolve(resolvedEditorRoot, '..')
  const packageState = currentPackageInputState ?? packageInputState(packageRoot)
  const editorInputs = ['build.mjs', 'extension.cjs', 'package.json', 'state.mjs'].map((name) => {
    const file = join(resolvedEditorRoot, name)
    return { path: `editor/${name}`, sha256: hash(readFileSync(file)) }
  })
  const dependencies = editorDependencies(resolvedEditorRoot)
    .map(({ identity }) => identity)
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : left.version < right.version ? -1 : left.version > right.version ? 1 : left.resolved < right.resolved ? -1 : left.resolved > right.resolved ? 1 : 0)
  const fingerprint = hash(JSON.stringify({ schema, packageFingerprint: packageState.fingerprint, editorInputs, dependencies }))
  return { fingerprint, packageFingerprint: packageState.fingerprint, editorInputs, dependencies }
}

export function isEditorInstallPath(editorRoot, file) {
  const path = relativePath(resolve(editorRoot), resolve(file))
  const parts = path.split('/')
  const name = parts.at(-1)
  return !parts.includes('test') && !['build.mjs', 'install.mjs', 'state.mjs', '.DS_Store'].includes(name)
}

function editorPayloads(editorRoot) {
  const root = resolve(editorRoot)
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const file = join(directory, entry.name)
      if (!isEditorInstallPath(root, file) || relativePath(root, file) === 'dist/editor-state.json') continue
      if (entry.isSymbolicLink()) throw new Error('Editor output contains a symbolic link.')
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile()) files.push({ path: relativePath(root, file), sha256: hash(readFileSync(file)), mode: statSync(file).mode & 0o777 })
      else throw new Error('Editor output contains an unsupported file.')
    }
  }
  visit(root)
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

function requiredEditorPayloads(editorRoot) {
  const platformName = `typescript-${process.platform}-${process.arch}`
  const required = [
    'package.json',
    'extension.cjs',
    'dist/language-server.mjs',
    'dist-types/index.d.ts',
    'routes/definition.ts',
    'node_modules/typescript/bin/tsc',
    'node_modules/typescript/lib/version.cjs',
    `node_modules/@typescript/${platformName}/package.json`,
    'node_modules/@babel/parser/package.json',
    'node_modules/hono/package.json',
    'node_modules/zod/package.json',
    'node_modules/jsonc-parser/package.json',
    'node_modules/@southneuhof/sprindle/package.json',
    'node_modules/@southneuhof/sprindle/dist-types/index.d.ts',
  ]
  for (const path of required) {
    if (!existsSync(join(editorRoot, path)) || !statSync(join(editorRoot, path)).isFile()) throw new Error(`Editor output is incomplete: ${path}.`)
  }
}

function inputMatches(left, right) {
  return left.fingerprint === right.fingerprint &&
    left.packageFingerprint === right.packageFingerprint &&
    JSON.stringify(left.editorInputs) === JSON.stringify(right.editorInputs) &&
    JSON.stringify(left.dependencies) === JSON.stringify(right.dependencies)
}

export function writeEditorReceipt(editorRoot, before) {
  const after = editorInputState(editorRoot)
  if (!inputMatches(before, after)) throw new Error('Editor inputs changed during the build.')
  requiredEditorPayloads(editorRoot)
  const receipt = { schema, inputs: before, payloads: editorPayloads(editorRoot) }
  const output = join(editorRoot, 'dist/editor-state.json')
  const temporary = `${output}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`)
  renameSync(temporary, output)
}

function allowedDiagnostic(error) {
  if (['EACCES', 'EPERM', 'EISDIR', 'ENOTDIR', 'ELOOP'].includes(error?.code)) return error.code
  return 'comparison failed'
}

export function editorCheckMessage(result) {
  if (result.status === 'stale') return 'The installed Sprindle VS Code extension is out of date or incomplete. Run pnpm setup:editor.'
  if (result.status === 'unverifiable') return `Could not verify the installed Sprindle VS Code extension (${result.diagnostic}). Run pnpm setup:editor.`
  return undefined
}

export function checkEditorInstallation(editorRoot, extensionsRoot, inputStateFactory = () => editorInputState(editorRoot)) {
  const installation = join(extensionsRoot, editorInstallDirectoryName)
  let info
  try {
    info = lstatSync(installation)
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'absent' }
    return { status: 'unverifiable', diagnostic: allowedDiagnostic(error) }
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return { status: 'stale' }
  try {
    const expected = inputStateFactory()
    const receiptPath = join(installation, 'dist/editor-state.json')
    const receiptInfo = lstatSync(receiptPath)
    if (!receiptInfo.isFile() || receiptInfo.size > 1_000_000) return { status: 'stale', fingerprint: expected.fingerprint }
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    if (receipt?.schema !== schema || !receipt.inputs || !Array.isArray(receipt.payloads) || !inputMatches(receipt.inputs, expected)) return { status: 'stale', fingerprint: expected.fingerprint }
    const actualPayloads = editorPayloads(installation)
    if (JSON.stringify(receipt.payloads) !== JSON.stringify(actualPayloads)) return { status: 'stale', fingerprint: expected.fingerprint }
    return { status: 'current', fingerprint: expected.fingerprint }
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'stale' }
    return { status: 'unverifiable', diagnostic: allowedDiagnostic(error) }
  }
}
