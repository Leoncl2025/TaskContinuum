import { run } from './cli'

try {
  process.exitCode = run(process.argv.slice(2), process.cwd())
} catch (error) {
  console.error(`ERROR [DOCUMENT_COMMAND_FAILED] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
