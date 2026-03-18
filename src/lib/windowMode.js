import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'

const MODES = {
  compact: { width: 560, height: 480 },
  paper: { width: 800, height: 660 },
}

const SIZE_TOLERANCE = 12
const ANIMATION_MS = 170

let appliedMode = null
let pending = Promise.resolve()

function getModeForPage(page) {
  return page === 'papers' || page === 'paper-detail' ? 'paper' : 'compact'
}

export function syncWindowMode(page) {
  const nextMode = getModeForPage(page)
  if (nextMode === appliedMode) return pending

  const nextSize = MODES[nextMode]
  const appWindow = getCurrentWindow()

  pending = pending
    .catch(() => {})
    .then(async () => {
      if (nextMode === appliedMode) return

      if (await appWindow.isMaximized()) {
        appliedMode = nextMode
        return
      }

      const scaleFactor = await appWindow.scaleFactor()
      const currentSize = (await appWindow.innerSize()).toLogical(scaleFactor)
      const widthDiff = Math.abs(currentSize.width - nextSize.width)
      const heightDiff = Math.abs(currentSize.height - nextSize.height)

      if (widthDiff <= SIZE_TOLERANCE && heightDiff <= SIZE_TOLERANCE) {
        appliedMode = nextMode
        return
      }

      await animateWindowSize(appWindow, currentSize, nextSize)
      appliedMode = nextMode
    })

  return pending
}

async function animateWindowSize(appWindow, fromSize, toSize) {
  const startWidth = fromSize.width
  const startHeight = fromSize.height
  const deltaWidth = toSize.width - startWidth
  const deltaHeight = toSize.height - startHeight

  if (Math.abs(deltaWidth) <= SIZE_TOLERANCE && Math.abs(deltaHeight) <= SIZE_TOLERANCE) {
    return
  }

  const startAt = performance.now()

  while (true) {
    const elapsed = performance.now() - startAt
    const progress = Math.min(1, elapsed / ANIMATION_MS)
    const eased = easeOutCubic(progress)
    const width = Math.round(startWidth + deltaWidth * eased)
    const height = Math.round(startHeight + deltaHeight * eased)

    await appWindow.setSize(new LogicalSize(width, height))

    if (progress >= 1) break
    await nextFrame()
  }
}

function easeOutCubic(value) {
  return 1 - Math.pow(1 - value, 3)
}

function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(resolve))
}
