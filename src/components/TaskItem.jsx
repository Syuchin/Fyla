import { memo } from 'preact/compat'
import { confirmTask, skipTask, updateTaskName, updateTaskDest, retryTask } from '../lib/taskQueue.js'
import { pickFolder } from '../lib/tauri.js'
import { t } from '../lib/i18n.js'

const STATUS_TEXT = {
  queued: () => <span class="task-status-text task-status--queued">—</span>,
  extracting: () => (
    <span class="task-status-text task-status--processing">
      <div class="spinner" />
      <span>{t('task.extracting')}</span>
    </span>
  ),
  generating: () => (
    <span class="task-status-text task-status--processing">
      <div class="spinner" />
      <span>{t('task.generating')}</span>
    </span>
  ),
  confirming: () => (
    <span class="task-status-text task-status--processing">
      <div class="spinner" />
    </span>
  ),
  done: () => (
    <span class="task-status-text task-status--done">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M2.5 7l3 3 6-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </span>
  ),
  error: (task) => (
    <span class="task-status-text task-status--error" title={task.error}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5"/>
        <path d="M7 4.5v3M7 9.5v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </span>
  ),
}

export const TaskItem = memo(function TaskItem({ task }) {
  const isReady = task.status === 'ready'
  const isDone = task.status === 'done'
  const isError = task.status === 'error'
  const StatusRenderer = STATUS_TEXT[task.status]

  async function handlePickDest() {
    const folder = await pickFolder()
    if (folder) updateTaskDest(task.id, folder)
  }

  return (
    <div class={`list-row task-item task-item--${task.status}`}>
      <div class="list-row-names">
        <span class="list-row-original" title={task.originalName}>
          {task.originalName}
        </span>

        {isReady && (
          <>
            <svg class="list-row-arrow" width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 6h8M7 3l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <div class="list-row-new has-tooltip" data-tooltip={task.newName + task.ext}>
              <input
                type="text"
                data-file-input
                value={task.newName}
                onInput={e => updateTaskName(task.id, e.target.value)}
                onClick={e => e.stopPropagation()}
              />
            </div>
            <span class="task-ext">{task.ext}</span>
          </>
        )}

        {isDone && task.newName && (
          <>
            <svg class="list-row-arrow" width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 6h8M7 3l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span class="list-row-new task-done-name has-tooltip" data-tooltip={task.newName + task.ext}>{task.newName}{task.ext}</span>
          </>
        )}
      </div>

      <div class="task-meta">
        {StatusRenderer && StatusRenderer(task)}

        {isReady && (
          <button class="task-dest-btn" onClick={handlePickDest} title={task.destFolder}>
            {task.destFolder.split('/').pop() || task.destFolder}
          </button>
        )}
      </div>

      <div class="task-actions">
        {isReady && task.newName && (
          <button class="btn btn-primary btn-sm" onClick={() => confirmTask(task.id)}>{t('confirm.confirm')}</button>
        )}
        {isError && (
          <button class="btn btn-ghost btn-sm" onClick={() => retryTask(task.id)}>{t('task.retry')}</button>
        )}
        {(isReady || isError) && (
          <button class="btn btn-ghost btn-sm" onClick={() => skipTask(task.id)}>{t('confirm.skip')}</button>
        )}
      </div>
    </div>
  )
})
