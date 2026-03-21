import { clearPaperSelection, insertSelectionIntoDraft, seedDraftFromSelection } from '../lib/paperChat.js'
import { paperSelectionContext } from '../lib/store.js'
import { t } from '../lib/i18n.js'

export function SelectionAskBubble() {
  const selection = paperSelectionContext.value
  if (!selection?.text || !selection?.rect) return null
  if (selection.source === 'pdf') return null

  const bubbleHalfWidth = 120
  const anchorX = Number.isFinite(selection.rect.centerX)
    ? selection.rect.centerX
    : selection.rect.left + selection.rect.width / 2
  const anchorTop = Number.isFinite(selection.rect.top)
    ? selection.rect.top
    : selection.rect.bottom
  const style = {
    left: `${Math.min(window.innerWidth - bubbleHalfWidth - 12, Math.max(bubbleHalfWidth + 12, anchorX))}px`,
    top: `${Math.max(12, anchorTop - 56)}px`,
  }

  return (
    <div class="selection-ask-bubble" style={style} role="toolbar" aria-label={t('papers.chatSelectionReport')}>
      <button type="button" class="selection-ask-btn selection-ask-btn-primary" onClick={seedDraftFromSelection}>
        <span class="selection-ask-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 3.75l1.5 3.5 3.5 1.5-3.5 1.5-1.5 3.5-1.5-3.5-3.5-1.5 3.5-1.5z" />
            <path d="M14.5 3.5v2" />
            <path d="M13.5 4.5h2" />
          </svg>
        </span>
        {t('papers.selectionAsk')}
      </button>
      <button type="button" class="selection-ask-btn selection-ask-btn-secondary" onClick={insertSelectionIntoDraft}>
        <span class="selection-ask-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6.25 8.25A1.75 1.75 0 1 1 8 10v2H5.75V10.5A2.95 2.95 0 0 1 6.25 8.25Z" />
            <path d="M11.5 8.25A1.75 1.75 0 1 1 13.25 10v2H11V10.5a2.95 2.95 0 0 1 .5-2.25Z" />
          </svg>
        </span>
        {t('papers.selectionQuote')}
      </button>
      <button type="button" class="selection-ask-dismiss" onClick={clearPaperSelection} aria-label={t('common.close')} title={t('common.close')}>
        <span class="selection-ask-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5.5 5.5l9 9" />
            <path d="M14.5 5.5l-9 9" />
          </svg>
        </span>
      </button>
    </div>
  )
}
