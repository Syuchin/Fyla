import { useEffect, useRef, useState } from 'preact/hooks'
import {
  clearPaperChatDraftQuote,
  addPaperChatDraftAttachment,
  addPaperChatDraftImages,
  clearPaperChatDraftAttachments,
  clearPaperSelection,
  createNewPaperChatSession,
  getCurrentPaperChatSessions,
  insertSelectionIntoDraft,
  PAPER_CHAT_MAX_DRAFT_IMAGES,
  openActivePaperChatWindow,
  removePaperChatDraftAttachment,
  removePaperChatDraftImage,
  retryLastPaperChatTurn,
  selectPaperChatSession,
  sendPaperChatQuestion,
  seedDraftFromSelection,
  setPaperChatDraft,
  setPaperChatHistoryPanelOpen,
  setPaperChatMentionState,
  stopActivePaperChatStream,
} from '../lib/paperChat.js'
import { t } from '../lib/i18n.js'
import { copyText, friendlyError, openExternalUrl, pickImageFiles, readBinaryFile } from '../lib/tauri.js'
import {
  activePaperChatPaper,
  config,
  paperChatActiveMentionQuery,
  paperChatDraft,
  paperChatDraftQuote,
  paperChatDraftAttachments,
  paperChatDraftImages,
  paperChatHistoryPanelOpen,
  paperChatMentionMenuOpen,
  paperSelectionContext,
  showToast,
} from '../lib/store.js'
import { renderMarkdownToHtml } from '../lib/renderMarkdown.js'

const INLINE_MENTION_GLOBAL_PATTERN = /\[@([^\]\n]+)\]/g
const PDF_CITATION_PREFIX = '@论文PDF/第'
const REPORT_CITATION_PREFIX = '@解读报告/'
const CITATION_SNIPPET_OPEN = '『'
const CITATION_SNIPPET_CLOSE = '』'

function renderPlainTextContent(content) {
  return String(content || '')
    .split('\n')
    .map((line, lineIndex, lines) => (
      <span key={`line-${lineIndex}`}>
        <span key={`part-${lineIndex}`}>{line}</span>
        {lineIndex < lines.length - 1 && <br />}
      </span>
    ))
}

function extractInlineMentionLabels(content) {
  return Array.from(String(content || '').matchAll(INLINE_MENTION_GLOBAL_PATTERN))
    .map(match => `@${String(match[1] || '').trim().replace(/^@+/, '')}`)
    .filter(Boolean)
}

function inferAttachmentKindFromLabel(label) {
  if (label === '@论文PDF') return 'pdf'
  if (label === '@解读报告') return 'report'
  return label
}

function resolveUserMessageAttachments(message) {
  const normalized = new Map()

  for (const item of message?.attachments || []) {
    const kind = item?.kind || inferAttachmentKindFromLabel(item?.label)
    if (!item?.label || kind === 'image') continue
    normalized.set(kind, {
      kind,
      label: item.label,
    })
  }

  for (const label of extractInlineMentionLabels(message?.content || '')) {
    const kind = inferAttachmentKindFromLabel(label)
    if (!normalized.has(kind)) {
      normalized.set(kind, { kind, label })
    }
  }

  return [...normalized.values()]
}

function stripInlineMentionTokens(
  content,
  {
    collapseWhitespace = true,
    collapseNewlines = true,
    trim = true,
  } = {},
) {
  let next = String(content || '').replace(INLINE_MENTION_GLOBAL_PATTERN, '')

  if (collapseWhitespace) {
    next = next.replace(/[ \t]{2,}/g, ' ')
  }

  next = next.replace(/\n[ \t]+/g, '\n')

  if (collapseNewlines) {
    next = next.replace(/\n{3,}/g, '\n\n')
  }

  return trim ? next.trim() : next
}

function splitLeadingQuoteBlock(content) {
  const normalized = String(content || '').replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  let index = 0

  while (index < lines.length && !lines[index].trim()) {
    index += 1
  }

  const quoteLines = []
  while (index < lines.length && /^\s*>/.test(lines[index])) {
    quoteLines.push(lines[index].replace(/^\s*>\s?/, ''))
    index += 1
  }

  if (!quoteLines.length) {
    return {
      quote: null,
      body: normalized.trim(),
    }
  }

  while (index < lines.length && !lines[index].trim()) {
    index += 1
  }

  return {
    quote: {
      text: quoteLines.join('\n').trim(),
    },
    body: lines.slice(index).join('\n').trim(),
  }
}

function parseUserMessageContent(content) {
  const stripped = stripInlineMentionTokens(content, {
    collapseWhitespace: false,
    collapseNewlines: false,
    trim: false,
  })
  const { quote, body } = splitLeadingQuoteBlock(stripped)
  return {
    quote,
    body: String(body || '').trim(),
  }
}

function getUserPreviewContent(content) {
  const { quote, body } = parseUserMessageContent(content)
  return String(body || quote?.text || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncateText(value, maxLength = 72) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}…`
}

function getFileNameFromPath(path) {
  return String(path || '').split(/[/\\]/).pop() || ''
}

function createDraftImageId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `paper-chat-image-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function inferImageMime(input, fallback = 'image/png') {
  const value = String(input || '').trim().toLowerCase()
  if (!value) return fallback
  if (value.startsWith('image/')) return value
  if (value.endsWith('.jpg') || value.endsWith('.jpeg')) return 'image/jpeg'
  if (value.endsWith('.png')) return 'image/png'
  if (value.endsWith('.webp')) return 'image/webp'
  if (value.endsWith('.gif')) return 'image/gif'
  if (value.endsWith('.bmp')) return 'image/bmp'
  if (value.endsWith('.tif') || value.endsWith('.tiff')) return 'image/tiff'
  return fallback
}

async function fileToDataUrl(file) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('Failed to read image'))
    reader.onload = () => resolve(String(reader.result || ''))
    reader.readAsDataURL(file)
  })
}

function bytesToObjectUrl(bytes, mime) {
  return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }))
}

const messageImagePreviewCache = new Map()

function getMessageImageAttachments(message) {
  return (message?.attachments || []).filter(item => item?.kind === 'image')
}

function getDraftImageSrc(image) {
  if (image?.objectUrl) return image.objectUrl
  if (image?.dataUrl) return image.dataUrl
  return ''
}

function getMessageImageKey(image) {
  return String(
    image?.id
    || image?.path
    || `${image?.name || 'image'}:${image?.mime || ''}:${image?.sizeBytes || ''}`
  )
}

function cleanupMessageImagePreview(key, entry = messageImagePreviewCache.get(key)) {
  if (!entry) return
  if (entry.objectUrl) {
    try {
      URL.revokeObjectURL(entry.objectUrl)
    } catch (_) {}
  }
  messageImagePreviewCache.delete(key)
}

function notifyMessageImagePreview(entry) {
  for (const listener of entry.listeners) {
    listener()
  }
}

async function loadMessageImagePreview(key, image, entry) {
  const path = String(image?.path || '').trim()
  if (!path) {
    entry.status = 'failed'
    entry.error = 'missing-path'
    notifyMessageImagePreview(entry)
    return
  }

  try {
    const bytes = await readBinaryFile(path)
    if (messageImagePreviewCache.get(key) !== entry) return
    entry.objectUrl = bytesToObjectUrl(bytes, inferImageMime(image?.mime || image?.name))
    entry.status = 'ready'
    entry.error = ''
  } catch (err) {
    if (messageImagePreviewCache.get(key) !== entry) return
    entry.status = 'failed'
    entry.error = friendlyError(err)
  } finally {
    if (messageImagePreviewCache.get(key) !== entry) return
    entry.promise = null
    notifyMessageImagePreview(entry)
    if (entry.refCount <= 0) {
      cleanupMessageImagePreview(key, entry)
    }
  }
}

function acquireMessageImagePreview(image, listener) {
  const key = getMessageImageKey(image)
  let entry = messageImagePreviewCache.get(key)
  if (!entry) {
    entry = {
      key,
      status: image?.objectUrl || image?.dataUrl ? 'ready' : 'loading',
      objectUrl: image?.objectUrl || image?.dataUrl || '',
      error: '',
      promise: null,
      refCount: 0,
      listeners: new Set(),
    }
    messageImagePreviewCache.set(key, entry)
  }

  entry.refCount += 1
  entry.listeners.add(listener)

  if (!entry.objectUrl && !entry.promise && entry.status !== 'failed') {
    entry.status = 'loading'
    entry.promise = loadMessageImagePreview(key, image, entry)
  }

  return {
    key,
    entry,
  }
}

function releaseMessageImagePreview(key, listener) {
  const entry = messageImagePreviewCache.get(key)
  if (!entry) return
  entry.listeners.delete(listener)
  entry.refCount = Math.max(0, entry.refCount - 1)
  if (entry.refCount === 0 && !entry.promise) {
    cleanupMessageImagePreview(key, entry)
  }
}

function useHydratedMessageImages(images) {
  const [, setRevision] = useState(0)
  const imageSignature = (images || []).map(getMessageImageKey).join('|')
  const listenerRef = useRef(() => {
    setRevision(current => current + 1)
  })

  useEffect(() => {
    const trackedKeys = (images || []).map(image =>
      acquireMessageImagePreview(image, listenerRef.current).key
    )

    return () => {
      for (const key of trackedKeys) {
        releaseMessageImagePreview(key, listenerRef.current)
      }
    }
  }, [imageSignature])

  return (images || []).map(image => {
    const key = getMessageImageKey(image)
    const entry = messageImagePreviewCache.get(key)
    return {
      key,
      image,
      status: entry?.status || 'loading',
      src: entry?.objectUrl || '',
      error: entry?.error || '',
    }
  })
}

function formatMessageTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString([], {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function buildSessionCards(summaries) {
  return (summaries || []).map(summary => ({
    ...summary,
    titlePreview: truncateText(
      getUserPreviewContent(summary.firstUserMessage || ''),
      48
    ),
    replyPreview: truncateText(summary.lastAssistantMessage || '', 64),
    timestamp: summary.updatedAt || summary.createdAt || '',
  }))
}

function removeResolvedMentionToken(value, token) {
  if (!token) return value

  const before = value.slice(0, token.start)
  const after = value.slice(token.end)
  const trimmedBefore = before.replace(/[ \t]+$/, '')
  const trimmedAfter = after.replace(/^[ \t]+/, '')

  if (!trimmedBefore) return trimmedAfter
  if (!trimmedAfter) return trimmedBefore
  if (trimmedBefore.endsWith('\n') || trimmedAfter.startsWith('\n')) {
    return `${trimmedBefore}${trimmedAfter}`
  }
  if (/^[,.;:!?)}\]]/.test(trimmedAfter)) {
    return `${trimmedBefore}${trimmedAfter}`
  }
  return `${trimmedBefore} ${trimmedAfter}`
}

function renderAssistantContent(content) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<body>${renderMarkdownToHtml(content)}</body>`, 'text/html')
  decorateInlineCitations(doc.body)
  return doc.body.innerHTML
}

function decorateInlineCitations(root) {
  const doc = root.ownerDocument
  const textNodes = []
  const walker = doc.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node.nodeValue?.includes('@')) return NodeFilter.FILTER_REJECT
        const parent = node.parentElement
        if (!parent || parent.closest('code, pre, .katex, math, annotation')) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      },
    },
  )

  while (walker.nextNode()) {
    textNodes.push(walker.currentNode)
  }

  for (const textNode of textNodes) {
    replaceTextNodeWithCitations(textNode, doc)
  }
}

function replaceTextNodeWithCitations(textNode, doc) {
  const text = expandCompactPdfCitationForms(textNode.nodeValue || '')
  let cursor = 0
  let changed = false
  const fragment = doc.createDocumentFragment()

  while (cursor < text.length) {
    const match = findNextCitation(text, cursor)
    if (!match) break

    changed = true
    if (match.start > cursor) {
      fragment.append(doc.createTextNode(text.slice(cursor, match.start)))
    }
    fragment.append(createCitationElement(doc, match))
    cursor = match.end
  }

  if (!changed) return

  if (cursor < text.length) {
    fragment.append(doc.createTextNode(text.slice(cursor)))
  }

  textNode.parentNode?.replaceChild(fragment, textNode)
}

function expandCompactPdfCitationForms(text) {
  const withRangesExpanded = String(text || '').replace(
    /@论文PDF\/第\s*(\d+)\s*页?\s*(?:-|–|—|~|～|至|到)\s*第?\s*(\d+)\s*页/g,
    (full, startRaw, endRaw) => {
      const start = Number(startRaw)
      const end = Number(endRaw)
      if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start || end - start > 3) {
        return full
      }
      return Array.from({ length: end - start + 1 }, (_, offset) => `@论文PDF/第${start + offset}页`).join(' ')
    }
  )

  return withRangesExpanded.replace(
    /@论文PDF\/第\s*(\d+)\s*页((?:\s*(?:、|,|，|和|及|以及)\s*第?\s*\d+\s*页?)*)/g,
    (full, firstPageRaw, suffix) => {
      if (!suffix || !suffix.trim()) return full
      const firstPage = Number(firstPageRaw)
      if (!Number.isInteger(firstPage)) return full

      const extraPages = Array.from(
        suffix.matchAll(/(?:、|,|，|和|及|以及)\s*第?\s*(\d+)\s*页?/g)
      )
        .map(match => Number(match[1]))
        .filter(page => Number.isInteger(page))

      if (!extraPages.length) return full

      const pages = [firstPage, ...extraPages].filter((page, index, list) => list.indexOf(page) === index)
      return pages.map(page => `@论文PDF/第${page}页`).join(' ')
    }
  )
}

function findNextCitation(text, fromIndex) {
  const nextPdf = text.indexOf(PDF_CITATION_PREFIX, fromIndex)
  const nextReport = text.indexOf(REPORT_CITATION_PREFIX, fromIndex)
  const candidates = [nextPdf, nextReport].filter(index => index >= 0)
  if (!candidates.length) return null

  const start = Math.min(...candidates)
  if (start === nextPdf) {
    const slice = text.slice(start)
    const match = slice.match(/^@论文PDF\/第\s*(\d+)\s*页/)
    if (!match) return null
    const snippet = parseOptionalCitationSnippet(text, start + match[0].length)
    return {
      type: 'pdf',
      start,
      end: snippet?.end ?? start + match[0].length,
      page: Number(match[1]),
      snippet: snippet?.value || null,
      label: `P.${match[1]}`,
    }
  }

  const contentStart = start + REPORT_CITATION_PREFIX.length
  const snippetStart = text.indexOf(CITATION_SNIPPET_OPEN, contentStart)
  const hardStop = findReportCitationBoundary(text, contentStart)
  const shouldUseSnippet = snippetStart >= 0 && (hardStop < 0 || snippetStart < hardStop)
  const end = shouldUseSnippet
    ? snippetStart
    : (hardStop >= 0 ? hardStop : text.length)

  const heading = text
    .slice(contentStart, end)
    .trim()
    .replace(/\s+/g, ' ')

  if (!heading) return null

  const snippet = shouldUseSnippet
    ? parseOptionalCitationSnippet(text, end)
    : null

  return {
    type: 'report',
    start,
    end: snippet?.end ?? end,
    heading,
    snippet: snippet?.value || null,
    label: heading,
  }
}

function parseOptionalCitationSnippet(text, fromIndex) {
  let cursor = fromIndex
  while (cursor < text.length && /\s/.test(text[cursor])) {
    cursor += 1
  }
  if (text[cursor] !== CITATION_SNIPPET_OPEN) return null

  const closeIndex = text.indexOf(CITATION_SNIPPET_CLOSE, cursor + 1)
  if (closeIndex < 0) return null

  const value = text.slice(cursor + 1, closeIndex).trim()
  if (!value) return null

  return {
    value,
    end: closeIndex + 1,
  }
}

function findReportCitationBoundary(text, fromIndex) {
  for (let index = fromIndex; index < text.length; index += 1) {
    if (/[\n\r。；，,!?！？、]/.test(text[index])) {
      return index
    }
  }
  return -1
}

function truncateCitationText(value, maxLength = 18) {
  const content = String(value || '').trim()
  if (!content) return ''
  if (content.length <= maxLength) return content
  return `${content.slice(0, maxLength)}…`
}

function createCitationElement(doc, citation) {
  const element = doc.createElement('span')
  element.className = 'paper-chat-inline-cite'
  element.dataset.source = citation.type
  if (citation.snippet) {
    element.dataset.snippet = citation.snippet
  }

  if (citation.type === 'pdf') {
    element.dataset.page = String(citation.page)
    element.textContent = citation.snippet
      ? `PDF ${citation.label} · ${truncateCitationText(citation.snippet)}`
      : `PDF ${citation.label}`
  } else {
    element.dataset.heading = citation.heading
    element.textContent = citation.snippet
      ? `SEC ${truncateCitationText(citation.label, 14)} · ${truncateCitationText(citation.snippet)}`
      : `SEC ${citation.label}`
  }

  return element
}

function resolveMentionToken(value, caret = value.length) {
  const beforeCaret = value.slice(0, caret)
  const match = beforeCaret.match(/(?:^|\s)(@[^\s@]*)$/)
  if (!match) return null
  const token = match[1]
  return {
    token,
    start: beforeCaret.length - token.length,
    end: caret,
  }
}

function getLastAssistantMessage(messages) {
  return [...(messages || [])].reverse().find(message => message.role === 'assistant') || null
}

function getLastUserMessage(messages) {
  return [...(messages || [])].reverse().find(message => message.role === 'user') || null
}

function ChatIcon({ name, className = '' }) {
  return (
    <span class={`paper-chat-icon ${className}`.trim()} aria-hidden="true">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
        {renderChatIconGlyph(name)}
      </svg>
    </span>
  )
}

function renderChatIconGlyph(name) {
  switch (name) {
    case 'history':
      return (
        <>
          <path d="M4.25 5.25V2.75" />
          <path d="M4.25 2.75H6.75" />
          <circle cx="10" cy="10" r="6.25" />
          <path d="M10 6.75v3.25l2.25 1.5" />
        </>
      )
    case 'plus':
      return (
        <>
          <path d="M10 4.5v11" />
          <path d="M4.5 10h11" />
        </>
      )
    case 'popout':
      return (
        <>
          <path d="M8 4.75H5.25v9.5h9.5V11.5" />
          <path d="M9.75 10.25L15 5" />
          <path d="M11 5H15v4" />
        </>
      )
    case 'reembed':
      return (
        <>
          <path d="M5.25 5.25h9.5v9.5h-9.5z" />
          <path d="M10.75 8.75L6 13.5" />
          <path d="M6 10.5v3h3" />
        </>
      )
    case 'close':
      return (
        <>
          <path d="M5.5 5.5l9 9" />
          <path d="M14.5 5.5l-9 9" />
        </>
      )
    case 'spark':
      return (
        <>
          <path d="M10 3.75l1.5 3.5 3.5 1.5-3.5 1.5-1.5 3.5-1.5-3.5-3.5-1.5 3.5-1.5z" />
          <path d="M14.5 3.5v2" />
          <path d="M13.5 4.5h2" />
        </>
      )
    case 'method':
      return (
        <>
          <path d="M5.25 5.5h9.5" />
          <path d="M5.25 9.5h9.5" />
          <path d="M5.25 13.5h6.25" />
          <path d="M12.75 13.5h2" />
        </>
      )
    case 'evidence':
      return (
        <>
          <path d="M4.75 14.75h10.5" />
          <path d="M6.5 14.75V9.5" />
          <path d="M10 14.75V6.75" />
          <path d="M13.5 14.75v-3.5" />
        </>
      )
    case 'helpful':
      return (
        <>
          <path d="M10 14.25V5.75" />
          <path d="M6.75 9l3.25-3.25L13.25 9" />
        </>
      )
    case 'unhelpful':
      return (
        <>
          <path d="M10 5.75v8.5" />
          <path d="M6.75 11l3.25 3.25L13.25 11" />
        </>
      )
    case 'copy':
      return (
        <>
          <rect x="6.5" y="6.5" width="8" height="8" rx="1.75" />
          <path d="M11 6.5V5.75a1.5 1.5 0 0 0-1.5-1.5h-4A1.5 1.5 0 0 0 4 5.75v4A1.5 1.5 0 0 0 5.5 11h1" />
        </>
      )
    case 'retry':
      return (
        <>
          <path d="M6 7.25H3.75V5" />
          <path d="M3.75 7.25A6.25 6.25 0 1 1 5.75 14" />
        </>
      )
    case 'send':
      return (
        <>
          <path d="M4.5 9.25L15.5 4.5l-4.75 11-1.25-4.25z" />
          <path d="M9.5 11.25l6-6.75" />
        </>
      )
    case 'stop':
      return <rect x="5.75" y="5.75" width="8.5" height="8.5" rx="1.5" />
    case 'pdf':
      return (
        <>
          <path d="M6 3.25h5l3 3v10.5H6z" />
          <path d="M11 3.25v3h3" />
          <path d="M8 10h4" />
          <path d="M8 12.75h3" />
        </>
      )
    case 'report':
      return (
        <>
          <rect x="4.5" y="4.5" width="11" height="11" rx="2" />
          <path d="M7 8h6" />
          <path d="M7 10.75h6" />
          <path d="M7 13.5h3.5" />
        </>
      )
    case 'attachment':
      return <path d="M7.5 7.25v5.25a2.25 2.25 0 1 0 4.5 0V6.75a3.75 3.75 0 1 0-7.5 0v6a5.25 5.25 0 1 0 10.5 0V8.5" />
    case 'image':
      return (
        <>
          <rect x="4.75" y="5" width="10.5" height="10" rx="2" />
          <circle cx="8.25" cy="8.5" r="1.1" />
          <path d="M6.5 13l2.5-2.75 2 1.85 2.5-3.1 1.5 1.75" />
        </>
      )
    case 'selection':
      return (
        <>
          <path d="M5.5 5.75h3v3H6.75L5.5 11h2.25" />
          <path d="M11.5 5.75h3v3h-1.75L11.5 11h2.25" />
        </>
      )
    case 'quote':
      return (
        <>
          <path d="M6.25 8.25A1.75 1.75 0 1 1 8 10v2H5.75V10.5A2.95 2.95 0 0 1 6.25 8.25Z" />
          <path d="M11.5 8.25A1.75 1.75 0 1 1 13.25 10v2H11V10.5a2.95 2.95 0 0 1 .5-2.25Z" />
        </>
      )
    case 'clear':
      return (
        <>
          <path d="M6.25 6h7.5" />
          <path d="M8 6V4.75h4V6" />
          <path d="M7 6l.5 8h5l.5-8" />
        </>
      )
    case 'arrow-right':
      return (
        <>
          <path d="M5 10h10" />
          <path d="M11.5 6.5L15 10l-3.5 3.5" />
        </>
      )
    case 'doc':
    default:
      return (
        <>
          <path d="M6 3.25h5l3 3v10.5H6z" />
          <path d="M11 3.25v3h3" />
          <path d="M8 9h4" />
          <path d="M8 12h4" />
        </>
      )
  }
}

function getAttachmentIconName(kind) {
  if (kind === 'pdf') return 'pdf'
  if (kind === 'report') return 'report'
  if (kind === 'image') return 'image'
  return 'attachment'
}

function getAttachmentDescriptor(item) {
  if (item?.kind === 'pdf') return t('papers.chatPdfView')
  if (item?.kind === 'report') return t('papers.chatReportView')
  return t('papers.chatAvailableSources')
}

function ChatHeader({
  title,
  chatOnly,
  compact = false,
  historyCount,
  historyOpen,
  onToggleHistory,
  onCreateSession,
  onOpenWindow,
  onReembed,
  onClose,
}) {
  return (
    <div class="paper-chat-header">
      <div class="paper-chat-header-main">
        <span class="paper-chat-header-mark">
          <ChatIcon name="doc" />
        </span>
        <div class="paper-chat-header-copy">
          <div class="paper-chat-header-meta">
            <span class="paper-chat-header-eyebrow">{t('papers.chatEyebrow')}</span>
            {!!historyCount && <span class="paper-chat-header-count">{historyCount}</span>}
          </div>
          <span class="paper-chat-header-title" title={title}>
            {title}
          </span>
        </div>
      </div>
      <div class="paper-chat-header-actions">
        <button
          type="button"
          class={`paper-chat-header-button ${historyOpen ? 'is-active' : ''}`}
          onClick={onToggleHistory}
          aria-label={t('papers.chatHistory')}
          title={t('papers.chatHistory')}
        >
          <ChatIcon name="history" />
        </button>
        {!compact && (
          <button type="button" class="paper-chat-header-button" onClick={onCreateSession} aria-label={t('papers.chatNewConversation')} title={t('papers.chatNewConversation')}>
            <ChatIcon name="plus" />
          </button>
        )}
        <button
          type="button"
          class="paper-chat-header-button"
          onClick={chatOnly ? onReembed : onOpenWindow}
          aria-label={chatOnly ? t('papers.chatReembed') : t('papers.chatPopout')}
          title={chatOnly ? t('papers.chatReembed') : t('papers.chatPopout')}
        >
          <ChatIcon name={chatOnly ? 'reembed' : 'popout'} />
        </button>
        {chatOnly && (
          <button type="button" class="paper-chat-header-button" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
            <ChatIcon name="close" />
          </button>
        )}
      </div>
    </div>
  )
}

function HistoryDrawer({ open, sessions, activeSessionId, onSelectSession, onCreateSession, onClose }) {
  return (
    <aside class={`paper-chat-history-drawer ${open ? 'is-open' : ''}`} aria-hidden={!open}>
      <div class="paper-chat-history-header">
        <div>
          <span class="paper-chat-history-eyebrow">{t('papers.chatEyebrow')}</span>
          <strong>{t('papers.chatHistory')}</strong>
          <span>{t('papers.chatHistoryScope')}</span>
        </div>
        <button type="button" class="paper-chat-history-close" onClick={onClose} aria-label={t('common.close')}>
          <ChatIcon name="close" />
        </button>
      </div>

      <div class="paper-chat-history-actions">
        <button
          type="button"
          class="paper-chat-history-latest"
          onClick={onCreateSession}
        >
          <ChatIcon name="plus" />
          {t('papers.chatNewConversation')}
        </button>
      </div>

      <div class="paper-chat-history-list">
        {sessions.length ? sessions.map(session => (
          <button
            key={session.sessionId}
            type="button"
            class={`paper-chat-history-item ${activeSessionId === session.sessionId ? 'is-active' : ''}`}
            onClick={() => onSelectSession(session.sessionId)}
          >
            <span class="paper-chat-history-item-rail" aria-hidden="true" />
            <div class="paper-chat-history-item-main">
              <div class="paper-chat-history-item-top">
                <strong class="paper-chat-history-item-question">
                  {session.titlePreview || t('papers.chatHistoryEmptySession')}
                </strong>
                <span class="paper-chat-history-item-time">{formatMessageTime(session.timestamp) || ''}</span>
              </div>
              <div class="paper-chat-history-item-answer">
                {session.replyPreview || t('papers.chatHistoryPending')}
              </div>
            </div>
          </button>
        )) : (
          <div class="paper-chat-history-empty">{t('papers.chatHistoryEmpty')}</div>
        )}
      </div>
    </aside>
  )
}

function EmptyState({ title, onSend, onActivate = null, compact = false }) {
  const starters = [
    { key: 'contribution', icon: 'spark', label: t('papers.chatStarterContribution') },
    { key: 'method', icon: 'method', label: t('papers.chatStarterMethod') },
    { key: 'evidence', icon: 'evidence', label: t('papers.chatStarterEvidence') },
  ]

  return (
    <div class={`paper-chat-empty-state ${compact ? 'is-compact' : ''}`}>
      <div class="paper-chat-empty-kicker">{t('papers.chatEyebrow')}</div>
      <div class="paper-chat-empty-copy">
        <div class="paper-chat-empty-icon">
          <ChatIcon name="spark" />
        </div>
        <div>
          <p class="paper-chat-empty-title">{t('papers.chatAskAnything')}</p>
          <p class="paper-chat-empty-subtitle">{t('papers.chatUsesFullContext')}</p>
        </div>
      </div>
      <div class="paper-chat-empty-actions" onMouseEnter={() => onActivate?.()}>
        {starters.map(item => (
          <button key={`${title}-${item.key}`} type="button" class="paper-chat-empty-action" onClick={() => onSend(item.label)}>
            <span class="paper-chat-empty-action-icon">
              <ChatIcon name={item.icon} />
            </span>
            <span class="paper-chat-empty-action-copy">
              <strong>{item.label}</strong>
            </span>
            <ChatIcon name="arrow-right" className="paper-chat-empty-action-arrow" />
          </button>
        ))}
      </div>
    </div>
  )
}

function getSelectionSummary(selection) {
  if (!selection?.text) return ''
  if (selection.heading) return truncateText(selection.heading, 28)
  if (selection.page) return `${t('papers.chatPage')} ${selection.page}`
  return t('papers.chatSelectionReady')
}

function QuoteBlock({ quote, variant = 'message', onRemove = null }) {
  if (!quote?.text) return null

  const isDraft = variant === 'draft'
  const label = isDraft
    ? (quote.heading || t('papers.chatSelectionReport'))
    : t('papers.chatQuoteBlockLabel')
  const iconName = isDraft ? getAttachmentIconName(quote.source || 'report') : 'quote'

  return (
    <div class={`paper-chat-quote-block ${isDraft ? 'is-draft' : 'is-user'}`}>
      <div class="paper-chat-quote-header">
        <span class="paper-chat-quote-label" title={label}>
          <ChatIcon name={iconName} />
          <span>{label}</span>
        </span>
        {onRemove && (
          <button
            type="button"
            class="paper-chat-quote-remove"
            onClick={onRemove}
            aria-label={t('papers.chatQuoteRemove')}
            title={t('papers.chatQuoteRemove')}
          >
            <ChatIcon name="close" />
          </button>
        )}
      </div>
      <blockquote class="paper-chat-quote-body">
        {renderPlainTextContent(quote.text)}
      </blockquote>
    </div>
  )
}

function ComposerImageStrip({ images, onRemove }) {
  if (!images?.length) return null

  return (
    <div class="paper-chat-image-row" role="list" aria-label={t('papers.chatImagePreviewLabel')}>
      {images.map(image => {
        const src = getDraftImageSrc(image)
        if (!src) return null
        return (
          <div key={image.id || image.path || image.name} class="paper-chat-image-chip" role="listitem">
            <div class="paper-chat-image-thumb">
              <img src={src} alt={image.name || t('papers.chatImageAttachment')} />
            </div>
            <div class="paper-chat-image-copy">
              <strong title={image.name || ''}>{image.name || t('papers.chatImageAttachment')}</strong>
              <span>{image.source === 'paste' ? t('papers.chatImagePasted') : t('papers.chatImageLocal')}</span>
            </div>
            <button
              type="button"
              class="paper-chat-image-remove"
              onClick={() => onRemove?.(image)}
              aria-label={t('papers.chatImageRemove')}
              title={t('papers.chatImageRemove')}
            >
              <ChatIcon name="close" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

function MessageImageStrip({ images }) {
  if (!images?.length) return null
  const previews = useHydratedMessageImages(images)

  return (
    <div class="paper-chat-message-image-strip" role="list" aria-label={t('papers.chatImageAttachment')}>
      {previews.map(({ key, image, status, src }) => {
        const title = image.name || t('papers.chatImageAttachment')

        if (status === 'ready' && src) {
          return (
            <a
              key={key}
              class="paper-chat-message-image"
              href={src}
              target="_blank"
              rel="noreferrer"
              title={title}
            >
              <img src={src} alt={title} loading="lazy" />
              <span>{title}</span>
            </a>
          )
        }

        return (
          <div
            key={key}
            class={`paper-chat-message-image paper-chat-message-image-fallback ${status === 'failed' ? 'is-error' : 'is-loading'}`}
            title={title}
          >
            <div class="paper-chat-message-image-placeholder">
              <ChatIcon name={status === 'failed' ? 'image' : 'attachment'} />
              <strong>{status === 'failed' ? t('papers.chatImageUnavailable') : t('papers.chatImageLoading')}</strong>
            </div>
            <span>{title}</span>
          </div>
        )
      })}
    </div>
  )
}

function PreparingNotice({ hasMessages }) {
  return (
    <div class={`paper-chat-preparing-notice ${hasMessages ? 'has-history' : ''}`}>
      <strong>
        <ChatIcon name="spark" />
        <span>{t('papers.chatPreparingTitle')}</span>
      </strong>
      <span>{t('papers.chatPreparingBody')}</span>
    </div>
  )
}

function StreamControls({ session, lastAssistant }) {
  const canRetry = !!getLastUserMessage(session?.messages)
    && !['streaming', 'retrying', 'preparing'].includes(session?.status)
    && ['stopped', 'error'].includes(lastAssistant?.status)

  if (session?.status === 'streaming') {
    return (
      <div class="paper-chat-stream-controls">
        <button type="button" class="paper-chat-stream-button paper-chat-stream-button-stop" onClick={() => stopActivePaperChatStream()}>
          <ChatIcon name="stop" />
          <span>{t('papers.chatStop')}</span>
        </button>
      </div>
    )
  }

  if (!canRetry) return null

  return (
    <div class="paper-chat-stream-controls">
      <button type="button" class="paper-chat-stream-button" onClick={() => retryLastPaperChatTurn()}>
        <ChatIcon name="retry" />
        <span>{t('papers.chatRetry')}</span>
      </button>
    </div>
  )
}

function MessageBubble({ message, isLastAssistant, onJumpCitation }) {
  const isUser = message.role === 'user'
  const userAttachments = isUser ? resolveUserMessageAttachments(message) : []
  const messageImages = isUser ? getMessageImageAttachments(message) : []
  const userContent = isUser ? parseUserMessageContent(message.content || '') : null
  const userQuote = userContent?.quote || null
  const userText = userContent?.body || ''
  const assistantHtml = !isUser && message.content ? renderAssistantContent(message.content) : ''
  const showActions = !isUser && message.status !== 'streaming'
  const messageTime = formatMessageTime(message.createdAt || message.updatedAt || message.timestamp)
  const messageMetaAttachments = (message.attachments || []).filter(item => item?.kind !== 'image')

  return (
    <article class={`paper-chat-message paper-chat-message-${isUser ? 'user' : 'assistant'}`}>
      <div class="paper-chat-message-shell">
        <div class="paper-chat-message-topline">
          <span class="paper-chat-message-role">{isUser ? t('papers.chatYou') : t('papers.chatAssistant')}</span>
          {!!messageTime && <span class="paper-chat-message-time">{messageTime}</span>}
        </div>

        {!!messageMetaAttachments.length && (
          <div class="paper-chat-message-meta">
            {messageMetaAttachments.map(item => (
              <span key={`${message.id}-${item.kind}`} class="paper-chat-message-source">
                <ChatIcon name={getAttachmentIconName(item.kind)} />
                <span>{item.label}</span>
              </span>
            ))}
          </div>
        )}

        {isUser ? (
          <div class="paper-chat-message-user-body">
            <MessageImageStrip images={messageImages} />
            {!!userAttachments.length && (
              <div class="paper-chat-message-user-pills">
                {userAttachments.map(item => (
                  <span key={`${message.id}-${item.kind}-${item.label}`} class="paper-chat-inline-mention">
                    <ChatIcon name={getAttachmentIconName(item.kind)} />
                    {item.label}
                  </span>
                ))}
              </div>
            )}
            {userQuote && (
              <QuoteBlock quote={userQuote} variant="message" />
            )}
            {!!userText && <p>{renderPlainTextContent(userText)}</p>}
          </div>
        ) : (
          <div
            class="paper-chat-message-assistant-body"
            onClick={async event => {
              const link = event.target.closest('a[href]')
              if (link) {
                const rawHref = link.getAttribute('href') || ''
                if (!rawHref || rawHref.startsWith('#')) return
                event.preventDefault()
                try {
                  await openExternalUrl(link.href || rawHref)
                } catch (err) {
                  showToast(friendlyError(err))
                }
                return
              }

              const cite = event.target.closest('.paper-chat-inline-cite')
              if (!cite) return
              onJumpCitation?.({
                id: `${cite.dataset.source}-${cite.dataset.page || cite.dataset.heading}`,
                source: cite.dataset.source,
                page: cite.dataset.page ? Number(cite.dataset.page) : null,
                heading: cite.dataset.heading || null,
                snippet: cite.dataset.snippet || null,
              })
            }}
          >
            {assistantHtml ? (
              <div class="paper-chat-markdown" dangerouslySetInnerHTML={{ __html: assistantHtml }} />
            ) : (
              <div class="paper-chat-assistant-placeholder">
                {message.status === 'streaming' ? t('papers.chatThinking') : t('papers.chatEmptyMessage')}
              </div>
            )}
            {message.status === 'streaming' && <span class="paper-chat-stream-cursor">▊</span>}
          </div>
        )}

        {showActions && (
          <div class="paper-chat-message-actions" role="toolbar" aria-label={t('papers.chatAssistant')}>
            <button type="button" class="paper-chat-message-action" title={t('papers.chatHelpful')} aria-label={t('papers.chatHelpful')} onClick={() => showToast(t('papers.chatHelpful'))}>
              <ChatIcon name="helpful" />
            </button>
            <button type="button" class="paper-chat-message-action" title={t('papers.chatUnhelpful')} aria-label={t('papers.chatUnhelpful')} onClick={() => showToast(t('papers.chatUnhelpful'))}>
              <ChatIcon name="unhelpful" />
            </button>
            <button type="button" class="paper-chat-message-action" title={t('papers.chatCopy')} aria-label={t('papers.chatCopy')} onClick={() => void handleCopyMessage(message.content || '')}>
              <ChatIcon name="copy" />
            </button>
            {isLastAssistant && (
              <button type="button" class="paper-chat-message-action" title={t('papers.chatRetry')} aria-label={t('papers.chatRetry')} onClick={() => retryLastPaperChatTurn()}>
                <ChatIcon name="retry" />
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  )
}

function ChatInput({
  session,
  textareaRef,
  draft,
  draftQuote,
  canSend,
  draftAttachments,
  draftImages,
  selection,
  mentionOpen,
  mentionQuery,
  mentionOptions,
  vlmEnabled,
  onMentionPick,
  onPickImages,
  onPasteImages,
  onRemoveDraftImage,
  onRemoveDraftAttachment,
  onClearDraftAttachments,
  onClearDraftQuote,
  onSend,
  onDraftChange,
  onEnsureSession = null,
  compact = false,
}) {
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0)
  const suggestedQuestions = session?.suggestedQuestions || []
  const showSuggestions = !compact && !!suggestedQuestions.length
  const showContextRow = !!draftAttachments.length || !!selection?.text
  const showImageRow = !!draftImages.length
  const selectionSummary = getSelectionSummary(selection)
  const mentionVisible = mentionOpen && !!mentionOptions.length
  const mentionListId = `paper-chat-mention-list-${session?.sessionId || 'default'}`
  const clampedMentionIndex = mentionVisible ? Math.min(mentionActiveIndex, mentionOptions.length - 1) : -1
  const activeMentionOption = clampedMentionIndex >= 0 ? mentionOptions[clampedMentionIndex] : null
  const activeMentionId = activeMentionOption ? `${mentionListId}-${activeMentionOption.kind}` : undefined

  useEffect(() => {
    if (!mentionVisible) {
      setMentionActiveIndex(0)
      return
    }
    setMentionActiveIndex(current => Math.min(current, mentionOptions.length - 1))
  }, [mentionVisible, mentionOptions.length])

  useEffect(() => {
    if (!mentionVisible) return
    setMentionActiveIndex(0)
  }, [mentionVisible, mentionQuery])

  function closeMentionMenu() {
    setPaperChatMentionState({ open: false, query: '' })
  }

  return (
    <div class={`paper-chat-input-area ${compact ? 'is-compact' : ''}`}>
      {showSuggestions && (
        <div class="paper-chat-suggestions">
          {suggestedQuestions.map((item, index) => (
            <button key={`${item}-${index}`} type="button" class="paper-chat-suggestion-chip" onClick={() => setPaperChatDraft(item)}>
              <ChatIcon name="spark" />
              {item}
            </button>
          ))}
        </div>
      )}

      {showImageRow && (
        <ComposerImageStrip
          images={draftImages}
          onRemove={onRemoveDraftImage}
        />
      )}

      {showContextRow && (
        <div class="paper-chat-context-row">
          {draftAttachments.map(item => (
            <div key={item.kind} class="paper-chat-context-chip">
              <ChatIcon name={getAttachmentIconName(item.kind)} />
              <span>{item.label}</span>
              <button type="button" onClick={() => onRemoveDraftAttachment(item)} aria-label={t('papers.chatRemoveAttachment')}>
                <ChatIcon name="close" />
              </button>
            </div>
          ))}
          {selection?.text && (
            <div
              class="paper-chat-context-chip paper-chat-context-chip-selection"
              title={`${selection.source === 'pdf' ? t('papers.chatSelectionPdf') : t('papers.chatSelectionReport')}: ${selectionSummary}`}
            >
              <ChatIcon name={selection.source === 'pdf' ? 'pdf' : 'report'} />
              <strong title={selectionSummary}>{selectionSummary}</strong>
              <div class="paper-chat-context-chip-tools">
                <button
                  type="button"
                  class="paper-chat-context-chip-tool"
                  onClick={seedDraftFromSelection}
                  aria-label={t('papers.selectionAsk')}
                  title={t('papers.selectionAsk')}
                >
                  <ChatIcon name="spark" />
                </button>
                <button
                  type="button"
                  class="paper-chat-context-chip-tool"
                  onClick={insertSelectionIntoDraft}
                  aria-label={t('papers.selectionQuote')}
                  title={t('papers.selectionQuote')}
                >
                  <ChatIcon name="quote" />
                </button>
                <button
                  type="button"
                  class="paper-chat-context-chip-tool"
                  onClick={clearPaperSelection}
                  aria-label={t('common.close')}
                  title={t('common.close')}
                >
                  <ChatIcon name="close" />
                </button>
              </div>
            </div>
          )}
          {!!draftAttachments.length && (
            <button type="button" class="paper-chat-context-action" onClick={onClearDraftAttachments}>
              <ChatIcon name="clear" />
              {t('papers.chatClearAttachments')}
            </button>
          )}
        </div>
      )}

      {draftQuote?.text && (
        <QuoteBlock
          quote={draftQuote}
          variant="draft"
          onRemove={onClearDraftQuote}
        />
      )}

      <div class="paper-chat-input-stack">
        {mentionVisible && (
          <div id={mentionListId} class="paper-chat-mention-menu" role="listbox" aria-label={t('papers.chatAvailableSources')}>
            {mentionOptions.map((item, index) => (
              <button
                key={item.kind}
                id={`${mentionListId}-${item.kind}`}
                type="button"
                role="option"
                aria-selected={index === clampedMentionIndex}
                class={`paper-chat-mention-item ${index === clampedMentionIndex ? 'is-active' : ''}`}
                onMouseDown={event => event.preventDefault()}
                onClick={() => onMentionPick(item)}
              >
                <span class={`paper-chat-mention-icon is-${item.kind}`}>
                  <ChatIcon name={getAttachmentIconName(item.kind)} />
                </span>
                <span class="paper-chat-mention-copy">
                  <strong>{item.label}</strong>
                  <span>{getAttachmentDescriptor(item)}</span>
                </span>
                <span class="paper-chat-mention-kind">{item.kind}</span>
              </button>
            ))}
          </div>
        )}

        <div class="paper-chat-input-capsule">
          <button
            type="button"
            class={`paper-chat-input-tool ${vlmEnabled ? '' : 'is-disabled'}`.trim()}
            onClick={() => onPickImages?.()}
            aria-label={t('papers.chatImagePicker')}
            title={t('papers.chatImagePicker')}
            aria-disabled={!vlmEnabled}
          >
            <ChatIcon name="image" />
          </button>
          <textarea
            ref={textareaRef}
            class="paper-chat-input"
            rows={1}
            value={draft}
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={mentionVisible}
            aria-controls={mentionVisible ? mentionListId : undefined}
            aria-activedescendant={mentionVisible ? activeMentionId : undefined}
            aria-label={t('papers.chatPlaceholder')}
            onInput={onDraftChange}
            onFocus={() => {
              onEnsureSession?.()
            }}
            onPaste={event => {
              onPasteImages?.(event)
            }}
            onKeyDown={event => {
              if (event.isComposing) {
                return
              }

              const isPlainEnter = event.key === 'Enter' && !event.shiftKey
              const isPlainTab = event.key === 'Tab' && !event.shiftKey

              if (mentionVisible && event.key === 'ArrowDown') {
                event.preventDefault()
                setMentionActiveIndex(current => (current + 1) % mentionOptions.length)
                return
              }
              if (mentionVisible && event.key === 'ArrowUp') {
                event.preventDefault()
                setMentionActiveIndex(current => (current - 1 + mentionOptions.length) % mentionOptions.length)
                return
              }
              if (mentionVisible && (isPlainEnter || isPlainTab)) {
                event.preventDefault()
                onMentionPick(mentionOptions[clampedMentionIndex] || mentionOptions[0])
                return
              }
              if (mentionOpen && event.key === 'Escape') {
                event.preventDefault()
                closeMentionMenu()
                return
              }
              if (isPlainEnter) {
                event.preventDefault()
                if (canSend) onSend()
              }
            }}
            onClick={event => {
              onEnsureSession?.()
              const nextValue = event.currentTarget.value
              const token = resolveMentionToken(nextValue, event.currentTarget.selectionStart ?? nextValue.length)
              setPaperChatMentionState(token ? { open: true, query: token.token } : { open: false, query: '' })
            }}
            onBlur={() => {
              requestAnimationFrame(() => {
                if (document.activeElement !== textareaRef.current) {
                  closeMentionMenu()
                }
              })
            }}
            placeholder={t('papers.chatPlaceholder')}
          />
          <button type="button" class={`paper-chat-send-button ${canSend ? 'is-active' : ''}`} disabled={!canSend} onClick={onSend} aria-label={t('papers.chatSend')} title={t('papers.chatSend')}>
            <ChatIcon name="send" />
          </button>
        </div>
      </div>
    </div>
  )
}

export function PaperChatDock({
  session,
  chatOnly = false,
  compact = false,
  onJumpCitation,
  onEnsureSession = null,
  onRequestReembed = null,
  onRequestClose = null,
}) {
  const textareaRef = useRef(null)
  const messagesRef = useRef(null)
  const sendLockRef = useRef(false)
  const paperMeta = activePaperChatPaper.value
  const draft = paperChatDraft.value
  const draftQuote = paperChatDraftQuote.value
  const draftAttachments = paperChatDraftAttachments.value
  const draftImages = paperChatDraftImages.value
  const historyOpen = paperChatHistoryPanelOpen.value
  const mentionQuery = paperChatActiveMentionQuery.value
  const mentionOpen = paperChatMentionMenuOpen.value
  const selection = paperSelectionContext.value
  const vlmEnabled = !!config.value.vlmEnabled
  const sessionCards = buildSessionCards(getCurrentPaperChatSessions())
  const visibleMessages = session?.messages || []
  const lastAssistant = getLastAssistantMessage(visibleMessages)
  const canSend = (!!draft.trim() || !!draftQuote?.text)
    && !['streaming', 'retrying', 'preparing', 'loading'].includes(session?.status || '')
  const mentionOptions = (session?.availableAttachments || []).filter(item => {
    const normalizedQuery = mentionQuery.trim().replace(/^@/, '').toLowerCase()
    if (!normalizedQuery) return true
    return item.label.toLowerCase().includes(normalizedQuery)
      || item.kind.toLowerCase().includes(normalizedQuery)
  })

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, compact ? 80 : 120)}px`
  }, [compact, draft])

  useEffect(() => {
    const container = messagesRef.current
    if (!container) return
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight
    })
  }, [visibleMessages.length, lastAssistant?.content, session?.status, session?.sessionId])

  function updateMentionState(value, caret = value.length) {
    const token = resolveMentionToken(value, caret)
    if (!token) {
      setPaperChatMentionState({ open: false, query: '' })
      return
    }
    setPaperChatMentionState({ open: true, query: token.token })
  }

  function handleMentionPick(item) {
    const textarea = textareaRef.current
    const token = resolveMentionToken(draft, textarea?.selectionStart ?? draft.length)
    const nextDraft = removeResolvedMentionToken(draft, token)

    setPaperChatDraft(nextDraft)
    addPaperChatDraftAttachment({ kind: item.kind, label: item.label, sourceState: 'mentioned' })
    requestAnimationFrame(() => {
      textarea?.focus()
      const cursor = nextDraft.length
      textarea?.setSelectionRange(cursor, cursor)
    })
  }

  function handleRemoveDraftAttachment(item) {
    removePaperChatDraftAttachment(item.kind)
  }

  function handleClearDraftAttachments() {
    clearPaperChatDraftAttachments()
  }

  function showImageLimitToast() {
    showToast(t('papers.chatImageLimitReached', { count: PAPER_CHAT_MAX_DRAFT_IMAGES }))
  }

  function showVlmDisabledToast() {
    showToast(t('papers.chatImageVlmDisabled'))
  }

  async function handleCopyMessage(content) {
    try {
      await copyText(content || '')
      showToast(t('papers.copied'))
    } catch (err) {
      showToast(t('papers.copyFailed') + ': ' + friendlyError(err))
    }
  }

  function handleRemoveDraftImage(image) {
    removePaperChatDraftImage(image?.id)
  }

  async function handlePickImages() {
    warmChatSession()

    if (!vlmEnabled) {
      showVlmDisabledToast()
      return
    }

    const remaining = PAPER_CHAT_MAX_DRAFT_IMAGES - draftImages.length
    if (remaining <= 0) {
      showImageLimitToast()
      return
    }

    try {
      const pickedPaths = await pickImageFiles()
      if (!pickedPaths.length) return

      const trimmedPaths = pickedPaths.slice(0, remaining)
      if (pickedPaths.length > trimmedPaths.length) {
        showImageLimitToast()
      }

      const nextImages = await Promise.all(trimmedPaths.map(async path => {
        const bytes = await readBinaryFile(path)
        const mime = inferImageMime(path)
        return {
          id: createDraftImageId(),
          source: 'picker',
          path,
          name: getFileNameFromPath(path) || t('papers.chatImageAttachment'),
          mime,
          sizeBytes: bytes.length,
          objectUrl: bytesToObjectUrl(bytes, mime),
        }
      }))

      addPaperChatDraftImages(nextImages)
    } catch (err) {
      showToast(`${t('papers.chatImagePickFailed')}: ${friendlyError(err)}`)
    }
  }

  async function handlePasteImages(event) {
    const clipboardItems = [...(event.clipboardData?.items || [])]
    const imageItems = clipboardItems.filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    if (!imageItems.length) return

    event.preventDefault()
    warmChatSession()

    if (!vlmEnabled) {
      showVlmDisabledToast()
      return
    }

    const remaining = PAPER_CHAT_MAX_DRAFT_IMAGES - draftImages.length
    if (remaining <= 0) {
      showImageLimitToast()
      return
    }

    try {
      const trimmedItems = imageItems.slice(0, remaining)
      if (imageItems.length > trimmedItems.length) {
        showImageLimitToast()
      }

      const nextImages = []
      for (const item of trimmedItems) {
        const file = item.getAsFile()
        if (!file) continue
        const dataUrl = await fileToDataUrl(file)
        nextImages.push({
          id: createDraftImageId(),
          source: 'paste',
          name: file.name || `clipboard-image-${Date.now()}.png`,
          mime: inferImageMime(file.type),
          sizeBytes: file.size || undefined,
          objectUrl: URL.createObjectURL(file),
          dataUrl,
        })
      }

      if (!nextImages.length) {
        showToast(t('papers.chatImagePasteUnsupported'))
        return
      }

      addPaperChatDraftImages(nextImages)
    } catch (err) {
      showToast(`${t('papers.chatImagePasteFailed')}: ${friendlyError(err)}`)
    }
  }

  async function ensureSessionReady() {
    if (session?.sessionId) return session.sessionId
    return await onEnsureSession?.()
  }

  function warmChatSession() {
    if (session?.sessionId) return
    void ensureSessionReady()
  }

  async function handleSend(question) {
    if (sendLockRef.current) return
    sendLockRef.current = true
    try {
      const sessionId = await ensureSessionReady()
      if (!sessionId) return
      await sendPaperChatQuestion(question)
    } finally {
      sendLockRef.current = false
    }
  }

  async function handleToggleHistory() {
    if (historyOpen) {
      setPaperChatHistoryPanelOpen(false)
      return
    }
    const sessionId = await ensureSessionReady()
    if (!sessionId) return
    setPaperChatHistoryPanelOpen(true)
  }

  async function handleCreateSession() {
    const sessionId = await ensureSessionReady()
    if (!sessionId) return
    await createNewPaperChatSession()
    setPaperChatHistoryPanelOpen(false)
  }

  async function handleOpenWindow() {
    const sessionId = await ensureSessionReady()
    if (!sessionId) return
    await openActivePaperChatWindow()
  }

  return (
    <aside class={`paper-chat-dock ${chatOnly ? 'paper-chat-dock-window' : ''} ${compact ? 'is-compact' : ''}`}>
      <ChatHeader
        title={session?.title || paperMeta?.title || t('papers.chatTitle')}
        chatOnly={chatOnly}
        compact={compact}
        historyCount={sessionCards.length}
        historyOpen={historyOpen}
        onToggleHistory={handleToggleHistory}
        onCreateSession={handleCreateSession}
        onOpenWindow={handleOpenWindow}
        onReembed={onRequestReembed}
        onClose={onRequestClose}
      />

      {session?.pdfWarning && (
        <div class="paper-chat-warning-strip">{session.pdfWarning}</div>
      )}
      {session?.reportWarning && (
        <div class="paper-chat-warning-strip">{session.reportWarning}</div>
      )}

      {session?.status === 'preparing' && (
        <PreparingNotice hasMessages={!!session?.messages?.length} />
      )}

      <div class="paper-chat-body">
        <HistoryDrawer
          open={historyOpen}
          sessions={sessionCards}
          activeSessionId={session?.sessionId || null}
          onSelectSession={async sessionId => {
            await selectPaperChatSession(sessionId)
            setPaperChatHistoryPanelOpen(false)
          }}
          onCreateSession={handleCreateSession}
          onClose={() => setPaperChatHistoryPanelOpen(false)}
        />

        <div class="paper-chat-thread">
          <div ref={messagesRef} class="paper-chat-messages">
            {visibleMessages.length ? (
              visibleMessages.map(message => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  isLastAssistant={message.id === lastAssistant?.id}
                  onJumpCitation={onJumpCitation}
                />
              ))
            ) : (
              <EmptyState
                title={session?.title || paperMeta?.title || ''}
                onSend={handleSend}
                onActivate={warmChatSession}
                compact={compact}
              />
            )}
          </div>

          <StreamControls session={session} lastAssistant={lastAssistant} />

          <ChatInput
            session={session}
            textareaRef={textareaRef}
            draft={draft}
            draftQuote={draftQuote}
            canSend={canSend}
            draftAttachments={draftAttachments}
            draftImages={draftImages}
            selection={selection}
            mentionOpen={mentionOpen}
            mentionQuery={mentionQuery}
            mentionOptions={mentionOptions}
            vlmEnabled={vlmEnabled}
            onMentionPick={handleMentionPick}
            onPickImages={handlePickImages}
            onPasteImages={handlePasteImages}
            onRemoveDraftImage={handleRemoveDraftImage}
            onRemoveDraftAttachment={handleRemoveDraftAttachment}
            onClearDraftAttachments={handleClearDraftAttachments}
            onClearDraftQuote={clearPaperChatDraftQuote}
            onSend={() => handleSend()}
            onDraftChange={event => {
              const nextValue = event.currentTarget.value
              setPaperChatDraft(nextValue)
              updateMentionState(nextValue, event.currentTarget.selectionStart ?? nextValue.length)
            }}
            onEnsureSession={warmChatSession}
            compact={compact}
          />
        </div>
      </div>
    </aside>
  )
}
