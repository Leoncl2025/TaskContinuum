import { setTimeout as delay } from 'node:timers/promises'

for (const label of ['ALPHA', 'BETA', 'GAMMA']) {
  await delay(700)
  process.stdout.write(`AHP_${label}:${Date.now()}\n`)
}