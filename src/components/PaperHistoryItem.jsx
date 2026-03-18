import { memo } from 'preact/compat'
import { copyText, friendlyError, readPaperArchiveMarkdown, revealInFinder } from '../lib/tauri.js'
import { openPaperDetail, removePaperHistoryItem } from '../lib/paperQueue.js'
import { showToast } from '../lib/store.js'
import { t, lang } from '../lib/i18n.js'
import { formatCompactPaperChars, formatExactPaperChars, hasPaperCharCount } from '../lib/paperChars.js'
import { PaperRowActionsMenu } from './PaperRowActionsMenu.jsx'

export const PaperHistoryItem = memo(function PaperHistoryItem({ item }) {
  const displayTitle = item.title || item.originalName
  const showOriginalName = !!item.originalName && item.originalName !== displayTitle
  const completedLabel = formatTime(item.completedAt)
  const pills = [item.venue, item.year, item.extractor].filter(Boolean)
  const compactCharCount = formatCompactPaperChars(item.charCount)
  const charCountTitle = formatExactPaperChars(item.charCount)

  async function handleCopy() {
    try {
      const markdown = await readPaperArchiveMarkdown(item.savedPath)
      await copyText(markdown)
      showToast(t('papers.copied'))
    } catch (err) {
      showToast(t('papers.copyFailed') + ': ' + friendlyError(err))
    }
  }

  const menuItems = [
    { id: 'copy', label: t('papers.copyMarkdown'), onClick: handleCopy },
    item.savedPath ? { id: 'reveal', label: t('papers.reveal'), onClick: () => revealInFinder(item.savedPath) } : null,
    { id: 'remove', label: t('papers.removeHistory'), danger: true, onClick: () => removePaperHistoryItem(item.id) },
  ].filter(Boolean)

  return (
    <div class="list-row paper-history-item">
      <div class="paper-history-main">
        <div class="paper-history-heading">
          <span class="paper-history-title" title={displayTitle}>{displayTitle}</span>
          {item.extractionWarning && (
            <span class="paper-warning-pill" title={item.extractionWarning}>
              {t('papers.extractWarningShort')}
            </span>
          )}
        </div>

        {pills.length > 0 && (
          <div class="paper-history-pill-row">
            <div class="paper-history-pill-group">
              {pills.map((part, index) => (
                <span key={`${part}-${index}`} class="paper-meta-pill">{part}</span>
              ))}
              {hasPaperCharCount(item.charCount) && (
                <span class="paper-meta-pill paper-char-pill" title={charCountTitle}>
                  {compactCharCount}
                </span>
              )}
            </div>
          </div>
        )}

        {!pills.length && hasPaperCharCount(item.charCount) && (
          <div class="paper-history-pill-row">
            <div class="paper-history-pill-group">
              <span class="paper-meta-pill paper-char-pill" title={charCountTitle}>
                {compactCharCount}
              </span>
            </div>
          </div>
        )}

        {completedLabel && (
          <div class="paper-history-time-row">
            <span class="paper-history-time">{completedLabel}</span>
          </div>
        )}

        {showOriginalName && (
          <div class="paper-history-source" title={item.originalName}>{item.originalName}</div>
        )}
      </div>

      <div class="paper-task-actions paper-history-actions">
        <button type="button" class="btn btn-secondary paper-action-btn paper-action-btn-secondary paper-row-action-btn paper-row-action-btn-primary paper-task-primary-action" onClick={() => openPaperDetail(item.id)}>
          {t('papers.view')}
        </button>
        <PaperRowActionsMenu items={menuItems} />
      </div>
    </div>
  )
})

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
