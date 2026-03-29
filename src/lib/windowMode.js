import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'

const MODES = {
  compact: { width: 560, height: 480 },
  paper: { width: 800, height: 660 },
  prompt: { width: 980, height: 760 },
  workspace: { width: 1320, height: 860 },
}

const SIZE_TOLERANCE = 12
const ANIMATION_MS = 170
const MIN_WINDOW_SIZE = new LogicalSize(MODES.compact.width, MODES.compact.height)
const warnedMinSizeFailure = new Set()

let appliedMode = null
let pending = Promise.resolve()
let overrideMode = null

function getModeForPage(page) {
  if (page === 'paper-detail') return 'workspace'
  return page === 'papers' ? 'paper' : 'compact'
}

export function syncWindowMode(page) {
  const nextMode = overrideMode || getModeForPage(page)
  return applyWindowMode(nextMode)
}

export function setWindowModeOverride(mode) {
  overrideMode = mode
  return applyWindowMode(mode)
}

export function clearWindowModeOverride(page) {
  overrideMode = null
  return applyWindowMode(getModeForPage(page))
}

function applyWindowMode(nextMode) {
  if (!nextMode) return pending

  const nextSize = MODES[nextMode]
  const appWindow = getCurrentWindow()
  const targetSize = new LogicalSize(nextSize.width, nextSize.height)

  pending = pending
    .catch(() => {})
    .then(async () => {
      try {
        await appWindow.setMinSize(MIN_WINDOW_SIZE)
      } catch (error) {
        if (import.meta.env.DEV && !warnedMinSizeFailure.has(nextMode)) {
          warnedMinSizeFailure.add(nextMode)
          console.warn('[windowMode] setMinSize failed; continuing with resize', { nextMode, error })
        }
      }

      if (await appWindow.isMaximized()) {
        appliedMode = nextMode
        return
      }

      const scaleFactor = await appWindow.scaleFactor()
      const currentSize = (await appWindow.innerSize()).toLogical(scaleFactor)
      const widthDiff = Math.abs(currentSize.width - nextSize.width)
      const heightDiff = Math.abs(currentSize.height - nextSize.height)

      if (nextMode === appliedMode && widthDiff <= SIZE_TOLERANCE && heightDiff <= SIZE_TOLERANCE) {
        appliedMode = nextMode
        return
      }

      await animateWindowSize(appWindow, currentSize, nextSize)
      await appWindow.setSize(targetSize)
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
