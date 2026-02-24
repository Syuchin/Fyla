const ILLEGAL_CHARS = /[<>:"/\\|?*\x00-\x1f]/g
const MAX_LEN = 255 // macOS APFS/HFS+ limit

export function validateFileName(name, ext, existingNames = new Set()) {
  const warnings = []
  let clean = name

  // 1. illegal characters -> underscore
  if (ILLEGAL_CHARS.test(clean)) {
    clean = clean.replace(ILLEGAL_CHARS, '_')
    warnings.push('illegal_chars')
  }

  // 2. leading/trailing spaces and dots
  const trimmed = clean.replace(/^[\s.]+|[\s.]+$/g, '')
  if (trimmed !== clean) { clean = trimmed; warnings.push('trimmed') }

  // 3. length limit (including ext + dot)
  const extLen = ext ? ext.length + 1 : 0
  if (clean.length + extLen > MAX_LEN) {
    clean = clean.slice(0, MAX_LEN - extLen)
    warnings.push('too_long')
  }

  // 4. empty fallback
  if (!clean) { clean = 'untitled'; warnings.push('empty') }

  // 5. duplicate detection -> auto suffix (matches renamer.rs logic)
  let full = ext ? `${clean}.${ext}` : clean
  let i = 1
  while (existingNames.has(full.toLowerCase())) {
    full = ext ? `${clean}-${i}.${ext}` : `${clean}-${i}`
    i++
  }
  if (i > 1) warnings.push('duplicate')

  return { validated: full, warnings, hasWarnings: warnings.length > 0 }
}
