#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRouteLanguage } from './language.ts'
import { applyChanges, offsetAt, positionAt, type LspChange as Change, type LspPosition as Position } from './lsp-text.ts'

type Message = { id?: number | string; method?: string; params?: Record<string, unknown> }
let buffer = Buffer.alloc(0)
let service: ReturnType<typeof createRouteLanguage> | undefined
let published = new Set<string>()
const documents = new Map<string, string>()

function send(message: unknown) { const body = Buffer.from(JSON.stringify(message)); process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`); process.stdout.write(body) }
function uriFile(value: unknown) { return fileURLToPath(String(value)) }
function text(file: string) { return documents.get(file) ?? (existsSync(file) ? readFileSync(file, 'utf8') : '') }
function diagnosticItems(fileName: string) {
  const source = text(fileName)
  return (service?.diagnostics() ?? []).filter((item) => item.fileName === fileName).flatMap((item) => item.pos === undefined || item.end === undefined ? [] : [{ range: { start: positionAt(source, item.pos), end: positionAt(source, item.end) }, severity: 1, code: item.code, message: item.text, source: 'sprindle' }])
}
function diagnostics() {
  const grouped = new Map<string, ReturnType<NonNullable<typeof service>['diagnostics']>>()
  for (const item of service?.diagnostics() ?? []) if (item.fileName) grouped.set(item.fileName, [...(grouped.get(item.fileName) ?? []), item])
  for (const fileName of new Set([...published, ...grouped.keys()])) {
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: pathToFileURL(fileName).href, diagnostics: diagnosticItems(fileName) } })
  }
  published = new Set(grouped.keys())
}
function reply(id: Message['id'], result: unknown) { if (id !== undefined) send({ jsonrpc: '2.0', id, result }) }
function location(item: { fileName: string; pos: number; end: number }) { const source = text(item.fileName); return { uri: pathToFileURL(item.fileName).href, range: { start: positionAt(source, item.pos), end: positionAt(source, item.end) } } }
function handle(message: Message) {
  const params = message.params ?? {}
  if (message.method === '$/cancelRequest') return
  if (message.method === 'initialize') { const root = uriFile(params.rootUri); service = createRouteLanguage(root, String((params.initializationOptions as { routesDirectory?: string } | undefined)?.routesDirectory ?? 'routes')); return reply(message.id, { capabilities: { textDocumentSync: 1, completionProvider: {}, definitionProvider: true, hoverProvider: true, renameProvider: true, diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false } } }) }
  if (message.method === 'shutdown') return reply(message.id, null)
  if (message.method === 'exit') { service?.close(); process.exit() }
  const document = params.textDocument as { uri: string; text?: string } | undefined
  if (message.method === 'textDocument/didOpen' && document?.text !== undefined) { const file = uriFile(document.uri); documents.set(file, document.text); service?.open(file, document.text); diagnostics(); return }
  if (message.method === 'textDocument/didChange' && document) { const file = uriFile(document.uri); const next = applyChanges(text(file), (params.contentChanges as Change[]) ?? []); documents.set(file, next); service?.open(file, next); diagnostics(); return }
  if (message.method === 'textDocument/didClose' && document) { const file = uriFile(document.uri); documents.delete(file); service?.closeDocument(file); diagnostics(); return }
  if (message.method === 'workspace/didChangeWatchedFiles') { diagnostics(); return }
  const file = document ? uriFile(document.uri) : ''
  if (message.method === 'textDocument/diagnostic') return reply(message.id, { kind: 'full', items: diagnosticItems(file) })
  const position = offsetAt(text(file), (params.position as Position | undefined) ?? { line: 0, character: 0 })
  if (message.method === 'textDocument/completion') return reply(message.id, service?.completions(file, position).map((entry) => ({ label: entry.name })) ?? [])
  if (message.method === 'textDocument/hover') return reply(message.id, { contents: [{ language: 'typescript', value: service?.type(file, position) ?? 'unknown' }] })
  if (message.method === 'textDocument/definition') return reply(message.id, (service?.definitions(file, position) ?? []).map(location))
  if (message.method === 'textDocument/rename') {
    const changes: Record<string, { range: { start: Position; end: Position }; newText: string }[]> = {}
    for (const item of service?.rename(file, position) ?? []) { const target = location(item); (changes[target.uri] ??= []).push({ range: target.range, newText: String(params.newName) }) }
    return reply(message.id, { changes })
  }
  reply(message.id, null)
}
function close() { service?.close() }
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const boundary = buffer.indexOf('\r\n\r\n'); if (boundary < 0) return
    const length = Number(buffer.subarray(0, boundary).toString().match(/Content-Length: (\d+)/i)?.[1]); if (!length || buffer.length < boundary + 4 + length) return
    const start = boundary + 4; const raw = buffer.subarray(start, start + length).toString(); buffer = buffer.subarray(start + length)
    try { handle(JSON.parse(raw) as Message) } catch (error) { const id = (() => { try { return (JSON.parse(raw) as Message).id } catch { return undefined } })(); if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }) }
  }
})
process.stdin.on('end', () => { close(); process.exit() })
process.on('SIGTERM', () => { close(); process.exit() })
