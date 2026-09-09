export type LspPosition = { line: number; character: number }
export type LspChange = { text: string; range?: { start: LspPosition; end: LspPosition } }

export function offsetAt(source: string, position: LspPosition) {
  let offset = 0
  for (let line = 0; line < position.line; line++) { const next = source.indexOf('\n', offset); if (next < 0) return source.length; offset = next + 1 }
  const next = source.indexOf('\n', offset)
  const end = next < 0 ? source.length : next > 0 && source[next - 1] === '\r' ? next - 1 : next
  return Math.min(offset + position.character, end)
}
export function positionAt(source: string, requested: number): LspPosition {
  const offset = Math.max(0, Math.min(requested, source.length)); let line = 0, start = 0
  for (let next = source.indexOf('\n', start); next >= 0 && next < offset; next = source.indexOf('\n', start)) { line++; start = next + 1 }
  return { line, character: offset - start }
}
export function applyChanges(source: string, changes: LspChange[]) {
  for (const change of changes) source = change.range ? source.slice(0, offsetAt(source, change.range.start)) + change.text + source.slice(offsetAt(source, change.range.end)) : change.text
  return source
}
