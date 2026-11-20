export type MermaidTheme = 'light' | 'dark'

export const MAX_MERMAID_SOURCE_LENGTH = 32_768
const MAX_CACHE_ENTRIES = 64
const ALLOWED_LABEL_TAG = /^<\s*(?:br\s*\/?|\/?\s*(?:b|strong|i|em|u|s|sub|sup|code))\s*>$/i
const FORBIDDEN_SVG_ELEMENTS = 'script, iframe, frame, frameset, object, embed, applet, audio, video, source, track, canvas, form, input, button, select, textarea, link, meta, base, img, image'

const svgCache = new Map<string, string>()
let renderQueue: Promise<unknown> = Promise.resolve()
let sequence = 0

export function normalizeMermaidLabels(source: string): string {
  return source.replace(/"([^"\r\n]*)"/g, (_whole, inner: string) => {
    const escaped = inner.replace(/<[^>]*>/g, (tag) => {
      if (/^<\s*br\s*\/?\s*>$/i.test(tag)) return '<br/>'
      if (ALLOWED_LABEL_TAG.test(tag)) return tag
      return `&lt;${tag.slice(1, -1)}&gt;`
    })
    return `"${escaped}"`
  })
}

function scrubStyleValue(css: string): string {
  return css
    .replace(/@import\b[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)\s*(?!#)[^)]*\1\s*\)/gi, 'none')
}

export function sanitizeMermaidSvg(rawSvg: string): string {
  const doc = new DOMParser().parseFromString(rawSvg, 'text/html')
  const svg = doc.querySelector('svg')
  if (!svg) throw new Error('Mermaid did not produce an SVG element.')

  for (const forbidden of Array.from(svg.querySelectorAll(FORBIDDEN_SVG_ELEMENTS))) {
    forbidden.remove()
  }

  for (const element of [svg, ...Array.from(svg.querySelectorAll('*'))]) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || name === 'src' || name === 'srcdoc' || name === 'formaction' || name === 'href' || name === 'xlink:href') {
        element.removeAttribute(attribute.name)
      } else if (name === 'style') {
        element.setAttribute('style', scrubStyleValue(attribute.value))
      }
    }
    if (element.tagName.toLowerCase() === 'style' && element.textContent) {
      element.textContent = scrubStyleValue(element.textContent)
    }
  }

  const viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  const naturalWidth = viewBox && viewBox.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2] > 0
    ? Math.ceil(viewBox[2]) : undefined
  svg.setAttribute('width', '100%')
  svg.removeAttribute('height')
  const cleanedStyle = (svg.getAttribute('style') ?? '').replace(/(?:^|;)\s*max-width\s*:[^;]*/gi, '').trim()
  const styleParts = [
    cleanedStyle,
    naturalWidth ? `--mermaid-natural-width: ${naturalWidth}px` : '',
  ].filter(Boolean)
  if (styleParts.length) svg.setAttribute('style', styleParts.join('; '))
  else svg.removeAttribute('style')
  return svg.outerHTML
}

function themeVariables(theme: MermaidTheme) {
  return theme === 'dark' ? {
    background: 'transparent',
    fontFamily: "'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
    fontSize: '13px',
    primaryColor: '#1e293b',
    primaryTextColor: '#e2e8f0',
    primaryBorderColor: '#3b82f6',
    lineColor: '#94a3b8',
    secondaryColor: '#252526',
    secondaryTextColor: '#e2e8f0',
    secondaryBorderColor: '#475569',
    tertiaryColor: '#1f242d',
    tertiaryTextColor: '#e2e8f0',
    tertiaryBorderColor: '#3c3c3c',
    mainBkg: '#1e293b',
    nodeBorder: '#3b82f6',
    clusterBkg: '#1e1e1e',
    clusterBorder: '#3c3c3c',
    titleColor: '#e2e8f0',
    edgeLabelBackground: '#181818',
    actorBkg: '#1e293b',
    actorBorder: '#3b82f6',
    actorTextColor: '#e2e8f0',
    signalColor: '#cbd5e1',
    noteBkgColor: '#262626',
    noteTextColor: '#e2e8f0',
    noteBorderColor: '#475569',
  } : {
    background: 'transparent',
    fontFamily: "'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
    fontSize: '13px',
    primaryColor: '#eff6ff',
    primaryTextColor: '#1f2328',
    primaryBorderColor: '#60a5fa',
    lineColor: '#64748b',
    secondaryColor: '#f8fafc',
    secondaryTextColor: '#1f2328',
    secondaryBorderColor: '#94a3b8',
    tertiaryColor: '#f1f5f9',
    tertiaryTextColor: '#1f2328',
    tertiaryBorderColor: '#cbd5e1',
    mainBkg: '#eff6ff',
    nodeBorder: '#60a5fa',
    clusterBkg: '#f8fafc',
    clusterBorder: '#cbd5e1',
    titleColor: '#1f2328',
    edgeLabelBackground: '#ffffff',
    actorBkg: '#eff6ff',
    actorBorder: '#60a5fa',
    actorTextColor: '#1f2328',
    signalColor: '#334155',
    noteBkgColor: '#fff8dc',
    noteTextColor: '#1f2328',
    noteBorderColor: '#cbd5e1',
  }
}

export function cachedMermaidSvg(source: string, theme: MermaidTheme): string | undefined {
  return svgCache.get(`${theme}:${source.trim()}`)
}

export function renderMermaidDiagram(source: string, theme: MermaidTheme): Promise<string> {
  const trimmed = source.trim()
  if (!trimmed) return Promise.reject(new Error('Empty Mermaid source.'))
  if (trimmed.length > MAX_MERMAID_SOURCE_LENGTH) {
    return Promise.reject(new Error(`Mermaid diagram exceeds ${MAX_MERMAID_SOURCE_LENGTH.toLocaleString()} characters.`))
  }
  const cacheKey = `${theme}:${trimmed}`
  const hit = svgCache.get(cacheKey)
  if (hit) return Promise.resolve(hit)

  const job = renderQueue.catch(() => undefined).then(async () => {
    const cached = svgCache.get(cacheKey)
    if (cached) return cached
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      maxTextSize: MAX_MERMAID_SOURCE_LENGTH,
      theme: 'base',
      themeVariables: themeVariables(theme),
      flowchart: { htmlLabels: true, curve: 'basis', padding: 14, wrappingWidth: 320 },
      sequence: { useMaxWidth: true },
    })
    const container = document.createElement('div')
    container.setAttribute('aria-hidden', 'true')
    container.style.cssText = 'position:fixed;left:-10000px;top:0;width:1400px;line-height:1.35;font-size:13px;visibility:hidden;pointer-events:none;'
    document.body.append(container)
    const id = `tc-mermaid-${++sequence}`
    try {
      const normalized = normalizeMermaidLabels(trimmed)
      const { svg } = await mermaid.render(id, normalized, container)
      const safeSvg = sanitizeMermaidSvg(svg)
      if (svgCache.size >= MAX_CACHE_ENTRIES) {
        const oldest = svgCache.keys().next().value
        if (oldest !== undefined) svgCache.delete(oldest)
      }
      svgCache.set(cacheKey, safeSvg)
      return safeSvg
    } finally {
      container.remove()
      document.getElementById(`d${id}`)?.remove()
    }
  })

  renderQueue = job.then(() => undefined, () => undefined)
  return job
}
