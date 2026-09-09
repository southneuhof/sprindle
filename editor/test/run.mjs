import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { runTests } from '@vscode/test-electron'

const editorSource = fileURLToPath(new URL('..', import.meta.url))
const fixture = mkdtempSync(join(tmpdir(), 'sprindle-editor-'))
const profile = mkdtempSync(join(tmpdir(), 'sprindle-editor-profile-'))
const editor = mkdtempSync(join(tmpdir(), 'sprindle-editor-package-'))
try {
  for (const item of ['extension.cjs', 'package.json', 'dist', 'dist-types', 'node_modules', 'routes']) cpSync(join(editorSource, item), join(editor, item), { recursive: true })
  mkdirSync(join(fixture, 'apps', 'api', 'src', 'routes', '[id]'), { recursive: true })
  mkdirSync(join(fixture, 'apps', 'api', 'node_modules'), { recursive: true })
  cpSync(join(editorSource, 'node_modules', 'zod'), join(fixture, 'apps', 'api', 'node_modules', 'zod'), { recursive: true })
  mkdirSync(join(fixture, 'apps', 'api', 'node_modules', '@southneuhof'), { recursive: true })
  cpSync(join(editorSource, 'node_modules', '@southneuhof', 'sprindle'), join(fixture, 'apps', 'api', 'node_modules', '@southneuhof', 'sprindle'), { recursive: true })
  writeFileSync(join(fixture, 'apps', 'api', 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', skipLibCheck: false }, include: ['src/**/*.ts'] }))
  writeFileSync(join(fixture, 'apps', 'api', 'src', 'ordinary.ts'), `const value: number = 'wrong'`)
  mkdirSync(join(fixture, 'apps', 'other', 'src', 'routes'), { recursive: true })
  writeFileSync(join(fixture, 'apps', 'other', 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src/**/*.ts'] }))
  writeFileSync(join(fixture, 'apps', 'other', 'src', 'routes', '+server.ts'), `import {defineRoute} from '@southneuhof/sprindle';export const GET=defineRoute({action:({context})=>context.other})`)
  const test = join(editorSource, 'test', 'suite.cjs')
  await runTests({
    vscodeExecutablePath: '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
    extensionDevelopmentPath: editor,
    extensionTestsPath: test,
    extensionTestsEnv: { ELECTRON_RUN_AS_NODE: undefined },
    launchArgs: [fixture, '--disable-workspace-trust', `--user-data-dir=${profile}`, `--extensions-dir=${join(profile, 'extensions')}`],
    reuseMachineInstall: true,
  })
} finally {
  rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  rmSync(editor, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
