import { unified } from 'unified'
import type { Plugin, PluggableList } from 'unified'
import type { Nodes, Root } from 'mdast'
import type { Nodes as HtmlNodes, Root as HtmlRoot } from 'hast'
import remarkParse from 'remark-parse'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import './math.css'

const parser = unified().use(remarkParse).use(remarkFrontmatter).use(remarkMath).freeze()
const protectedTypes = new Set(['code', 'inlineCode', 'html', 'link', 'linkReference', 'image', 'imageReference', 'definition', 'yaml', 'toml'])
type Range = { start: number; end: number }
type Formula = Range & { value: string; display: boolean }

function walk(node: Nodes, visit: (node: Nodes) => boolean): void {
  if (visit(node) && 'children' in node) node.children.forEach((child) => walk(child, visit))
}

function escaped(source: string, offset: number): boolean {
  let count = 0
  while (offset > 0 && source[--offset] === '\\') count++
  return count % 2 !== 0
}

/** Protect math before GFM splits table cells; never rewrite code or link destinations. */
export function prepareMarkdownMath(source: string): { source: string; plugin: Plugin<[], Root> } {
  const formulas: Formula[] = []
  const protectedRanges: Range[] = []
  if (/[$]|\\[[(]/.test(source)) {
    walk(parser.parse(source), (node) => {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start === undefined || end === undefined) return true
      if (protectedTypes.has(node.type)) { protectedRanges.push({ start, end }); return false }
      if (node.type === 'math' || node.type === 'inlineMath') {
        const raw = source.slice(start, end)
        const display = node.type === 'math' || raw.startsWith('$$')
        // Do not interpret "$5 and $10" or whitespace-padded currency as inline math.
        if (!display && (/^\$\s|\s\$$/.test(raw) || /^\$\d/.test(raw) && /\d/.test(source[end] ?? ''))) {
          protectedRanges.push({ start, end })
          return false
        }
        formulas.push({ start, end, value: node.value, display })
        protectedRanges.push({ start, end })
        return false
      }
      return true
    })
    const openings = /\\([[(])/g
    for (let match = openings.exec(source); match; match = openings.exec(source)) {
      const start = match.index
      if (escaped(source, start) || protectedRanges.some((range) => start >= range.start && start < range.end)) continue
      const closing = match[1] === '[' ? '\\]' : '\\)'
      let end = source.indexOf(closing, openings.lastIndex)
      while (end >= 0 && escaped(source, end)) end = source.indexOf(closing, end + closing.length)
      if (end < 0 || protectedRanges.some((range) => end >= range.start && end < range.end)) continue
      const lineStart = source.lastIndexOf('\n', start - 1) + 1
      const quote = /^(?: {0,3}>[ \t]?)+/.exec(source.slice(lineStart, start))?.[0]
      const value = source.slice(openings.lastIndex, end).split(/\r?\n/)
        .map((line, index) => index > 0 && quote && line.startsWith(quote) ? line.slice(quote.length) : line).join('\n').trim()
      if (!value || match[1] === '(' && /\r?\n[ \t]*\r?\n/.test(value)) continue
      formulas.push({ start, end: end + closing.length, value, display: match[1] === '[' })
      openings.lastIndex = end + closing.length
    }
  }

  let prefix = 'tc-math-'
  while (source.includes(prefix)) prefix += '-'
  const values = new Map<string, Formula>()
  const parts: string[] = []
  let cursor = 0
  for (const formula of formulas.sort((left, right) => left.start - right.start || right.end - left.end)) {
    if (formula.start < cursor) continue
    const key = `${prefix}${values.size}`
    values.set(key, formula)
    parts.push(source.slice(cursor, formula.start), `[${key}]()`)
    cursor = formula.end
  }
  parts.push(source.slice(cursor))
  const plugin: Plugin<[], Root> = () => (tree) => {
    walk(tree, (node) => {
      if (node.type !== 'link' || node.url !== '' || node.children.length !== 1 || node.children[0].type !== 'text') return true
      const formula = values.get(node.children[0].value)
      if (!formula) return false
      node.data = {
        hName: 'span',
        hProperties: { href: undefined, className: [formula.display ? 'math-display' : 'math-inline'] },
        hChildren: [{ type: 'text', value: formula.value }],
      }
      return false
    })
  }
  return { source: parts.join(''), plugin }
}

const mathSizeLimit: Plugin<[], HtmlRoot> = () => (tree) => {
  function visit(node: HtmlNodes): void {
    if (node.type === 'element') {
      const classes = node.properties.className
      if (Array.isArray(classes) && classes.some((value) => ['language-math', 'math-display', 'math-inline'].includes(String(value)))
        && node.children.length === 1 && node.children[0].type === 'text' && node.children[0].value.length > 32768) {
        node.properties.className = ['math-size-error']
      }
    }
    if ('children' in node) node.children.forEach(visit)
  }
  visit(tree)
}

const mathPresentation: Plugin<[], HtmlRoot> = () => (tree) => {
  function visit(node: HtmlNodes): void {
    if (node.type === 'element') {
      const classes = node.properties.className
      if (Array.isArray(classes) && classes.includes('katex-display')) {
        node.properties.tabIndex = 0
        node.properties.role = 'group'
        node.properties.ariaLabel = 'Block formula'
      }
      if (Array.isArray(classes) && (classes.includes('katex-error') || classes.includes('math-size-error'))) {
        node.properties.role = 'status'
        node.properties.ariaLabel = 'Formula could not be rendered'
        if (classes.includes('math-size-error')) node.properties.title = 'Formula exceeds the 32,768-character rendering limit.'
      }
    }
    if ('children' in node) node.children.forEach(visit)
  }
  visit(tree)
}

export const mathRehypePlugins: PluggableList = [
  mathSizeLimit,
  [rehypeKatex, { trust: false, strict: 'error', maxExpand: 1000, maxSize: 20, errorColor: '#c44747' }],
  mathPresentation,
]
