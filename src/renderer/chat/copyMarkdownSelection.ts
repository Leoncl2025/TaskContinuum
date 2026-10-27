import type { ClipboardEvent } from 'react'
import { parseChatLink } from '../../shared/chatLinks'

const linkSelector = 'a[data-markdown-href]'
const blocks = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
const permittedTags = new Set(['A', 'P', 'DIV', 'SPAN', 'STRONG', 'EM', 'B', 'I', 'S', 'DEL', 'CODE', 'PRE', 'BR', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])

function plainText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (!(node instanceof Element)) return Array.from(node.childNodes).map(plainText).join('')
  const content = Array.from(node.childNodes).map(plainText).join('')
  if (node.tagName === 'A') {
    const href = node.getAttribute('href')
    if (href && parseChatLink(href)) {
      const label = content.replace(/[\\[\]]/g, '\\$&')
      const destination = href.replaceAll('<', '%3C').replaceAll('>', '%3E')
      return `[${label}](<${destination}>)`
    }
  }
  if (node.tagName === 'BR') return '\n'
  if (node.tagName === 'TR') return Array.from(node.children).map(plainText).join('\t') + '\n'
  if (node.tagName === 'LI') return `- ${content.trim()}\n`
  return blocks.has(node.tagName) ? `${content}\n\n` : content
}

/** Only override a text selection containing links; native code/input copying is unchanged. */
export function copyMarkdownSelection(event: ClipboardEvent<HTMLElement>): void {
  if (event.defaultPrevented) return
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return
  const fragment = document.createElement('div')
  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index)
    if (!range.intersectsNode(event.currentTarget)) return
    const copied = range.cloneContents()
    const ancestor = range.commonAncestorContainer
    const element = ancestor instanceof Element ? ancestor : ancestor.parentElement
    const parentLink = element?.closest(linkSelector)
    if (parentLink && !copied.querySelector(linkSelector)) {
      const link = document.createElement('a')
      link.setAttribute('data-markdown-href', parentLink.getAttribute('data-markdown-href') ?? '')
      link.append(copied)
      fragment.append(link)
    } else fragment.append(copied)
  }
  const links = Array.from(fragment.querySelectorAll(linkSelector))
  if (!links.some((link) => parseChatLink(link.getAttribute('data-markdown-href') ?? ''))) return

  for (const link of links) {
    const href = link.getAttribute('data-markdown-href')
    if (href && parseChatLink(href)) link.setAttribute('href', href)
    else link.removeAttribute('href')
  }
  fragment.querySelectorAll('button, input, textarea, select, script, style, iframe, img, .message-code-header').forEach((node) => node.remove())
  for (const math of fragment.querySelectorAll('.katex-display, .katex:not(.katex-display .katex)')) {
    const tex = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent
    if (tex !== undefined && tex !== null) math.replaceWith(document.createTextNode(math.classList.contains('katex-display') ? `\\[\n${tex}\n\\]` : `\\(${tex}\\)`))
  }
  for (const node of Array.from(fragment.querySelectorAll('*'))) {
    if (!permittedTags.has(node.tagName)) { node.replaceWith(...node.childNodes); continue }
    for (const attribute of Array.from(node.attributes)) {
      if (!(node.tagName === 'A' && attribute.name === 'href' && parseChatLink(attribute.value))) node.removeAttribute(attribute.name)
    }
  }
  const text = plainText(fragment).trim()
  event.clipboardData.setData('text/plain', text)
  event.clipboardData.setData('text/html', fragment.innerHTML)
  event.preventDefault()
}
