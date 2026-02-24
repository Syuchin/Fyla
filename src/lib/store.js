import { signal } from '@preact/signals'

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
  autoCategorize: false,
})

// 文件夹路径
export const folderPath = signal('')

// 全局状态
export const isScanning = signal(false)
export const isWatching = signal(false)
export const toast = signal(null)

// 引导弹窗
export const showWelcome = signal(false)

// 重命名历史记录
export const recentActivity = signal([])

// toast: null | { msg, undoId? }
let toastTimer = null
export function showToast(msg, duration = 3000, undoId = null) {
  if (toastTimer) clearTimeout(toastTimer)
  toast.value = { msg, undoId }
  toastTimer = setTimeout(() => { toast.value = null }, duration)
}
