import { useEffect, useState } from 'preact/hooks'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { closePaperDetail, paperHistory, paperTasks } from '../lib/paperQueue.js'
import { currentPaperDetailId, showToast } from '../lib/store.js'
import { copyText, friendlyError, readPaperArchiveMarkdown, revealInFinder } from '../lib/tauri.js'
import { t } from '../lib/i18n.js'

marked.setOptions({
  gfm: true,
  breaks: false,
})

export function PaperDetailPage() {
  const queueTask = paperTasks.value.find(item => item.id === currentPaperDetailId.value)
  const historyItem = queueTask ? null : paperHistory.value.find(item => item.id === currentPaperDetailId.value)
  const [historyMarkdown, setHistoryMarkdown] = useState('')
  const [historyLoadError, setHistoryLoadError] = useState('')
  const [rendered, setRendered] = useState('')

  useEffect(() => {
    let cancelled = false

    if (!historyItem?.savedPath) {
      setHistoryMarkdown('')
      setHistoryLoadError('')
      return () => {}
    }

    setHistoryMarkdown('')
    setHistoryLoadError('')

    readPaperArchiveMarkdown(historyItem.savedPath)
      .then(content => {
        if (!cancelled) setHistoryMarkdown(content)
      })
      .catch(err => {
        if (!cancelled) setHistoryLoadError(friendlyError(err))
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
  } : null
  const result = queueTask?.result || livePreviewResult || (historyItem ? {
    title: historyItem.title,
    venue: historyItem.venue,
    year: historyItem.year,
    extractor: historyItem.extractor,
    savedPath: historyItem.savedPath,
    extractionWarning: historyItem.extractionWarning,
    markdown: historyMarkdown,
  } : null)

  const title = result?.title || queueTask?.previewMeta?.title || queueTask?.originalName || historyItem?.originalName
  const markdown = result?.markdown || queueTask?.previewMarkdown || ''

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

  useEffect(() => {
    if (!markdown) {
      setRendered('')
      return () => {}
    }

    const timer = setTimeout(() => {
      setRendered(DOMPurify.sanitize(marked.parse(markdown)))
    }, 180)

    return () => clearTimeout(timer)
  }, [markdown])

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

  return (
    <div class="main">
      <div class="paper-detail-page">
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

        <div class="paper-detail-shell">
          {!markdown && !historyLoadError ? (
            <div class="paper-detail-loading">
              {queueTask?.error
                ? queueTask.error
                : historyItem
                  ? t('papers.loadingArchive')
                  : t('papers.waitingPreview')}
            </div>
          ) : (
            <article class="paper-prose" dangerouslySetInnerHTML={{ __html: rendered }} />
          )}
        </div>
      </div>
    </div>
  )
}
