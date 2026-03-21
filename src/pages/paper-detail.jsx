import { useEffect, useRef, useState } from 'preact/hooks'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { closePaperDetail, paperHistory, paperTasks } from '../lib/paperQueue.js'
import {
  collectTextNodesFromRoots,
  findTextNodeMatch,
  normalizeSearchText,
  unwrapCitationHighlights,
  wrapTextNodeMatch,
} from '../lib/textSearch.js'
import {
  clearPaperSelection,
  ensurePaperChatSession,
  getActivePaperChatSession,
  primePaperChatPaper,
  setPaperSelection,
} from '../lib/paperChat.js'
import {
  activePaperChatWindowSessionId,
  currentPaperDetailId,
  paperChatPresentation,
  paperSelectionContext,
  paperWorkspaceMode,
  showToast,
} from '../lib/store.js'
import { copyText, friendlyError, openExternalUrl, readPaperArchiveMarkdown, revealInFinder } from '../lib/tauri.js'
import { t } from '../lib/i18n.js'
import { PaperChatDock } from '../components/PaperChatDock.jsx'
import { PaperPdfViewer } from '../components/PaperPdfViewer.jsx'
import { SelectionAskBubble } from '../components/SelectionAskBubble.jsx'

marked.setOptions({
  gfm: true,
  breaks: false,
})

const REPORT_SNIPPET_HIGHLIGHT_TYPE = 'report-snippet'
const TEMP_HIGHLIGHT_DURATION_MS = 2200

export function PaperDetailPage() {
  const queueTask = paperTasks.value.find(item => item.id === currentPaperDetailId.value)
  const historyItem = queueTask ? null : paperHistory.value.find(item => item.id === currentPaperDetailId.value)
  const [historyMarkdown, setHistoryMarkdown] = useState('')
  const [historyLoadError, setHistoryLoadError] = useState('')
  const [renderedReport, setRenderedReport] = useState('')
  const [jumpCitation, setJumpCitation] = useState(null)
  const [chatActivated, setChatActivated] = useState(false)
  const articleRef = useRef(null)
  const chatPrepareRef = useRef({ key: '', promise: null })
  const pendingReportSelectionRef = useRef(null)
  const lastReportRangeRef = useRef(null)
  const selectionCommitFrameRef = useRef(0)

  useEffect(() => {
    let cancelled = false

    if (!historyItem?.savedPath) {
      setHistoryMarkdown('')
      setHistoryLoadError('')
      return () => {}
    }

    setHistoryMarkdown('')
    setHistoryLoadError('')
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()

    readPaperArchiveMarkdown(historyItem.savedPath)
      .then(content => {
        if (!cancelled) {
          setHistoryMarkdown(content)
          const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt
          console.info('[paper-perf] read_paper_archive_markdown', {
            path: historyItem.savedPath,
            elapsedMs: Math.round(elapsedMs),
            chars: content.length,
          })
        }
      })
      .catch(err => {
        if (!cancelled) {
          setHistoryLoadError(friendlyError(err))
          const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt
          console.info('[paper-perf] read_paper_archive_markdown.error', {
            path: historyItem.savedPath,
            elapsedMs: Math.round(elapsedMs),
            error: friendlyError(err),
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [historyItem?.id, historyItem?.savedPath])

  const isLivePreview = !!queueTask && !queueTask.result
  const livePreviewResult = isLivePreview ? {
    title: queueTask.previewMeta?.title || '',
    venue: queueTask.previewMeta?.venue || '',
    year: queueTask.previewMeta?.year || '',
    extractor: '',
    savedPath: '',
    extractionWarning: '',
    markdown: queueTask.previewMarkdown || '',
    sourcePath: queueTask.path,
  } : null
  const result = queueTask?.result || livePreviewResult || (historyItem ? {
    title: historyItem.title,
    venue: historyItem.venue,
    year: historyItem.year,
    extractor: historyItem.extractor,
    savedPath: historyItem.savedPath,
    extractionWarning: historyItem.extractionWarning,
    markdown: historyMarkdown,
    sourcePath: historyItem.sourcePath,
  } : null)

  const title = result?.title || queueTask?.previewMeta?.title || queueTask?.originalName || historyItem?.originalName
  const markdown = result?.markdown || queueTask?.previewMarkdown || ''
  const sourcePath = result?.sourcePath || queueTask?.path || historyItem?.sourcePath || ''
  const workspaceMode = paperWorkspaceMode.value
  const paperIdentity = `${sourcePath}::${result?.savedPath || ''}::${title || ''}`
  const activeSession = getActivePaperChatSession()
  const matchedActiveSession = activeSession && (
    activeSession.sourcePath === sourcePath
    || (result?.savedPath && activeSession.savedPath === result.savedPath)
  ) ? activeSession : null
  const session = chatActivated ? matchedActiveSession : null

  useEffect(() => {
    if (!result) return
    primePaperChatPaper({
      sourcePath,
      savedPath: result.savedPath || '',
      title: title || queueTask?.originalName || historyItem?.originalName || '',
    })
    setChatActivated(false)
    chatPrepareRef.current = { key: '', promise: null }
  }, [paperIdentity])

  useEffect(() => {
    if (paperSelectionContext.value?.source === 'pdf') {
      clearPaperSelection()
    }
  }, [result?.savedPath, sourcePath])

  useEffect(() => {
    pendingReportSelectionRef.current = null
    lastReportRangeRef.current = null
    if (selectionCommitFrameRef.current) {
      window.cancelAnimationFrame(selectionCommitFrameRef.current)
      selectionCommitFrameRef.current = 0
    }
    if (paperSelectionContext.value?.source === 'report') {
      clearPaperSelection()
    }
  }, [paperIdentity, renderedReport])

  useEffect(() => {
    if (workspaceMode !== 'pdf') return
    pendingReportSelectionRef.current = null
    lastReportRangeRef.current = null
    if (selectionCommitFrameRef.current) {
      window.cancelAnimationFrame(selectionCommitFrameRef.current)
      selectionCommitFrameRef.current = 0
    }
    if (paperSelectionContext.value?.source === 'report') {
      clearPaperSelection()
    }
  }, [workspaceMode])

  useEffect(() => {
    if (!markdown) {
      setRenderedReport('')
      return () => {}
    }

    try {
      const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
      const html = DOMPurify.sanitize(marked.parse(markdown))
      setRenderedReport(decorateReportHtml(html))
      const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt
      console.info('[paper-perf] render_report_html', {
        title: title || '',
        elapsedMs: Math.round(elapsedMs),
        chars: markdown.length,
      })
    } catch (err) {
      console.info('[paper-perf] render_report_html.error', {
        title: title || '',
        error: friendlyError(err),
      })
      setRenderedReport('')
    }
    return () => {}
  }, [markdown])

  useEffect(() => {
    const article = articleRef.current
    if (!article) return () => {}

    async function handleExternalLinkClick(event) {
      const link = event.target.closest('a[href]')
      if (!link || !article.contains(link)) return

      const rawHref = link.getAttribute('href') || ''
      if (!rawHref || rawHref.startsWith('#')) return

      event.preventDefault()
      try {
        await openExternalUrl(link.href || rawHref)
      } catch (err) {
        showToast(friendlyError(err))
      }
    }

    function clearResolvedReportSelection() {
      pendingReportSelectionRef.current = null
      lastReportRangeRef.current = null
      if (paperSelectionContext.value?.source === 'report') {
        clearPaperSelection()
      }
    }

    function updatePendingSelection() {
      const resolved = resolveReportSelection(article)
      pendingReportSelectionRef.current = resolved
      if (!resolved) {
        lastReportRangeRef.current = null
        if (paperSelectionContext.value?.source === 'report') {
          clearPaperSelection()
        }
      }
    }

    function commitSelection() {
      if (selectionCommitFrameRef.current) {
        window.cancelAnimationFrame(selectionCommitFrameRef.current)
      }
      selectionCommitFrameRef.current = window.requestAnimationFrame(() => {
        selectionCommitFrameRef.current = 0
        const resolved = resolveReportSelection(article) || pendingReportSelectionRef.current
        if (!resolved) {
          clearResolvedReportSelection()
          return
        }
        pendingReportSelectionRef.current = resolved
        lastReportRangeRef.current = resolved.range
        setPaperSelection(resolved.selection)
      })
    }

    function remeasureSelectionRect() {
      if (paperSelectionContext.value?.source !== 'report') return
      const range = lastReportRangeRef.current
      if (!range || !isRangeInsideRoot(article, range)) {
        clearResolvedReportSelection()
        return
      }

      const rect = measureRangeRect(range)
      if (!rect) {
        clearResolvedReportSelection()
        return
      }

      setPaperSelection({
        ...paperSelectionContext.value,
        rect,
      })
    }

    function handlePointerDown(event) {
      const target = event.target
      if (!(target instanceof Node)) return
      if (article.contains(target)) return
      if (target instanceof Element && target.closest('.selection-ask-bubble')) return
      if (paperSelectionContext.value?.source === 'report') {
        clearResolvedReportSelection()
      }
    }

    article.addEventListener('click', handleExternalLinkClick)
    document.addEventListener('selectionchange', updatePendingSelection)
    document.addEventListener('pointerup', commitSelection)
    document.addEventListener('keyup', commitSelection)
    document.addEventListener('touchend', commitSelection)
    document.addEventListener('pointerdown', handlePointerDown, true)
    article.addEventListener('scroll', remeasureSelectionRect, { passive: true })
    window.addEventListener('resize', remeasureSelectionRect)

    return () => {
      if (selectionCommitFrameRef.current) {
        window.cancelAnimationFrame(selectionCommitFrameRef.current)
        selectionCommitFrameRef.current = 0
      }
      article.removeEventListener('click', handleExternalLinkClick)
      document.removeEventListener('selectionchange', updatePendingSelection)
      document.removeEventListener('pointerup', commitSelection)
      document.removeEventListener('keyup', commitSelection)
      document.removeEventListener('touchend', commitSelection)
      document.removeEventListener('pointerdown', handlePointerDown, true)
      article.removeEventListener('scroll', remeasureSelectionRect)
      window.removeEventListener('resize', remeasureSelectionRect)
    }
  }, [renderedReport, workspaceMode])

  useEffect(() => {
    if (!jumpCitation || jumpCitation.source !== 'report' || !articleRef.current) return
    const article = articleRef.current
    unwrapCitationHighlights(article, REPORT_SNIPPET_HIGHLIGHT_TYPE)
    const target = findReportHeadingTarget(article, jumpCitation.heading || '')
    if (!target) return

    const snippetMatch = jumpCitation.snippet
      ? highlightReportSnippet(article, target, jumpCitation.snippet)
      : null

    if (snippetMatch) {
      snippetMatch.scrollIntoView({ block: 'center', behavior: 'smooth' })
      window.setTimeout(() => {
        unwrapCitationHighlights(article, REPORT_SNIPPET_HIGHLIGHT_TYPE)
      }, TEMP_HIGHLIGHT_DURATION_MS)
      return
    }

    target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    flashElementClass(target, 'paper-report-heading-highlight')
  }, [jumpCitation?.id, renderedReport])

  if (!result) {
    return (
      <div class="main">
        <div class="paper-detail-empty">
          <h3>{t('papers.detailUnavailable')}</h3>
          <button class="btn btn-secondary" onClick={closePaperDetail}>{t('papers.back')}</button>
        </div>
      </div>
    )
  }

  async function ensureCurrentPaperChatSession() {
    if (!result) return null
    if (matchedActiveSession?.sessionId) {
      setChatActivated(true)
      return matchedActiveSession.sessionId
    }

    if (chatPrepareRef.current.key === paperIdentity && chatPrepareRef.current.promise) {
      const sessionId = await chatPrepareRef.current.promise
      if (sessionId) setChatActivated(true)
      return sessionId
    }

    const promise = ensurePaperChatSession({
      sourcePath,
      savedPath: result.savedPath || '',
      title: title || queueTask?.originalName || historyItem?.originalName || '',
    })
      .catch(err => {
        showToast(`${t('papers.chatPrepareFailed')}: ${friendlyError(err)}`)
        return null
      })
      .finally(() => {
        if (chatPrepareRef.current.promise === promise) {
          chatPrepareRef.current = { key: '', promise: null }
        }
      })

    chatPrepareRef.current = { key: paperIdentity, promise }
    const sessionId = await promise
    if (sessionId) {
      setChatActivated(true)
    }
    return sessionId
  }

  async function handleCopy() {
    if (!markdown) {
      showToast(t('papers.markdownUnavailable'))
      return
    }
    try {
      await copyText(markdown)
      showToast(isLivePreview ? t('papers.previewCopied') : t('papers.copied'))
    } catch (err) {
      showToast(t('papers.copyFailed') + ': ' + friendlyError(err))
    }
  }

  const canShowPdf = !!sourcePath
  const canShowReport = !!markdown
  const isDetached = !!session
    && paperChatPresentation.value === 'detached'
    && activePaperChatWindowSessionId.value === session.sessionId

  function handleJumpCitation(citation) {
    if (!citation?.source) return

    if (paperWorkspaceMode.value !== 'split') {
      paperWorkspaceMode.value = citation.source === 'pdf' ? 'pdf' : 'report'
    }

    const targetKey = citation.source === 'pdf'
      ? citation.page || 'page'
      : citation.heading || 'heading'
    setJumpCitation({
      ...citation,
      id: `${citation.source}-${targetKey}-${Date.now()}`,
      snippet: citation.snippet || null,
    })
  }

  return (
    <div class="main">
      <div class="paper-workspace-page">
        <div class="paper-detail-topbar">
          <button class="paper-detail-back" onClick={closePaperDetail}>{t('papers.back')}</button>
          <div class="paper-detail-meta">
            <span class="paper-detail-eyebrow">{t('papers.eyebrow')}</span>
            <h2>{title}</h2>
            <div class="paper-detail-tags">
              {isLivePreview && <span class="paper-detail-live-tag">{t('papers.livePreview')}</span>}
              {queueTask?.status === 'error' && <span class="paper-detail-error-tag">{t('papers.phaseError')}</span>}
              {result.venue && <span>{result.venue}</span>}
              {result.year && <span>{result.year}</span>}
              {result.extractor && <span>{result.extractor}</span>}
            </div>
          </div>
          <div class="paper-detail-actions" role="toolbar" aria-label="paper detail actions">
            <div class="paper-workspace-modes">
              <button class={`paper-workspace-mode ${workspaceMode === 'report' ? 'is-active' : ''}`} onClick={() => { paperWorkspaceMode.value = 'report' }}>
                {t('papers.chatReportView')}
              </button>
              <button class={`paper-workspace-mode ${workspaceMode === 'pdf' ? 'is-active' : ''}`} onClick={() => { paperWorkspaceMode.value = 'pdf' }}>
                PDF
              </button>
              <button class={`paper-workspace-mode ${workspaceMode === 'split' ? 'is-active' : ''}`} onClick={() => { paperWorkspaceMode.value = 'split' }}>
                {t('papers.chatSplitView')}
              </button>
            </div>
            <button class="paper-detail-tool" onClick={handleCopy}>{isLivePreview ? t('papers.copyPreview') : t('papers.copyMarkdown')}</button>
            {result.savedPath && (
              <button class="paper-detail-tool" onClick={() => revealInFinder(result.savedPath)}>{t('papers.reveal')}</button>
            )}
          </div>
        </div>

        {isLivePreview && (
          <div class="paper-detail-warning paper-detail-warning-preview">
            {markdown ? t('papers.previewStreaming') : t('papers.waitingPreview')}
          </div>
        )}

        {result.extractionWarning && (
          <div class="paper-detail-warning">{result.extractionWarning}</div>
        )}

        {queueTask?.error && (
          <div class="paper-detail-warning paper-detail-warning-error">{queueTask.error}</div>
        )}

        {historyLoadError && (
          <div class="paper-detail-warning paper-detail-warning-error">
            {t('papers.archiveReadFailed')}: {historyLoadError}
          </div>
        )}

        <div class={`paper-workspace-shell ${isDetached ? 'is-detached' : ''}`}>
          <section class="paper-workspace-reading">
            {(workspaceMode === 'report' || workspaceMode === 'split') && (
              <div class={`paper-workspace-pane paper-workspace-report ${workspaceMode === 'split' ? 'is-split' : ''}`}>
                {canShowReport ? (
                  <article ref={articleRef} class="paper-prose paper-report-prose" dangerouslySetInnerHTML={{ __html: renderedReport }} />
                ) : (
                  <div class="paper-detail-loading">{t('papers.chatReportMissing')}</div>
                )}
              </div>
            )}

            {(workspaceMode === 'pdf' || workspaceMode === 'split') && (
              <div class={`paper-workspace-pane paper-workspace-pdf ${workspaceMode === 'split' ? 'is-split' : ''}`}>
                {canShowPdf ? (
                  <PaperPdfViewer path={sourcePath} jumpCitation={jumpCitation} />
                ) : (
                  <div class="paper-detail-loading">{t('papers.chatPdfMissing')}</div>
                )}
              </div>
            )}
          </section>

          {!isDetached && (
            <PaperChatDock
              session={session}
              onJumpCitation={handleJumpCitation}
              onEnsureSession={ensureCurrentPaperChatSession}
              compact
            />
          )}
        </div>
      </div>
      <SelectionAskBubble />
    </div>
  )
}

function isRangeInsideRoot(root, range) {
  if (!root || !range) return false
  return [range.commonAncestorContainer, range.startContainer, range.endContainer]
    .every(node => containsNode(root, node))
}

function containsNode(root, node) {
  if (!root || !node) return false
  return root.contains(node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode)
}

function measureRangeRect(range) {
  if (!range) return null
  const bounding = range.getBoundingClientRect()
  const fallback = range.getClientRects()[0]
  const rect = (bounding.width > 0 || bounding.height > 0) ? bounding : fallback
  if (!rect) return null

  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
    centerX: rect.left + rect.width / 2,
  }
}

function resolveReportSelection(article) {
  if (!article) return null
  const selection = document.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null

  const text = selection.toString().trim()
  if (!text) return null

  const range = selection.getRangeAt(0)
  if (!isRangeInsideRoot(article, range)) return null

  const rect = measureRangeRect(range)
  if (!rect) return null

  const heading = findNearestHeading(article, range.startContainer)
  return {
    range: range.cloneRange(),
    selection: {
      source: 'report',
      text,
      heading: heading?.textContent?.trim() || '',
      rect,
    },
  }
}

function decorateReportHtml(html) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<body>${html}</body>`, 'text/html')
  const headings = [...doc.body.querySelectorAll('h1, h2, h3, h4, h5, h6')]
  const counts = new Map()
  for (const heading of headings) {
    const base = slugifyHeading(heading.textContent || '')
    const normalized = normalizeHeadingText(heading.textContent || '')
    const nextCount = (counts.get(base) || 0) + 1
    counts.set(base, nextCount)
    const id = nextCount === 1 ? base : `${base}-${nextCount}`
    heading.id = id
    heading.setAttribute('data-heading-slug', base)
    heading.setAttribute('data-heading-normalized', normalized)
  }
  return doc.body.innerHTML
}

function normalizeHeadingText(text) {
  return normalizeSearchText(text)
}

function slugifyHeading(text) {
  const raw = String(text || '').trim().toLowerCase()
  const slug = raw
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'section'
}

function findNearestHeading(root, node) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
  if (!element) return null
  const headings = [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')]
  let nearest = headings[0] || null
  for (const heading of headings) {
    if (heading.offsetTop <= element.offsetTop) {
      nearest = heading
    } else {
      break
    }
  }
  return nearest
}

function findReportHeadingTarget(article, heading) {
  const normalized = normalizeHeadingText(heading)
  if (normalized) {
    const exact = [...article.querySelectorAll('h1, h2, h3, h4, h5, h6')]
      .find(item => item.getAttribute('data-heading-normalized') === normalized)
    if (exact) return exact
  }

  const slug = slugifyHeading(heading)
  return article.querySelector(`#${CSS.escape(slug)}`)
    || article.querySelector(`[data-heading-slug="${slug}"]`)
    || [...article.querySelectorAll('h1, h2, h3, h4, h5, h6')]
      .find(item => normalizeHeadingText(item.textContent || '') === normalized)
    || null
}

function getReportSectionRoots(heading) {
  const nodes = []
  let current = heading?.nextSibling || null

  while (current) {
    if (current.nodeType === Node.ELEMENT_NODE && /^H[1-6]$/.test(current.nodeName)) {
      break
    }
    nodes.push(current)
    current = current.nextSibling
  }

  return nodes
}

function highlightReportSnippet(article, heading, snippet) {
  const textNodes = collectTextNodesFromRoots(getReportSectionRoots(heading))
  const match = findTextNodeMatch(textNodes, snippet)
  if (!match) return null

  const highlights = wrapTextNodeMatch(
    article.ownerDocument,
    textNodes,
    match,
    'paper-citation-fragment-highlight',
    REPORT_SNIPPET_HIGHLIGHT_TYPE,
  )

  return highlights[0] || null
}

function flashElementClass(element, className, duration = TEMP_HIGHLIGHT_DURATION_MS) {
  if (!element) return
  element.classList.add(className)
  window.setTimeout(() => {
    element.classList.remove(className)
  }, duration)
}
