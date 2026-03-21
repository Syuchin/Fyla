import { useEffect, useRef, useState } from 'preact/hooks'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs'
import 'pdfjs-dist/web/pdf_viewer.css'
import { collectTextNodesFromRoots, findTextNodeMatch } from '../lib/textSearch.js'
import { showToast } from '../lib/store.js'
import { friendlyError, openExternalUrl, readBinaryFile } from '../lib/tauri.js'
import { t } from '../lib/i18n.js'

const MIN_SCALE = 0.5
const MAX_SCALE = 3
const SCALE_STEP = 0.1
const PDF_SNIPPET_HIGHLIGHT_DURATION_MS = 2200
const PDF_SNIPPET_SEARCH_ATTEMPTS = 10
const PDF_SNIPPET_SEARCH_DELAY_MS = 120

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.mjs',
  import.meta.url
).toString()

function resolvePdfExternalUrl(rawHref, resolvedHref) {
  const rawValue = String(rawHref || '').trim()
  if (!rawValue || rawValue.startsWith('#')) return null

  try {
    const parsed = new URL(resolvedHref || rawValue, window.location.href)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString()
    }
  } catch (_) {}

  return null
}

function sleep(ms) {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function clearPdfSnippetHighlights(container) {
  container?.querySelectorAll('[data-citation-highlight="pdf-snippet"]').forEach(element => {
    element.classList.remove('paper-pdf-snippet-highlight')
    delete element.dataset.citationHighlight
  })
}

function flashPdfPage(pageNode) {
  if (!pageNode) return
  pageNode.classList.add('paper-pdf-page-highlight')
  window.setTimeout(() => {
    pageNode.classList.remove('paper-pdf-page-highlight')
  }, PDF_SNIPPET_HIGHLIGHT_DURATION_MS)
}

function highlightPdfSnippetMatch(textNodes, match) {
  const elements = []
  const seen = new Set()

  for (let nodeIndex = match.start.nodeIndex; nodeIndex <= match.end.nodeIndex; nodeIndex += 1) {
    const element = textNodes[nodeIndex]?.parentElement
    if (!element || seen.has(element)) continue
    seen.add(element)
    element.dataset.citationHighlight = 'pdf-snippet'
    element.classList.add('paper-pdf-snippet-highlight')
    elements.push(element)
  }

  return elements
}

export function PaperPdfViewer({ path, jumpCitation }) {
  const containerRef = useRef(null)
  const viewerRef = useRef(null)
  const runtimeRef = useRef(null)
  const scaleModeRef = useRef('page-width')
  const gestureBaseScaleRef = useRef(1)
  const [pageLabel, setPageLabel] = useState('')
  const [isLoading, setIsLoading] = useState(!!path)
  const [hasRenderedPage, setHasRenderedPage] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [zoomPercent, setZoomPercent] = useState(100)
  const [scaleMode, setScaleMode] = useState('page-width')

  function clampScale(value) {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
  }

  function toPercent(value) {
    return Math.round((Number(value) || 1) * 100)
  }

  function syncScaleState(nextMode, scaleValue) {
    scaleModeRef.current = nextMode
    setScaleMode(nextMode)
    setZoomPercent(toPercent(scaleValue))
  }

  function reapplyFitWidth() {
    const viewer = runtimeRef.current?.viewer
    if (!viewer) return
    viewer.currentScaleValue = 'page-width'
    viewer.update()
    syncScaleState('page-width', viewer.currentScale)
  }

  function applyManualScale(nextScale) {
    const viewer = runtimeRef.current?.viewer
    const container = containerRef.current
    if (!viewer || !container) return
    const clampedScale = clampScale(nextScale)
    const previousScale = Number(viewer.currentScale) || 1
    const centerLeft = (container.scrollLeft + container.clientWidth / 2) / previousScale
    const centerTop = (container.scrollTop + container.clientHeight / 2) / previousScale

    viewer.currentScale = clampedScale
    syncScaleState('manual', clampedScale)

    requestAnimationFrame(() => {
      container.scrollLeft = Math.max(0, centerLeft * clampedScale - container.clientWidth / 2)
      container.scrollTop = Math.max(0, centerTop * clampedScale - container.clientHeight / 2)
    })
  }

  function adjustScale(direction) {
    const viewer = runtimeRef.current?.viewer
    if (!viewer) return
    const baseScale = scaleModeRef.current === 'page-width'
      ? Number(viewer.currentScale) || 1
      : zoomPercent / 100
    applyManualScale(baseScale + direction * SCALE_STEP)
  }

  useEffect(() => {
    if (!path || !containerRef.current || !viewerRef.current) {
      runtimeRef.current = null
      setPageLabel('')
      setIsLoading(false)
      setHasRenderedPage(false)
      setLoadError('')
      setZoomPercent(100)
      setScaleMode('page-width')
      return () => {}
    }

    let cancelled = false

    async function mountPdf() {
      const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
      try {
        setPageLabel('')
        setIsLoading(true)
        setHasRenderedPage(false)
        setLoadError('')
        setZoomPercent(100)
        setScaleMode('page-width')
        scaleModeRef.current = 'page-width'
        const bytes = await readBinaryFile(path)
        if (cancelled) return

        viewerRef.current.replaceChildren()
        const eventBus = new EventBus()
        const linkService = new PDFLinkService({ eventBus })
        const viewer = new PDFViewer({
          container: containerRef.current,
          viewer: viewerRef.current,
          eventBus,
          linkService,
          textLayerMode: 1,
        })

        linkService.setViewer(viewer)

        const loadingTask = pdfjsLib.getDocument({ data: bytes })
        const pdfDocument = await loadingTask.promise
        if (cancelled) {
          await loadingTask.destroy()
          return
        }

        runtimeRef.current = { viewer, loadingTask, pdfDocument }
        let firstPageVisibleLogged = false
        eventBus.on('pagesinit', () => {
          if (cancelled) return
          setPageLabel(`${viewer.currentPageNumber} / ${pdfDocument.numPages}`)
        })

        eventBus.on('pagerendered', event => {
          if (cancelled) return
          if (!firstPageVisibleLogged) {
            firstPageVisibleLogged = true
            setHasRenderedPage(true)
            setIsLoading(false)
            setLoadError('')
            const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt
            console.info('[paper-perf] pdf_first_page_visible', {
              path,
              page: Number(event?.pageNumber) || viewer.currentPageNumber || 1,
              elapsedMs: Math.round(elapsedMs),
            })
          }
          if (event?.pageNumber) {
            setPageLabel(`${event.pageNumber} / ${pdfDocument.numPages}`)
          }
        })

        eventBus.on('pagechanging', event => {
          if (cancelled) return
          setPageLabel(`${event.pageNumber} / ${pdfDocument.numPages}`)
        })

        eventBus.on('scalechanging', event => {
          if (cancelled) return
          setZoomPercent(toPercent(event.scale))
        })

        eventBus.on('pagesloaded', event => {
          if (cancelled) return
          const pagesCount = Number(event?.pagesCount) || pdfDocument.numPages
          setPageLabel(`${viewer.currentPageNumber} / ${pagesCount}`)
        })

        viewer.setDocument(pdfDocument)
        linkService.setDocument(pdfDocument, null)
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            if (cancelled || runtimeRef.current?.viewer !== viewer) return
            viewer.currentScaleValue = 'page-width'
            viewer.update()
            syncScaleState('page-width', viewer.currentScale)
          })
        })
      } catch (err) {
        if (!cancelled) {
          setIsLoading(false)
          setLoadError(friendlyError(err))
        }
      }
    }

    mountPdf()

    return () => {
      cancelled = true
      const runtime = runtimeRef.current
      runtimeRef.current = null
      if (runtime?.viewer) {
        runtime.viewer.setDocument(null)
      }
      if (runtime?.loadingTask) {
        runtime.loadingTask.destroy().catch(() => {})
      }
    }
  }, [path])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return () => {}

    function handleWheel(event) {
      if (!event.metaKey && !event.ctrlKey) return
      event.preventDefault()
      adjustScale(event.deltaY < 0 ? 1 : -1)
    }

    function handleGestureStart(event) {
      event.preventDefault()
      const viewer = runtimeRef.current?.viewer
      gestureBaseScaleRef.current = scaleModeRef.current === 'page-width'
        ? Number(viewer?.currentScale) || 1
        : zoomPercent / 100
    }

    function handleGestureChange(event) {
      event.preventDefault()
      const baseScale = gestureBaseScaleRef.current || 1
      applyManualScale(baseScale * (event.scale || 1))
    }

    function handleGestureEnd() {
      gestureBaseScaleRef.current = 1
    }

    container.addEventListener('wheel', handleWheel, { passive: false })
    container.addEventListener('gesturestart', handleGestureStart)
    container.addEventListener('gesturechange', handleGestureChange)
    container.addEventListener('gestureend', handleGestureEnd)
    return () => {
      container.removeEventListener('wheel', handleWheel)
      container.removeEventListener('gesturestart', handleGestureStart)
      container.removeEventListener('gesturechange', handleGestureChange)
      container.removeEventListener('gestureend', handleGestureEnd)
    }
  }, [zoomPercent])

  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return () => {}

    const observer = new ResizeObserver(() => {
      if (runtimeRef.current?.viewer && scaleModeRef.current === 'page-width') {
        reapplyFitWidth()
      }
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return () => {}

    async function handlePdfLinkClick(event) {
      const target = event.target
      if (!(target instanceof Element)) return

      const link = target.closest('a[href]')
      if (!link || !container.contains(link)) return

      const externalUrl = resolvePdfExternalUrl(link.getAttribute('href'), link.href)
      if (!externalUrl) return

      event.preventDefault()
      event.stopPropagation()

      try {
        await openExternalUrl(externalUrl)
      } catch (err) {
        showToast(friendlyError(err))
      }
    }

    container.addEventListener('click', handlePdfLinkClick, true)
    return () => {
      container.removeEventListener('click', handlePdfLinkClick, true)
    }
  }, [path])

  useEffect(() => {
    if (!jumpCitation || jumpCitation.source !== 'pdf' || !runtimeRef.current?.viewer) return

    let cancelled = false
    const page = Number(jumpCitation.page || 1)
    const snippet = String(jumpCitation.snippet || '').trim()
    const viewer = runtimeRef.current.viewer
    const container = containerRef.current

    async function focusCitation() {
      viewer.currentPageNumber = page
      clearPdfSnippetHighlights(container)

      for (let attempt = 0; attempt < PDF_SNIPPET_SEARCH_ATTEMPTS && !cancelled; attempt += 1) {
        const pageNode = container?.querySelector(`.page[data-page-number="${page}"]`)
        if (!pageNode) {
          await sleep(PDF_SNIPPET_SEARCH_DELAY_MS)
          continue
        }

        if (!snippet) {
          flashPdfPage(pageNode)
          pageNode.scrollIntoView({ block: 'center', behavior: 'smooth' })
          return
        }

        const textLayer = pageNode.querySelector('.textLayer')
        const textNodes = collectTextNodesFromRoots(textLayer ? [textLayer] : [])
        const match = findTextNodeMatch(textNodes, snippet)

        if (match) {
          const highlights = highlightPdfSnippetMatch(textNodes, match)
          const first = highlights[0]
          if (first) {
            first.scrollIntoView({ block: 'center', behavior: 'smooth' })
            window.setTimeout(() => clearPdfSnippetHighlights(container), PDF_SNIPPET_HIGHLIGHT_DURATION_MS)
            return
          }
        }

        await sleep(PDF_SNIPPET_SEARCH_DELAY_MS)
      }

      if (!cancelled) {
        const pageNode = container?.querySelector(`.page[data-page-number="${page}"]`)
        if (pageNode) {
          pageNode.scrollIntoView({ block: 'center', behavior: 'smooth' })
          flashPdfPage(pageNode)
        }
      }
    }

    focusCitation()

    return () => {
      cancelled = true
    }
  }, [jumpCitation?.id])

  const viewerReady = hasRenderedPage && !loadError
  const canZoomOut = viewerReady && zoomPercent > MIN_SCALE * 100 + 1
  const canZoomIn = viewerReady && zoomPercent < MAX_SCALE * 100 - 1

  return (
    <section class="paper-pdf-panel is-selection-disabled">
      <div class="paper-pdf-toolbar">
        <div class="paper-pdf-toolbar-group">
          <span>{t('papers.chatPdfView')}</span>
        </div>
        <div class="paper-pdf-toolbar-group paper-pdf-toolbar-zoom">
          <button
            type="button"
            class="paper-pdf-zoom-button"
            onClick={() => adjustScale(-1)}
            disabled={!canZoomOut}
            title={t('papers.chatPdfZoomOut')}
            aria-label={t('papers.chatPdfZoomOut')}
          >
            -
          </button>
          <span class="paper-pdf-zoom-value">{zoomPercent}%</span>
          <button
            type="button"
            class="paper-pdf-zoom-button"
            onClick={() => adjustScale(1)}
            disabled={!canZoomIn}
            title={t('papers.chatPdfZoomIn')}
            aria-label={t('papers.chatPdfZoomIn')}
          >
            +
          </button>
          <button
            type="button"
            class={`paper-pdf-fit-button ${scaleMode === 'page-width' ? 'is-active' : ''}`}
            onClick={reapplyFitWidth}
            disabled={!viewerReady}
          >
            {t('papers.chatPdfFitWidth')}
          </button>
        </div>
        <div class="paper-pdf-toolbar-group paper-pdf-toolbar-page">
          <span>{pageLabel}</span>
        </div>
      </div>
      <div
        class={`paper-pdf-stage ${isLoading ? 'is-loading' : ''} ${viewerReady ? 'is-rendered' : ''} ${loadError ? 'has-error' : ''}`}
        aria-busy={isLoading}
      >
        <div ref={containerRef} class="paper-pdf-container">
          <div ref={viewerRef} class="pdfViewer" />
        </div>
        {isLoading && (
          <div class="paper-pdf-loading-badge" aria-live="polite">{t('papers.chatPdfLoading')}</div>
        )}
        {!!loadError && (
          <div class="paper-pdf-status paper-pdf-status-error" role="alert">
            {t('papers.chatPdfLoadFailed')}: {loadError}
          </div>
        )}
      </div>
    </section>
  )
}
