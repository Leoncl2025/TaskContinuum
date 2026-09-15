import fs from 'node:fs'
import path from 'node:path'

/** One bounded read budget per validation; cached text also feeds scanning and hashing. */
export class DocumentFiles {
  readonly root: string
  readonly texts = new Map<string, string>()
  private bytes = 0
  private entries = 0

  constructor(root: string) {
    this.root = fs.realpathSync(root)
    if (!fs.statSync(this.root).isDirectory()) throw new Error('The workspace must be a folder.')
  }

  private inside(file: string): boolean {
    const relative = path.relative(this.root, file)
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  }

  contained(file: string): string {
    const absolute = path.resolve(file)
    if (!this.inside(absolute)) throw new Error('Workspace path escapes the selected folder.')
    // Check the nearest existing ancestor as well, including absent output files.
    let ancestor = absolute
    while (!fs.existsSync(ancestor)) {
      const parent = path.dirname(ancestor)
      if (parent === ancestor) throw new Error('Cannot resolve workspace path.')
      ancestor = parent
    }
    if (!this.inside(fs.realpathSync(ancestor))) throw new Error('Workspace link escapes the selected folder.')
    return absolute
  }

  existsSync(file: string): boolean {
    return fs.existsSync(this.contained(file))
  }

  readFileSync(file: string, encoding: 'utf8'): string {
    const absolute = this.contained(file)
    const cached = this.texts.get(absolute)
    if (cached !== undefined) return cached
    const fd = fs.openSync(absolute, 'r')
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error(`${file} exceeds the 1 MB file limit or is not a file.`)
      if (this.bytes + stat.size > 16 * 1024 * 1024) throw new Error('The workspace exceeds the 16 MB read limit.')
      // The extra byte detects growth without allocating an unbounded readFile buffer.
      const buffer = Buffer.alloc(stat.size + 1)
      let length = 0
      while (length < buffer.length) {
        const count = fs.readSync(fd, buffer, length, buffer.length - length, null)
        if (!count) break
        length += count
      }
      this.bytes += length
      if (length > 1024 * 1024 || this.bytes > 16 * 1024 * 1024) throw new Error('Workspace data changed beyond the read limit.')
      if (length > stat.size) throw new Error('Workspace data changed while reading. Refresh to retry.')
      const text = buffer.subarray(0, length).toString(encoding)
      this.texts.set(absolute, text)
      return text
    } finally { fs.closeSync(fd) }
  }

  readdirSync(file: string): string[]
  readdirSync(file: string, options: { withFileTypes: true }): fs.Dirent[]
  readdirSync(file: string, options?: { withFileTypes: true }): string[] | fs.Dirent[] {
    const directory = fs.opendirSync(this.contained(file))
    const entries: fs.Dirent[] = []
    try {
      let entry: fs.Dirent | null
      while ((entry = directory.readSync()) !== null) {
        if (++this.entries > 20000) throw new Error('The workspace exceeds the 20,000 directory entry limit.')
        entries.push(entry)
      }
    } finally { directory.closeSync() }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    return options ? entries : entries.map((entry) => entry.name)
  }
}
