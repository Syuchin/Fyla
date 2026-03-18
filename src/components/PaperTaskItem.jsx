import { memo } from 'preact/compat'
import { copyText, revealInFinder } from '../lib/tauri.js'
import { openPaperDetail, removePaperTask, retryPaperTask } from '../lib/paperQueue.js'
import { showToast } from '../lib/store.js'
import { t } from '../lib/i18n.js'
import { formatCompactPaperChars, formatExactPaperChars, hasPaperCharCount } from '../lib/paperChars.js'
import { PaperRowActionsMenu } from './PaperRowActionsMenu.jsx'

const PROCESSING = new Set(['extracting', 'generating', 'saving'])

export const PaperTaskItem = memo(function PaperTaskItem({ task, now, hasProcessingTasks }) {
  const isDone = task.status === 'done'
  const isError = task.status === 'error'
  const isQueued = task.status === 'queued'
  const isProcessing = PROCESSING.has(task.status)
  const canViewPreview = !!task.canOpenPreview
  const savedPath = task.result?.savedPath
  const extractorLabel = task.result?.extractor || ''
  const previewSnippet = makePreviewSnippet(task.previewMarkdown)
  const elapsedLabel = formatElapsed(task, now)
  const queuedHint = task.message || t(hasProcessingTasks ? 'papers.queuedWaitingAhead' : 'papers.queuedWaitingStart')
  const charCount = getTaskCharCount(task)
  const compactCharCount = formatCompactPaperChars(charCount)
  const charCountTitle = formatExactPaperChars(charCount)

  async function handleCopy() {
    if (!task.result?.markdown) return
    try {
      await copyText(task.result.markdown)
      showToast(t('papers.copied'))
    } catch (err) {
      showToast(t('papers.copyFailed') + ': ' + String(err))
    }
  }

  const doneMenuItems = [
    { id: 'copy', label: t('papers.copyMarkdown'), onClick: handleCopy },
    savedPath ? { id: 'reveal', label: t('papers.reveal'), onClick: () => revealInFinder(savedPath) } : null,
    { id: 'remove', label: t('papers.remove'), danger: true, onClick: () => removePaperTask(task.id) },
  ].filter(Boolean)

  const previewMenuItems = [
    { id: 'remove', label: t('papers.remove'), danger: true, onClick: () => removePaperTask(task.id) },
  ]

  const errorMenuItems = [
    canViewPreview ? { id: 'view', label: t('papers.view'), onClick: () => openPaperDetail(task.id) } : null,
    { id: 'remove', label: t('papers.remove'), danger: true, onClick: () => removePaperTask(task.id) },
  ].filter(Boolean)

  return (
    <div class={`list-row paper-task-item paper-task-item--${task.status}`}>
      <div class="paper-task-main">
        <div class="paper-task-heading">
          <span class="paper-task-name" title={task.originalName}>{task.originalName}</span>
          {task.result?.extractionWarning && (
            <span class="paper-warning-pill" title={task.result.extractionWarning}>
              {t('papers.extractWarningShort')}
            </span>
          )}
        </div>

        <div class={`paper-task-subline ${isQueued ? 'paper-task-subline--queued' : ''}`}>
          <span class={`paper-phase phase-${task.status}`}>
            {isProcessing && <div class="spinner" />}
            <span>{statusLabel(task)}</span>
          </span>
          {isQueued ? (
            <span class="paper-task-waiting">{queuedHint}</span>
          ) : elapsedLabel ? (
            <span class="paper-elapsed">{elapsedLabel}</span>
          ) : null}
          {!isQueued && extractorLabel && (
            <span class="paper-meta-pill">{extractorLabel}</span>
          )}
          {!isQueued && hasPaperCharCount(charCount) && (
            <span class="paper-meta-pill paper-char-pill" title={charCountTitle}>
              {compactCharCount}
            </span>
          )}
        </div>

        {task.status === 'generating' && previewSnippet && (
          <div class="paper-task-preview">{previewSnippet}</div>
        )}

        {isError && task.error && (
          <div class="paper-task-error" title={task.error}>{task.error}</div>
        )}
      </div>

      <div class="paper-task-actions">
        {isDone && (
          <>
            <button type="button" class="btn btn-secondary paper-action-btn paper-action-btn-secondary paper-row-action-btn paper-row-action-btn-primary paper-task-primary-action" onClick={() => openPaperDetail(task.id)}>
              {t('papers.view')}
            </button>
            <PaperRowActionsMenu items={doneMenuItems} />
          </>
        )}
        {!isDone && !isError && canViewPreview && (
          <>
            <button type="button" class="btn btn-secondary paper-action-btn paper-action-btn-secondary paper-row-action-btn paper-row-action-btn-primary paper-task-primary-action" onClick={() => openPaperDetail(task.id)}>
              {t('papers.view')}
            </button>
            <PaperRowActionsMenu items={previewMenuItems} />
          </>
        )}
        {isError && (
          <>
            <button type="button" class="btn btn-secondary paper-action-btn paper-action-btn-secondary paper-row-action-btn paper-row-action-btn-primary paper-task-primary-action" onClick={() => retryPaperTask(task.id)}>
              {t('task.retry')}
            </button>
            <PaperRowActionsMenu items={errorMenuItems} />
          </>
        )}
        {!isDone && !isError && !canViewPreview && (
          <PaperRowActionsMenu items={previewMenuItems} />
        )}
      </div>
    </div>
  )
})

function statusLabel(task) {
  switch (task.status) {
    case 'queued': return t('papers.phaseQueued')
    case 'extracting': return t('papers.phaseExtracting')
    case 'generating': return t('papers.phaseGenerating')
    case 'saving': return t('papers.phaseSaving')
    case 'done': return t('papers.phaseDone')
    case 'error': return t('papers.phaseError')
    default: return task.message || task.status
  }
}

function formatElapsed(task, now) {
  if (task.elapsedMs) return formatMs(task.elapsedMs)
  if (task.startedAt && PROCESSING.has(task.status)) return formatMs(now - task.startedAt)
  return ''
}

function formatMs(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

function makePreviewSnippet(markdown = '') {
  return markdown
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
}

function getTaskCharCount(task) {
  if (task.result?.charCount) return task.result.charCount
  if (task.result?.markdown) return task.result.markdown.length
  if (task.previewChars) return task.previewChars
  return 0
}
