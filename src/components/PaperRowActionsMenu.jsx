import { createPortal, memo } from 'preact/compat'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { t } from '../lib/i18n.js'

export const PaperRowActionsMenu = memo(function PaperRowActionsMenu({ items }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const menuRef = useRef(null)
  const [menuStyle, setMenuStyle] = useState(null)

  useLayoutEffect(() => {
    if (!open) return

    function updatePosition() {
      const trigger = rootRef.current
      const menu = menuRef.current
      if (!trigger || !menu) return

      const triggerRect = trigger.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      const gap = 8
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight

      let top = triggerRect.bottom + gap
      let left = triggerRect.right - menuRect.width

      if (left < 8) {
        left = Math.max(8, triggerRect.left)
      }
      if (left + menuRect.width > viewportWidth - 8) {
        left = Math.max(8, viewportWidth - menuRect.width - 8)
      }

      if (top + menuRect.height > viewportHeight - 8) {
        top = triggerRect.top - menuRect.height - gap
      }
      if (top < 8) {
        top = Math.max(8, viewportHeight - menuRect.height - 8)
      }

      setMenuStyle({
        top: `${Math.round(top)}px`,
        left: `${Math.round(left)}px`,
        visibility: 'visible',
      })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)

    return () => {
      window.removeEventListener('resize', updatePosition)
    }
  }, [open, items])

  useEffect(() => {
    if (!open) {
      setMenuStyle(null)
      return () => {}
    }

    function handlePointerDown(event) {
      const target = event.target
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false)
      }
    }

    function handleScroll() {
      setOpen(false)
    }

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  async function handleItemClick(item) {
    setOpen(false)
    await item.onClick?.()
  }

  if (!items.length) return null

  return (
    <div ref={rootRef} class="paper-row-menu">
      <button
        type="button"
        class={`paper-row-action-btn paper-row-action-btn-secondary paper-row-menu-trigger ${open ? 'is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        {t('papers.more')}
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          class="paper-row-menu-popover"
          role="menu"
          style={menuStyle || { top: '0px', left: '0px', visibility: 'hidden' }}
        >
          {items.map(item => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              class={`paper-row-menu-item ${item.danger ? 'danger' : ''}`}
              onClick={() => handleItemClick(item)}
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
})
