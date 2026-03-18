import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { Icon } from '../components/Icon.jsx'
import { PaperHistoryItem } from '../components/PaperHistoryItem.jsx'
import { PaperTaskItem } from '../components/PaperTaskItem.jsx'
import { activatePaperTab, clearPaperDone, clearPaperHistory, enqueuePaperPaths, hasPaperConfig, hydratePaperHistory, isPaperRunning, paperHistory, paperStats, paperTasks, startPaperBatch } from '../lib/paperQueue.js'
import { pickPdfFiles } from '../lib/tauri.js'
import { paperListScrollPositions, paperProjectName, papersActiveTab, showToast, currentPage } from '../lib/store.js'
import { t } from '../lib/i18n.js'

export function PapersPage() {
  const [now, setNow] = useState(Date.now())
  const historyPanelRef = useRef(null)
  const queuePanelRef = useRef(null)
  const list = paperTasks.value
  const historyList = paperHistory.value
  const stats = paperStats.value
  const configured = hasPaperConfig()
  const activeTab = papersActiveTab.value
  const running = isPaperRunning.value

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    hydratePaperHistory().catch(err => {
      showToast(t('papers.historyLoadFailed') + ': ' + String(err))
    })
  }, [])

  useLayoutEffect(() => {
    const panel = activeTab === 'history' ? historyPanelRef.current : queuePanelRef.current
    if (!panel) return
    const nextTop = paperListScrollPositions.value[activeTab] || 0
    const rafId = requestAnimationFrame(() => {
      panel.scrollTop = nextTop
    })
    return () => cancelAnimationFrame(rafId)
  }, [activeTab, historyList.length, list.length])

  useEffect(() => {
    if (configured && !running && stats.queued > 0) {
      void startPaperBatch()
    }
  }, [configured, running, stats.queued])

  async function handlePickPapers() {
    const paths = await pickPdfFiles()
    if (!paths.length) return
    const added = enqueuePaperPaths(paths, 'pick')
    if (!added) {
      showToast(t('papers.duplicateSkipped'))
      return
    }
    void startPaperBatch()
  }

  const hasTasks = list.length > 0
  const hasHistory = historyList.length > 0

  function handlePanelScroll(tab, event) {
    const scrollTop = event.currentTarget.scrollTop
    const current = paperListScrollPositions.value
    if (current[tab] === scrollTop) return
    paperListScrollPositions.value = { ...current, [tab]: scrollTop }
  }

  return (
    <div class="main">
      <div class="papers-page">
        <section class="papers-shell-card">
          <div class="papers-shell-top">
            <div class="papers-shell-heading">
              <span class="papers-eyebrow">{t('papers.eyebrow')}</span>
              <h2>{t('papers.title')}</h2>
              <p>{t('papers.subtitle')}</p>

              <label class="papers-project-field">
                <span>{t('papers.projectName')}</span>
                <input
                  class="settings-input"
                  type="text"
                  value={paperProjectName.value}
                  onInput={e => { paperProjectName.value = e.target.value }}
                  placeholder={t('papers.projectPlaceholder')}
                />
              </label>
            </div>

            <div class="papers-shell-side">
              <div class="papers-shell-actions">
                <button class="btn btn-secondary paper-action-btn paper-action-btn-secondary" onClick={handlePickPapers}>
                  {hasTasks ? t('papers.addMore') : t('papers.pickPapers')}
                </button>
              </div>

              <div class="papers-queue-panel">
                <span class="papers-queue-label">{t('papers.queueTitle')}</span>
                <div class="papers-stats-strip">
                  <span class="papers-stat-chip">{stats.total} {t('papers.total')}</span>
                  <span class="papers-stat-chip">{stats.processing} {t('papers.processing')}</span>
                  <span class="papers-stat-chip">{stats.done} {t('papers.done')}</span>
                  <span class="papers-stat-chip">{stats.error} {t('papers.failed')}</span>
                  <span class="papers-stat-chip">{t('papers.totalElapsed', { time: formatMs(stats.totalElapsedMs) })}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="papers-support-strip">
            <span class="papers-meta-chip">{t('papers.pdfOnly')}</span>
            <span class="papers-meta-chip">{t('papers.localArchive')}</span>
            <span class="papers-meta-chip">{t('papers.batchMode')}</span>
            <span class="papers-meta-chip">{t('papers.strongerModel')}</span>
          </div>
        </section>

        {!configured && (
          <div class="empty-hint papers-config-hint">
            <Icon name="triangle-exclamation" className="empty-hint-icon" />
            <span>{t('papers.configRequired')}</span>
            <a class="empty-hint-link" onClick={() => currentPage.value = 'settings'}>
              <Icon name="gear" className="empty-hint-icon" />
              {t('empty.goSettings')}
            </a>
          </div>
        )}

        <section class="papers-list-shell">
          <div class="papers-list-header">
            <div class="papers-list-tabs" role="tablist" aria-label={t('papers.listSwitcher')}>
              <button
                class={`papers-list-tab ${activeTab === 'history' ? 'active' : ''}`}
                role="tab"
                aria-selected={activeTab === 'history'}
                onClick={() => activatePaperTab('history')}
              >
                <span>{t('papers.historyTab')}</span>
                <span class="papers-list-tab-count">{historyList.length}</span>
              </button>
              <button
                class={`papers-list-tab ${activeTab === 'queue' ? 'active' : ''}`}
                role="tab"
                aria-selected={activeTab === 'queue'}
                onClick={() => activatePaperTab('queue')}
              >
                <span>{t('papers.queueTab')}</span>
                <span class="papers-list-tab-count">{stats.total}</span>
              </button>
            </div>

            <div class="papers-list-header-actions">
              {activeTab === 'history' ? (
                <>
                  {hasHistory && (
                    <button class="btn btn-ghost" onClick={clearPaperHistory}>{t('papers.clearHistory')}</button>
                  )}
                  <span class="papers-list-summary">
                    {t('papers.historyCount', { count: historyList.length })}
                  </span>
                </>
              ) : (
                <>
                  {stats.done > 0 && (
                    <button class="btn btn-ghost" onClick={clearPaperDone}>{t('papers.clearDone')}</button>
                  )}
                  <span class="papers-list-summary">
                    {stats.total} {t('papers.total')}
                  </span>
                </>
              )}
            </div>
          </div>

          <div class="papers-list-viewport">
            <section
              ref={historyPanelRef}
              class={`papers-list-panel papers-list-panel-history ${activeTab === 'history' ? 'is-active' : ''}`}
              aria-hidden={activeTab !== 'history'}
              onScroll={event => handlePanelScroll('history', event)}
            >
              {hasHistory ? (
                <div class="papers-history-list">
                  {historyList.map(item => (
                    <PaperHistoryItem key={item.id} item={item} />
                  ))}
                </div>
              ) : (
                <div class="empty-state papers-empty-state">
                  <Icon name="rotate-left" className="empty-icon" />
                  <h3 class="empty-title">{t('papers.historyEmptyTitle')}</h3>
                  <p class="empty-subtitle">{t('papers.historyEmptySubtitle')}</p>
                </div>
              )}
            </section>

            <section
              ref={queuePanelRef}
              class={`papers-list-panel papers-list-panel-queue ${activeTab === 'queue' ? 'is-active' : ''}`}
              aria-hidden={activeTab !== 'queue'}
              onScroll={event => handlePanelScroll('queue', event)}
            >
              {hasTasks ? (
                <div class="papers-list">
                  {list.map(task => (
                    <PaperTaskItem key={task.id} task={task} now={now} hasProcessingTasks={stats.processing > 0} />
                  ))}
                </div>
              ) : (
                <div class="empty-state papers-empty-state">
                  <Icon name="file-lines" className="empty-icon" />
                  <h3 class="empty-title">{t('papers.emptyTitle')}</h3>
                  <p class="empty-subtitle">{t('papers.emptySubtitle')}</p>
                  <button class="btn btn-primary" onClick={handlePickPapers}>{t('papers.pickPapers')}</button>
                </div>
              )}
            </section>
          </div>
        </section>
      </div>
    </div>
  )
}

function formatMs(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}
