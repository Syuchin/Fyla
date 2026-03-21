import { listen } from '@tauri-apps/api/event'
import {
  activePaperChatPaper,
  activePaperChatSessionId,
  activePaperChatWindowSessionId,
  config,
  currentWindowLabel,
  paperChatActiveMentionQuery,
  paperChatCurrentPaperSessions,
  paperChatDraft,
  paperChatDraftQuote,
  paperChatDraftAttachments,
  paperChatDraftImages,
  paperChatHistoryPanelOpen,
  paperChatMentionMenuOpen,
  paperChatPresentation,
  paperChatSessions,
  paperChatWindowOpen,
  paperSelectionContext,
  showToast,
} from './store.js'
import {
  createPaperChatSession,
  friendlyError,
  focusPaperChatWindow,
  getPaperChatHistory,
  hidePaperChatWindow,
  openPaperChatWindow,
  preparePaperChatSession,
  retryPaperChatTurn,
  stopPaperChatStream,
  streamPaperChatReply,
} from './tauri.js'
import { t } from './i18n.js'

let sessionUpdateListening = false
const RETRY_WAIT_MS = 150
export const PAPER_CHAT_MAX_DRAFT_IMAGES = 3

function clearNativeSelection() {
  if (typeof document === 'undefined' || typeof document.getSelection !== 'function') return
  const selection = document.getSelection()
  if (selection?.rangeCount) {
    selection.removeAllRanges()
  }
}

function serializeDraftQuote(quote) {
  const text = String(quote?.text || '').trim()
  if (!text) return ''
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n')
}

function buildOutgoingQuestionContent(question, quote = paperChatDraftQuote.value) {
  const body = String(question || '').trim()
  const serializedQuote = serializeDraftQuote(quote)
  if (!serializedQuote) return body
  if (!body) return serializedQuote
  return `${serializedQuote}\n\n${body}`
}

function cloneDraftQuote(quote) {
  return quote?.text ? { ...quote } : null
}

function cloneSelection(selection) {
  return selection?.text ? { ...selection } : null
}

function cloneDraftImages(images) {
  return (images || []).map(item => ({ ...item }))
}

function revokeDraftImageObjectUrl(image) {
  const objectUrl = String(image?.objectUrl || '')
  if (!objectUrl.startsWith('blob:')) return
  try {
    URL.revokeObjectURL(objectUrl)
  } catch (_) {}
}

function revokeDraftImageCollection(images) {
  for (const image of images || []) {
    revokeDraftImageObjectUrl(image)
  }
}

function serializeDraftImageInput(image) {
  if (!image?.mime || !image?.name) return null
  return {
    id: image.id || '',
    source: image.source || 'picker',
    path: image.path || null,
    name: image.name,
    mime: image.mime,
    sizeBytes: image.sizeBytes ?? null,
    dataUrl: image.dataUrl || null,
  }
}

export function getActivePaperChatSession() {
  return paperChatSessions.value[activePaperChatSessionId.value] || null
}

export function getCurrentPaperChatSessions() {
  return paperChatCurrentPaperSessions.value
}

function isSamePaperIdentity(paper, { sourcePath = '', savedPath = '', title = '' } = {}) {
  if (!paper) return false
  if (savedPath && paper.savedPath && paper.savedPath === savedPath) return true
  if (sourcePath && paper.sourcePath && paper.sourcePath === sourcePath) return true
  return !!title && !!paper.title && paper.title === title
}

export function primePaperChatPaper({ sourcePath = '', savedPath = '', title = '' } = {}) {
  const previous = activePaperChatPaper.value
  if (isSamePaperIdentity(previous, { sourcePath, savedPath, title })) {
    activePaperChatPaper.value = {
      ...previous,
      sourcePath,
      savedPath,
      title,
      pdfAvailable: !!sourcePath,
      reportAvailable: !!savedPath,
    }
    return
  }

  activePaperChatPaper.value = {
    paperKey: '',
    sourcePath,
    savedPath,
    title,
    availableAttachments: [],
    pdfAvailable: !!sourcePath,
    reportAvailable: !!savedPath,
    pdfPageCount: 0,
    reportSectionCount: 0,
    pdfWarning: '',
    reportWarning: '',
    cachePrepared: false,
    retrievalStrategy: '',
    tokenEstimate: 0,
  }
  paperChatCurrentPaperSessions.value = []
  paperChatHistoryPanelOpen.value = false
  paperChatDraft.value = ''
  clearPaperChatDraftQuote()
  clearPaperChatDraftAttachments()
  clearPaperChatDraftImages()
  setPaperChatMentionState({ open: false, query: '' })
}

export async function ensurePaperChatSession({ sourcePath, savedPath, title }) {
  ensureSessionUpdateListener()
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const prepared = await preparePaperChatSession(
    sourcePath || '',
    savedPath || '',
    title || '',
    config.value
  )
  const previousSessionId = activePaperChatSessionId.value
  mergePreparedSession(prepared)
  activePaperChatSessionId.value = prepared.sessionId
  if (paperChatPresentation.value === 'detached') {
    activePaperChatWindowSessionId.value = prepared.sessionId
  }
  await syncDetachedPaperChatWindow(getSessionWindowPayload(prepared.sessionId) || prepared)
  if (previousSessionId && previousSessionId !== prepared.sessionId) {
    paperChatHistoryPanelOpen.value = false
    clearPaperChatDraftQuote()
  }
  if (!paperChatDraft.value) {
    paperChatDraft.value = ''
  }
  const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt
  console.info('[paper-perf] preparePaperChatSession', {
    title: title || prepared.title || '',
    sessionId: prepared.sessionId,
    cachePrepared: !!prepared.cachePrepared,
    retrievalStrategy: prepared.retrievalStrategy || '',
    elapsedMs: Math.round(elapsedMs),
  })
  return prepared.sessionId
}

export async function refreshPaperChatHistory(sessionId = activePaperChatSessionId.value) {
  if (!sessionId) return []
  const messages = await getPaperChatHistory(sessionId)
  patchSession(sessionId, session => ({
    ...session,
    messages,
    status: session.status === 'streaming' ? 'streaming' : 'idle',
    hydrated: true,
  }))
  syncCurrentPaperSummaryFromStoredSession(sessionId)
  return messages
}

export async function selectPaperChatSession(sessionId) {
  if (!sessionId) return null
  const currentPaper = activePaperChatPaper.value
  const summary = paperChatCurrentPaperSessions.value.find(item => item.sessionId === sessionId)
  if (!summary && !paperChatSessions.value[sessionId]) return null

  if (!paperChatSessions.value[sessionId]) {
    patchSession(sessionId, buildSessionStub(sessionId, summary))
  }

  activePaperChatSessionId.value = sessionId
  if (paperChatPresentation.value === 'detached') {
    activePaperChatWindowSessionId.value = sessionId
  }

  if (!paperChatSessions.value[sessionId]?.hydrated) {
    patchSession(sessionId, { status: 'loading' })
    try {
      await refreshPaperChatHistory(sessionId)
    } catch (err) {
      patchSession(sessionId, { status: 'idle' })
      showToast(`${t('papers.chatPrepareFailed')}: ${friendlyError(err)}`)
    }
  }

  if (currentPaper?.paperKey && summary?.paperKey === currentPaper.paperKey) {
    paperChatHistoryPanelOpen.value = false
  }

  return sessionId
}

export async function createNewPaperChatSession() {
  const paper = activePaperChatPaper.value
  if (!paper?.paperKey) return null

  ensureSessionUpdateListener()

  try {
    const prepared = await createPaperChatSession(
      paper.sourcePath || '',
      paper.savedPath || '',
      paper.title || '',
      config.value
    )

    mergePreparedSession(prepared)
    activePaperChatSessionId.value = prepared.sessionId
    if (paperChatPresentation.value === 'detached') {
      activePaperChatWindowSessionId.value = prepared.sessionId
    }

    paperChatHistoryPanelOpen.value = false
    paperChatDraft.value = ''
    clearPaperChatDraftQuote()
    clearPaperSelection()
    clearPaperChatDraftAttachments()
    clearPaperChatDraftImages()

    await syncDetachedPaperChatWindow(getSessionWindowPayload(prepared.sessionId) || prepared)
    return prepared.sessionId
  } catch (err) {
    showToast(`${t('papers.chatPrepareFailed')}: ${friendlyError(err)}`)
    return null
  }
}

export function setPaperChatDraft(value) {
  paperChatDraft.value = value
}

export function clearPaperChatDraftQuote() {
  paperChatDraftQuote.value = null
}

export function setPaperChatMentionState({ open = false, query = '' } = {}) {
  paperChatMentionMenuOpen.value = open
  paperChatActiveMentionQuery.value = query
}

export function setPaperChatHistoryPanelOpen(open) {
  paperChatHistoryPanelOpen.value = !!open
}

export function addPaperChatDraftAttachment(attachment) {
  if (!attachment?.kind) return
  const next = [
    ...paperChatDraftAttachments.value.filter(item => item.kind !== attachment.kind),
    attachment,
  ]
  paperChatDraftAttachments.value = next
  paperChatMentionMenuOpen.value = false
  paperChatActiveMentionQuery.value = ''
}

export function removePaperChatDraftAttachment(kind) {
  if (!kind) return
  paperChatDraftAttachments.value = paperChatDraftAttachments.value.filter(item => item.kind !== kind)
}

export function clearPaperChatDraftAttachments() {
  paperChatDraftAttachments.value = []
  paperChatMentionMenuOpen.value = false
  paperChatActiveMentionQuery.value = ''
}

export function addPaperChatDraftImages(images = [], { replace = false } = {}) {
  const normalized = (images || []).filter(item => item?.id && item?.mime && item?.name)
  if (!normalized.length) return
  if (replace) {
    const previous = paperChatDraftImages.value
    paperChatDraftImages.value = normalized.slice(0, PAPER_CHAT_MAX_DRAFT_IMAGES)
    revokeDraftImageCollection(previous)
    return
  }

  const next = [...paperChatDraftImages.value]
  for (const image of normalized) {
    const existingIndex = next.findIndex(item => item.id === image.id)
    if (existingIndex >= 0) {
      revokeDraftImageObjectUrl(next[existingIndex])
      next[existingIndex] = image
    } else if (next.length < PAPER_CHAT_MAX_DRAFT_IMAGES) {
      next.push(image)
    }
  }
  paperChatDraftImages.value = next
}

export function removePaperChatDraftImage(id) {
  if (!id) return
  const target = paperChatDraftImages.value.find(item => item.id === id)
  paperChatDraftImages.value = paperChatDraftImages.value.filter(item => item.id !== id)
  revokeDraftImageObjectUrl(target)
}

export function clearPaperChatDraftImages() {
  const previous = paperChatDraftImages.value
  paperChatDraftImages.value = []
  revokeDraftImageCollection(previous)
}

export function setPaperSelection(selection) {
  paperSelectionContext.value = selection
}

export function clearPaperSelection() {
  paperSelectionContext.value = null
  clearNativeSelection()
}

export function insertSelectionIntoDraft() {
  const selection = paperSelectionContext.value
  if (!selection?.text || selection.source !== 'report') return
  paperChatDraftQuote.value = {
    source: 'report',
    text: selection.text.trim(),
    heading: selection.heading?.trim() || '',
  }
  clearPaperSelection()
}

export function seedDraftFromSelection() {
  const selection = paperSelectionContext.value
  if (!selection?.text) return
  clearPaperChatDraftQuote()
  paperChatDraft.value = `请结合上下文详细解释这段内容，并说明它在论文中的作用：\n\n${selection.text.trim()}`
}

export function togglePaperAttachment(kind) {
  const session = getActivePaperChatSession()
  if (!session) return
  const current = new Set(session.activeAttachmentKinds || [])
  if (current.has(kind)) {
    if (current.size === 1) return
    current.delete(kind)
  } else {
    current.add(kind)
  }
  patchSession(session.sessionId, {
    activeAttachmentKinds: [...current],
  })
}

export function focusPaperAttachment(kind) {
  const session = getActivePaperChatSession()
  if (!session) return
  patchSession(session.sessionId, {
    activeAttachmentKinds: [kind],
  })
}

export async function sendPaperChatQuestion(question = paperChatDraft.value) {
  const session = getActivePaperChatSession()
  const content = buildOutgoingQuestionContent(question, paperChatDraftQuote.value)
  if (!session || !content) return

  const draftSnapshot = paperChatDraft.value
  const quoteSnapshot = cloneDraftQuote(paperChatDraftQuote.value)
  const sourceAttachmentSnapshot = [...paperChatDraftAttachments.value]
  const selectionSnapshot = cloneSelection(paperSelectionContext.value)
  const imageSnapshot = cloneDraftImages(paperChatDraftImages.value)

  patchSession(session.sessionId, {
    status: session.cachePrepared ? 'streaming' : 'preparing',
    suggestedQuestions: [],
  })

  const attachments = paperChatDraftAttachments.value
    .filter(item => (session.availableAttachments || []).some(available => available.kind === item.kind))

  const selection = paperSelectionContext.value?.text
    ? {
        source: paperSelectionContext.value.source,
        text: paperSelectionContext.value.text,
        page: paperSelectionContext.value.page || null,
        heading: paperSelectionContext.value.heading || null,
      }
    : null
  const images = imageSnapshot
    .map(serializeDraftImageInput)
    .filter(Boolean)

  paperChatDraft.value = ''
  paperChatDraftQuote.value = null
  paperSelectionContext.value = null
  paperChatDraftImages.value = []
  clearNativeSelection()
  setPaperChatMentionState({ open: false, query: '' })

  let answerStarted = false
  let restoredDraft = false

  try {
    await streamPaperChatReply(
      session.sessionId,
      content,
      attachments,
      images,
      selection,
      config.value,
      message => {
        if (message?.event === 'answerStarted') {
          answerStarted = true
        }
        handleChatStreamEvent(session.sessionId, message)
      }
    )
  } catch (err) {
    patchSession(session.sessionId, { status: 'idle' })
    if (!answerStarted) {
      restoredDraft = true
      paperChatDraft.value = draftSnapshot
      paperChatDraftQuote.value = quoteSnapshot
      paperChatDraftAttachments.value = sourceAttachmentSnapshot
      paperSelectionContext.value = selectionSnapshot
      paperChatDraftImages.value = imageSnapshot
    }
    showToast(`${t('papers.chatSendFailed')}: ${friendlyError(err)}`)
  } finally {
    if (!restoredDraft) {
      revokeDraftImageCollection(imageSnapshot)
    }
  }
}

export async function stopActivePaperChatStream({ sessionId = activePaperChatSessionId.value, silent = false } = {}) {
  const session = paperChatSessions.value[sessionId]
  if (!session || session.status !== 'streaming') return

  patchSession(sessionId, current => ({
    ...current,
    status: 'idle',
    messages: current.messages.map(message =>
      message.role === 'assistant' && message.status === 'streaming'
        ? { ...message, status: 'stopped' }
        : message
    ),
  }))
  syncCurrentPaperSummaryFromStoredSession(sessionId)

  try {
    await stopPaperChatStream(sessionId)
  } catch (err) {
    if (!silent) {
      showToast(`${t('papers.chatSendFailed')}: ${friendlyError(err)}`)
    }
  }
}

export async function retryLastPaperChatTurn(sessionId = activePaperChatSessionId.value) {
  const session = paperChatSessions.value[sessionId]
  if (!session) return

  if (session.status === 'streaming') {
    await stopActivePaperChatStream({ sessionId, silent: true })
    await wait(RETRY_WAIT_MS)
  }

  patchSession(sessionId, { status: 'retrying', suggestedQuestions: [] })

  try {
    await retryPaperChatTurn(
      sessionId,
      config.value,
      message => handleChatStreamEvent(sessionId, message)
    )
  } catch (err) {
    patchSession(sessionId, { status: 'idle' })
    showToast(`${t('papers.chatSendFailed')}: ${friendlyError(err)}`)
  }
}

export async function openActivePaperChatWindow() {
  const session = getActivePaperChatSession()
  if (!session) return
  await openPaperChatWindow(makePaperChatWindowPayload(session))
  paperChatPresentation.value = 'detached'
  activePaperChatWindowSessionId.value = session.sessionId
  paperChatWindowOpen.value = true
}

export async function reembedActivePaperChat({ hideWindow = false, sessionId = null } = {}) {
  const nextSessionId = sessionId || activePaperChatWindowSessionId.value || activePaperChatSessionId.value
  if (nextSessionId) {
    activePaperChatSessionId.value = nextSessionId
  }
  paperChatPresentation.value = 'embedded'
  activePaperChatWindowSessionId.value = null
  paperChatWindowOpen.value = false
  if (hideWindow) {
    await hidePaperChatWindow().catch(() => {})
  }
}

export async function activatePaperChatWindowSession(payload) {
  if (!payload?.sourcePath && !payload?.savedPath && !payload?.sessionId) return
  ensureSessionUpdateListener()
  const latestSessionId = await ensurePaperChatSession({
    sourcePath: payload.sourcePath,
    savedPath: payload.savedPath,
    title: payload.title,
  })
  const resolvedSessionId = payload.sessionId || latestSessionId
  if (resolvedSessionId && resolvedSessionId !== latestSessionId) {
    await selectPaperChatSession(resolvedSessionId)
  }
  activePaperChatWindowSessionId.value = resolvedSessionId
  paperChatPresentation.value = 'detached'
  paperChatWindowOpen.value = true
}

async function syncDetachedPaperChatWindow(session) {
  if (
    currentWindowLabel.value !== 'main'
    || paperChatPresentation.value !== 'detached'
    || !paperChatWindowOpen.value
  ) {
    return
  }

  if (!session?.sessionId || session.sessionId === activePaperChatWindowSessionId.value) {
    return
  }

  activePaperChatWindowSessionId.value = session.sessionId

  const payload = makePaperChatWindowPayload(session)
  const focused = await focusPaperChatWindow(payload).catch(() => null)
  if (!focused) {
    await openPaperChatWindow(payload)
  }
}

function makePaperChatWindowPayload(session) {
  return {
    sessionId: session.sessionId,
    sourcePath: session.sourcePath,
    savedPath: session.savedPath,
    title: session.title,
  }
}

function ensureSessionUpdateListener() {
  if (sessionUpdateListening) return
  sessionUpdateListening = true
  listen('sessionUpdated', event => {
    const session = event.payload
    if (!session?.sessionId) return
    const existing = paperChatSessions.value[session.sessionId]
    const nextMessages = session.messages || []
    const availableAttachments = existing?.availableAttachments || activePaperChatPaper.value?.availableAttachments || []
    const fallbackKinds = availableAttachments.map(item => item.kind)
    patchSession(session.sessionId, {
      paperKey: session.paperKey || existing?.paperKey || activePaperChatPaper.value?.paperKey || '',
      sessionId: session.sessionId,
      sourcePath: session.sourcePath || existing?.sourcePath || activePaperChatPaper.value?.sourcePath || '',
      savedPath: session.savedPath || existing?.savedPath || activePaperChatPaper.value?.savedPath || '',
      title: session.title || existing?.title || activePaperChatPaper.value?.title || '',
      createdAt: session.createdAt || existing?.createdAt || '',
      updatedAt: session.updatedAt || existing?.updatedAt || '',
      messages: nextMessages,
      suggestedQuestions: nextMessages.length ? (existing?.suggestedQuestions || []) : [],
      status: nextMessages.some(message => message.status === 'streaming') ? 'streaming' : 'idle',
      cachePrepared: existing?.cachePrepared || activePaperChatPaper.value?.cachePrepared || nextMessages.length > 0,
      availableAttachments,
      activeAttachmentKinds: (existing?.activeAttachmentKinds || fallbackKinds)
        .filter(kind => fallbackKinds.includes(kind)),
      pdfAvailable: existing?.pdfAvailable ?? activePaperChatPaper.value?.pdfAvailable ?? false,
      reportAvailable: existing?.reportAvailable ?? activePaperChatPaper.value?.reportAvailable ?? false,
      pdfPageCount: existing?.pdfPageCount ?? activePaperChatPaper.value?.pdfPageCount ?? 0,
      reportSectionCount: existing?.reportSectionCount ?? activePaperChatPaper.value?.reportSectionCount ?? 0,
      pdfWarning: existing?.pdfWarning || activePaperChatPaper.value?.pdfWarning || '',
      reportWarning: existing?.reportWarning || activePaperChatPaper.value?.reportWarning || '',
      hydrated: true,
    })
    syncCurrentPaperSummaryFromStoredSession(session.sessionId)
  }).catch(() => {
    sessionUpdateListening = false
  })
}

function handleChatStreamEvent(sessionId, message) {
  if (!message?.event) return
  const data = message.data || {}
  switch (message.event) {
    case 'answerStarted':
      patchSession(sessionId, session => ({
        ...session,
        status: 'streaming',
        cachePrepared: true,
        hydrated: true,
        updatedAt: new Date().toISOString(),
        messages: upsertMessages(session.messages, [data.userMessage, data.assistantMessage]),
      }))
      syncCurrentPaperSummaryFromStoredSession(sessionId)
      break
    case 'answerDelta':
      patchSession(sessionId, session => ({
        ...session,
        status: 'streaming',
        updatedAt: session.updatedAt || new Date().toISOString(),
        messages: session.messages.map(item =>
          item.id === data.messageId
            ? { ...item, content: (item.content || '') + (data.delta || ''), status: 'streaming' }
            : item
        ),
      }))
      break
    case 'answerDone':
      patchSession(sessionId, session => ({
        ...session,
        status: 'idle',
        hydrated: true,
        updatedAt: new Date().toISOString(),
        suggestedQuestions: data.suggestedQuestions || [],
        messages: session.messages.map(item =>
          item.id === data.messageId
            ? {
                ...item,
                content: data.content || item.content,
                citations: data.citations || [],
                status: 'done',
              }
            : item
        ),
      }))
      syncCurrentPaperSummaryFromStoredSession(sessionId)
      break
    case 'answerStopped':
      patchSession(sessionId, session => ({
        ...session,
        status: 'idle',
        hydrated: true,
        updatedAt: new Date().toISOString(),
        messages: session.messages.map(item =>
          item.id === data.messageId
            ? {
                ...item,
                content: data.content || item.content,
                status: 'stopped',
              }
            : item
        ),
      }))
      syncCurrentPaperSummaryFromStoredSession(sessionId)
      break
    case 'answerError':
      patchSession(sessionId, session => ({
        ...session,
        status: 'idle',
        hydrated: true,
        updatedAt: new Date().toISOString(),
        messages: session.messages.map(item =>
          item.id === data.messageId
            ? { ...item, content: data.message || item.content, status: 'error' }
            : item
        ),
      }))
      syncCurrentPaperSummaryFromStoredSession(sessionId)
      showToast(`${t('papers.chatSendFailed')}: ${data.message || t('papers.chatUnknownError')}`)
      break
  }
}

function mergePreparedSession(prepared) {
  const existing = paperChatSessions.value[prepared.sessionId]
  const availableAttachments = prepared.availableAttachments || []
  const fallbackKinds = availableAttachments.map(item => item.kind)
  const activeAttachmentKinds = (existing?.activeAttachmentKinds || fallbackKinds)
    .filter(kind => fallbackKinds.includes(kind))

  activePaperChatPaper.value = {
    paperKey: prepared.paperKey,
    sourcePath: prepared.sourcePath,
    savedPath: prepared.savedPath,
    title: prepared.title,
    availableAttachments,
    pdfAvailable: prepared.pdfAvailable,
    reportAvailable: prepared.reportAvailable,
    pdfPageCount: prepared.pdfPageCount,
    reportSectionCount: prepared.reportSectionCount,
    pdfWarning: prepared.pdfWarning || '',
    reportWarning: prepared.reportWarning || '',
    cachePrepared: !!prepared.cachePrepared,
    retrievalStrategy: prepared.retrievalStrategy || '',
    tokenEstimate: prepared.tokenEstimate || 0,
  }

  paperChatCurrentPaperSessions.value = sortSessionSummaries(prepared.sessionSummaries || [])

  patchSession(prepared.sessionId, {
    paperKey: prepared.paperKey,
    sessionId: prepared.sessionId,
    sourcePath: prepared.sourcePath,
    savedPath: prepared.savedPath,
    title: prepared.title,
    messages: prepared.messages || [],
    createdAt: prepared.createdAt || '',
    updatedAt: prepared.updatedAt || '',
    hydrated: true,
    availableAttachments,
    activeAttachmentKinds: activeAttachmentKinds.length ? activeAttachmentKinds : fallbackKinds,
    pdfAvailable: prepared.pdfAvailable,
    reportAvailable: prepared.reportAvailable,
    pdfPageCount: prepared.pdfPageCount,
    reportSectionCount: prepared.reportSectionCount,
    pdfWarning: prepared.pdfWarning || '',
    reportWarning: prepared.reportWarning || '',
    cachePrepared: !!prepared.cachePrepared,
    suggestedQuestions: existing?.suggestedQuestions || [],
    status: existing?.status === 'streaming' ? 'streaming' : 'idle',
  })

  if (activePaperChatSessionId.value !== prepared.sessionId) {
    clearPaperChatDraftAttachments()
    clearPaperChatDraftImages()
  }
}

function patchSession(sessionId, patch) {
  const current = paperChatSessions.value[sessionId] || makeEmptySession(sessionId)
  const next = typeof patch === 'function'
    ? patch(current)
    : { ...current, ...patch }
  paperChatSessions.value = {
    ...paperChatSessions.value,
    [sessionId]: next,
  }
}

function makeEmptySession(sessionId) {
  return {
    paperKey: '',
    sessionId,
    sourcePath: '',
    savedPath: '',
    title: '',
    messages: [],
    createdAt: '',
    updatedAt: '',
    hydrated: false,
    availableAttachments: [],
    activeAttachmentKinds: [],
    pdfAvailable: false,
    reportAvailable: false,
    pdfPageCount: 0,
    reportSectionCount: 0,
    pdfWarning: '',
    reportWarning: '',
    cachePrepared: false,
    suggestedQuestions: [],
    status: 'idle',
  }
}

function buildSessionStub(sessionId, summary) {
  const paper = activePaperChatPaper.value || {}
  const availableAttachments = paper.availableAttachments || []
  return {
    ...makeEmptySession(sessionId),
    paperKey: summary?.paperKey || paper.paperKey || '',
    sourcePath: summary?.sourcePath || paper.sourcePath || '',
    savedPath: summary?.savedPath || paper.savedPath || '',
    title: summary?.title || paper.title || '',
    createdAt: summary?.createdAt || '',
    updatedAt: summary?.updatedAt || '',
    availableAttachments,
    activeAttachmentKinds: availableAttachments.map(item => item.kind),
    pdfAvailable: paper.pdfAvailable || false,
    reportAvailable: paper.reportAvailable || false,
    pdfPageCount: paper.pdfPageCount || 0,
    reportSectionCount: paper.reportSectionCount || 0,
    pdfWarning: paper.pdfWarning || '',
    reportWarning: paper.reportWarning || '',
    cachePrepared: !!paper.cachePrepared,
  }
}

function syncCurrentPaperSummaryFromStoredSession(sessionId) {
  const session = paperChatSessions.value[sessionId]
  if (!session) return
  upsertCurrentPaperSessionSummary(buildSessionSummaryFromSession(session))
}

function buildSessionSummaryFromSession(session) {
  const messages = session?.messages || []
  return {
    paperKey: session.paperKey || activePaperChatPaper.value?.paperKey || '',
    sessionId: session.sessionId,
    sourcePath: session.sourcePath || activePaperChatPaper.value?.sourcePath || '',
    savedPath: session.savedPath || activePaperChatPaper.value?.savedPath || '',
    title: session.title || activePaperChatPaper.value?.title || '',
    createdAt: session.createdAt || '',
    updatedAt: session.updatedAt || new Date().toISOString(),
    messageCount: messages.length,
    firstUserMessage: messages.find(item =>
      item.role === 'user' && String(item.content || '').trim()
    )?.content || '',
    lastAssistantMessage: [...messages].reverse().find(item =>
      item.role === 'assistant' && String(item.content || '').trim()
    )?.content || '',
  }
}

function upsertCurrentPaperSessionSummary(summary) {
  const currentPaperKey = activePaperChatPaper.value?.paperKey || ''
  if (!summary?.sessionId || !currentPaperKey || summary.paperKey !== currentPaperKey) {
    return
  }

  const next = [...paperChatCurrentPaperSessions.value]
  const index = next.findIndex(item => item.sessionId === summary.sessionId)
  if (index >= 0) {
    next[index] = {
      ...next[index],
      ...summary,
    }
  } else {
    next.push(summary)
  }
  paperChatCurrentPaperSessions.value = sortSessionSummaries(next)
}

function sortSessionSummaries(items) {
  return [...items]
    .filter(item => item?.sessionId)
    .sort((left, right) => {
      const rightTime = Date.parse(right.updatedAt || right.createdAt || '') || 0
      const leftTime = Date.parse(left.updatedAt || left.createdAt || '') || 0
      return rightTime - leftTime
    })
}

function getSessionWindowPayload(sessionId) {
  const session = paperChatSessions.value[sessionId]
  if (!session?.sessionId) return null
  return {
    sessionId: session.sessionId,
    sourcePath: session.sourcePath,
    savedPath: session.savedPath,
    title: session.title,
  }
}

function upsertMessages(existing, incoming) {
  const map = new Map(existing.map(item => [item.id, item]))
  for (const message of incoming.filter(Boolean)) {
    map.set(message.id, { ...(map.get(message.id) || {}), ...message })
  }
  return [...map.values()].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
