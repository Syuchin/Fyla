import { lang, t } from './i18n.js'

export function hasPaperCharCount(value) {
  return Number.isFinite(value) && value > 0
}

export function getPaperCharCountFromMarkdown(markdown = '') {
  return typeof markdown === 'string' ? markdown.length : 0
}

export function formatCompactPaperChars(value) {
  if (!hasPaperCharCount(value)) return ''
  if (value < 1000) return String(value)
  return `${(value / 1000).toFixed(1)}k`
}

export function formatExactPaperChars(value) {
  if (!hasPaperCharCount(value)) return ''
  const locale = lang.value === 'zh' ? 'zh-CN' : 'en-US'
  const count = new Intl.NumberFormat(locale).format(value)
  return t('papers.charCountExact', { count })
}
