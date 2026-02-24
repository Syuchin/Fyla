import { files, folderPath, isScanning, isProcessing,
  selectedIds, selectedCount, batchCancelled, batchProgress,
  showToast, config, recentActivity } from '../lib/store.js'
import { FileItem } from '../components/file-item.jsx'
import { pickFolder, scanFolder, extractFileText, generateFilename, renameFiles, addHistory, friendlyError } from '../lib/tauri.js'
import { t } from '../lib/i18n.js'

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
      files.value = list.map((f, i) => ({
        id: i, path: f.path, originalName: f.name,
        newName: '', status: 'pending', error: '',
      }))
      selectedIds.value = new Set(list.map((_, i) => i))
    } catch (e) {
      showToast(t('files.scanFailed') + ': ' + e)
    } finally {
      isScanning.value = false
    }
  }

  async function handleAutoRename() {
    const targets = files.value.filter(f => selectedIds.value.has(f.id) && f.status === 'pending')
    if (!targets.length) { showToast(t('files.noPending')); return }
    isProcessing.value = true
    batchCancelled.value = false
    batchProgress.value = { current: 0, total: targets.length }

    for (const file of targets) {
      if (batchCancelled.value) break
      files.value = files.value.map(f => f.id === file.id ? { ...f, status: 'loading' } : f)
      try {
        const text = await extractFileText(file.path)
        if (batchCancelled.value) break
        const newName = await generateFilename(text, config.value, file.path)
        if (batchCancelled.value) break
        const ext = file.originalName.includes('.') ? '.' + file.originalName.split('.').pop() : ''
        files.value = files.value.map(f =>
          f.id === file.id ? { ...f, status: 'done', newName } : f
        )
        const results = await renameFiles([{ path: file.path, newName: newName + ext }])
        const r = results[0]
        if (r.error) throw new Error(r.error)
        const actualName = r.newName || (newName + ext)
        files.value = files.value.map(f =>
          f.id === file.id ? { ...f, status: 'renamed' } : f
        )
        const dir = file.path.split('/').slice(0, -1).join('/')
        const newPath = dir + '/' + actualName
        const histEntry = {
          id: Date.now() * 1000 + Math.floor(Math.random() * 1000000),
          originalPath: file.path,
          originalName: file.originalName,
          newPath,
          newName: actualName,
          timestamp: new Date().toISOString(),
        }
        addHistory(histEntry).catch(() => {})
        recentActivity.value = [
          { id: histEntry.id, name: file.originalName, newName: actualName, newPath, originalPath: file.path, dest: dir, time: new Date(), status: 'done' },
          ...recentActivity.value,
        ].slice(0, 200)
      } catch (e) {
        files.value = files.value.map(f =>
          f.id === file.id ? { ...f, status: 'error', error: friendlyError(e) } : f
        )
      }
      batchProgress.value = { ...batchProgress.value, current: batchProgress.value.current + 1 }
    }

    isProcessing.value = false
    if (batchCancelled.value) {
      files.value = files.value.map(f => f.status === 'loading' ? { ...f, status: 'pending' } : f)
      showToast(t('files.cancelled'))
    } else {
      const renamed = files.value.filter(f => f.status === 'renamed').length
      showToast(t('files.doneCount', { count: renamed }))
    }
    batchProgress.value = { current: 0, total: 0 }
  }

  function handleCancel() {
    batchCancelled.value = true
  }

  const hasFiles = files.value.length > 0
  const pendingCount = files.value.filter(f => selectedIds.value.has(f.id) && f.status === 'pending').length

  return (
    <div class="main">
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

      {!hasFiles ? (
        <div class="empty-state">
          <svg viewBox="0 0 48 48" fill="none">
            <path d="M8 12A4 4 0 0112 8h8.343a4 4 0 012.829 1.172L25.656 11.5H36A4 4 0 0140 15.5v20A4 4 0 0136 39.5H12A4 4 0 018 35.5V12z" stroke="currentColor" stroke-width="2"/>
            <path d="M24 22v8M20 26h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <p>{t('files.emptyHint')}</p>
          <button class="btn btn-primary" onClick={handlePickFolder}>{t('files.pickFolder')}</button>
        </div>
      ) : (
        <div class="file-list">
          {files.value.map(file => <FileItem key={file.id} file={file} />)}
        </div>
      )}

      {hasFiles && (
        <div class="bottom-bar">
          <div class="bottom-bar-left">
            <span class="count-label">
              {t('files.fileCount', { total: files.value.length, selected: selectedCount.value })}
            </span>
            {!isProcessing.value && (
              <>
                <button class="btn btn-ghost" style="font-size:12px;padding:4px 8px" onClick={() => selectedIds.value = new Set(files.value.map(f => f.id))}>{t('files.selectAll')}</button>
                <button class="btn btn-ghost" style="font-size:12px;padding:4px 8px" onClick={() => selectedIds.value = new Set()}>{t('files.deselect')}</button>
              </>
            )}
            {isProcessing.value && batchProgress.value.total > 0 && (
              <div style="display:flex;align-items:center;gap:8px">
                <div class="progress-bar">
                  <div class="progress-fill" style={`width:${(batchProgress.value.current / batchProgress.value.total) * 100}%`} />
                </div>
                <span class="count-label">{batchProgress.value.current}/{batchProgress.value.total}</span>
              </div>
            )}
          </div>
          <div class="bottom-bar-right">
            {isProcessing.value ? (
              <button class="btn btn-danger" onClick={handleCancel}>{t('files.cancel')}</button>
            ) : (
              <button
                class="btn btn-primary"
                onClick={handleAutoRename}
                disabled={!pendingCount}
              >
                {t('files.aiRename')} ({pendingCount})
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
