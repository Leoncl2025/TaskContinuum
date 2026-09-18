import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { renderAllSchemas } from '../../shared/taskDocuments/schemaFiles.js'
import { IndexFile } from '../../shared/taskDocuments/indexFile.js'
import { DocumentFiles } from './files.js'
import { buildIndex } from './indexer.js'
import { scanDocuments, validateDocuments, type DocumentDiagnostic } from './validation.js'
import { createTaskDocuments, readTaskCreationDraft, taskCreationDraftSchema } from './create.js'

export function run(args: string[], cwd: string): number {
  const [command, ...options] = args
  if (!command || command === '--help') {
    console.log([
      'task-documents validate [T-0001] | scan --all | check | reindex | schema:gen [--check]; all accept --root <directory>',
      'task-documents create --title <title> [--description <text>] [--parent T-0001] [--owner <member>] [--level <level>] [--type <type>] [--priority <priority>] [--slug <slug>] [--acceptance <line> ...] [--actor <actor>] --root <directory>',
      'task-documents create --draft <workspace-contained JSON file> [--actor <actor>] --root <directory>',
    ].join('\n'))
    return command ? 0 : 2
  }
  if (command === 'create') return runCreate(options, cwd)
  if (!['validate', 'scan', 'check', 'reindex', 'schema:gen'].includes(command)) throw new Error(`Unknown command: ${command}`)
  let root = cwd
  let only: string | undefined
  let check = false
  let all = false
  for (let i = 0; i < options.length; i++) {
    const option = options[i]
    if (option === '--root') {
      const value = options[++i]
      if (!value || value.startsWith('--')) throw new Error('--root requires a directory.')
      root = path.resolve(cwd, value)
    } else if (option === '--check' && command === 'schema:gen') check = true
    else if (option === '--all' && command === 'scan') all = true
    else if (/^T-\d+$/.test(option) && command === 'validate' && !only) only = option
    else throw new Error(`Unsupported argument: ${option}`)
  }
  if (command === 'scan' && !all) throw new Error('Specify scan --all; staged-git scanning is not part of this command.')
  if (command === 'schema:gen') {
    const files = new DocumentFiles(root)
    let drift = false
    for (const schema of renderAllSchemas()) {
      const file = files.contained(path.join(files.root, '.agentdesk', 'schema', schema.file))
      if (check) {
        if (!files.existsSync(file) || files.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== schema.content) {
          console.error(`ERROR [SCHEMA_DRIFT] ${schema.file}`)
          drift = true
        }
      } else writeOwnedFile(files, file, schema.content)
    }
    console.log(check ? 'Schema drift check completed.' : 'Generated 4 document schemas.')
    return drift ? 1 : 0
  }
  const result = validateDocuments(root, only)
  const diagnostics: DocumentDiagnostic[] = command === 'scan' ? [] : [...result.issues]
  if (command === 'scan' || command === 'check') {
    const scanned = scanDocuments(result.files, result.workspace)
    // Invalid config/path data must not make scan succeed over a fallback directory.
    if (command === 'scan') diagnostics.push(...result.workspace.issues)
    diagnostics.push(...scanned.issues)
    for (const finding of scanned.findings) diagnostics.push({
      severity: finding.severity, code: finding.kind === 'secret' ? 'SECRET' : 'INJECTION',
      message: `${finding.reason}: ${finding.excerpt}`, path: finding.path, line: finding.line,
    })
  }
  for (const diagnostic of diagnostics) {
    console.log(`${diagnostic.severity.toUpperCase()} [${diagnostic.code}] ${diagnostic.taskId ?? diagnostic.path ?? '-'}${diagnostic.line ? `:${diagnostic.line}` : ''}: ${diagnostic.message}`)
  }
  const errors = diagnostics.filter((item) => item.severity === 'error').length
  const warnings = diagnostics.filter((item) => item.severity === 'warn').length
  console.log(`Workspace: ${result.workspace.config.workspace}; tasks: ${result.workspace.tasks.length}; ${errors} error(s), ${warnings} warning(s).`)
  if (command === 'reindex') {
    const { index } = buildIndex(result.workspace, result.files.texts)
    IndexFile.parse(index)
    writeOwnedFile(result.files, path.join(result.files.root, '.agentdesk', 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
    console.log('Rebuilt .agentdesk/index.json; canonical documents unchanged.')
  }
  return errors ? 1 : 0
}

function runCreate(args: string[], cwd: string): number {
  let root = cwd
  let draftFile: string | undefined
  let actor: string | undefined
  const draft: Record<string, unknown> = {}
  const acceptance: string[] = []
  const seen = new Set<string>()
  const fields: Record<string, string> = {
    '--title': 'title', '--description': 'description', '--parent': 'parentId',
    '--owner': 'owner', '--level': 'level', '--type': 'type',
    '--priority': 'priority', '--slug': 'slug',
  }
  for (let i = 0; i < args.length; i++) {
    const option = args[i]
    if (!Object.hasOwn(fields, option) && !['--root', '--draft', '--actor', '--acceptance'].includes(option)) {
      throw new Error(`Unsupported create argument: ${option}`)
    }
    if (seen.has(option) && option !== '--acceptance') throw new Error(`Duplicate create argument: ${option}`)
    seen.add(option)
    const value = args[++i]
    if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value.`)
    if (option === '--root') {
      if (!value.trim()) throw new Error('--root requires a directory.')
      root = path.resolve(cwd, value)
    } else if (option === '--draft') {
      if (!value.trim()) throw new Error('--draft requires a JSON file.')
      draftFile = value
    } else if (option === '--actor') actor = value
    else if (option === '--acceptance') acceptance.push(value)
    else draft[fields[option]] = value
  }
  if (acceptance.length) draft.acceptance = acceptance
  if (draftFile !== undefined && Object.keys(draft).length) {
    throw new Error('--draft cannot be combined with title, description, parent, owner, level, type, priority, slug, or acceptance overrides.')
  }
  const parsed = draftFile === undefined ? taskCreationDraftSchema.parse(draft) : readTaskCreationDraft(root, draftFile)
  const result = createTaskDocuments(root, parsed, { actor, source: 'agent' })
  console.log(JSON.stringify({ taskId: result.taskId, directory: result.directory }))
  return 0
}

function writeOwnedFile(files: DocumentFiles, target: string, content: string): void {
  const file = files.contained(target)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  files.contained(file)
  const staging = `${file}.${randomUUID()}.staging`
  try {
    fs.writeFileSync(staging, content, { encoding: 'utf8', flag: 'wx' })
    files.contained(file)
    fs.renameSync(staging, file)
  } finally {
    if (fs.existsSync(staging)) fs.unlinkSync(staging)
  }
}
