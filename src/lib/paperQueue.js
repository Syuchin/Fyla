import { computed, signal } from '@preact/signals'
import { config, currentPage, currentPaperDetailId, paperProjectName, papersActiveTab, showToast } from './store.js'
import { addPaperHistory, clearPaperHistoryItems, friendlyError, generatePaperReviewsStream, getPaperHistory, removePaperHistoryItem as removePaperHistoryRecord, stopPaperReview } from './tauri.js'
import { t } from './i18n.js'
import { getPaperCharCountFromMarkdown } from './paperChars.js'

export const paperTasks = signal([])
export const paperHistory = signal([])
export const isPaperRunning = signal(false)

const PAPER_HISTORY_KEY = 'fyla-paper-history'
const PAPER_HISTORY_LIMIT = 80
let paperHistoryHydratePromise = null

export const paperStats = computed(() => {
  const list = paperTasks.value
  const queued = list.filter(task => task.status === 'queued').length
  const processing = list.filter(task => ['extracting', 'generating', 'saving', 'cancelling'].includes(task.status)).length
  return {
    total: list.length,
    queued,
    processing,
    pending: queued + processing,
    done: list.filter(task => task.status === 'done').length,
    error: list.filter(task => task.status === 'error').length,
    cancelled: list.filter(task => task.status === 'cancelled').length,
    totalElapsedMs: list.reduce((sum, task) => sum + (task.elapsedMs || 0), 0),
  }
})

let batchPromise = null

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function getNameFromPath(path) {
  return path.split('/').pop() || path
}

function getLegacyPaperHistory() {
  try {
    const raw = localStorage.getItem(PAPER_HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(normalizePaperHistoryEntry)
      .filter(Boolean)
      .slice(0, PAPER_HISTORY_LIMIT)
  } catch (_) {
    return []
  }
}

function clearLegacyPaperHistory() {
  try {
    localStorage.removeItem(PAPER_HISTORY_KEY)
  } catch (_) {}
}

function setPaperHistory(next) {
  paperHistory.value = next
    .map(normalizePaperHistoryEntry)
    .filter(Boolean)
    .slice(0, PAPER_HISTORY_LIMIT)
}

function updateTask(id, updates) {
  paperTasks.value = paperTasks.value.map(task => task.id === id ? { ...task, ...updates } : task)
}

function updateTaskWith(id, updater) {
  paperTasks.value = paperTasks.value.map(task => task.id === id ? updater(task) : task)
}

function findTaskIdByPath(path) {
  return paperTasks.value.find(task => task.path === path)?.id || null
}

function getTaskById(id) {
  return paperTasks.value.find(task => task.id === id) || null
}

function isTerminalStatus(status) {
  return ['done', 'error', 'cancelled'].includes(status)
}

function getBatchFailurePhase(task) {
  if (task?.lastPhase) return task.lastPhase
  if (task?.status === 'queued') return 'queued'
  return 'generating'
}

function markBatchTasksFailed(pathSet, message) {
  const failedAt = Date.now()
  paperTasks.value = paperTasks.value.map(task => {
    if (!pathSet.has(task.path)) return task
    if (isTerminalStatus(task.status)) return task
    return {
      ...task,
      status: 'error',
      message: '',
      error: message,
      errorPhase: getBatchFailurePhase(task),
      cancelledPhase: '',
      endedAt: failedAt,
      elapsedMs: task.startedAt ? Math.max(0, failedAt - task.startedAt) : task.elapsedMs || 0,
      canOpenPreview: !!task.previewMarkdown,
    }
  })
}

function normalizePreviewMeta(meta) {
  if (!meta) return null
  return {
    title: meta.title || '',
    year: meta.year || '',
    venue: meta.venue || '',
    summary: meta.summary || '',
  }
}

function normalizePaperResult(result) {
  if (!result) return null
  const markdown = result.markdown || ''
  return {
    sourcePath: result.sourcePath || result.source_path || '',
    markdown,
    savedPath: result.savedPath || result.saved_path || '',
    title: result.title || '',
    year: result.year || '',
    venue: result.venue || '',
    slug: result.slug || '',
    summary: result.summary || '',
    elapsedMs: result.elapsedMs || result.elapsed_ms || 0,
    charCount: result.charCount || result.char_count || getPaperCharCountFromMarkdown(markdown),
    extractor: result.extractor || '',
    extractionWarning: result.extractionWarning || result.extraction_warning || null,
  }
}

function normalizePaperHistoryEntry(entry) {
  if (!entry || !entry.id || !entry.savedPath) return null
  return {
    id: entry.id,
    sourcePath: entry.sourcePath || '',
    originalName: entry.originalName || getNameFromPath(entry.sourcePath || entry.savedPath),
    savedPath: entry.savedPath,
    title: entry.title || '',
    year: entry.year || '',
    venue: entry.venue || '',
    slug: entry.slug || '',
    summary: entry.summary || '',
    elapsedMs: entry.elapsedMs || 0,
    charCount: entry.charCount || entry.char_count || 0,
    extractor: entry.extractor || '',
    extractionWarning: entry.extractionWarning || null,
    completedAt: entry.completedAt || new Date().toISOString(),
  }
}

function pushPaperHistory(task, result) {
  const savedPath = result?.savedPath
  if (!savedPath) return Promise.resolve()

  const nextEntry = normalizePaperHistoryEntry({
    id: `history:${savedPath}`,
    sourcePath: task?.path || result.sourcePath || '',
    originalName: task?.originalName || getNameFromPath(task?.path || result.sourcePath || savedPath),
    savedPath,
    title: result.title,
    year: result.year,
    venue: result.venue,
    slug: result.slug,
    summary: result.summary,
    elapsedMs: result.elapsedMs,
    charCount: result.charCount || getPaperCharCountFromMarkdown(result.markdown),
    extractor: result.extractor,
    extractionWarning: result.extractionWarning,
    completedAt: new Date().toISOString(),
  })

  if (!nextEntry) return Promise.resolve()
  return persistPaperHistoryEntry(nextEntry)
}

export function hasPaperConfig(c = config.value) {
  if (c.paperProvider === 'ollama') return !!c.paperOllamaUrl && !!c.paperOllamaModel
  if (c.paperProvider === 'openai') {
    return !!c.paperOpenaiBaseUrl && !!c.paperOpenaiKey && !!c.paperOpenaiModel
  }
  return false
}

export function enqueuePaperPaths(paths, source = 'pick') {
  const existing = new Set(paperTasks.value.map(task => task.path))
  const nextTasks = paths
    .filter(path => /\.pdf$/i.test(path))
    .filter(path => !existing.has(path))
    .map(path => ({
      id: makeId(),
      path,
      originalName: getNameFromPath(path),
      source,
      status: 'queued',
      message: '',
      error: '',
      lastPhase: 'queued',
      errorPhase: '',
      cancelledPhase: '',
      elapsedMs: 0,
      startedAt: null,
      endedAt: null,
      previewMarkdown: '',
      previewMeta: null,
      previewChars: 0,
      previewUpdatedAt: null,
      canOpenPreview: false,
      result: null,
    }))

  if (!nextTasks.length) return 0
  paperTasks.value = [...paperTasks.value, ...nextTasks]
  activatePaperTab('queue')
  return nextTasks.length
}

export async function startPaperBatch() {
  if (isPaperRunning.value || batchPromise) return

  const queued = paperTasks.value.filter(task => task.status === 'queued')
  if (!queued.length) return
  if (!hasPaperConfig()) {
    showToast(t('papers.configRequired'))
    currentPage.value = 'settings'
    return
  }

  isPaperRunning.value = true
  activatePaperTab('queue')
  const paths = queued.map(task => task.path)
  const pathSet = new Set(paths)
  const projectName = paperProjectName.value.trim() || null

  batchPromise = generatePaperReviewsStream(paths, config.value, projectName, handlePaperEvent)
    .catch(err => {
      const message = friendlyError(err)
      markBatchTasksFailed(pathSet, message)
      showToast(t('papers.batchFailed') + ': ' + message)
    })
    .finally(() => {
      batchPromise = null
      isPaperRunning.value = false
      if (paperTasks.value.some(task => task.status === 'queued' && !pathSet.has(task.path))) {
        startPaperBatch()
      }
    })

  await batchPromise
}

function handlePaperEvent(message) {
  const type = message.event
  const data = message.data
  if (!type) return

  const sourcePath = data?.sourcePath || data?.source_path

  const taskId = sourcePath ? findTaskIdByPath(sourcePath) : null
  if (!taskId && type !== 'batchFinished') return
  const currentTask = taskId ? getTaskById(taskId) : null

  switch (type) {
    case 'itemStarted':
      updateTask(taskId, {
        status: 'extracting',
        message: t('papers.phaseExtracting'),
        error: '',
        lastPhase: 'extracting',
        errorPhase: '',
        cancelledPhase: '',
        startedAt: Date.now(),
        endedAt: null,
        previewMarkdown: '',
        previewMeta: null,
        previewChars: 0,
        previewUpdatedAt: null,
        canOpenPreview: false,
      })
      activatePaperTab('queue')
      break
    case 'itemPhaseChanged':
      updateTask(taskId, {
        status: data.phase,
        message: data.message,
        lastPhase: data.phase || currentTask?.lastPhase || 'queued',
      })
      break
    case 'itemPreviewStarted':
      updateTask(taskId, {
        status: 'generating',
        message: t('papers.phaseGenerating'),
        lastPhase: 'generating',
        previewMarkdown: '',
        previewMeta: null,
        previewChars: 0,
        previewUpdatedAt: Date.now(),
        canOpenPreview: false,
      })
      activatePaperTab('queue')
      break
    case 'itemPreviewReady':
      updateTask(taskId, {
        status: 'generating',
        message: t('papers.phaseGenerating'),
        lastPhase: 'generating',
        previewChars: data.previewChars || 0,
        previewMeta: normalizePreviewMeta(data.previewMeta || data.preview_meta),
        previewUpdatedAt: Date.now(),
        canOpenPreview: true,
      })
      break
    case 'itemPreviewDelta':
      updateTaskWith(taskId, task => ({
        ...task,
        status: 'generating',
        message: t('papers.phaseGenerating'),
        lastPhase: 'generating',
        previewMarkdown: (task.previewMarkdown || '') + (data.delta || ''),
        previewChars: data.previewChars || ((task.previewMarkdown || '').length + (data.delta || '').length),
        previewUpdatedAt: Date.now(),
        canOpenPreview: true,
      }))
      break
    case 'itemDone':
      const normalizedResult = normalizePaperResult(data.result)
      updateTask(taskId, {
        status: 'done',
        message: t('papers.phaseDone'),
        elapsedMs: normalizedResult?.elapsedMs || 0,
        endedAt: Date.now(),
        previewMarkdown: normalizedResult?.markdown || '',
        previewMeta: normalizedResult ? {
          title: normalizedResult.title,
          year: normalizedResult.year,
          venue: normalizedResult.venue,
          summary: normalizedResult.summary,
        } : null,
        previewChars: normalizedResult?.markdown?.length || 0,
        previewUpdatedAt: Date.now(),
        canOpenPreview: true,
        result: normalizedResult,
        error: '',
        lastPhase: 'done',
        errorPhase: '',
        cancelledPhase: '',
      })
      void pushPaperHistory(
        paperTasks.value.find(task => task.id === taskId),
        normalizedResult,
      )
      break
    case 'itemError': {
      const errorPhase = data.phase || currentTask?.lastPhase || 'generating'
      updateTask(taskId, {
        status: 'error',
        message: '',
        elapsedMs: data.elapsedMs || data.elapsed_ms || 0,
        endedAt: Date.now(),
        previewUpdatedAt: Date.now(),
        canOpenPreview: !!currentTask?.previewMarkdown,
        error: friendlyError(data.message),
        errorPhase,
        cancelledPhase: '',
        lastPhase: errorPhase,
      })
      break
    }
    case 'itemCancelled': {
      const cancelledPhase = data.phase || currentTask?.lastPhase || 'queued'
      updateTask(taskId, {
        status: 'cancelled',
        message: '',
        elapsedMs: data.elapsedMs || data.elapsed_ms || 0,
        endedAt: Date.now(),
        previewUpdatedAt: Date.now(),
        canOpenPreview: !!currentTask?.previewMarkdown,
        error: '',
        errorPhase: '',
        cancelledPhase,
        lastPhase: cancelledPhase,
      })
      break
    }
    case 'batchFinished':
      showToast(t('papers.batchFinished', { completed: data.completed, failed: data.failed }))
      break
  }
}

export function retryPaperTask(id) {
  updateTask(id, {
    status: 'queued',
    message: '',
    error: '',
    lastPhase: 'queued',
    errorPhase: '',
    cancelledPhase: '',
    elapsedMs: 0,
    startedAt: null,
    endedAt: null,
    previewMarkdown: '',
    previewMeta: null,
    previewChars: 0,
    previewUpdatedAt: null,
    canOpenPreview: false,
    result: null,
  })
  if (!isPaperRunning.value) {
    startPaperBatch()
  }
}

export async function cancelPaperTask(id) {
  const task = getTaskById(id)
  if (!task || isTerminalStatus(task.status) || task.status === 'cancelling') return

  const snapshot = {
    status: task.status,
    message: task.message,
    error: task.error,
    lastPhase: task.lastPhase,
    errorPhase: task.errorPhase,
    cancelledPhase: task.cancelledPhase,
  }

  updateTask(id, {
    status: 'cancelling',
    message: t('papers.phaseCancelling'),
    error: '',
    errorPhase: '',
    cancelledPhase: '',
  })

  try {
    await stopPaperReview(task.path)
  } catch (err) {
    updateTask(id, snapshot)
    showToast(t('papers.cancelFailed') + ': ' + friendlyError(err))
  }
}

export function removePaperTask(id) {
  const task = getTaskById(id)
  if (!task || !isTerminalStatus(task.status)) return
  if (currentPaperDetailId.value === id) {
    currentPaperDetailId.value = null
    currentPage.value = 'papers'
  }
  paperTasks.value = paperTasks.value.filter(task => task.id !== id)
}

export function clearPaperDone() {
  if (currentPaperDetailId.value && paperTasks.value.find(task => task.id === currentPaperDetailId.value)?.status === 'done') {
    currentPaperDetailId.value = null
    currentPage.value = 'papers'
  }
  paperTasks.value = paperTasks.value.filter(task => task.status !== 'done')
}

export function openPaperDetail(id) {
  currentPaperDetailId.value = id
  currentPage.value = 'paper-detail'
}

export function closePaperDetail() {
  currentPaperDetailId.value = null
  currentPage.value = 'papers'
}

export function removePaperHistoryItem(id) {
  if (currentPaperDetailId.value === id) {
    closePaperDetail()
  }
  removePaperHistoryRecord(id)
    .then(setPaperHistory)
    .catch(err => {
      showToast(t('papers.historyWriteFailed') + ': ' + friendlyError(err))
    })
}

export function clearPaperHistory() {
  if (currentPaperDetailId.value?.startsWith('history:')) {
    closePaperDetail()
  }
  clearPaperHistoryItems()
    .then(() => setPaperHistory([]))
    .catch(err => {
      showToast(t('papers.historyWriteFailed') + ': ' + friendlyError(err))
    })
}

export function activatePaperTab(tab) {
  papersActiveTab.value = tab === 'queue' ? 'queue' : 'history'
}

export function resetPaperTab() {
  papersActiveTab.value = 'history'
}

export async function hydratePaperHistory() {
  if (paperHistoryHydratePromise) return paperHistoryHydratePromise

  paperHistoryHydratePromise = (async () => {
    const diskHistory = await getPaperHistory()
    const normalizedDiskHistory = diskHistory
      .map(normalizePaperHistoryEntry)
      .filter(Boolean)
      .slice(0, PAPER_HISTORY_LIMIT)

    if (normalizedDiskHistory.length) {
      setPaperHistory(normalizedDiskHistory)
      clearLegacyPaperHistory()
      return normalizedDiskHistory
    }

    const legacyHistory = getLegacyPaperHistory()
    if (!legacyHistory.length) {
      setPaperHistory([])
      return []
    }

    for (const entry of [...legacyHistory].reverse()) {
      await addPaperHistory(entry)
    }

    const migratedHistory = await getPaperHistory()
    setPaperHistory(migratedHistory)
    clearLegacyPaperHistory()
    return migratedHistory
  })()
    .catch(err => {
      paperHistoryHydratePromise = null
      throw err
    })

  return paperHistoryHydratePromise
}

async function persistPaperHistoryEntry(entry) {
  try {
    const nextHistory = await addPaperHistory(entry)
    setPaperHistory(nextHistory)
  } catch (err) {
    showToast(t('papers.historyWriteFailed') + ': ' + friendlyError(err))
  }
}
