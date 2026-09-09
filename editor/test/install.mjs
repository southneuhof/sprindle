import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = mkdtempSync(join(tmpdir(), 'sprindle-editor-install-'))
try {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../install.mjs', import.meta.url))], { env: { ...process.env, SPRINDLE_VSCODE_EXTENSIONS_DIR: root }, encoding: 'utf8' })
  if (result.status) throw new Error(result.stderr || result.stdout)
  const installed = join(root, 'southneuhof.sprindle-language-0.0.0')
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  if (manifest.main !== './extension.cjs') throw new Error('Installed extension manifest is invalid.')
  if (!existsSync(join(installed, 'extension.cjs')) || !existsSync(join(installed, 'dist', 'language-server.mjs'))) throw new Error('Installed extension files are incomplete.')
  process.stdout.write(`${installed}\n`)
} finally { rmSync(root, { recursive: true, force: true }) }
