import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { promisify } from 'node:util'

const onWindows = process.platform === 'win32'

export interface Service {
  name: string
  /** `null` while it runs; once it has died, how. */
  exited(): string | null
  stop(): Promise<void>
}

/**
 * A service as it runs for real: its own `start` script, its own reading of `.env`, with
 * only what the run must control (RPC URL, ports) set in its environment, which wins over
 * the file.
 */
export async function startService(options: {
  name: string
  cwd: string
  env: Record<string, string>
  ready: RegExp
  logPath: string
  timeoutMs?: number
}): Promise<Service> {
  const { name, cwd, env, ready, logPath, timeoutMs = 60_000 } = options
  const child = spawn('pnpm', ['run', 'start'], {
    cwd,
    env: { ...process.env, ...env },
    shell: onWindows,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = createWriteStream(logPath)
  child.stdout?.pipe(log)
  child.stderr?.pipe(log)

  await new Promise<void>((done, fail) => {
    let seen = ''
    const timer = setTimeout(
      () => fail(new Error(`${name} not ready after ${timeoutMs} ms, see ${logPath}`)),
      timeoutMs,
    )
    const watch = (chunk: Buffer) => {
      seen += chunk.toString('utf8')
      if (ready.test(seen)) {
        clearTimeout(timer)
        child.stdout?.off('data', watch)
        done()
      }
    }
    child.stdout?.on('data', watch)
    child.once('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`${name} exited with ${code} before it was ready, see ${logPath}`))
    })
  })

  let exit: string | null = null
  let stopping = false
  child.once('exit', (code, signal) => {
    if (!stopping) exit = `${name} exited with ${code ?? signal}, see ${logPath}`
  })
  return {
    name,
    exited: () => exit,
    stop: () => {
      stopping = true
      return stopTree(child)
    },
  }
}

// On Windows the shell stands between us and node, and killing the shell leaves node holding the port.
async function stopTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return
  const exited = new Promise((done) => child.once('exit', done))
  if (onWindows) {
    await promisify(execFile)('taskkill', ['/pid', String(child.pid), '/T', '/F']).catch(() => {})
  } else {
    child.kill('SIGTERM')
  }
  await exited
}

/** A one-shot command of the repo's own tooling; its output is returned, failure thrown. */
export async function runTool(
  args: readonly string[],
  options: { cwd: string; env: Record<string, string> },
): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn('pnpm', args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: onWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.once('exit', (code) =>
      code === 0 ? done(output) : fail(new Error(`pnpm ${args.join(' ')} failed:\n${output}`)),
    )
  })
}
