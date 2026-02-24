import { selectedIds, toggleSelect, updateFileName } from '../lib/store.js'
import { t } from '../lib/i18n.js'

export function FileItem({ file }) {
  const isSelected = selectedIds.value.has(file.id)

  return (
    <div class={`file-item ${isSelected ? 'selected' : ''}`}>
      <input
        type="checkbox"
        checked={isSelected}
        onChange={() => toggleSelect(file.id)}
      />

      <div class="file-names">
        <span class="file-original" title={file.originalName}>
          {file.originalName}
        </span>

        {file.newName && (
          <>
            <svg class="arrow-icon" width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 6h8M7 3l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <div class="file-new">
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
        {file.status === 'pending' && (
          <span class="status-pending">—</span>
        )}
        {file.status === 'loading' && (
          <span class="status-loading">
            <div class="spinner" />
          </span>
        )}
        {file.status === 'done' && (
          <span class="status-done">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2.5 7l3 3 6-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </span>
        )}
        {file.status === 'error' && (
          <span class="status-error" title={file.error}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5"/>
              <path d="M7 4.5v3M7 9.5v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </span>
        )}
        {file.status === 'renamed' && (
          <span class="status-badge status-renamed">{t('files.renamed')}</span>
        )}
      </div>
    </div>
  )
}
