const RESULTS = 'tests/e2e/results/'

/**
 * Files that differ from HEAD, read from `git status --porcelain=v1 -z`. A result names the
 * commit it was built on; with any of these present, that commit is not the code that ran.
 */
export function uncommitted(porcelain: string): string[] {
  const entries = porcelain.split('\0').filter((entry) => entry.length > 0)
  const paths: string[] = []
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] as string
    paths.push(entry.slice(3))
    // A rename or copy is followed by its source path, which is no entry of its own.
    if (entry[0] === 'R' || entry[0] === 'C') i += 1
  }
  return paths.filter((path) => !path.startsWith(RESULTS))
}
