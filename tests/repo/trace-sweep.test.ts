import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/trace-sweep.sh')

// On Windows a bare `bash` resolves to WSL, which sees neither this path nor this git.
// The sweep is run locally through Git Bash, so the test runs it there too.
const BASH =
  process.platform === 'win32'
    ? join(
        execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(),
        '../../../bin/bash.exe',
      )
    : 'bash'

const repos: string[] = []

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-'))
  repos.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.test')
  git(dir, 'config', 'core.autocrlf', 'false')
  mkdirSync(join(dir, 'scripts'))
  copyFileSync(SCRIPT, join(dir, 'scripts/trace-sweep.sh'))
  writeFileSync(join(dir, '.git/info/trace-identities'), 'jdoe-handle\n')
  return dir
}

function commit(dir: string, files: Record<string, string>, message = 'chore: change'): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
}

function sweep(dir: string, mode?: 'tree' | 'ci') {
  const run = spawnSync(BASH, ['scripts/trace-sweep.sh', ...(mode ? [mode] : [])], {
    cwd: dir,
    encoding: 'utf8',
  })
  return { code: run.status, out: `${run.stdout}${run.stderr}` }
}

// Every sample is glued from parts: written whole, it would be a trace in this very file,
// and the repository's own sweep would report it.
const WSL_PATH = ['', 'mnt', 'e', 'work', 'proj'].join('/')
const WINDOWS_PATH = ['C:', 'Users', 'bob'].join('\\')
const CRATE_LINE = `name = "solana-seed-${'phrase'}"`
const SEED_WORDS_CHECK = `mnem${'onic'}`

// Each case runs the real script: three git processes per pattern, about two seconds
// alone on Windows and several times that inside the parallel gate.
describe('trace-sweep.sh', { timeout: 60_000 }, () => {
  it('passes a clean history with the identities list present', () => {
    const dir = repo()
    commit(dir, { 'src/a.ts': 'export const a = 1\n' })
    const { code, out } = sweep(dir)
    expect(out).toContain('clean')
    expect(code).toBe(0)
  })

  it('finds a trace that lives only in an earlier revision', () => {
    const dir = repo()
    commit(dir, { 'build.sh': `cd ${WSL_PATH}\n` })
    commit(dir, { 'build.sh': 'cd "$(dirname "$0")"\n' })
    expect(sweep(dir, 'tree').code).toBe(0)
    const { code, out } = sweep(dir)
    expect(out).toContain('✗ absolute WSL path')
    expect(code).toBe(1)
  })

  it('finds a trace in a commit message', () => {
    const dir = repo()
    commit(dir, { 'a.txt': 'x\n' }, `chore: built in ${WINDOWS_PATH}`)
    const { code, out } = sweep(dir)
    expect(out).toContain('✗ absolute Windows path')
    expect(code).toBe(1)
  })

  it('finds a name from the identities list', () => {
    const dir = repo()
    commit(dir, { 'a.txt': 'by jdoe-handle\n' })
    const { code, out } = sweep(dir)
    expect(out).toContain('✗ personal data: jdoe-handle')
    expect(code).toBe(1)
  })

  it('reports a missing identities list as unchecked, but accepts it in ci mode', () => {
    const dir = repo()
    commit(dir, { 'a.txt': 'x\n' })
    rmSync(join(dir, '.git/info/trace-identities'))
    const local = sweep(dir)
    expect(local.out).toContain('unchecked')
    expect(local.code).toBe(1)
    expect(sweep(dir, 'ci').code).toBe(0)
  })

  describe('exceptions', () => {
    it('drops a hit whose path and whole line are listed', () => {
      const dir = repo()
      commit(dir, {
        'Cargo.lock': `${CRATE_LINE}\n`,
        'scripts/trace-sweep.allow': `Cargo.lock\t${CRATE_LINE}\n`,
      })
      const { code, out } = sweep(dir)
      expect(out).toContain(`✓ ${SEED_WORDS_CHECK}`)
      expect(code).toBe(0)
    })

    it('still reports the same line under another path', () => {
      const dir = repo()
      commit(dir, {
        'notes.txt': `${CRATE_LINE}\n`,
        'scripts/trace-sweep.allow': `Cargo.lock\t${CRATE_LINE}\n`,
      })
      const { code, out } = sweep(dir)
      expect(out).toContain(`✗ ${SEED_WORDS_CHECK}`)
      expect(code).toBe(1)
    })

    it('still reports the listed line once anything else on it changes', () => {
      const dir = repo()
      commit(dir, {
        'Cargo.lock': `${CRATE_LINE}\n${CRATE_LINE} # my seed ${'phrase'}\n`,
        'scripts/trace-sweep.allow': `Cargo.lock\t${CRATE_LINE}\n`,
      })
      const { code, out } = sweep(dir)
      expect(out).toContain(`✗ ${SEED_WORDS_CHECK}`)
      expect(out).not.toContain('matches nothing')
      expect(code).toBe(1)
    })

    // A listed line that no revision contains any more hides nothing today, but it is
    // a blank cheque for the day the same text comes back.
    it('fails the history pass on an exception that matches nothing', () => {
      const dir = repo()
      commit(dir, { 'scripts/trace-sweep.allow': `Cargo.lock\t${CRATE_LINE}\n` })
      const { code, out } = sweep(dir)
      expect(out).toContain('matches nothing')
      expect(code).toBe(1)
    })

    it('tolerates an exception for history only in the working-copy pass', () => {
      const dir = repo()
      commit(dir, { 'Cargo.lock': `${CRATE_LINE}\n` })
      commit(dir, {
        'Cargo.lock': 'name = "other"\n',
        'scripts/trace-sweep.allow': `Cargo.lock\t${CRATE_LINE}\n`,
      })
      expect(sweep(dir, 'tree').code).toBe(0)
      expect(sweep(dir).code).toBe(0)
    })
  })

  it('refuses to call a shallow clone clean', () => {
    const origin = repo()
    commit(origin, { 'build.sh': `cd ${WSL_PATH}\n` })
    commit(origin, { 'build.sh': 'cd .\n' })
    const dir = mkdtempSync(join(tmpdir(), 'sweep-shallow-'))
    repos.push(dir)
    git(tmpdir(), 'clone', '-q', '--depth', '1', `file://${origin.replaceAll('\\', '/')}`, dir)
    const { code, out } = sweep(dir, 'ci')
    expect(out).toContain('shallow')
    expect(code).toBe(2)
  })
})
