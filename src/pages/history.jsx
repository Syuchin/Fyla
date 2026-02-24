import { recentActivity, showToast } from '../lib/store.js'
import { undoRename, friendlyError } from '../lib/tauri.js'
import { Command } from '@tauri-apps/plugin-shell'
import { t, lang } from '../lib/i18n.js'

async function revealInFinder(path) {
  try {
    await Command.create('reveal-in-finder', ['-R', path]).execute()
  } catch (_) {}
}

export function HistoryPage() {
  async function handleUndo(item) {
    try {
      await undoRename(item.id)
      recentActivity.value = recentActivity.value.filter(a => a.id !== item.id)
      showToast(t('history.undone') + ': ' + item.name)
    } catch (e) {
      showToast(t('history.undoFailed') + ': ' + friendlyError(e))
    }
  }

  const list = recentActivity.value

  return (
    <div class="main">
      <div class="history-page">
        <div class="history-card">
          <div class="history-card-title">
            <span>{t('history.title')}</span>
            <span class="history-count">{t('history.count', { count: list.length })}</span>
          </div>

          {list.length === 0 ? (
            <div class="empty-state" style="padding:40px 20px">
              <svg width="40" height="40" viewBox="0 0 48 48" fill="none">
                <circle cx="24" cy="24" r="16" stroke="currentColor" stroke-width="2"/>
                <path d="M24 16v8l5 3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
              <p>{t('history.empty')}</p>
            </div>
          ) : (
            <div class="history-list">
              {list.map(item => (
                <div key={item.id} class="list-row history-item">
                  <div class="list-row-names">
                    <span class="list-row-original">{item.name}</span>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="list-row-arrow">
                      <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <span class="list-row-new">{item.newName}</span>
                  </div>
                  <div class="history-item-meta">
                    <span class="history-dest" title={item.newPath}>
                      {item.dest ? item.dest.split('/').pop() : ''}
                    </span>
                    <span class="history-time">
                      {formatTime(item.time)}
                    </span>
                  </div>
                  <div class="history-item-actions">
                    <button
                      class="btn btn-ghost history-btn"
                      title={t('history.revealInFinder')}
                      onClick={() => revealInFinder(item.newPath)}
                    >
                      <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                        <path d="M6 2H3a1 1 0 00-1 1v8a1 1 0 001 1h8a1 1 0 001-1V8M9 2h3v3M12 2L7 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                    </button>
                    <button
                      class="btn btn-ghost history-btn"
                      title={t('history.undo')}
                      onClick={() => handleUndo(item)}
                    >
                      <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                        <path d="M2 5h5a4 4 0 010 8H4M2 5l3-3M2 5l3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function formatTime(time) {
  if (!time) return ''
  const d = time instanceof Date ? time : new Date(time)
  const now = new Date()
  const diff = now - d
  if (diff < 60000) return t('time.justNow')
  if (diff < 3600000) return t('time.minutesAgo', { n: Math.floor(diff / 60000) })
  if (diff < 86400000) return t('time.hoursAgo', { n: Math.floor(diff / 3600000) })
  const locale = lang.value === 'zh' ? 'zh-CN' : 'en-US'
  return d.toLocaleDateString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
