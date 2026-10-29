import { spawn } from 'node:child_process'
import { loadWorkspaceEnv } from './load-workspace-env.mjs'

loadWorkspaceEnv(process.cwd())

const port = process.env.WEB_PORT ?? '3000'
const child = spawn('next', ['dev', '--port', port], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: port,
  },
  shell: process.platform === 'win32',
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal)
  })
}

child.on('exit', (code) => {
  process.exit(code ?? 0)
})
