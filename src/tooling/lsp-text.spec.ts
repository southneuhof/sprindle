import { expect, test } from 'vitest'
import { applyChanges, offsetAt, positionAt } from './lsp-text'

test('maps UTF-16 positions through multiline CRLF text', () => {
  const source = 'café 🚀\r\nsecond\r\n'
  const position = { line: 0, character: 7 }
  expect(source.slice(0, offsetAt(source, position))).toBe('café 🚀')
  expect(positionAt(source, offsetAt(source, position))).toEqual(position)
  expect(offsetAt(source, { line: 1, character: 3 })).toBe(source.indexOf('second') + 3)
})

test('applies standard incremental and full document changes', () => {
  expect(applyChanges('one\r\ntwo', [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, text: 'three' }])).toBe('one\r\nthree')
  expect(applyChanges('old', [{ text: 'new' }])).toBe('new')
})
