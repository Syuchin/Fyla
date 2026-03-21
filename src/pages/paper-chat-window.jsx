import { useEffect, useState } from 'preact/hooks'
import { emitTo, listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { PaperChatDock } from '../components/PaperChatDock.jsx'
import { activatePaperChatWindowSession, getActivePaperChatSession } from '../lib/paperChat.js'
import { paperChatWindowOpen } from '../lib/store.js'
import { t } from '../lib/i18n.js'

export function PaperChatWindowPage() {
  const [ready, setReady] = useState(false)
  const session = getActivePaperChatSession()

  useEffect(() => {
    paperChatWindowOpen.value = true
    setReady(!!session)
    const unlistenActivate = listen('paper-chat:activate', async event => {
      await activatePaperChatWindowSession(event.payload)
      setReady(true)
    })
    const unlistenClose = listen('tauri://close-requested', async () => {
      const sessionId = getActivePaperChatSession()?.sessionId || null
      await emitTo('main', 'paper-chat:reembed', { sessionId }).catch(() => {})
    })
    return () => {
      paperChatWindowOpen.value = false
      unlistenActivate.then(fn => fn()).catch(() => {})
      unlistenClose.then(fn => fn()).catch(() => {})
    }
  }, [])

  async function handleReembed() {
    const currentWindow = getCurrentWebviewWindow()
    const sessionId = session?.sessionId || null
    await emitTo('main', 'paper-chat:reembed', { sessionId }).catch(() => {})
    await currentWindow.hide().catch(() => {})
    paperChatWindowOpen.value = false
  }

  async function handleClose() {
    await handleReembed()
  }

  return (
    <div class="paper-chat-window-shell">
      {ready && session ? (
        <PaperChatDock
          session={session}
          chatOnly
          onRequestReembed={handleReembed}
          onRequestClose={handleClose}
        />
      ) : (
        <div class="paper-chat-window-empty">
          <h3>{t('papers.chatWindowTitle')}</h3>
          <p>{t('papers.chatWindowSubtitle')}</p>
        </div>
      )}
    </div>
  )
}
