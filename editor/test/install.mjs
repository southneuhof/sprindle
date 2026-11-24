import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = mkdtempSync(join(tmpdir(), 'sprindle-editor-install-'))
const declarationDirectory = fileURLToPath(new URL('../dist-types', import.meta.url))
const staleDeclaration = `${basename(root)}.d.ts`
const stalePath = join(declarationDirectory, staleDeclaration)
try {
  mkdirSync(declarationDirectory, { recursive: true })
  writeFileSync(stalePath, 'export declare const removed: true\n', { flag: 'wx' })
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../install.mjs', import.meta.url))], { env: { ...process.env, SPRINDLE_VSCODE_EXTENSIONS_DIR: root }, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Editor installer exited with ${result.signal ?? result.status}.`)
  const installed = join(root, 'southneuhof.sprindle-language-0.0.0')
  if (existsSync(join(installed, 'dist-types', staleDeclaration))) throw new Error('The editor installer copied an obsolete declaration.')
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  if (manifest.main !== './extension.cjs') throw new Error('Installed extension manifest is invalid.')
  if (!existsSync(join(installed, 'extension.cjs')) || !existsSync(join(installed, 'dist', 'language-server.mjs'))) throw new Error('Installed extension files are incomplete.')
  const receipt = JSON.parse(readFileSync(join(installed, 'dist/editor-state.json'), 'utf8'))
  if (receipt.schema !== 2 || typeof receipt.inputs?.fingerprint !== 'string' || !Array.isArray(receipt.payloads)) throw new Error('Installed editor state receipt is invalid.')
  for (const path of ['extension.cjs', 'dist/language-server.mjs', 'dist-types/index.d.ts', 'dist-types/routes/definition.d.ts']) {
    if (!receipt.payloads.some((payload) => payload.path === path)) throw new Error(`Installed editor receipt does not include ${path}.`)
  }
  process.stdout.write(`${installed}\n`)
} finally {
  rmSync(stalePath, { force: true })
  rmSync(root, { recursive: true, force: true })
}
