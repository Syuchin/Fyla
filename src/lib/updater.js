import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { showToast } from './store.js'
import { t } from './i18n.js'

function isMissingLatestManifestError(message) {
  const normalized = String(message || '').toLowerCase()
  return normalized.includes('latest.json')
    && (
      normalized.includes('404')
      || normalized.includes('not found')
      || normalized.includes('status code 404')
    )
}

export async function checkForUpdate() {
  try {
    const update = await check()
    if (!update) return

    await update.downloadAndInstall()
    showToast(t('updater.ready'))
    setTimeout(() => relaunch(), 2000)
  } catch (err) {
    console.error('[updater] background check failed', err)
  }
}

export async function checkForUpdateManual(setChecking) {
  setChecking(true)
  try {
    const update = await check()
    if (!update) {
      showToast(t('updater.upToDate'))
      setChecking(false)
      return
    }
    showToast(t('updater.downloading'))
    await update.downloadAndInstall()
    showToast(t('updater.ready'))
    setTimeout(() => relaunch(), 2000)
  } catch (e) {
    const msg = String(e?.message || e || '')
    console.error('[updater] manual check failed', e)
    if (isMissingLatestManifestError(msg)) {
      showToast(t('updater.upToDate'))
    } else {
      showToast(t('updater.checkFailed'))
    }
  }
  setChecking(false)
}
