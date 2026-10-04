import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { acquirePackageLock, packageInputState, packageIsCurrent, writeReceipt } from './package-state.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'dist-tooling')
const types = join(root, 'dist-types')
let interrupted

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = signal
})

function throwIfInterrupted() {
  if (interrupted) throw new Error(`Sprindle package preparation was interrupted by ${interrupted}.`)
}

function relocateSourceMaps(stageTooling, stageRoot = stageTooling) {
  for (const file of readdirSync(stageTooling, { withFileTypes: true })) {
    if (file.isDirectory()) relocateSourceMaps(join(stageTooling, file.name), stageRoot)
    else if (file.name.endsWith('.js.map')) {
      const stagedMap = join(stageTooling, file.name)
      const finalMap = join(output, relative(stageRoot, stagedMap))
      const map = JSON.parse(readFileSync(stagedMap, 'utf8'))
      map.sources = map.sources.map((source) => {
        const sourcePath = resolve(dirname(stagedMap), map.sourceRoot ?? '', source)
        return relative(dirname(finalMap), sourcePath).split(sep).join('/')
      })
      delete map.sourceRoot
      writeFileSync(stagedMap, `${JSON.stringify(map)}\n`)
    }
  }
}

function publish(stage, backup) {
  const stagedTypes = join(stage, 'dist-types')
  const stagedTooling = join(stage, 'dist-tooling')
  const backupTypes = join(backup, 'dist-types')
  const backupTooling = join(backup, 'dist-tooling')
  const movedPrevious = []
  const movedCurrent = []
  mkdirSync(backup)
  try {
    if (existsSync(output)) {
      renameSync(output, backupTooling)
      movedPrevious.push([backupTooling, output])
    }
    if (existsSync(types)) {
      renameSync(types, backupTypes)
      movedPrevious.push([backupTypes, types])
    }
    renameSync(stagedTypes, types)
    movedCurrent.push(types)
    renameSync(stagedTooling, output)
    movedCurrent.push(output)
    const after = packageInputState(root)
    if (!packageIsCurrent(root, after)) throw new Error('Sprindle inputs changed during output publication.')
  } catch (error) {
    const recoveryErrors = []
    for (const current of movedCurrent.reverse()) {
      try {
        rmSync(current, { recursive: true, force: true })
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError)
      }
    }
    for (const [source, target] of movedPrevious.reverse()) {
      try {
        if (existsSync(source)) renameSync(source, target)
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError)
      }
    }
    if (recoveryErrors.length) {
      const failure = new AggregateError([error, ...recoveryErrors], `Sprindle output recovery failed. Previous outputs remain under ${backup}.`)
      failure.preserveBackup = true
      throw failure
    }
    throw error
  }
  rmSync(backup, { recursive: true, force: true })
}

async function prepare() {
  const release = await acquirePackageLock(root)
  const stage = join(root, '.sprindle-package', `stage-${process.pid}-${randomUUID()}`)
  const backup = join(root, '.sprindle-package', `backup-${process.pid}-${randomUUID()}`)
  let preserveBackup = false
  try {
    const inputs = packageInputState(root)
    throwIfInterrupted()
    if (packageIsCurrent(root, inputs)) return

    const stageTypes = join(stage, 'dist-types')
    const stageTooling = join(stage, 'dist-tooling')
    mkdirSync(stageTypes, { recursive: true })
    mkdirSync(stageTooling, { recursive: true })

    const declarations = spawnSync(process.execPath, [
      join(root, 'node_modules/typescript/bin/tsc'),
      '-p',
      join(root, 'tsconfig.json'),
      '--emitDeclarationOnly',
      '--declaration',
      '--noEmit',
      'false',
      '--composite',
      'false',
      '--incremental',
      'false',
      '--outDir',
      stageTypes,
      '--singleThreaded',
    ], { cwd: root, encoding: 'utf8' })
    if (declarations.error) throw new Error('TypeScript declaration build could not start.', { cause: declarations.error })
    if (declarations.status !== 0) throw new Error(declarations.stderr || declarations.stdout || `TypeScript declaration build failed with ${declarations.signal ?? declarations.status}.`)
    throwIfInterrupted()

    const entries = {
      build: join(root, 'tooling/build.mjs'),
      check: join(root, 'tooling/check.mjs'),
      dev: join(root, 'tooling/dev.mjs'),
      'language-server': join(root, 'tooling/language-server.mjs'),
      index: join(root, 'src/tooling/index.ts'),
    }
    await build({
      absWorkingDir: root,
      entryPoints: entries,
      outdir: stageTooling,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      sourcemap: true,
      sourcesContent: true,
      external: ['typescript/unstable/sync', 'esbuild', 'jsonc-parser', 'chokidar'],
    })
    throwIfInterrupted()
    for (const name of ['build.js', 'check.js', 'dev.js', 'language-server.js']) chmodSync(join(stageTooling, name), 0o755)
    relocateSourceMaps(stageTooling)

    const afterBuild = packageInputState(root)
    if (afterBuild.fingerprint !== inputs.fingerprint) throw new Error('Sprindle inputs changed during the package build. Run preparation again after the edit is complete.')
    throwIfInterrupted()
    writeReceipt(stageTooling, stageTypes, inputs)
    publish(stage, backup)
  } catch (error) {
    preserveBackup = error?.preserveBackup === true
    throw error
  } finally {
    rmSync(stage, { recursive: true, force: true })
    if (!preserveBackup) rmSync(backup, { recursive: true, force: true })
    release()
  }
}

prepare().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
