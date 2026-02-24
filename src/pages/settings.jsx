import { useState, useEffect } from 'preact/hooks'
import { config, showToast, isWatching, showWelcome } from '../lib/store.js'
import { saveConfig, startWatch, stopWatch, pickFolder, testConnection } from '../lib/tauri.js'
import { invoke } from '@tauri-apps/api/core'
import { changelog } from '../lib/changelog.js'
import { t, lang, setLang } from '../lib/i18n.js'
import { checkForUpdateManual } from '../lib/updater.js'

export function SettingsPage() {
  const c = config.value
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [autoStart, setAutoStart] = useState(false)
  const [showChangelog, setShowChangelog] = useState(false)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    invoke('is_autostart_enabled').then(setAutoStart).catch(() => {})
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

  return (
    <div class="main">
      <div class="settings-page">

        {/* General */}
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

        {/* AI Provider */}
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

        {/* Naming Rules */}
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

        {/* Auto Watch */}
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

        {/* About */}
        <div class="settings-section about-section">
          <div class="about-version">
            <span class="about-version-left" onClick={() => setShowChangelog(!showChangelog)}>
              <span>Fyla v{changelog[0].version}</span>
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

      </div>
    </div>
  )
}
