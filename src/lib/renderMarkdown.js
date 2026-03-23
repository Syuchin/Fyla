import DOMPurify from 'dompurify'
import { Marked } from 'marked'
import markedKatex from 'marked-katex-extension'

const markdownRenderer = new Marked({
  gfm: true,
  breaks: false,
})

markdownRenderer.use(markedKatex({
  throwOnError: false,
  trust: false,
  nonStandard: true,
}))

const INLINE_PAREN_DELIMITER_PATTERN = /(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)/g
const DISPLAY_BRACKET_DELIMITER_PATTERN = /(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g

export function renderMarkdownToHtml(markdown = '') {
  const normalizedMarkdown = normalizeMarkdownMathDelimiters(String(markdown || ''))
  const rawHtml = markdownRenderer.parse(normalizedMarkdown)
  const html = typeof rawHtml === 'string' ? rawHtml : String(rawHtml || '')
  return typeof DOMPurify?.sanitize === 'function'
    ? DOMPurify.sanitize(html)
    : html
}

function normalizeMarkdownMathDelimiters(markdown) {
  if (!markdown.includes('\\(') && !markdown.includes('\\[')) {
    return markdown
  }

  let cursor = 0
  let textStart = 0
  let normalized = ''

  while (cursor < markdown.length) {
    const fencedCodeBlock = matchFencedCodeBlock(markdown, cursor)
    if (fencedCodeBlock) {
      normalized += normalizeMathTextSegment(markdown.slice(textStart, cursor))
      normalized += fencedCodeBlock.raw
      cursor = fencedCodeBlock.end
      textStart = cursor
      continue
    }

    const inlineCodeSpan = matchInlineCodeSpan(markdown, cursor)
    if (inlineCodeSpan) {
      normalized += normalizeMathTextSegment(markdown.slice(textStart, cursor))
      normalized += inlineCodeSpan.raw
      cursor = inlineCodeSpan.end
      textStart = cursor
      continue
    }

    cursor += 1
  }

  normalized += normalizeMathTextSegment(markdown.slice(textStart))
  return normalized
}

function normalizeMathTextSegment(segment) {
  return segment
    .replace(DISPLAY_BRACKET_DELIMITER_PATTERN, (_, math) => {
      const value = String(math || '')
      return value.includes('\n')
        ? `$$\n${value.trim()}\n$$`
        : `$$${value}$$`
    })
    .replace(INLINE_PAREN_DELIMITER_PATTERN, (_, math) => `$${String(math || '')}$`)
}

function matchFencedCodeBlock(markdown, index) {
  if (index > 0 && markdown[index - 1] !== '\n') return null

  let cursor = index
  let indent = 0
  while (indent < 3 && markdown[cursor] === ' ') {
    cursor += 1
    indent += 1
  }

  const marker = markdown[cursor]
  if (marker !== '`' && marker !== '~') return null

  let fenceLength = 0
  while (markdown[cursor + fenceLength] === marker) {
    fenceLength += 1
  }

  if (fenceLength < 3) return null

  const openingLineEnd = markdown.indexOf('\n', cursor + fenceLength)
  if (openingLineEnd === -1) {
    return {
      raw: markdown.slice(index),
      end: markdown.length,
    }
  }

  let lineStart = openingLineEnd + 1
  while (lineStart < markdown.length) {
    let lineCursor = lineStart
    let lineIndent = 0
    while (lineIndent < 3 && markdown[lineCursor] === ' ') {
      lineCursor += 1
      lineIndent += 1
    }

    let markerRun = 0
    while (markdown[lineCursor + markerRun] === marker) {
      markerRun += 1
    }

    if (markerRun >= fenceLength) {
      let lineEnd = lineCursor + markerRun
      while (lineEnd < markdown.length && markdown[lineEnd] !== '\n' && /[ \t]/.test(markdown[lineEnd])) {
        lineEnd += 1
      }

      if (lineEnd === markdown.length || markdown[lineEnd] === '\n') {
        const end = lineEnd === markdown.length ? lineEnd : lineEnd + 1
        return {
          raw: markdown.slice(index, end),
          end,
        }
      }
    }

    const nextLineBreak = markdown.indexOf('\n', lineStart)
    if (nextLineBreak === -1) {
      break
    }
    lineStart = nextLineBreak + 1
  }

  return {
    raw: markdown.slice(index),
    end: markdown.length,
  }
}

function matchInlineCodeSpan(markdown, index) {
  if (markdown[index] !== '`') return null

  let markerLength = 0
  while (markdown[index + markerLength] === '`') {
    markerLength += 1
  }

  let cursor = index + markerLength
  while (cursor < markdown.length) {
    const nextMarker = markdown.indexOf('`', cursor)
    if (nextMarker === -1) return null

    let nextMarkerLength = 0
    while (markdown[nextMarker + nextMarkerLength] === '`') {
      nextMarkerLength += 1
    }

    if (nextMarkerLength === markerLength) {
      const end = nextMarker + nextMarkerLength
      return {
        raw: markdown.slice(index, end),
        end,
      }
    }

    cursor = nextMarker + nextMarkerLength
  }

  return null
}
