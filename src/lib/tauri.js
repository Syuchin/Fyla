import { invoke, Channel } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { t } from './i18n.js'

export async function pickFolder() {
  const selected = await open({
    directory: true,
    multiple: false,
    title: t('files.pickFolder'),
  })
  return selected
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

export async function moveAndRename(srcPath, destFolder, newName) {
  return await invoke('move_and_rename', { srcPath, destFolder, newName })
}

export async function getConfig() {
  return await invoke('get_config')
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

export async function getHistory() {
  return await invoke('get_history')
}

export async function addHistory(entry) {
  return await invoke('add_history', { entry })
}

export async function undoRename(id) {
  return await invoke('undo_rename', { id })
}

export async function setBadgeCount(count) {
  return await invoke('set_badge_count', { count })
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
]

export function friendlyError(err) {
  const msg = String(err)
  for (const [pattern, key] of errorMap) {
    if (pattern.test(msg)) return t(key)
  }
  return msg
}
