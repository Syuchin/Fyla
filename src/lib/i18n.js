import { signal, computed } from '@preact/signals'
import zh from '../i18n/zh.json'
import en from '../i18n/en.json'
import { translate } from 'preact-i18n'

export const LANGS = { zh, en }
const STORAGE_KEY = 'fyla-lang'

function detectLang() {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved && LANGS[saved]) return saved
  const nav = navigator.language || ''
  return nav.startsWith('zh') ? 'zh' : 'en'
}

export const lang = signal(detectLang())
export const definition = computed(() => LANGS[lang.value])

export function setLang(l) {
  if (!LANGS[l]) return
  lang.value = l
  localStorage.setItem(STORAGE_KEY, l)
}

export function toggleLang() {
  setLang(lang.value === 'zh' ? 'en' : 'zh')
}

// Shorthand for non-JSX contexts (event handlers, title attrs, etc.)
// Uses preact-i18n's translate() under the hood.
// t('nav.files') -> "文件"
// t('files.doneCount', { count: 3 }) -> "完成，3 个文件已重命名"
export function t(key, fields) {
  return translate(key, null, definition.value, fields) || key
}
