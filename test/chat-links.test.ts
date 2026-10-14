import { describe, expect, it } from 'vitest'
import { parseChatLink } from '../src/shared/chatLinks'

describe('supported Markdown link addresses', () => {
  it.each([
    ['https://dev.azure.com/org/project/_git/repo/pullrequest/42', 'https://dev.azure.com/org/project/_git/repo/pullrequest/42'],
    ['HTTP://EXAMPLE.COM/docs#topic', 'http://example.com/docs#topic'],
    ['//example.com/docs', 'https://example.com/docs'],
  ])('opens explicit web address %s without treating it as a file', (value, url) => {
    expect(parseChatLink(value)).toEqual({ kind: 'external', url })
  })

  it.each([
    ['file:///C:/Work/plan.md', 'C:\\Work\\plan.md'],
    ['file:///C%3A/Work/space%20name.txt', 'C:\\Work\\space name.txt'],
    ['file://localhost/C:/Work/plan.md', 'C:\\Work\\plan.md'],
    ['C:\\Work\\plan.md', 'C:\\Work\\plan.md'],
    ['Q:/Work/plan.md', 'Q:/Work/plan.md'],
    ['C:/Work/space%20name.ts', 'C:/Work/space name.ts'],
    ['/home/owner/space%20name.txt', '/home/owner/space name.txt'],
    ['file:///home/owner/report.txt', '/home/owner/report.txt'],
    ['/home/owner/report.txt', '/home/owner/report.txt'],
  ])('keeps absolute source path semantics for %s', (href, path) => {
    expect(parseChatLink(href)).toEqual({ kind: 'file', path, relative: false })
  })

  it('retains source line locations without sending them as a filename or shell arguments', () => {
    expect(parseChatLink('file:///C:/Work/example.ts:42:3')).toEqual({
      kind: 'file', path: 'C:\\Work\\example.ts', relative: false, line: 42, column: 3,
    })
    expect(parseChatLink('/home/owner/example.ts#L20C4')).toEqual({
      kind: 'file', path: '/home/owner/example.ts', relative: false, line: 20, column: 4,
    })
    expect(parseChatLink('../example.ts:7')).toEqual({
      kind: 'file', path: '../example.ts', relative: true, line: 7,
    })
  })

  it.each(['README.md', './docs/plan.md', '../notes/report.log'])('requires a verified source folder for relative link %s', (href) => {
    expect(parseChatLink(href)).toEqual({ kind: 'file', path: href, relative: true })
  })

  it.each([
    '', '#section', ':42',
    'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'command:workbench.action.closeWindow', 'vscode://file/C:/Work/plan.md',
    'ftp://example.com/file', 'mailto:person@example.com',
    'https://user:password@example.com', 'https://example.com/\n',
    'file://server/share/private.txt', '\\\\server\\share\\private.txt',
    'file:///C:/Work/file.txt?command=run', 'file:///C:/Work/%00secret',
    'file:///C:/Work/%0asecret', 'file:///C:/Work/%ZZ',
    'file:///C:/Work/%E2%80%A8secret',
    'file:relative.txt', 'file:./relative.txt', 'javascript%3Aalert(1)',
    'C:/Work/%00private.txt', 'C:/Work/%ZZ',
  ])('does not enable unsupported or unsafe address %s', (value) => {
    expect(parseChatLink(value)).toBeUndefined()
  })
})
