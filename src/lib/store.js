import { signal, computed } from '@preact/signals'

// 当前页面
export const currentPage = signal('files')

// 配置
export const config = signal({
  provider: 'ollama',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.2',
  openaiKey: '',
  openaiModel: 'gpt-4o-mini',
  openaiBaseUrl: 'https://api.openai.com/v1',
  customRules: '',
  namingStyle: 'kebab-case',
  includeDate: false,
  watchFolder: '',
  watchExtensions: 'pdf',
  nameTemplate: '',
  defaultDestFolder: '',
  autoCategorize: false,
})

// 文件夹路径
export const folderPath = signal('')

// 文件列表
// status: 'pending' | 'loading' | 'done' | 'error' | 'renamed'
export const files = signal([])

// 全局状态
export const isScanning = signal(false)
export const isRenaming = signal(false)
export const isProcessing = signal(false)
export const isWatching = signal(false)
export const batchCancelled = signal(false)
export const batchProgress = signal({ current: 0, total: 0 })
export const toast = signal(null)

// 自动重命名历史记录
export const recentActivity = signal([])

// 待确认队列（支持多文件排队）
// 每项: { id, path, name, ext, newName, destFolder, status: 'analyzing' | 'ready' | 'error', error }
export const confirmQueue = signal([])

export function pushConfirm(item) {
  confirmQueue.value = [...confirmQueue.value, item]
}

export function updateConfirmById(id, updates) {
  confirmQueue.value = confirmQueue.value.map(item =>
    item.id === id ? { ...item, ...updates } : item
  )
}

export function removeConfirmById(id) {
  confirmQueue.value = confirmQueue.value.filter(item => item.id !== id)
}

// 选中的文件
export const selectedIds = signal(new Set())

export const selectedCount = computed(() => selectedIds.value.size)
export const doneCount = computed(() => files.value.filter(f => f.newName && f.status === 'done').length)

// toast: null | { msg, undoId? }
let toastTimer = null
export function showToast(msg, duration = 3000, undoId = null) {
  if (toastTimer) clearTimeout(toastTimer)
  toast.value = { msg, undoId }
  toastTimer = setTimeout(() => { toast.value = null }, duration)
}

export function toggleSelect(id) {
  const s = new Set(selectedIds.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  selectedIds.value = s
}

export function selectAll() {
  selectedIds.value = new Set(files.value.map(f => f.id))
}

export function selectNone() {
  selectedIds.value = new Set()
}

export function updateFileName(id, newName) {
  files.value = files.value.map(f => f.id === id ? { ...f, newName } : f)
}
