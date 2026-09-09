const vscode = require('vscode')
const { existsSync } = require('node:fs')
const { dirname, join, relative } = require('node:path')
const { spawn } = require('node:child_process')

exports.activate = async function activate(context) {
  const diagnostics = vscode.languages.createDiagnosticCollection('sprindle')
  let client, starting
  const routeDocument = (document) => /\+(server|scope)\.ts$/.test(document.fileName)
  const projectFor = (file) => {
    let directory = dirname(file), routes
    while (true) {
      if (!routes && directory.endsWith('/routes')) routes = directory
      if (existsSync(join(directory, 'tsconfig.json')) && routes) return { root: directory, routesDirectory: relative(directory, routes) }
      const parent = dirname(directory); if (parent === directory) return undefined; directory = parent
    }
  }
  const start = async (document) => {
    if (client) return document.fileName.startsWith(client.project.root + '/') ? client : undefined
    if (starting) { const active = await starting; return active && document.fileName.startsWith(active.project.root + '/') ? active : undefined }
    const project = projectFor(document.fileName); if (!project) return undefined
    starting = (async () => {
    const child = spawn('node', [join(__dirname, 'dist/language-server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] })
    let id = 0, input = Buffer.alloc(0); const pending = new Map()
    const send = (message) => { const body = Buffer.from(JSON.stringify(message)); child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`); child.stdin.write(body) }
    const request = (method, params, token) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); token?.onCancellationRequested(() => { pending.delete(next); reject(new vscode.CancellationError()); send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: next } }) }); send({ jsonrpc: '2.0', id: next, method, params }) })
    child.stdout.on('data', (chunk) => { input = Buffer.concat([input, chunk]); while (true) { const boundary = input.indexOf('\r\n\r\n'); if (boundary < 0) break; const length = Number(input.subarray(0, boundary).toString().match(/Content-Length: (\d+)/i)?.[1]); if (input.length < boundary + 4 + length) break; const start = boundary + 4, message = JSON.parse(input.subarray(start, start + length)); input = input.subarray(start + length); if (message.id !== undefined) { const item = pending.get(message.id); message.error ? item?.reject(Error(message.error.message)) : item?.resolve(message.result); pending.delete(message.id) } else if (message.method === 'textDocument/publishDiagnostics') { const uri = vscode.Uri.parse(message.params.uri); diagnostics.set(uri, message.params.diagnostics.map((item) => { const diagnostic = new vscode.Diagnostic(new vscode.Range(item.range.start, item.range.end), item.message, vscode.DiagnosticSeverity.Error); diagnostic.code = item.code; diagnostic.source = item.source; return diagnostic })) } } })
    const failed = (error) => { for (const item of pending.values()) item.reject(error); pending.clear(); client = undefined; starting = undefined }
    child.once('error', failed); child.once('exit', (code) => failed(Error(`Sprindle language server exited with code ${code}`)))
    await request('initialize', { rootUri: vscode.Uri.file(project.root).toString(), capabilities: {}, initializationOptions: { routesDirectory: project.routesDirectory } })
    send({ jsonrpc: '2.0', method: 'initialized', params: {} })
    client = { child, send, request, project }
    return client
    })()
    return starting
  }
  const activateDocument = async (document) => {
    if (!routeDocument(document)) return
    const active = await start(document); if (!active) return
    const typed = document.languageId === 'sprindle-typescript' ? document : await vscode.languages.setTextDocumentLanguage(document, 'sprindle-typescript')
    active.send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: typed.uri.toString(), languageId: typed.languageId, version: typed.version, text: typed.getText() } } })
    for (const other of vscode.workspace.textDocuments) if (other !== typed && other.fileName.startsWith(active.project.root + '/')) active.send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: other.uri.toString(), languageId: other.languageId, version: other.version, text: other.getText() } } })
  }
  const pullDiagnostics = () => Promise.all(vscode.workspace.textDocuments.filter(routeDocument).map((document) => client.request('textDocument/diagnostic', { textDocument: { uri: document.uri.toString() } }).then((report) => diagnostics.set(document.uri, report.items.map((item) => { const diagnostic = new vscode.Diagnostic(new vscode.Range(item.range.start, item.range.end), item.message, vscode.DiagnosticSeverity.Error); diagnostic.code = item.code; diagnostic.source = item.source; return diagnostic })))))
  await Promise.all(vscode.workspace.textDocuments.map(activateDocument))
  const selector = [{ language: 'sprindle-typescript', pattern: '**/+server.ts' }, { language: 'sprindle-typescript', pattern: '**/+scope.ts' }]
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(selector, { provideCompletionItems(document, position, token) { return client.request('textDocument/completion', { textDocument: { uri: document.uri.toString() }, position }, token).then((items) => items.map((item) => new vscode.CompletionItem(item.label))) } }, '.'))
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, { provideDefinition(document, position, token) { return client.request('textDocument/definition', { textDocument: { uri: document.uri.toString() }, position }, token).then((items) => items.map((item) => new vscode.Location(vscode.Uri.parse(item.uri), new vscode.Range(item.range.start, item.range.end)))) } }))
  context.subscriptions.push(vscode.languages.registerHoverProvider(selector, { provideHover(document, position, token) { return client.request('textDocument/hover', { textDocument: { uri: document.uri.toString() }, position }, token).then((item) => new vscode.Hover(item.contents.map((content) => new vscode.MarkdownString('```' + content.language + '\n' + content.value + '\n```')))) } }))
  context.subscriptions.push(vscode.languages.registerRenameProvider(selector, { provideRenameEdits(document, position, newName, token) { return client.request('textDocument/rename', { textDocument: { uri: document.uri.toString() }, position, newName }, token).then((result) => { const edit = new vscode.WorkspaceEdit(); for (const [uri, changes] of Object.entries(result.changes)) for (const change of changes) edit.replace(vscode.Uri.parse(uri), new vscode.Range(change.range.start, change.range.end), change.newText); return edit }) } }))
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((document) => { if (routeDocument(document)) activateDocument(document); else if (client && document.fileName.startsWith(client.project.root + '/')) client.send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: document.uri.toString(), languageId: document.languageId, version: document.version, text: document.getText() } } }) }))
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(({ document }) => { if (client && document.fileName.startsWith(client.project.root + '/')) { client.send({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri: document.uri.toString(), version: document.version }, contentChanges: [{ text: document.getText() }] } }); pullDiagnostics() } }))
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => { if (client && document.fileName.startsWith(client.project.root + '/')) client.send({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri: document.uri.toString() } } }) }))
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,json}')
  const changed = (type) => (uri) => { client?.send({ jsonrpc: '2.0', method: 'workspace/didChangeWatchedFiles', params: { changes: [{ uri: uri.toString(), type }] } }); if (client) pullDiagnostics() }
  context.subscriptions.push(diagnostics, watcher, watcher.onDidCreate(changed(1)), watcher.onDidChange(changed(2)), watcher.onDidDelete(changed(3)), { dispose() { if (client) client.request('shutdown', {}).finally(() => { client.send({ jsonrpc: '2.0', method: 'exit' }); client.child.kill() }) } })
}
