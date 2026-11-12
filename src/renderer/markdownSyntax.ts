import { common, createLowlight } from 'lowlight'
import powershell from 'highlight.js/lib/languages/powershell'
import type { Element, Nodes, Root } from 'hast'
import type { Plugin } from 'unified'
import './syntax.css'

const highlighter = createLowlight({ ...common, powershell })
const maxCodeCharacters = 65_536

export function markdownCodeText(node: Nodes): string {
  if (node.type === 'text') return node.value
  return 'children' in node ? node.children.map(markdownCodeText).join('') : ''
}

function highlightCode(node: Element): void {
  const classes = node.properties.className
  if (!Array.isArray(classes) || classes.includes('no-highlight') || classes.includes('nohighlight')) return
  const languageClass = classes.find((value) => typeof value === 'string' && value.startsWith('language-'))
  if (typeof languageClass !== 'string') return
  const language = languageClass.slice('language-'.length).toLowerCase()
  if (!highlighter.registered(language)) return

  const source = markdownCodeText(node)
  if (source.length > maxCodeCharacters) {
    node.properties['data-syntax-highlight'] = 'skipped-size'
    node.properties.title = 'Syntax highlighting is disabled above 65,536 characters. All code remains available to read and copy.'
    return
  }
  try {
    node.children = highlighter.highlight(language, source).children.map((child) => {
      if (child.type === 'element' || child.type === 'text') return child
      throw new Error('Unsupported syntax highlighting token.')
    })
    node.properties.className = [...classes, 'hljs']
  } catch {
    console.error('Syntax highlighting failed for a code block; the original code remains available.')
    node.properties['data-syntax-highlight'] = 'failed'
    node.properties.title = 'Syntax highlighting is unavailable. The original code remains available to read and copy.'
  }
}

export const highlightMarkdownCode: Plugin<[], Root> = () => (tree) => {
  function visit(node: Nodes): void {
    if (node.type === 'element' && node.tagName === 'pre') {
      for (const child of node.children) {
        if (child.type === 'element' && child.tagName === 'code') highlightCode(child)
      }
      return
    }
    if ('children' in node) node.children.forEach(visit)
  }
  visit(tree)
}
