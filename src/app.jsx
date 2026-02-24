import { useEffect, useState } from 'preact/hooks'
import { listen } from '@tauri-apps/api/event'
import {
  currentPage, toast, config,
  isWatching, recentActivity, showToast, showWelcome,
} from './lib/store.js'
import { tasks, stats, enqueueFile, confirmAll, dismissAll } from './lib/taskQueue.js'
import { getConfig, getHistory, undoRename, friendlyError, setBadgeCount, scanPaths } from './lib/tauri.js'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { useAppShortcuts } from './lib/shortcuts.js'
import { t, lang, toggleLang } from './lib/i18n.js'
import { checkForUpdate } from './lib/updater.js'
import { FilesPage } from './pages/files.jsx'
import { SettingsPage } from './pages/settings.jsx'
import { HistoryPage } from './pages/history.jsx'
import { WelcomeGuide, useOnboard } from './components/WelcomeGuide.jsx'

export function App() {
  const { onboardDone, finishOnboard } = useOnboard()
  if (!onboardDone) showWelcome.value = true

  useEffect(() => {
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
      try {
        let granted = await isPermissionGranted()
        if (!granted) granted = (await requestPermission()) === 'granted'
        if (granted) sendNotification({ title: t('common.newFileDetected'), body: name })
      } catch (_) {}
      enqueueFile(path, name, 'watch')
    })

    const unlistenFinderService = listen('finder-service-files', async (event) => {
      const paths = JSON.parse(event.payload)
      const files = await scanPaths(paths, 1)
      for (const f of files) {
        enqueueFile(f.path, f.name, 'finder')
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
        enqueueFile(f.path, f.name, 'drop')
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

  useAppShortcuts({
    onConfirmAll: confirmAll,
    onUndo: () => {
      const last = recentActivity.value[0]
      if (last) handleUndo(last.id)
    },
    onDismiss: () => {
      if (tasks.value.length > 0) {
        dismissAll()
      }
    },
  })

  async function handleUndo(id) {
    try {
      const entry = await undoRename(id)
      recentActivity.value = recentActivity.value.filter(a => a.id !== id)
      showToast(t('history.undone') + ': ' + entry.originalName)
    } catch (e) {
      showToast(t('history.undoFailed') + ': ' + friendlyError(e))
    }
  }

  function renderPage(page) {
    switch (page) {
      case 'history':  return <HistoryPage />
      case 'settings': return <SettingsPage />
      default:         return <FilesPage />
    }
  }

  const [dragOver, setDragOver] = useState(false)
  const { ready, processing } = stats.value
  const pendingCount = ready + processing

  useEffect(() => {
    setBadgeCount(pendingCount).catch(() => {})
  }, [pendingCount])

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
          {pendingCount > 0 && (
            <div class="pending-badge" title={t('confirm.pendingBadge', { count: pendingCount })} onClick={() => currentPage.value = 'files'}>
              <span class="pending-count">{pendingCount}</span>
              <span class="pending-text">{t('confirm.pendingLabel')}</span>
            </div>
          )}
          {isWatching.value && (
            <div class="watch-indicator" title={`${t('common.monitoring')}: ${config.value.watchFolder}`}>
              <span class="watch-dot" />
              <span class="watch-text">{t('common.monitoring')}</span>
            </div>
          )}
          <button class="lang-toggle" onClick={toggleLang} title={lang.value === 'zh' ? 'English' : '中文'}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10A15.3 15.3 0 0112 2z"/>
            </svg>
          </button>
        </div>
      </div>

      <div class="page-content">
        {renderPage(currentPage.value)}
      </div>

      {toast.value && (
        <div class="toast">
          <span>{toast.value.msg}</span>
          {toast.value.undoId && (
            <button class="toast-undo" onClick={() => handleUndo(toast.value.undoId)}>{t('history.undo')}</button>
          )}
        </div>
      )}

      {showWelcome.value && (
        <WelcomeGuide onDone={() => { finishOnboard(); showWelcome.value = false }} />
      )}
    </div>
  )
}
