import { spawn } from 'node:child_process'
import { deployVariables } from './cloud-helpers'

// Wrangler reads CLOUDFLARE_ACCOUNT_ID itself; extra arguments pass through.
const child = spawn(
  'wrangler',
  ['deploy', ...deployVariables(), ...process.argv.slice(2)],
  { stdio: 'inherit' },
)
child.once('error', () => {
  process.stderr.write('Wrangler could not be started.\n')
  process.exitCode = 1
})
child.once('exit', (code) => {
  process.exitCode = code ?? 1
})
