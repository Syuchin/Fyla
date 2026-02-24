import { useEffect } from 'preact/hooks'

export function useAppShortcuts({ onConfirmAll, onUndo, onDismiss }) {
  useEffect(() => {
    const handler = (e) => {
      const isMeta = e.metaKey || e.ctrlKey

      // Cmd+Enter -> confirm all pending renames
      if (isMeta && e.key === 'Enter') {
        e.preventDefault()
        onConfirmAll?.()
        return
      }

      // Cmd+Z -> undo last rename (don't override existing behavior handled in app.jsx)
      // This is a no-op here since app.jsx already handles Cmd+Z

      // Esc -> close confirm panel / clear selection
      if (e.key === 'Escape') {
        e.preventDefault()
        onDismiss?.()
        return
      }

      // Tab / Shift+Tab -> jump between editable filename inputs
      if (e.key === 'Tab') {
        const inputs = document.querySelectorAll('[data-file-input]')
        if (inputs.length === 0) return
        const idx = Array.from(inputs).indexOf(document.activeElement)
        if (idx === -1) return
        e.preventDefault()
        const next = e.shiftKey
          ? inputs[(idx - 1 + inputs.length) % inputs.length]
          : inputs[(idx + 1) % inputs.length]
        next.focus()
        next.select()
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onConfirmAll, onUndo, onDismiss])
}
