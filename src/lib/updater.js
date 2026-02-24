import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { showToast } from './store.js'
import { t } from './i18n.js'

export async function checkForUpdate() {
  try {
    const update = await check()
    if (!update) return

    await update.downloadAndInstall()
    showToast(t('updater.ready'))
    setTimeout(() => relaunch(), 2000)
  } catch (_) {
    // silently ignore update check failures
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
  } catch (_) {
    showToast(t('updater.checkFailed'))
  }
  setChecking(false)
}
