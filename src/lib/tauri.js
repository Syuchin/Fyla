import { invoke, Channel } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { emitTo } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { Command, open as openShell } from '@tauri-apps/plugin-shell'
import { t } from './i18n.js'

export async function pickFolder() {
  const selected = await openDialog({
    directory: true,
    multiple: false,
    title: t('files.pickFolder'),
  })
  return selected
}

export async function pickPdfFiles() {
  const selected = await openDialog({
    directory: false,
    multiple: true,
    title: t('papers.pickPapers'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (!selected) return []
  return Array.isArray(selected) ? selected : [selected]
}

export async function pickImageFiles() {
  const selected = await openDialog({
    directory: false,
    multiple: true,
    title: t('papers.chatImagePickerTitle'),
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'] }],
  })
  if (!selected) return []
  return Array.isArray(selected) ? selected : [selected]
}

export async function scanFolder(path, extensions = 'pdf') {
  return await invoke('scan_folder', { path, extensions })
}

export async function scanPaths(paths, maxDepth = 3) {
  return await invoke('scan_paths', { paths, maxDepth })
}

export async function extractFileText(path) {
  return await invoke('extract_file_text', { path })
}

export async function readPaperArchiveMarkdown(path) {
  return await invoke('read_paper_archive_markdown', { path })
}

export async function readBinaryFile(path) {
  return await invoke('read_file_bytes', { path })
}

export async function generateFilename(text, config, filePath) {
  return await invoke('generate_filename', { text, config, filePath })
}

export async function generateNamesStream(paths, config, onEvent) {
  const channel = new Channel()
  channel.onmessage = (msg) => {
    onEvent(msg)
  }
  await invoke('generate_names_stream', { paths, config, onEvent: channel })
}

export async function renameFiles(tasks) {
  return await invoke('rename_files', { tasks })
}

export async function moveAndRename(srcPath, destFolder, newName, autoCategorize = false) {
  return await invoke('move_and_rename', { srcPath, destFolder, newName, autoCategorize })
}

export async function getConfig() {
  return await invoke('get_config')
}

export async function getAppVersion() {
  return await getVersion()
}

export async function saveConfig(config) {
  return await invoke('save_config', { config })
}

export async function startWatch(folder, extensions) {
  return await invoke('start_watch', { folder, extensions })
}

export async function stopWatch() {
  return await invoke('stop_watch')
}

export async function testConnection(config) {
  return await invoke('test_connection', { config })
}

export async function testPaperConnection(config) {
  return await invoke('test_paper_connection', { config })
}

export async function getPaperEmbeddingStatus(config) {
  return await invoke('get_paper_embedding_status', { config })
}

export async function testPaperEmbeddingConnection(config) {
  return await invoke('test_paper_embedding_connection', { config })
}

export async function generatePaperReviewsStream(paths, config, projectName, onEvent) {
  const channel = new Channel()
  channel.onmessage = (msg) => onEvent(msg)
  await invoke('generate_paper_reviews_stream', { paths, config, projectName, onEvent: channel })
}

export async function getHistory() {
  return await invoke('get_history')
}

export async function addHistory(entry) {
  return await invoke('add_history', { entry })
}

export async function getPaperHistory() {
  return await invoke('get_paper_history')
}

export async function preparePaperChatSession(sourcePath, savedPath, title, config) {
  return await invoke('prepare_paper_chat_session', { sourcePath, savedPath, title, config })
}

export async function createPaperChatSession(sourcePath, savedPath, title, config) {
  return await invoke('create_paper_chat_session', { sourcePath, savedPath, title, config })
}

export async function getPaperChatHistory(sessionId) {
  return await invoke('get_paper_chat_history', { sessionId })
}

export async function clearPaperChatSession(sessionId) {
  return await invoke('clear_paper_chat_session', { sessionId })
}

export async function stopPaperChatStream(sessionId) {
  return await invoke('stop_paper_chat_stream', { sessionId })
}

export async function streamPaperChatReply(sessionId, question, attachments, images, selectionContext, config, onEvent) {
  const channel = new Channel()
  channel.onmessage = msg => onEvent(msg)
  await invoke('stream_paper_chat_reply', {
    sessionId,
    question,
    attachments,
    images,
    selectionContext,
    config,
    onEvent: channel,
  })
}

export async function retryPaperChatTurn(sessionId, config, onEvent) {
  const channel = new Channel()
  channel.onmessage = msg => onEvent(msg)
  await invoke('retry_paper_chat_turn', {
    sessionId,
    config,
    onEvent: channel,
  })
}

export async function addPaperHistory(entry) {
  return await invoke('add_paper_history', { entry })
}

export async function removePaperHistoryItem(id) {
  return await invoke('remove_paper_history_item', { id })
}

export async function clearPaperHistoryItems() {
  return await invoke('clear_paper_history')
}

export async function undoRename(id) {
  return await invoke('undo_rename', { id })
}

export async function setBadgeCount(count) {
  return await invoke('set_badge_count', { count })
}

export async function openPaperChatWindow(payload) {
  let win = await WebviewWindow.getByLabel('paper-chat')
  if (!win) {
    win = new WebviewWindow('paper-chat')
    await new Promise((resolve, reject) => {
      const cleanup = []
      win.once('tauri://created', () => {
        cleanup.forEach(fn => fn())
        resolve()
      }).then(unlisten => cleanup.push(unlisten))
      win.once('tauri://error', event => {
        cleanup.forEach(fn => fn())
        reject(new Error(String(event.payload)))
      }).then(unlisten => cleanup.push(unlisten))
    })
  }
  await win.show()
  await win.setFocus()
  await emitTo('paper-chat', 'paper-chat:activate', payload)
  return win
}

export async function hidePaperChatWindow() {
  const win = await WebviewWindow.getByLabel('paper-chat')
  if (!win) return
  await win.hide()
}

export async function focusPaperChatWindow(payload = null) {
  const win = await WebviewWindow.getByLabel('paper-chat')
  if (!win) return null
  if (payload) {
    await emitTo('paper-chat', 'paper-chat:activate', payload)
  }
  await win.show()
  await win.setFocus()
  return win
}

export async function revealInFinder(path) {
  try {
    await Command.create('reveal-in-finder', ['-R', path]).execute()
  } catch (_) {}
}

export function isAllowedExternalUrl(input) {
  const value = String(input || '').trim()
  if (!value) return false

  let parsed
  try {
    parsed = new URL(value)
  } catch (_) {
    return false
  }

  if (parsed.protocol === 'https:') return true
  if (parsed.protocol === 'http:' && parsed.hostname === 'localhost') return true
  return false
}

export async function openExternalUrl(input) {
  const value = String(input || '').trim()
  if (!isAllowedExternalUrl(value)) {
    throw new Error(t('errors.invalidExternalUrl'))
  }

  try {
    await openShell(value)
  } catch (_) {
    throw new Error(t('errors.openExternalFailed'))
  }
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

const errorMap = [
  [/Connection refused|连接被拒绝/i, 'errors.ollamaNotRunning'],
  [/无法连接 Ollama/i, 'errors.ollamaConnFailed'],
  [/timeout|超时/i, 'errors.timeout'],
  [/API Key 无效/i, 'errors.invalidApiKey'],
  [/401|Unauthorized/i, 'errors.unauthorized'],
  [/429|Too Many Requests/i, 'errors.tooManyRequests'],
  [/500|Internal Server Error/i, 'errors.serverError'],
  [/模型.*未找到|model.*not found/i, 'errors.modelNotFound'],
  [/目标文件已存在|already exists/i, 'errors.fileExists'],
  [/文件不存在|not found/i, 'errors.fileNotFound'],
  [/PDF.*extract|提取.*失败/i, 'errors.pdfExtractFailed'],
  [/AI 返回了空文件名|empty.*filename/i, 'errors.emptyFilename'],
  [/论文解读结果解析失败/i, 'errors.paperParseFailed'],
]

export function friendlyError(err) {
  const msg = String(err)
  for (const [pattern, key] of errorMap) {
    if (pattern.test(msg)) return t(key)
  }
  return msg
}
