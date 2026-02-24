import { useEffect, useState } from 'preact/hooks'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  currentPage, toast, config,
  isWatching, recentActivity, showToast,
  confirmQueue, pushConfirm, updateConfirmById, removeConfirmById,
} from './lib/store.js'
import { getConfig, getHistory, extractFileText, generateFilename, moveAndRename, pickFolder, addHistory, undoRename, friendlyError, setBadgeCount, scanPaths } from './lib/tauri.js'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { useAppShortcuts } from './lib/shortcuts.js'
import { t, lang, toggleLang } from './lib/i18n.js'
import { checkForUpdate } from './lib/updater.js'
import { FilesPage } from './pages/files.jsx'
import { SettingsPage } from './pages/settings.jsx'
import { HistoryPage } from './pages/history.jsx'

export function App() {
  async function processFile(path, name) {
    const ext = name.includes('.') ? '.' + name.split('.').pop() : '.pdf'
    const id = Date.now() * 1000 + Math.floor(Math.random() * 1000000)

    const defaultDest = config.value.defaultDestFolder || path.split('/').slice(0, -1).join('/')

    pushConfirm({
      id, path, name, ext,
      newName: '', destFolder: defaultDest,
      status: 'analyzing', error: '',
    })

    try {
      const text = await extractFileText(path)
      let newName = await generateFilename(text, config.value, path)
      // 兜底：如果后端返回的名字仍带后缀，在前端去掉
      if (ext && newName.toLowerCase().endsWith(ext.toLowerCase())) {
        newName = newName.slice(0, -ext.length)
      }
      confirmQueue.value = confirmQueue.value.map(item =>
        item.id === id ? { ...item, newName, status: 'ready' } : item
      )
    } catch (e) {
      confirmQueue.value = confirmQueue.value.map(item =>
        item.id === id ? { ...item, status: 'error', error: friendlyError(e) } : item
      )
    }
  }

  useEffect(() => {
    isPermissionGranted().then(async (granted) => {
      if (!granted) await requestPermission()
    }).catch(() => {})

    // Check for updates after a short delay
    setTimeout(checkForUpdate, 5000)

    getConfig().then(c => {
      if (c) {
        config.value = c
        if (c.watchFolder) isWatching.value = true
      }
    }).catch(() => {})

    getHistory().then(history => {
      if (history && history.length) {
        recentActivity.value = history.map(h => ({
          id: h.id,
          name: h.originalName,
          newName: h.newName,
          newPath: h.newPath,
          originalPath: h.originalPath,
          dest: h.newPath.split('/').slice(0, -1).join('/'),
          time: new Date(h.timestamp),
          status: 'done',
        }))
      }
    }).catch(() => {})

    const unlisten = listen('new-file', async (event) => {
      const { path, name } = event.payload
      try { sendNotification({ title: t('common.newFileDetected'), body: name }) } catch (_) {}
      processFile(path, name)
    })

    const unlistenFinderService = listen('finder-service-files', async (event) => {
      const paths = JSON.parse(event.payload)
      const files = await scanPaths(paths, 1)
      for (const f of files) {
        processFile(f.path, f.name + '.' + f.ext)
      }
      currentPage.value = 'files'
    })

    const unlistenDragEnter = listen('tauri://drag-enter', () => setDragOver(true))
    const unlistenDragLeave = listen('tauri://drag-leave', () => setDragOver(false))

    const unlistenDrop = listen('tauri://drag-drop', async (event) => {
      setDragOver(false)
      const paths = event.payload.paths || []
      if (!paths.length) return
      const files = await scanPaths(paths, 3)
      for (const f of files) {
        processFile(f.path, f.name + '.' + f.ext)
      }
    })

    return () => {
      unlisten.then(fn => fn())
      unlistenDrop.then(fn => fn())
      unlistenDragEnter.then(fn => fn())
      unlistenDragLeave.then(fn => fn())
      unlistenFinderService.then(fn => fn())
    }
  }, [])

  useEffect(() => {
    function onKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        const last = recentActivity.value[0]
        if (last) {
          e.preventDefault()
          handleUndo(last.id)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  useAppShortcuts({
    onConfirmAll: handleConfirmAll,
    onUndo: () => {
      const last = recentActivity.value[0]
      if (last) handleUndo(last.id)
    },
    onDismiss: () => {
      if (confirmQueue.value.length > 0) {
        confirmQueue.value = []
      }
    },
  })

  async function handleConfirmRename(item) {
    if (!item || !item.newName) return
    const newFullName = item.newName + item.ext
    try {
      const actualName = await moveAndRename(item.path, item.destFolder, newFullName, !!config.value.autoCategorize)
      const newPath = item.destFolder + '/' + actualName
      await addHistory({
        id: item.id,
        originalPath: item.path,
        originalName: item.name,
        newPath,
        newName: actualName,
        timestamp: new Date().toISOString(),
      })
      recentActivity.value = [
        { id: item.id, name: item.name, newName: actualName, newPath, dest: item.destFolder, time: new Date(), status: 'done' },
        ...recentActivity.value,
      ].slice(0, 200)
      showToast(t('common.movedAndRenamed') + ': ' + actualName, 5000, item.id)
      const visible = await getCurrentWindow().isVisible()
      if (!visible) {
        try { sendNotification({ title: 'Fyla', body: t('common.movedAndRenamed') + ': ' + actualName }) } catch (_) {}
      }
    } catch (e) {
      showToast(t('common.operationFailed') + ': ' + friendlyError(e))
    }
    removeConfirmById(item.id)
  }

  function handleSkip(id) {
    removeConfirmById(id)
  }

  async function handleConfirmAll() {
    const readyItems = confirmQueue.value.filter(i => i.status === 'ready' && i.newName)
    for (const item of readyItems) {
      await handleConfirmRename(item)
    }
  }

  async function handlePickDest(id) {
    const folder = await pickFolder()
    if (folder) {
      updateConfirmById(id, { destFolder: folder })
    }
  }

  async function handleUndo(id) {
    try {
      const entry = await undoRename(id)
      recentActivity.value = recentActivity.value.filter(a => a.id !== id)
      showToast(t('history.undone') + ': ' + entry.originalName)
    } catch (e) {
      showToast(t('history.undoFailed') + ': ' + friendlyError(e))
    }
  }

  const queue = confirmQueue.value
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    setBadgeCount(queue.length).catch(() => {})
  }, [queue.length])

  return (
    <div id="app">
      {dragOver && (
        <div class="drag-overlay">
          <div class="drag-overlay-content">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M12 5v14M5 12h14" stroke-linecap="round"/>
            </svg>
            <p>{t('common.dropHint')}</p>
          </div>
        </div>
      )}
      <div class="titlebar" data-tauri-drag-region>
        <div class="titlebar-tabs">
          <button
            class={`tab ${currentPage.value === 'files' ? 'active' : ''}`}
            onClick={() => currentPage.value = 'files'}
          >
            {t('nav.files')}
          </button>
          <button
            class={`tab ${currentPage.value === 'history' ? 'active' : ''}`}
            onClick={() => currentPage.value = 'history'}
          >
            {t('nav.history')}
          </button>
          <button
            class={`tab ${currentPage.value === 'settings' ? 'active' : ''}`}
            onClick={() => currentPage.value = 'settings'}
          >
            {t('nav.settings')}
          </button>
        </div>
        <div
          class="titlebar-spacer"
          data-tauri-drag-region
        />
        <div class="titlebar-right">
          {queue.length > 0 && (
            <div class="pending-badge" title={t('confirm.pendingBadge', { count: queue.length })} onClick={() => currentPage.value = 'files'}>
              <span class="pending-count">{queue.length}</span>
              <span class="pending-text">{t('confirm.pendingLabel')}</span>
            </div>
          )}
          {isWatching.value && (
            <div class="watch-indicator" title={`${t('common.monitoring')}: ${config.value.watchFolder}`}>
              <span class="watch-dot" />
              <span class="watch-text">{t('common.monitoring')}</span>
            </div>
          )}
          <button class="lang-toggle" onClick={toggleLang}>
            {lang.value === 'zh' ? 'EN' : '中文'}
          </button>
        </div>
      </div>

      <div class="page-content">
        {currentPage.value === 'files' ? <FilesPage /> : currentPage.value === 'history' ? <HistoryPage /> : <SettingsPage />}
      </div>

      {queue.length > 0 && (
        <div class="confirm-panel">
          <div class="confirm-panel-header">
            <span>{t('confirm.pending')} ({queue.length})</span>
            {queue.filter(i => i.status === 'ready' && i.newName).length > 1 && (
              <button class="btn btn-primary btn-sm" onClick={handleConfirmAll}>{t('confirm.confirmAll')}</button>
            )}
          </div>
          <div class="confirm-panel-list">
            {queue.map(item => (
              <div class={`confirm-item confirm-item--${item.status}`} key={item.id}>
                <div class="confirm-item-name">{item.name}</div>
                {item.status === 'analyzing' && (
                  <div class="confirm-item-status">{t('confirm.analyzing')}</div>
                )}
                {item.status === 'ready' && (
                  <div class="confirm-item-detail">
                    <div class="confirm-item-row">
                      <input
                        class="confirm-input"
                        data-file-input
                        value={item.newName}
                        onInput={e => updateConfirmById(item.id, { newName: e.target.value })}
                      />
                      <span class="confirm-ext">{item.ext}</span>
                    </div>
                    <div class="confirm-item-row">
                      <span class="confirm-dest-label">{t('confirm.saveTo')}</span>
                      <button class="confirm-dest-btn" onClick={() => handlePickDest(item.id)}>
                        {item.destFolder.split('/').pop() || item.destFolder}
                      </button>
                    </div>
                  </div>
                )}
                {item.status === 'error' && (
                  <div class="confirm-item-error">{item.error}</div>
                )}
                <div class="confirm-item-actions">
                  <button class="btn btn-secondary btn-sm" onClick={() => handleSkip(item.id)}>{t('confirm.skip')}</button>
                  {item.status === 'ready' && item.newName && (
                    <button class="btn btn-primary btn-sm" onClick={() => handleConfirmRename(item)}>{t('confirm.confirm')}</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {toast.value && (
        <div class="toast">
          <span>{toast.value.msg}</span>
          {toast.value.undoId && (
            <button class="toast-undo" onClick={() => handleUndo(toast.value.undoId)}>{t('history.undo')}</button>
          )}
        </div>
      )}
    </div>
  )
}
