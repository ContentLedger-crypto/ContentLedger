#!/usr/bin/env bash
# Trace sweep — the precondition of the first push to a public repository.
#
# The question the script answers: is there anything left in the repository that
# describes **the author's machine** rather than the project — absolute local
# paths, user directories, keys and mnemonics.
#
# Invoke:
#   scripts/trace-sweep.sh          # the whole history — before a push
#   scripts/trace-sweep.sh tree     # only the working copy — fast, during work
#   scripts/trace-sweep.sh ci       # the whole history, but without the identities pass
#
# # Why over the history and not the working copy
#
# After a push the history is public as it is, and a line can be removed from it
# only by rewriting — i.e. by changing every hash in an already published repo.
# So the sweep goes over every revision, and not only over file contents: a trace
# hides just as well in a commit message and in the very path of a file that
# once existed and was deleted.
#
# # Why there is a self-check
#
# Empty output comes in two kinds: "there is nothing" and "the pattern does not work".
# From the outside they look the same, and the price of the second is a trace in
# the public history forever. So every pattern is first run against a sample that
# is OBLIGED to match; if even one does not, the script refuses to report "clean".
#
# # Why the personal-data list lives outside the repository
#
# A pattern that looks for the author's name contains that name itself. A script
# with such a line in a public repo would be exactly the trace it looks for. So the
# names are read from `.git/info/trace-identities` — one line per name, a file that
# is never committed. If it is missing, this pass is SKIPPED, and the script says so
# in a separate line of the summary: "clean" without such a line would mean checked,
# while it is unchecked.

set -uo pipefail

MODE="${1:-history}"
case "$MODE" in
  history | tree | ci) ;;
  *)
    echo "unknown mode: $MODE (history | tree | ci)" >&2
    exit 2
    ;;
esac

# The `ci` mode is `history` plus one concession: the identities list is not there
# and cannot be (it lives outside the repository on purpose), so its absence is
# the expected state, not an oversight. All structural patterns still run, and
# they are the ones that catch what most often ends up in a public repo: an
# absolute path from the machine it was built on.
CI=0
if [ "$MODE" = ci ]; then
  CI=1
  MODE=history
fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "not a git repository" >&2
  exit 2
}
cd "$ROOT" || exit 2

# The script itself is excluded from the check: by definition it contains everything
# it looks for, and without this every sweep would report its own patterns. The
# consequence to keep in mind: a real trace inside THIS file the sweep will not
# see, so edits here are read by eye.
readonly SELF='scripts/trace-sweep.sh'
readonly IDENTITIES='.git/info/trace-identities'

# Exceptions: `path<TAB>the whole line`, both exact. They exist for one case only — a
# line that is not a trace but matches a pattern and already sits in the published
# history, where no edit can reach it (a crate called `solana-seed-phrase` in
# Cargo.lock). A line in the working copy is fixed in the code, not listed here.
# Exactness is the point: the same text under another path, or the same line with
# anything appended, is reported as before. The file is excluded from the scan for
# the same reason as this script, and is read by eye for the same reason.
readonly ALLOW='scripts/trace-sweep.allow'

# The PEM header is glued from two parts on purpose: as a whole line it does not
# appear here, otherwise this file would itself fail the secrets checks — neither
# this one nor the one on pre-commit.
readonly PEM_A='BEGIN ([A-Z0-9]+ )*PRIV'
readonly PEM_B='ATE KEY'

REVS=''
if [ "$MODE" = history ]; then
  # A shallow clone (the default of actions/checkout) holds a single commit, and a
  # sweep over it would call the whole history clean having read none of it.
  if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
    echo "shallow clone: the history is not all here — fetch it in full (fetch-depth: 0)" >&2
    exit 2
  fi
  REVS="$(git rev-list --all)"
  if [ -z "$REVS" ]; then
    echo "the history has no commits at all" >&2
    exit 2
  fi
fi

found=0
broken=0
stale=0
skipped_identities=0

USED="$(mktemp)"
trap 'rm -f "$USED"' EXIT

# Drops content hits listed in $ALLOW and records which entries were used.
# A hit is `[<rev>:]<path>:<line number>:<text>`.
allowed() {
  if [ ! -s "$ALLOW" ]; then
    cat
    return
  fi
  awk -v allow="$ALLOW" -v used="$USED" -v history="$([ "$MODE" = history ] && echo 1)" '
    BEGIN {
      while ((getline entry < allow) > 0)
        if (entry != "" && substr(entry, 1, 1) != "#") listed[entry] = 1
    }
    {
      rest = $0
      if (history) rest = substr(rest, index(rest, ":") + 1)
      path = substr(rest, 1, index(rest, ":") - 1)
      rest = substr(rest, index(rest, ":") + 1)
      key = path "\t" substr(rest, index(rest, ":") + 1)
      if (key in listed) { print key >> used; next }
      print
    }'
}

# Three surfaces a trace hides on: contents, commit message, file path.
scan() {
  local re="$1"
  {
    if [ "$MODE" = tree ]; then
      git grep -nEI -i -e "$re" -- . ":(exclude)$SELF" ":(exclude)$ALLOW" | allowed
    else
      # $REVS deliberately unquoted: git grep expects revisions as separate arguments.
      # shellcheck disable=SC2086
      git grep -nEI -i -e "$re" $REVS -- . ":(exclude)$SELF" ":(exclude)$ALLOW" | allowed
      git log --all --format='message %h: %s %b' | grep -Ei -e "$re"
      git log --all --pretty=format: --name-only | sort -u | grep -Ei -e "$re" |
        sed 's/^/path in history: /'
    fi
  } 2>/dev/null | sort -u
}

# check <name> <regex> <sample that is obliged to match>
check() {
  local name="$1" re="$2" sample="$3" hits

  if ! printf '%s\n' "$sample" | grep -qEi -e "$re"; then
    printf '  ✗ SELF-CHECK: "%s" does not match its own sample — do not trust the output\n' "$name"
    broken=$((broken + 1))
    return
  fi

  hits="$(scan "$re")"
  if [ -n "$hits" ]; then
    printf '  ✗ %s\n' "$name"
    printf '%s\n' "$hits" | sed 's/^/        /'
    found=$((found + 1))
  else
    printf '  ✓ %s\n' "$name"
  fi
}

if [ "$MODE" = history ]; then
  printf '── trace sweep: whole history (%s commits) ──\n' "$(printf '%s\n' "$REVS" | wc -l | tr -d ' ')"
else
  printf '── trace sweep: working copy ──\n'
fi

# Absolute paths. The first pattern is the one the sweep already gave a false
# "clean" through: the form /mnt/<drive>/... has no colon, and a pattern written
# for a Windows path does not see it. Both forms are always checked.
check 'absolute WSL path' \
  '/mnt/[a-z]/' \
  '/mnt/e/proj/x'

# The `[a-zA-Z_.]` tail here is not cosmetic: without it the pattern would catch
# "https://" (letter, colon, slash) in every link. The `\b` in front is the
# second lesson: a drive letter is a single letter, and without the boundary the
# pattern fires on `you:\n` in every English string with an escaped newline.
check 'absolute Windows path' \
  '\b[a-z]:[\\/][a-zA-Z_.]' \
  'C:\Users\bob'

check 'user home directory' \
  '/home/[a-z][a-z0-9_.-]*/' \
  '/home/bob/proj'

check 'profile or temp directory' \
  'appdata|[\\/]temp[\\/]' \
  'AppData\Local'

check 'tooling directory outside the project' \
  '[\\/]?_(backups|keys|tools)[\\/]' \
  'x/_keys/y'

# Secrets. Keys and mnemonics are not "machine traces", but the pre-publication
# sweep is the only one, and splitting the two lists would mean one day running only one.
check 'private key (PEM)' \
  "${PEM_A}${PEM_B}" \
  "-----BEGIN RSA PRIV${PEM_B}-----"

check 'Solana key array' \
  '\[([0-9]{1,3}, ?){20}' \
  '[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21]'

check 'mnemonic' \
  'mnemonic|seed[ -]phrase' \
  'seed phrase'

# Personal data — the list outside the repository, see the header.
if [ -s "$IDENTITIES" ]; then
  # Line format: `regex` or `regex<TAB>sample`.
  #
  # The second column is needed exactly when the regex contains escaping: the sample
  # for `\.arena\.json` cannot be the regex itself — backslashes in the sample text
  # do not match, and the self-check honestly fails. That is not nitpicking: it is
  # exactly how it should behave, because a pattern that catches nothing and a
  # pattern that catches the wrong thing look the same from the outside.
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    re="${line%%	*}"
    sample="${line#*	}"
    [ "$sample" = "$line" ] && sample="sample ${re} sample"
    check "personal data: $re" "$re" "$sample"
  done <"$IDENTITIES"
else
  skipped_identities=1
fi

# Only the history pass can call an exception stale: the working copy legitimately
# lacks lines that the published history still has.
if [ "$MODE" = history ] && [ -s "$ALLOW" ]; then
  while IFS= read -r entry || [ -n "$entry" ]; do
    case "$entry" in '' | '#'*) continue ;; esac
    if ! grep -qxF -e "$entry" "$USED"; then
      printf '  ✗ exception matches nothing in the history: %s\n' "$entry"
      stale=$((stale + 1))
    fi
  done <"$ALLOW"
fi

echo
if [ "$broken" -gt 0 ]; then
  printf '✗ SELF-CHECK FAILED (%s patterns) — the sweep did not happen.\n' "$broken"
  exit 2
fi
if [ "$found" -gt 0 ]; then
  printf '✗ traces found: %s. Do not push.\n' "$found"
  printf '  Until the push is made, a trace is removed by rewriting the history;\n'
  printf '  after the push it stays in the public repo forever.\n'
  exit 1
fi
if [ "$stale" -gt 0 ]; then
  printf '✗ stale exceptions: %s. Remove them from %s.\n' "$stale" "$ALLOW"
  exit 1
fi
if [ "$skipped_identities" -eq 1 ]; then
  printf '✓ structural patterns are clean.\n'
  printf '! the personal-data pass did not run — no %s.\n' "$IDENTITIES"
  if [ "$CI" -eq 1 ]; then
    printf '  In CI this file never exists — it lives outside the repository on purpose.\n'
    exit 0
  fi
  printf '  This is not "clean", this is "unchecked". Create the file: one regex per line.\n'
  exit 1
fi
printf '✓ clean: no traces found, self-check passed.\n'
