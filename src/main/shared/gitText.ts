export function matchesGitText(actual: Buffer, expected: string): boolean {
  if (actual.equals(Buffer.from(expected))) return true
  const lf = expected.replace(/\r\n/g, '\n')
  return actual.equals(Buffer.from(lf)) || actual.equals(Buffer.from(lf.replace(/\n/g, '\r\n')))
}
