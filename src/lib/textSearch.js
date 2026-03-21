const SEARCHABLE_CHAR_PATTERN = /[\p{L}\p{N}]/u

function isSearchableChar(char) {
  return SEARCHABLE_CHAR_PATTERN.test(char)
}

export function normalizeSearchText(value) {
  let normalized = ''

  for (const char of String(value || '')) {
    if (!isSearchableChar(char)) continue
    normalized += char.toLocaleLowerCase()
  }

  return normalized
}

function shouldSkipTextNode(node, skipSelector) {
  if (!node?.nodeValue?.trim()) return true
  const parent = node.parentElement
  return !!(parent && skipSelector && parent.closest(skipSelector))
}

export function collectTextNodesFromRoots(roots, { skipSelector = 'code, pre, script, style' } = {}) {
  const textNodes = []

  for (const root of roots || []) {
    if (!root) continue

    if (root.nodeType === Node.TEXT_NODE) {
      if (!shouldSkipTextNode(root, skipSelector)) {
        textNodes.push(root)
      }
      continue
    }

    if (root.nodeType !== Node.ELEMENT_NODE) continue

    const walker = root.ownerDocument.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          return shouldSkipTextNode(node, skipSelector)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT
        },
      },
    )

    while (walker.nextNode()) {
      textNodes.push(walker.currentNode)
    }
  }

  return textNodes
}

export function findTextNodeMatch(textNodes, needle) {
  const normalizedNeedle = normalizeSearchText(needle)
  if (!normalizedNeedle || !textNodes?.length) return null

  let haystack = ''
  const positions = []

  textNodes.forEach((node, nodeIndex) => {
    const value = node.nodeValue || ''
    let offset = 0

    for (const char of value) {
      const length = char.length
      if (isSearchableChar(char)) {
        const lowered = char.toLocaleLowerCase()
        for (const loweredChar of lowered) {
          if (!isSearchableChar(loweredChar)) continue
          haystack += loweredChar
          positions.push({ nodeIndex, offset, length })
        }
      }
      offset += length
    }
  })

  if (!haystack) return null

  const startIndex = haystack.indexOf(normalizedNeedle)
  if (startIndex < 0) return null

  const endIndex = startIndex + normalizedNeedle.length - 1
  return {
    start: positions[startIndex],
    end: positions[endIndex],
  }
}

export function wrapTextNodeMatch(doc, textNodes, match, className, highlightType = 'snippet') {
  if (!doc || !match?.start || !match?.end) return []

  const created = []

  for (let nodeIndex = match.end.nodeIndex; nodeIndex >= match.start.nodeIndex; nodeIndex -= 1) {
    const textNode = textNodes[nodeIndex]
    const parent = textNode?.parentNode
    if (!textNode || !parent) continue

    const value = textNode.nodeValue || ''
    const startOffset = nodeIndex === match.start.nodeIndex ? match.start.offset : 0
    const endOffset = nodeIndex === match.end.nodeIndex
      ? match.end.offset + match.end.length
      : value.length

    if (startOffset >= endOffset) continue

    const fragment = doc.createDocumentFragment()
    if (startOffset > 0) {
      fragment.append(doc.createTextNode(value.slice(0, startOffset)))
    }

    const mark = doc.createElement('span')
    mark.className = className
    mark.dataset.citationHighlight = highlightType
    mark.textContent = value.slice(startOffset, endOffset)
    fragment.append(mark)
    created.push(mark)

    if (endOffset < value.length) {
      fragment.append(doc.createTextNode(value.slice(endOffset)))
    }

    parent.replaceChild(fragment, textNode)
    parent.normalize()
  }

  return created.reverse()
}

export function unwrapCitationHighlights(root, highlightType = 'snippet') {
  if (!root) return

  root.querySelectorAll(`[data-citation-highlight="${highlightType}"]`).forEach(element => {
    const parent = element.parentNode
    if (!parent) return

    while (element.firstChild) {
      parent.insertBefore(element.firstChild, element)
    }

    parent.removeChild(element)
    parent.normalize()
  })
}
