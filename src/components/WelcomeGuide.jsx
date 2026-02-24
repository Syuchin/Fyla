import { useState } from 'preact/hooks'
import { Icon } from './Icon.jsx'
import { config } from '../lib/store.js'
import { saveConfig, testConnection, pickFolder } from '../lib/tauri.js'
import { t } from '../lib/i18n.js'

const STORAGE_KEY = 'fyla-onboard-done'

export function useOnboard() {
  const done = localStorage.getItem(STORAGE_KEY) === '1'
  return {
    onboardDone: done,
    finishOnboard() { localStorage.setItem(STORAGE_KEY, '1') },
  }
}

function update(key, value) {
  const next = { ...config.value, [key]: value }
  config.value = next
  saveConfig(next).catch(() => {})
}

function StepProvider() {
  const c = config.value
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)

  async function handleTest() {
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
    <div class="welcome-step-form">
      <div class="welcome-form-row">
        <div class="toggle-group" style="width:100%">
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
          <div class="welcome-form-row">
            <label class="welcome-form-label">{t('settings.serverUrl')}</label>
            <input
              class="settings-input"
              style="max-width:none"
              value={c.ollamaUrl}
              onInput={e => update('ollamaUrl', e.target.value)}
              placeholder="http://localhost:11434"
            />
          </div>
          <div class="welcome-form-row">
            <label class="welcome-form-label">{t('settings.modelName')}</label>
            <input
              class="settings-input"
              style="max-width:none"
              value={c.ollamaModel}
              onInput={e => update('ollamaModel', e.target.value)}
              placeholder="llama3.2"
            />
          </div>
        </>
      ) : (
        <>
          <div class="welcome-form-row">
            <label class="welcome-form-label">{t('settings.baseUrl')}</label>
            <input
              class="settings-input"
              style="max-width:none"
              value={c.openaiBaseUrl}
              onInput={e => update('openaiBaseUrl', e.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </div>
          <div class="welcome-form-row">
            <label class="welcome-form-label">{t('settings.apiKey')}</label>
            <input
              class="settings-input"
              style="max-width:none"
              type="password"
              value={c.openaiKey}
              onInput={e => update('openaiKey', e.target.value)}
              placeholder="sk-..."
            />
          </div>
          <div class="welcome-form-row">
            <label class="welcome-form-label">{t('settings.model')}</label>
            <input
              class="settings-input"
              style="max-width:none"
              value={c.openaiModel}
              onInput={e => update('openaiModel', e.target.value)}
              placeholder="gpt-4o-mini"
            />
          </div>
        </>
      )}

      <div class="welcome-form-test">
        <button class="btn btn-secondary btn-sm" disabled={testing} onClick={handleTest}>
          {testing ? t('settings.testing') : t('settings.testConnection')}
        </button>
        {testResult && (
          <span class={`welcome-test-result ${testResult.ok ? 'ok' : 'fail'}`}>
            {testResult.msg}
          </span>
        )}
      </div>
    </div>
  )
}

function StepDestFolder() {
  const c = config.value

  return (
    <div class="welcome-step-form">
      <div class="welcome-form-row" style="flex-direction:row;align-items:center;justify-content:space-between">
        <label class="welcome-form-label" style="margin:0">
          {t('settings.autoCategorize')}
          <small>{t('settings.autoCategorizeHint')}</small>
        </label>
        <label class="switch">
          <input
            type="checkbox"
            checked={c.autoCategorize}
            onChange={e => update('autoCategorize', e.target.checked)}
          />
          <span class="switch-slider" />
        </label>
      </div>
    </div>
  )
}

function StepReady() {
  return (
    <div class="welcome-step-form welcome-step-ready">
      <Icon name="circle-check" className="welcome-ready-icon" />
      <p class="welcome-ready-text">{t('welcome.step4Desc')}</p>
    </div>
  )
}

function StepWatch() {
  const c = config.value
  const exts = (c.watchExtensions || 'pdf').split(',').map(s => s.trim()).filter(Boolean)

  async function handlePickWatch() {
    const path = await pickFolder()
    if (path) update('watchFolder', path)
  }

  function toggleExt(ext) {
    const checked = exts.includes(ext)
    const next = checked
      ? exts.filter(e => e !== ext)
      : [...exts, ext]
    update('watchExtensions', next.join(',') || 'pdf')
  }

  return (
    <div class="welcome-step-form">
      <div class="welcome-form-row">
        <label class="welcome-form-label">
          {t('settings.watchFolder')}
          <small>{t('settings.watchFolderHint')}</small>
        </label>
        <div style="display:flex;gap:6px;width:100%">
          <input
            class="settings-input"
            style="flex:1;max-width:none"
            value={c.watchFolder}
            onInput={e => update('watchFolder', e.target.value)}
            placeholder="~/Downloads"
          />
          <button class="btn btn-secondary btn-sm" onClick={handlePickWatch}>
            {t('settings.pick')}
          </button>
        </div>
      </div>
      <div class="welcome-form-row" style="flex-direction:column;align-items:flex-start;gap:6px">
        <label class="welcome-form-label">{t('settings.watchTypes')}</label>
        <div class="ext-checkboxes">
          {['pdf', 'docx', 'pptx', 'txt', 'md', 'xlsx', 'jpg', 'png'].map(ext => (
            <label key={ext} class="ext-checkbox">
              <input
                type="checkbox"
                checked={exts.includes(ext)}
                onChange={() => toggleExt(ext)}
              />
              <span>.{ext}</span>
            </label>
          ))}
        </div>
      </div>
      <div class="welcome-form-row" style="justify-content:flex-start;gap:8px;margin-top:4px">
        <small style="color:var(--text-secondary)">{t('welcome.watchOptional')}</small>
      </div>
    </div>
  )
}

export function WelcomeGuide({ onDone }) {
  const [step, setStep] = useState(0)

  const stepMeta = [
    { icon: 'microchip',           title: t('welcome.step1Title') },
    { icon: 'folder-open',         title: t('welcome.step2Title') },
    { icon: 'eye',                 title: t('welcome.step3Title') },
    { icon: 'wand-magic-sparkles', title: t('welcome.step4Title') },
  ]

  function handleNext() {
    if (step < stepMeta.length - 1) {
      setStep(step + 1)
    } else {
      onDone()
    }
  }

  return (
    <div class="welcome-overlay">
      <div class="welcome-card">
        <div class="welcome-header">
          <h1 class="welcome-title">{t('welcome.title')}</h1>
          <p class="welcome-subtitle">{t('welcome.subtitle')}</p>
        </div>

        <div class="welcome-steps-indicator">
          {stepMeta.map((_, i) => (
            <div key={i} class={`welcome-dot ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`} />
          ))}
        </div>

        <div class="welcome-step-content">
          <div class="welcome-step-heading">
            <Icon name={stepMeta[step].icon} className="welcome-step-icon-sm" />
            <h2 class="welcome-step-title">{stepMeta[step].title}</h2>
          </div>
          {step === 0 && <StepProvider />}
          {step === 1 && <StepDestFolder />}
          {step === 2 && <StepWatch />}
          {step === 3 && <StepReady />}
        </div>

        <div class="welcome-actions">
          {step > 0 ? (
            <button class="btn btn-ghost" onClick={() => setStep(step - 1)}>{t('welcome.prev')}</button>
          ) : (
            <button class="btn btn-ghost" onClick={onDone}>{t('welcome.skip')}</button>
          )}
          <button class="btn btn-primary" onClick={handleNext}>
            {step < stepMeta.length - 1 ? t('welcome.next') : t('welcome.getStarted')}
          </button>
        </div>
      </div>
    </div>
  )
}
