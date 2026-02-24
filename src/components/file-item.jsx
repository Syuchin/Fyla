import { memo } from 'preact/compat'
import { selectedIds, toggleSelect, updateFileName } from '../lib/store.js'
import { t } from '../lib/i18n.js'

const STATUS_ICONS = {
  pending: () => <span class="status-pending">—</span>,
  loading: () => (
    <span class="status-loading">
      <div class="spinner" />
    </span>
  ),
  done: () => (
    <span class="status-done">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M2.5 7l3 3 6-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </span>
  ),
  error: (file) => (
    <span class="status-error" title={file.error}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5"/>
        <path d="M7 4.5v3M7 9.5v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </span>
  ),
  renamed: () => (
    <span class="status-badge status-renamed">{t('files.renamed')}</span>
  ),
}

export const FileItem = memo(function FileItem({ file, isSelected }) {
  const StatusIcon = STATUS_ICONS[file.status]

  return (
    <div class={`list-row file-item ${isSelected ? 'selected' : ''}`}>
      <input
        type="checkbox"
        checked={isSelected}
        onChange={() => toggleSelect(file.id)}
      />

      <div class="list-row-names">
        <span class="list-row-original" title={file.originalName}>
          {file.originalName}
        </span>

        {file.newName && (
          <>
            <svg class="list-row-arrow" width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 6h8M7 3l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <div class="list-row-new">
              <input
                type="text"
                data-file-input
                value={file.newName}
                onInput={e => updateFileName(file.id, e.target.value)}
                onClick={e => e.stopPropagation()}
              />
            </div>
          </>
        )}
      </div>

      <div class="file-status">
        {StatusIcon && StatusIcon(file)}
      </div>
    </div>
  )
})
