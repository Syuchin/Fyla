import { folderPath, isScanning, showToast, config, currentPage } from '../lib/store.js'
import { tasks, stats, enqueueFiles, confirmAll, dismissAll, clearDone } from '../lib/taskQueue.js'
import { TaskItem } from '../components/TaskItem.jsx'
import { Icon } from '../components/Icon.jsx'
import { pickFolder, scanFolder } from '../lib/tauri.js'
import { t } from '../lib/i18n.js'

function hasApiConfig(c) {
  if (c.provider === 'ollama') return !!c.ollamaUrl && !!c.ollamaModel
  if (c.provider === 'openai') return !!c.openaiBaseUrl && !!c.openaiKey
  return false
}

export function FilesPage() {
  async function handlePickFolder() {
    const path = await pickFolder()
    if (!path) return
    folderPath.value = path
    await handleScan(path)
  }

  async function handleScan(path) {
    const target = path || folderPath.value
    if (!target) return
    isScanning.value = true
    try {
      const list = await scanFolder(target, config.value.watchExtensions || 'pdf')
      const MAX_FILES = 500
      const capped = list.slice(0, MAX_FILES)
      if (list.length > MAX_FILES) {
        showToast(t('files.tooMany', { max: MAX_FILES, total: list.length }))
      }
      enqueueFiles(capped, 'scan')
    } catch (e) {
      showToast(t('files.scanFailed') + ': ' + e)
    } finally {
      isScanning.value = false
    }
  }

  const taskList = tasks.value
  const hasTasks = taskList.length > 0
  const { ready, processing, done, total } = stats.value
  const apiConfigured = hasApiConfig(config.value)

  return (
    <div class="main">
      {hasTasks && (
        <div class="toolbar">
          <div class="folder-path">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 3.5A1.5 1.5 0 012.5 2h2.086a1.5 1.5 0 011.06.44L6.5 3.5H11.5A1.5 1.5 0 0113 5v5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 011 10V3.5z" stroke="currentColor" stroke-width="1.2"/>
            </svg>
            <span>{folderPath.value || t('files.noFolder')}</span>
          </div>
          <button class="btn btn-secondary" onClick={handlePickFolder} disabled={isScanning.value}>
            {isScanning.value ? t('files.scanning') : t('files.pickFolder')}
          </button>
        </div>
      )}

      {!hasTasks ? (
        <div class="empty-state">
          <Icon name="file-lines" className="empty-icon" />
          <h3 class="empty-title">{t('empty.title')}</h3>
          <p class="empty-subtitle">{t('empty.subtitle')}</p>

          <div class="empty-flow">
            <span class="empty-flow-step">
              <Icon name="file-lines" className="empty-flow-icon" />
              <span>{t('empty.stepDrop')}</span>
            </span>
            <Icon name="arrow-right" className="empty-flow-arrow" />
            <span class="empty-flow-step">
              <Icon name="microchip" className="empty-flow-icon" />
              <span>{t('empty.stepAnalyze')}</span>
            </span>
            <Icon name="arrow-right" className="empty-flow-arrow" />
            <span class="empty-flow-step">
              <Icon name="wand-magic-sparkles" className="empty-flow-icon" />
              <span>{t('empty.stepRename')}</span>
            </span>
          </div>

          {!apiConfigured && (
            <div class="empty-hint">
              <Icon name="triangle-exclamation" className="empty-hint-icon" />
              <span>{t('empty.noApiHint')}</span>
              <a class="empty-hint-link" onClick={() => currentPage.value = 'settings'}>
                <Icon name="gear" className="empty-hint-icon" />
                {t('empty.goSettings')}
              </a>
            </div>
          )}

          <button class="btn btn-primary" style="margin-top:8px" onClick={handlePickFolder} disabled={isScanning.value}>
            {isScanning.value ? t('files.scanning') : t('files.pickFolder')}
          </button>
        </div>
      ) : (
        <div class="file-list">
          {taskList.map(task => (
            <TaskItem key={task.id} task={task} />
          ))}
        </div>
      )}

      {hasTasks && (
        <div class="bottom-bar">
          <div class="bottom-bar-left">
            <span class="count-label">
              {total} {t('task.total')}
              {processing > 0 && <> · {processing} {t('task.processingLabel')}</>}
              {ready > 0 && <> · {ready} {t('task.readyLabel')}</>}
              {done > 0 && <> · {done} {t('task.doneLabel')}</>}
            </span>
          </div>
          <div class="bottom-bar-right">
            {done > 0 && (
              <button class="btn btn-ghost" style="font-size:12px;padding:4px 8px" onClick={clearDone}>{t('task.clearDone')}</button>
            )}
            {taskList.length > 0 && (
              <button class="btn btn-ghost" style="font-size:12px;padding:4px 8px" onClick={dismissAll}>{t('confirm.dismissAll')}</button>
            )}
            {ready > 0 && (
              <button class="btn btn-primary" onClick={confirmAll}>
                {t('confirm.confirmAll')} ({ready})
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
