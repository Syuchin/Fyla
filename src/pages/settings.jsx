import { useState, useEffect } from 'preact/hooks'
import { config, showToast, isWatching, showWelcome } from '../lib/store.js'
import {
  friendlyError,
  getAppVersion,
  getPaperEmbeddingStatus,
  saveConfig,
  startWatch,
  stopWatch,
  pickFolder,
  testConnection,
  testPaperEmbeddingConnection,
  testPaperConnection,
} from '../lib/tauri.js'
import { invoke } from '@tauri-apps/api/core'
import { changelog } from '../lib/changelog.js'
import { t, lang, setLang } from '../lib/i18n.js'
import { checkForUpdateManual } from '../lib/updater.js'
import { clearWindowModeOverride, setWindowModeOverride } from '../lib/windowMode.js'
import defaultPaperReviewPromptTemplateRaw from '../lib/paper-review-prompt-template.txt?raw'

const DEFAULT_PAPER_REVIEW_PROMPT_TEMPLATE = defaultPaperReviewPromptTemplateRaw.trim()
const SETTINGS_TABS = ['general', 'ai', 'papers', 'watch', 'about']

export function SettingsPage() {
  const c = config.value
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [autoStart, setAutoStart] = useState(false)
  const [showChangelog, setShowChangelog] = useState(false)
  const [checking, setChecking] = useState(false)
  const [appVersion, setAppVersion] = useState(changelog[0]?.version || '')
  const [testingPaper, setTestingPaper] = useState(false)
  const [paperTestResult, setPaperTestResult] = useState(null)
  const [testingPaperEmbedding, setTestingPaperEmbedding] = useState(false)
  const [paperEmbeddingTestResult, setPaperEmbeddingTestResult] = useState(null)
  const [paperEmbeddingStatus, setPaperEmbeddingStatus] = useState(null)
  const [showPaperReviewPromptEditor, setShowPaperReviewPromptEditor] = useState(false)
  const [paperReviewPromptDraft, setPaperReviewPromptDraft] = useState(
    c.paperReviewPromptTemplate || DEFAULT_PAPER_REVIEW_PROMPT_TEMPLATE,
  )
  const [activeSettingsTab, setActiveSettingsTab] = useState('general')

  useEffect(() => {
    invoke('is_autostart_enabled').then(setAutoStart).catch(() => {})
  }, [])

  useEffect(() => {
    getAppVersion()
      .then(version => {
        if (version) setAppVersion(version)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    refreshPaperEmbeddingStatus()
  }, [
    c.paperEmbeddingProvider,
    c.paperEmbeddingOllamaUrl,
    c.paperEmbeddingOllamaModel,
    c.paperEmbeddingOpenaiBaseUrl,
    c.paperEmbeddingOpenaiKey,
    c.paperEmbeddingOpenaiModel,
  ])

  useEffect(() => {
    setPaperReviewPromptDraft(c.paperReviewPromptTemplate || DEFAULT_PAPER_REVIEW_PROMPT_TEMPLATE)
  }, [c.paperReviewPromptTemplate])

  useEffect(() => {
    if (!showPaperReviewPromptEditor) return undefined

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        closePaperReviewPromptEditor()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [showPaperReviewPromptEditor, c.paperReviewPromptTemplate])

  useEffect(() => {
    if (!showPaperReviewPromptEditor) return undefined

    let cancelled = false

    setWindowModeOverride('prompt').catch(() => {})

    requestAnimationFrame(() => {
      if (cancelled) return
      setWindowModeOverride('prompt').catch(() => {})
    })

    return () => {
      cancelled = true
      clearWindowModeOverride('settings').catch(() => {})
    }
  }, [showPaperReviewPromptEditor])

  useEffect(() => () => {
    clearWindowModeOverride('settings').catch(() => {})
  }, [])

  function update(key, value) {
    const next = { ...config.value, [key]: value }
    config.value = next
    saveConfig(next).catch(() => {})
  }

  async function handleTestConnection() {
    setTesting(true); setTestResult(null)
    try {
      const msg = await testConnection(config.value)
      setTestResult({ ok: true, msg })
    } catch (e) {
      setTestResult({ ok: false, msg: String(e) })
    }
    setTesting(false)
  }

  async function handleTestPaperConnection() {
    setTestingPaper(true); setPaperTestResult(null)
    try {
      const msg = await testPaperConnection(config.value)
      setPaperTestResult({ ok: true, msg })
    } catch (e) {
      setPaperTestResult({ ok: false, msg: String(e) })
    }
    setTestingPaper(false)
  }

  async function refreshPaperEmbeddingStatus() {
    try {
      const status = await getPaperEmbeddingStatus(config.value)
      setPaperEmbeddingStatus(status)
    } catch (err) {
      setPaperEmbeddingStatus({
        state: 'error',
        message: friendlyError(err),
        modelName: '',
        resolvedProvider: null,
      })
    }
  }

  async function handleTestPaperEmbeddingConnection() {
    setTestingPaperEmbedding(true)
    setPaperEmbeddingTestResult(null)
    try {
      const msg = await testPaperEmbeddingConnection(config.value)
      setPaperEmbeddingTestResult({ ok: true, msg })
      await refreshPaperEmbeddingStatus()
    } catch (e) {
      setPaperEmbeddingTestResult({ ok: false, msg: String(e) })
      await refreshPaperEmbeddingStatus()
    }
    setTestingPaperEmbedding(false)
  }
  const paperEmbeddingFeedback = paperEmbeddingTestResult?.msg
    || paperEmbeddingStatus?.message
    || t('settings.paperEmbeddingAutoHint')
  const paperEmbeddingFeedbackClass = paperEmbeddingTestResult
    ? (paperEmbeddingTestResult.ok ? 'is-success' : 'is-error')
    : paperEmbeddingStatus?.state === 'error'
      ? 'is-error'
      : paperEmbeddingStatus?.state === 'ready' || paperEmbeddingStatus?.state === 'fallback'
        ? 'is-success'
        : ''
  const paperConnectionFeedback = paperTestResult?.msg || t('settings.paperConnectionHint')
  const paperConnectionFeedbackClass = paperTestResult
    ? (paperTestResult.ok ? 'is-success' : 'is-error')
    : ''
  const paperEmbeddingStateText = paperEmbeddingStatus?.resolvedProvider
    ? t('settings.paperEmbeddingResolved', {
        provider: paperEmbeddingStatus.resolvedProvider,
        model: paperEmbeddingStatus.modelName || '-',
      })
    : t('settings.paperEmbeddingAutoHint')
  const paperEmbeddingStateClass = paperEmbeddingStatus?.state === 'error'
    ? 'is-error'
    : paperEmbeddingStatus?.state === 'ready' || paperEmbeddingStatus?.state === 'fallback'
      ? 'is-success'
      : ''

  async function handlePickPaperArchiveRoot() {
    const path = await pickFolder()
    if (path) update('paperArchiveRoot', path)
  }

  function normalizePaperReviewPromptValue(value) {
    return value.trim() ? value : DEFAULT_PAPER_REVIEW_PROMPT_TEMPLATE
  }

  function openPaperReviewPromptEditor() {
    setPaperReviewPromptDraft(c.paperReviewPromptTemplate || DEFAULT_PAPER_REVIEW_PROMPT_TEMPLATE)
    setShowPaperReviewPromptEditor(true)
    setWindowModeOverride('prompt').catch(() => {})
  }

  function closePaperReviewPromptEditor() {
    setShowPaperReviewPromptEditor(false)
    setPaperReviewPromptDraft(c.paperReviewPromptTemplate || DEFAULT_PAPER_REVIEW_PROMPT_TEMPLATE)
    clearWindowModeOverride('settings').catch(() => {})
  }

  function handleSavePaperReviewPrompt() {
    const nextValue = normalizePaperReviewPromptValue(paperReviewPromptDraft)
    setPaperReviewPromptDraft(nextValue)
    update('paperReviewPromptTemplate', nextValue)
    setShowPaperReviewPromptEditor(false)
    clearWindowModeOverride('settings').catch(() => {})
  }

  function handleResetPaperReviewPrompt() {
    setPaperReviewPromptDraft(DEFAULT_PAPER_REVIEW_PROMPT_TEMPLATE)
    update('paperReviewPromptTemplate', DEFAULT_PAPER_REVIEW_PROMPT_TEMPLATE)
    showToast(t('settings.paperReviewPromptResetDone'))
  }

  return (
    <div class="main">
      <div class="settings-page">
        <div class="settings-tabs-shell">
          <div class="settings-tabs" role="tablist" aria-label={t('settings.settingsTabs')}>
            {SETTINGS_TABS.map(tab => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={activeSettingsTab === tab}
                class={`settings-tab ${activeSettingsTab === tab ? 'active' : ''}`}
                onClick={() => setActiveSettingsTab(tab)}
              >
                {t(`settings.tab${tab.charAt(0).toUpperCase()}${tab.slice(1)}`)}
              </button>
            ))}
          </div>
        </div>

        {activeSettingsTab === 'general' && (
        <>
        <div class="settings-section">
          <div class="settings-section-title">{t('settings.general')}</div>
          <div class="settings-row">
            <span class="settings-label">
              {t('settings.language')}
              <small>{t('settings.languageHint')}</small>
            </span>
            <select class="settings-select" value={lang.value} onChange={e => setLang(e.target.value)}>
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </div>
          <div class="settings-row">
            <span class="settings-label">
              {t('settings.autostart')}
              <small>{t('settings.autostartHint')}</small>
            </span>
            <label class="switch">
              <input
                type="checkbox"
                checked={autoStart}
                onChange={async (e) => {
                  try {
                    await invoke('set_autostart', { enabled: e.target.checked })
                    setAutoStart(e.target.checked)
                  } catch (err) {
                    showToast(t('settings.setFailed') + ': ' + err)
                  }
                }}
              />
              <span class="switch-slider" />
            </label>
          </div>
          <div class="settings-row" style="justify-content:flex-end">
            <button class="btn btn-ghost" style="font-size:12px" onClick={() => { showWelcome.value = true }}>
              {t('settings.showGuide')}
            </button>
          </div>
        </div>
        </>
        )}

        {activeSettingsTab === 'ai' && (
        <>
        <div class="settings-section">
          <div class="settings-section-title">{t('settings.aiProvider')}</div>
          <div class="settings-row">
            <span class="settings-label">{t('settings.selectMode')}</span>
            <div class="toggle-group">
              <button
                class={`toggle-option ${c.provider === 'ollama' ? 'active' : ''}`}
                onClick={() => update('provider', 'ollama')}
              >
                {t('settings.ollamaLocal')}
              </button>
              <button
                class={`toggle-option ${c.provider === 'openai' ? 'active' : ''}`}
                onClick={() => update('provider', 'openai')}
              >
                {t('settings.openaiCompat')}
              </button>
            </div>
          </div>

          {c.provider === 'ollama' ? (
            <>
              <div class="settings-row">
                <span class="settings-label">
                  {t('settings.serverUrl')}
                  <small>{t('settings.serverUrlHint')}</small>
                </span>
                <input
                  class="settings-input"
                  type="text"
                  value={c.ollamaUrl}
                  onInput={e => update('ollamaUrl', e.target.value)}
                  placeholder="http://localhost:11434"
                />
              </div>
              <div class="settings-row">
                <span class="settings-label">
                  {t('settings.modelName')}
                  <small>{t('settings.modelNameHint')}</small>
                </span>
                <input
                  class="settings-input"
                  type="text"
                  value={c.ollamaModel}
                  onInput={e => update('ollamaModel', e.target.value)}
                  placeholder="llama3.2"
                />
              </div>
            </>
          ) : (
            <>
              <div class="settings-row">
                <span class="settings-label">
                  {t('settings.baseUrl')}
                  <small>{t('settings.baseUrlHint')}</small>
                </span>
                <input
                  class="settings-input"
                  type="text"
                  value={c.openaiBaseUrl}
                  onInput={e => update('openaiBaseUrl', e.target.value)}
                  placeholder="https://api.openai.com/v1"
                />
              </div>
              <div class="settings-row">
                <span class="settings-label">
                  {t('settings.apiKey')}
                  <small>Bearer Token</small>
                </span>
                <input
                  class="settings-input"
                  type="password"
                  value={c.openaiKey}
                  onInput={e => update('openaiKey', e.target.value)}
                  placeholder="sk-..."
                />
              </div>
              <div class="settings-row">
                <span class="settings-label">
                  {t('settings.model')}
                  <small>{t('settings.modelHint')}</small>
                </span>
                <input
                  class="settings-input"
                  type="text"
                  value={c.openaiModel}
                  onInput={e => update('openaiModel', e.target.value)}
                  placeholder="gpt-4o-mini"
                />
              </div>
            </>
          )}

          <div class="settings-row" style="justify-content:flex-end">
            <button class="btn btn-secondary" style="font-size:12px" disabled={testing} onClick={handleTestConnection}>
              {testing ? t('settings.testing') : t('settings.testConnection')}
            </button>
            {testResult && (
              <span style={`font-size:12px;margin-left:8px;color:${testResult.ok ? 'var(--success)' : 'var(--danger)'}`}>
                {testResult.msg}
              </span>
            )}
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">{t('settings.namingRules')}</div>
          <div class="settings-row" style="flex-direction: column; align-items: flex-start; gap: 8px;">
            <span class="settings-label">
              {t('settings.namingStyle')}
              <small>{t('settings.namingStyleHint')}</small>
            </span>
            <div class="toggle-group">
              {[
                ['kebab-case', 'kebab-case'],
                ['Train-Case', 'Train-Case'],
                ['snake_case', 'snake_case'],
                ['camelCase', 'camelCase'],
                ['PascalCase', 'PascalCase'],
                ['chinese', '中文'],
              ].map(([val, label]) => (
                <button
                  key={val}
                  class={`toggle-option ${c.namingStyle === val ? 'active' : ''}`}
                  onClick={() => update('namingStyle', val)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div class="settings-row">
            <span class="settings-label">
              {t('settings.includeDate')}
              <small>{t('settings.includeDateHint')}</small>
            </span>
            <label class="switch">
              <input
                type="checkbox"
                checked={c.includeDate}
                onChange={e => update('includeDate', e.target.checked)}
              />
              <span class="switch-slider" />
            </label>
          </div>
          <div class="settings-row" style="flex-direction: column; align-items: flex-start; gap: 8px;">
            <span class="settings-label">
              {t('settings.customRules')}
              <small>{t('settings.customRulesHint')}</small>
            </span>
            <textarea
              class="settings-textarea"
              value={c.customRules}
              onInput={e => update('customRules', e.target.value)}
              placeholder={t('settings.customRulesPlaceholder')}
            />
          </div>
          <div class="settings-row" style="flex-direction: column; align-items: flex-start; gap: 8px;">
            <span class="settings-label">
              {t('settings.nameTemplate')}
              <small>{t('settings.nameTemplateHint')}</small>
            </span>
            <input
              class="settings-input"
              style="max-width:100%"
              value={c.nameTemplate}
              onInput={e => update('nameTemplate', e.target.value)}
              placeholder={t('settings.nameTemplatePlaceholder')}
            />
          </div>
        </div>

        {/* VLM */}
        <div class="settings-section">
          <div class="settings-section-title">{t('settings.vlm')}</div>
          <div class="settings-row">
            <span class="settings-label">
              {t('settings.enableVlm')}
              <small>{t('settings.enableVlmHint')}</small>
            </span>
            <label class="switch">
              <input
                type="checkbox"
                checked={c.vlmEnabled}
                onChange={e => update('vlmEnabled', e.target.checked)}
              />
              <span class="switch-slider" />
            </label>
          </div>
          {c.vlmEnabled && (
            <>
              <div class="settings-row">
                <span class="settings-label">
                  {t('settings.reuseLlm')}
                  <small>{t('settings.reuseLlmHint')}</small>
                </span>
                <label class="switch">
                  <input
                    type="checkbox"
                    checked={c.vlmSameAsLlm}
                    onChange={e => update('vlmSameAsLlm', e.target.checked)}
                  />
                  <span class="switch-slider" />
                </label>
              </div>
              {!c.vlmSameAsLlm && (
                <>
                  <div class="settings-row">
                    <span class="settings-label">
                      {t('settings.vlmBaseUrl')}
                      <small>{t('settings.vlmBaseUrlHint')}</small>
                    </span>
                    <input
                      class="settings-input"
                      type="text"
                      value={c.vlmBaseUrl}
                      onInput={e => update('vlmBaseUrl', e.target.value)}
                      placeholder="https://api.openai.com/v1"
                    />
                  </div>
                  <div class="settings-row">
                    <span class="settings-label">
                      {t('settings.vlmApiKey')}
                      <small>{t('settings.vlmApiKeyHint')}</small>
                    </span>
                    <input
                      class="settings-input"
                      type="password"
                      value={c.vlmKey}
                      onInput={e => update('vlmKey', e.target.value)}
                      placeholder="sk-..."
                    />
                  </div>
                  <div class="settings-row">
                    <span class="settings-label">
                      {t('settings.vlmModel')}
                      <small>{t('settings.vlmModelHint')}</small>
                    </span>
                    <input
                      class="settings-input"
                      type="text"
                      value={c.vlmModel}
                      onInput={e => update('vlmModel', e.target.value)}
                      placeholder="gpt-4o"
                    />
                  </div>
                </>
              )}
            </>
          )}
        </div>
        </>
        )}

        {activeSettingsTab === 'papers' && (
        <div class="settings-section settings-section-paper">
          <div class="settings-paper-header">
            <div class="settings-paper-header-copy">
              <div class="settings-section-title">{t('settings.paperReading')}</div>
              <h3 class="settings-paper-title">{t('settings.paperReading')}</h3>
              <p class="settings-paper-intro">{t('settings.paperReadingIntro')}</p>
            </div>
            <span class="settings-paper-badge">{t('settings.paperManualOnly')}</span>
          </div>

          <div class="settings-paper-layout">
            <div class="settings-paper-card">
              <div class="settings-paper-card-title">{t('settings.paperModelSection')}</div>
              <p class="settings-paper-card-subtitle">{t('settings.paperModelSectionIntro')}</p>

              <div class="settings-paper-fields">
                <div class="settings-paper-field">
                  <span class="settings-paper-field-label">{t('settings.selectPaperMode')}</span>
                  <div class="toggle-group settings-paper-toggle">
                    <button
                      type="button"
                      class={`toggle-option ${c.paperProvider === 'ollama' ? 'active' : ''}`}
                      onClick={() => update('paperProvider', 'ollama')}
                    >
                      {t('settings.ollamaLocal')}
                    </button>
                    <button
                      type="button"
                      class={`toggle-option ${c.paperProvider === 'openai' ? 'active' : ''}`}
                      onClick={() => update('paperProvider', 'openai')}
                    >
                      {t('settings.openaiCompat')}
                    </button>
                  </div>
                </div>

                {c.paperProvider === 'ollama' ? (
                  <div class="settings-paper-subgroup">
                    <div class="settings-paper-subgroup-title">{t('settings.ollamaLocal')}</div>
                    <div class="settings-paper-fields">
                      <div class="settings-paper-field">
                        <span class="settings-paper-field-label">{t('settings.paperServerUrl')}</span>
                        <small>{t('settings.paperServerUrlHint')}</small>
                        <input
                          class="settings-input settings-paper-input"
                          type="text"
                          value={c.paperOllamaUrl}
                          onInput={e => update('paperOllamaUrl', e.target.value)}
                          placeholder="http://localhost:11434"
                        />
                      </div>
                      <div class="settings-paper-field">
                        <span class="settings-paper-field-label">{t('settings.paperModel')}</span>
                        <small>{t('settings.paperModelHint')}</small>
                        <input
                          class="settings-input settings-paper-input"
                          type="text"
                          value={c.paperOllamaModel}
                          onInput={e => update('paperOllamaModel', e.target.value)}
                          placeholder="llama3.2"
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div class="settings-paper-subgroup">
                    <div class="settings-paper-subgroup-title">{t('settings.openaiCompat')}</div>
                    <div class="settings-paper-fields">
                      <div class="settings-paper-field">
                        <span class="settings-paper-field-label">{t('settings.paperBaseUrl')}</span>
                        <small>{t('settings.paperBaseUrlHint')}</small>
                        <input
                          class="settings-input settings-paper-input"
                          type="text"
                          value={c.paperOpenaiBaseUrl}
                          onInput={e => update('paperOpenaiBaseUrl', e.target.value)}
                          placeholder="https://api.openai.com/v1"
                        />
                      </div>
                      <div class="settings-paper-field">
                        <span class="settings-paper-field-label">{t('settings.paperApiKey')}</span>
                        <small>Bearer Token</small>
                        <input
                          class="settings-input settings-paper-input"
                          type="password"
                          value={c.paperOpenaiKey}
                          onInput={e => update('paperOpenaiKey', e.target.value)}
                          placeholder="sk-..."
                        />
                      </div>
                      <div class="settings-paper-field">
                        <span class="settings-paper-field-label">{t('settings.paperModel')}</span>
                        <small>{t('settings.paperModelHint')}</small>
                        <input
                          class="settings-input settings-paper-input"
                          type="text"
                          value={c.paperOpenaiModel}
                          onInput={e => update('paperOpenaiModel', e.target.value)}
                          placeholder="gpt-4.1"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div class="settings-paper-footer">
                <span class={`settings-paper-status ${paperConnectionFeedbackClass || 'settings-paper-status-placeholder'}`}>
                  {paperConnectionFeedback}
                </span>
                <button
                  type="button"
                  class="btn btn-secondary settings-paper-test-btn"
                  disabled={testingPaper}
                  onClick={handleTestPaperConnection}
                >
                  {testingPaper ? t('settings.testing') : t('settings.testPaperConnection')}
                </button>
              </div>
            </div>

            <div class="settings-paper-card">
              <div class="settings-paper-card-title">{t('settings.paperReviewPrompt')}</div>
              <p class="settings-paper-card-subtitle">{t('settings.paperReviewPromptHint')}</p>
              <div class="settings-paper-state">
                {t('settings.paperReviewPromptLocked')}
              </div>

              <div class="settings-paper-footer">
                <span class="settings-paper-status settings-paper-status-placeholder">
                  {t('settings.paperReviewPromptHint')}
                </span>
                <button
                  type="button"
                  class="btn btn-secondary settings-paper-test-btn"
                  onClick={openPaperReviewPromptEditor}
                >
                  {t('settings.paperReviewPromptEdit')}
                </button>
              </div>
            </div>

            <div class="settings-paper-card">
              <div class="settings-paper-card-title">{t('settings.paperArchiveSection')}</div>
              <p class="settings-paper-card-subtitle">{t('settings.paperArchiveSectionIntro')}</p>

              <div class="settings-paper-fields">
                <div class="settings-paper-field settings-paper-field--full">
                  <span class="settings-paper-field-label">{t('settings.paperArchiveRoot')}</span>
                  <small>{t('settings.paperArchiveRootHint')}</small>
                  <input
                    class="settings-input settings-paper-input settings-paper-input-path"
                    type="text"
                    value={c.paperArchiveRoot}
                    onInput={e => update('paperArchiveRoot', e.target.value)}
                    placeholder="/Users/chenghaoyang/Local/papers"
                  />
                </div>
              </div>

              <div class="settings-paper-footer">
                <span class="settings-paper-status settings-paper-status-placeholder">
                  {t('settings.paperArchiveBrowseHint')}
                </span>
                <button
                  type="button"
                  class="btn btn-secondary settings-paper-test-btn"
                  onClick={handlePickPaperArchiveRoot}
                >
                  {t('settings.pick')}
                </button>
              </div>
            </div>

            <div class="settings-paper-card">
              <div class="settings-paper-card-title">{t('settings.paperEmbedding')}</div>
              <p class="settings-paper-card-subtitle">{t('settings.paperEmbeddingIntro')}</p>
              <div class={`settings-paper-state ${paperEmbeddingStateClass}`}>
                {paperEmbeddingStateText}
              </div>

              <div class="settings-paper-fields">
                <div class="settings-paper-field">
                  <span class="settings-paper-field-label">{t('settings.paperEmbeddingMode')}</span>
                  <div class="toggle-group settings-paper-toggle">
                    <button
                      type="button"
                      class={`toggle-option ${c.paperEmbeddingProvider === 'auto' ? 'active' : ''}`}
                      onClick={() => update('paperEmbeddingProvider', 'auto')}
                    >
                      {t('settings.paperEmbeddingAuto')}
                    </button>
                    <button
                      type="button"
                      class={`toggle-option ${c.paperEmbeddingProvider === 'ollama' ? 'active' : ''}`}
                      onClick={() => update('paperEmbeddingProvider', 'ollama')}
                    >
                      {t('settings.ollamaLocal')}
                    </button>
                    <button
                      type="button"
                      class={`toggle-option ${c.paperEmbeddingProvider === 'openai' ? 'active' : ''}`}
                      onClick={() => update('paperEmbeddingProvider', 'openai')}
                    >
                      {t('settings.openaiCompat')}
                    </button>
                  </div>
                </div>

                <div class="settings-paper-field">
                  <span class="settings-paper-field-label">{t('settings.paperFulltextTokenLimit')}</span>
                  <small>{t('settings.paperFulltextTokenLimitHint')}</small>
                  <input
                    class="settings-input settings-paper-input"
                    type="number"
                    min="4000"
                    step="1000"
                    value={c.paperFulltextTokenLimit}
                    onInput={e => update('paperFulltextTokenLimit', Math.max(4000, Number(e.target.value) || 4000))}
                    placeholder="60000"
                  />
                </div>

                {c.paperEmbeddingProvider !== 'openai' && (
                  <div class="settings-paper-subgroup">
                    <div class="settings-paper-subgroup-title">{t('settings.paperEmbeddingLocalSection')}</div>
                    <div class="settings-paper-fields">
                      <div class="settings-paper-field">
                        <span class="settings-paper-field-label">{t('settings.paperEmbeddingOllamaUrl')}</span>
                        <small>{t('settings.paperEmbeddingOllamaUrlHint')}</small>
                        <input
                          class="settings-input settings-paper-input"
                          type="text"
                          value={c.paperEmbeddingOllamaUrl}
                          onInput={e => update('paperEmbeddingOllamaUrl', e.target.value)}
                          placeholder="http://localhost:11434"
                        />
                      </div>
                      <div class="settings-paper-field">
                        <span class="settings-paper-field-label">{t('settings.paperEmbeddingOllamaModel')}</span>
                        <small>{t('settings.paperEmbeddingOllamaModelHint')}</small>
                        <input
                          class="settings-input settings-paper-input"
                          type="text"
                          value={c.paperEmbeddingOllamaModel}
                          onInput={e => update('paperEmbeddingOllamaModel', e.target.value)}
                          placeholder="nomic-embed-text"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {c.paperEmbeddingProvider === 'auto' && (
                  <div class="settings-paper-subgroup">
                    <div class="settings-paper-subgroup-title">{t('settings.paperEmbeddingFallbackSection')}</div>
                    <div class="settings-paper-fields">
                      <div class="settings-paper-field">
                        <span class="settings-paper-field-label">{t('settings.paperEmbeddingBaseUrl')}</span>
                        <small>{t('settings.paperEmbeddingBaseUrlHint')}</small>
                        <input
                          class="settings-input settings-paper-input"
                          type="text"
                          value={c.paperEmbeddingOpenaiBaseUrl}
                          onInput={e => update('paperEmbeddingOpenaiBaseUrl', e.target.value)}
                          placeholder="https://api.openai.com/v1"
                        />
                      </div>
                      <div class="settings-paper-field">
                        <span class="settings-paper-field-label">{t('settings.paperEmbeddingApiKey')}</span>
                        <small>Bearer Token</small>
                        <input
                          class="settings-input settings-paper-input"
                          type="password"
                          value={c.paperEmbeddingOpenaiKey}
                          onInput={e => update('paperEmbeddingOpenaiKey', e.target.value)}
                          placeholder="sk-..."
                        />
                      </div>
                      <div class="settings-paper-field">
                        <span class="settings-paper-field-label">{t('settings.paperEmbeddingModel')}</span>
                        <small>{t('settings.paperEmbeddingModelHint')}</small>
                        <input
                          class="settings-input settings-paper-input"
                          type="text"
                          value={c.paperEmbeddingOpenaiModel}
                          onInput={e => update('paperEmbeddingOpenaiModel', e.target.value)}
                          placeholder="text-embedding-3-small"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {c.paperEmbeddingProvider === 'openai' && (
                  <div class="settings-paper-subgroup">
                    <div class="settings-paper-subgroup-title">{t('settings.paperEmbeddingCloudSection')}</div>
                    <div class="settings-paper-fields">
                      <div class="settings-paper-field">
                        <span class="settings-paper-field-label">{t('settings.paperEmbeddingBaseUrl')}</span>
                        <small>{t('settings.paperEmbeddingBaseUrlHint')}</small>
                        <input
                          class="settings-input settings-paper-input"
                          type="text"
                          value={c.paperEmbeddingOpenaiBaseUrl}
                          onInput={e => update('paperEmbeddingOpenaiBaseUrl', e.target.value)}
                          placeholder="https://api.openai.com/v1"
                        />
                      </div>
                      <div class="settings-paper-field">
                        <span class="settings-paper-field-label">{t('settings.paperEmbeddingApiKey')}</span>
                        <small>Bearer Token</small>
                        <input
                          class="settings-input settings-paper-input"
                          type="password"
                          value={c.paperEmbeddingOpenaiKey}
                          onInput={e => update('paperEmbeddingOpenaiKey', e.target.value)}
                          placeholder="sk-..."
                        />
                      </div>
                      <div class="settings-paper-field">
                        <span class="settings-paper-field-label">{t('settings.paperEmbeddingModel')}</span>
                        <small>{t('settings.paperEmbeddingModelHint')}</small>
                        <input
                          class="settings-input settings-paper-input"
                          type="text"
                          value={c.paperEmbeddingOpenaiModel}
                          onInput={e => update('paperEmbeddingOpenaiModel', e.target.value)}
                          placeholder="text-embedding-3-small"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div class="settings-paper-footer">
                <span class={`settings-paper-status ${paperEmbeddingFeedbackClass || 'settings-paper-status-placeholder'}`}>
                  {paperEmbeddingFeedback}
                </span>
                <button
                  type="button"
                  class="btn btn-secondary settings-paper-test-btn"
                  disabled={testingPaperEmbedding}
                  onClick={handleTestPaperEmbeddingConnection}
                >
                  {testingPaperEmbedding ? t('settings.testing') : t('settings.testPaperEmbeddingConnection')}
                </button>
              </div>
            </div>
          </div>
        </div>
        )}

        {activeSettingsTab === 'watch' && (
        <div class="settings-section">
          <div class="settings-section-title">{t('settings.autoWatch')}</div>
          <div class="settings-row">
            <span class="settings-label">
              {t('settings.watchFolder')}
              <small>{t('settings.watchFolderHint')}</small>
            </span>
            <div style="display:flex;gap:6px;align-items:center">
              <input
                class="settings-input"
                type="text"
                value={c.watchFolder}
                onInput={e => update('watchFolder', e.target.value)}
                placeholder="~/Downloads"
                style="max-width:200px"
              />
              <button class="btn btn-secondary" style="padding:6px 8px" onClick={async () => {
                const path = await pickFolder()
                if (path) update('watchFolder', path)
              }}>
                {t('settings.pick')}
              </button>
            </div>
          </div>
          <div class="settings-row">
            <span class="settings-label">
              {t('settings.autoCategorize')}
              <small>{t('settings.autoCategorizeHint')}</small>
            </span>
            <label class="switch">
              <input type="checkbox" checked={c.autoCategorize} onChange={e => update('autoCategorize', e.target.checked)} />
              <span class="switch-slider" />
            </label>
          </div>
          <div class="settings-row" style="flex-direction: column; align-items: flex-start; gap: 8px;">
            <span class="settings-label">
              {t('settings.watchTypes')}
              <small>{t('settings.watchTypesHint')}</small>
            </span>
            <div class="ext-checkboxes">
              {['pdf', 'docx', 'pptx', 'txt', 'md', 'xlsx', 'jpg', 'png'].map(ext => {
                const exts = (c.watchExtensions || 'pdf').split(',').map(s => s.trim()).filter(Boolean)
                const checked = exts.includes(ext)
                return (
                  <label key={ext} class="ext-checkbox">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = checked
                          ? exts.filter(e => e !== ext)
                          : [...exts, ext]
                        update('watchExtensions', next.join(',') || 'pdf')
                      }}
                    />
                    <span>.{ext}</span>
                  </label>
                )
              })}
            </div>
          </div>
          <div class="settings-row">
            <span class="settings-label">
              {t('settings.enableWatch')}
              <small>{t('settings.enableWatchHint')}</small>
            </span>
            {isWatching.value ? (
              <button class="btn btn-secondary" style="font-size:12px;padding:4px 12px" onClick={async () => {
                try {
                  await stopWatch()
                  isWatching.value = false
                  showToast(t('settings.watchStopped'))
                } catch (e) { showToast(t('settings.watchStopFailed') + ': ' + e) }
              }}>
                {t('settings.stopWatch')}
              </button>
            ) : (
              <button class="btn btn-primary" style="font-size:12px;padding:4px 12px" onClick={async () => {
                if (!c.watchFolder) { showToast(t('settings.setWatchFirst')); return }
                try {
                  await startWatch(c.watchFolder, c.watchExtensions || 'pdf')
                  isWatching.value = true
                  showToast(t('settings.watchStarted') + ': ' + c.watchFolder)
                } catch (e) { showToast(t('settings.watchStartFailed') + ': ' + e) }
              }}>
                {t('settings.startWatch')}
              </button>
            )}
          </div>
        </div>
        )}

        {activeSettingsTab === 'about' && (
        <div class="settings-section about-section">
          <div class="about-version">
            <span class="about-version-left" onClick={() => setShowChangelog(!showChangelog)}>
              <span>Fyla v{appVersion || changelog[0].version}</span>
              <span class="about-toggle">{showChangelog ? t('settings.collapse') : t('settings.changelog')}</span>
            </span>
            <button class="btn btn-secondary about-update-btn" disabled={checking} onClick={() => checkForUpdateManual(setChecking)}>
              {checking ? t('updater.checking') : t('updater.checkUpdate')}
            </button>
          </div>
          {showChangelog && (
            <div class="about-changelog">
              {changelog.map(entry => (
                <div key={entry.version} class="changelog-entry">
                  <div class="changelog-header">v{entry.version} · {entry.date}</div>
                  <ul class="changelog-list">
                    {entry.notes.map((note, i) => <li key={i}>{note}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
        )}

      </div>

      {showPaperReviewPromptEditor && (
        <div class="settings-prompt-overlay" onClick={closePaperReviewPromptEditor}>
          <div
            class="settings-prompt-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="paper-review-prompt-title"
            onClick={event => event.stopPropagation()}
          >
            <div class="settings-prompt-header">
              <div class="settings-prompt-header-copy">
                <h3 id="paper-review-prompt-title" class="settings-prompt-title">
                  {t('settings.paperReviewPrompt')}
                </h3>
                <p class="settings-prompt-subtitle">{t('settings.paperReviewPromptHint')}</p>
              </div>
              <button
                type="button"
                class="btn btn-ghost settings-prompt-close"
                onClick={closePaperReviewPromptEditor}
              >
                {t('settings.paperReviewPromptClose')}
              </button>
            </div>

            <div class="settings-prompt-state">
              {t('settings.paperReviewPromptLocked')}
            </div>

            <textarea
              class="settings-textarea settings-prompt-textarea"
              value={paperReviewPromptDraft}
              onInput={event => setPaperReviewPromptDraft(event.target.value)}
              placeholder={DEFAULT_PAPER_REVIEW_PROMPT_TEMPLATE}
            />

            <div class="settings-prompt-actions">
              <button
                type="button"
                class="btn btn-ghost"
                onClick={handleResetPaperReviewPrompt}
              >
                {t('settings.paperReviewPromptReset')}
              </button>
              <div class="settings-prompt-actions-right">
                <button
                  type="button"
                  class="btn btn-ghost"
                  onClick={closePaperReviewPromptEditor}
                >
                  {t('settings.paperReviewPromptCancel')}
                </button>
                <button
                  type="button"
                  class="btn btn-primary"
                  onClick={handleSavePaperReviewPrompt}
                >
                  {t('settings.paperReviewPromptSave')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
