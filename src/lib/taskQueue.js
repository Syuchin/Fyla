import { signal, computed } from '@preact/signals'
import { extractFileText, generateFilename, moveAndRename, addHistory, friendlyError } from './tauri.js'
import { config, showToast, recentActivity } from './store.js'
import { t } from './i18n.js'

// --- Unified task queue ---
// status: 'queued' | 'extracting' | 'generating' | 'ready' | 'confirming' | 'done' | 'error'
export const tasks = signal([])

const CONCURRENCY = 3
let activeCount = 0

// --- Computed stats ---
export const stats = computed(() => {
  const list = tasks.value
  return {
    total: list.length,
    queued: list.filter(t => t.status === 'queued').length,
    processing: list.filter(t => t.status === 'extracting' || t.status === 'generating').length,
    ready: list.filter(t => t.status === 'ready').length,
    done: list.filter(t => t.status === 'done').length,
    error: list.filter(t => t.status === 'error').length,
  }
})

// --- Internal helpers ---

function getCategoryFolder(ext) {
  const e = ext.toLowerCase().replace(/^\./, '')
  if (['jpg','jpeg','png','heic','webp','tiff','gif','bmp','svg'].includes(e)) return 'Images'
  if (['md','txt','docx','doc','rtf','pptx','xlsx','xls'].includes(e)) return 'Documents'
  if (e === 'pdf') return 'PDFs'
  if (['zip','rar','7z','tar','gz','bz2','xz'].includes(e)) return 'Archives'
  return ''
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function updateTask(id, updates) {
  tasks.value = tasks.value.map(t => t.id === id ? { ...t, ...updates } : t)
}

// Batch-pick up to CONCURRENCY tasks and start them
// Only ONE signal update per drain cycle
function drain() {
  const toStart = []
  for (const t of tasks.value) {
    if (activeCount + toStart.length >= CONCURRENCY) break
    if (t.status === 'queued') toStart.push(t)
  }
  if (!toStart.length) return

  // Single signal update for all picked tasks
  const ids = new Set(toStart.map(t => t.id))
  tasks.value = tasks.value.map(t => ids.has(t.id) ? { ...t, status: 'extracting' } : t)
  activeCount += toStart.length

  for (const task of toStart) {
    runTask(task).finally(() => {
      activeCount = Math.max(0, activeCount - 1)
      drain()
    })
  }
}

async function runTask(task) {
  try {
    const text = await extractFileText(task.path)
    updateTask(task.id, { status: 'generating' })
    let newName = await generateFilename(text, config.value, task.path)
    // Strip duplicate extension (handle both ".pdf" and "pdf" forms)
    if (task.ext && newName.toLowerCase().endsWith(task.ext.toLowerCase())) {
      newName = newName.slice(0, -task.ext.length)
    }
    updateTask(task.id, { newName, status: 'ready' })
  } catch (e) {
    updateTask(task.id, { status: 'error', error: friendlyError(e) })
  }
}

// --- Public API ---

export function enqueueFile(path, name, source = 'drop') {
  const ext = name.includes('.') ? '.' + name.split('.').pop() : ''
  const id = makeId()

  let destFolder = path.split('/').slice(0, -1).join('/')
  if (config.value.autoCategorize && ext) {
    const sub = getCategoryFolder(ext)
    if (sub) destFolder = destFolder + '/' + sub
  }

  tasks.value = [...tasks.value, {
    id, path, originalName: name, ext,
    newName: '', destFolder, source,
    status: 'queued', error: '',
  }]

  // Defer to let UI render first
  setTimeout(drain, 0)
}

export function enqueueFiles(fileList, source = 'scan') {
  const newTasks = fileList.map(f => {
    const ext = f.name.includes('.') ? '.' + f.name.split('.').pop() : ''
    const id = makeId()
    let destFolder = f.path.split('/').slice(0, -1).join('/')
    if (config.value.autoCategorize && ext) {
      const sub = getCategoryFolder(ext)
      if (sub) destFolder = destFolder + '/' + sub
    }
    return {
      id, path: f.path, originalName: f.name, ext,
      newName: '', destFolder, source,
      status: 'queued', error: '',
    }
  })

  tasks.value = [...tasks.value, ...newTasks]
  // Defer drain to let UI render the list first
  setTimeout(drain, 0)
}

export async function confirmTask(id) {
  const task = tasks.value.find(t => t.id === id)
  if (!task || !task.newName || task.status !== 'ready') return

  updateTask(id, { status: 'confirming' })
  const newFullName = task.newName + task.ext
  try {
    const actualName = await moveAndRename(task.path, task.destFolder, newFullName, false)
    const newPath = task.destFolder + '/' + actualName
    const historyId = Date.now() * 1000 + Math.floor(Math.random() * 1000000)
    await addHistory({
      id: historyId,
      originalPath: task.path,
      originalName: task.originalName,
      newPath,
      newName: actualName,
      timestamp: new Date().toISOString(),
    })
    recentActivity.value = [
      { id: historyId, name: task.originalName, newName: actualName, newPath, dest: task.destFolder, time: new Date(), status: 'done' },
      ...recentActivity.value,
    ].slice(0, 200)
    updateTask(id, { status: 'done' })
    showToast(t('common.movedAndRenamed') + ': ' + actualName, 5000, historyId)
  } catch (e) {
    updateTask(id, { status: 'error', error: friendlyError(e) })
    showToast(t('common.operationFailed') + ': ' + friendlyError(e))
  }
}

export async function confirmAll() {
  const readyTasks = tasks.value.filter(t => t.status === 'ready' && t.newName)
  for (const task of readyTasks) {
    await confirmTask(task.id)
  }
}

export function skipTask(id) {
  tasks.value = tasks.value.filter(t => t.id !== id)
}

export function dismissAll() {
  // Keep running tasks (they'll finish harmlessly), remove everything else
  tasks.value = tasks.value.filter(t => t.status === 'extracting' || t.status === 'generating')
}

export function clearDone() {
  tasks.value = tasks.value.filter(t => t.status !== 'done')
}

export function updateTaskName(id, newName) {
  updateTask(id, { newName })
}

export function updateTaskDest(id, destFolder) {
  updateTask(id, { destFolder })
}

export function retryTask(id) {
  updateTask(id, { status: 'queued', error: '' })
  drain()
}
