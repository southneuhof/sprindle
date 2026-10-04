import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { editorInstallDirectoryName, isEditorInstallPath } from './state.mjs'

const editor = fileURLToPath(new URL('.', import.meta.url))
const build = spawnSync(process.execPath, [join(editor, 'build.mjs')], { encoding: 'utf8' })
if (build.status) throw new Error(build.stderr || build.stdout)
const extensions = process.env.SPRINDLE_VSCODE_EXTENSIONS_DIR || join(homedir(), '.vscode', 'extensions')
const target = join(extensions, editorInstallDirectoryName)
mkdirSync(extensions, { recursive: true })
rmSync(target, { recursive: true, force: true })
cpSync(editor, target, { recursive: true, filter: (source) => isEditorInstallPath(editor, source) })
process.stdout.write(`${target}\n`)
