#!/usr/bin/env python3
"""Check a git ref, or the working tree, for planted code.

Written after 11 Sep 2026, when a commit was rewritten and force-pushed with an
auto-running payload in it. Every check here is one that would have caught that
commit, and the order is by how well each one worked.

    python tracker/scripts/repo-scan.py                 # working tree + HEAD
    python tracker/scripts/repo-scan.py --ref origin/main
    python tracker/scripts/repo-scan.py --remote origin  # fetch first, then scan
    python tracker/scripts/repo-scan.py --history        # every blob ever committed

Exits 1 if anything is flagged, so it can gate a script or a CI step.

A finding is not proof. It is a file worth opening before trusting the ref.
"""
import argparse
import re
import subprocess
import sys

# Where this project's files legitimately live. Anything at the top level that
# is not one of these is worth a look - the payload arrived as ".vscode/" and
# "public/", neither of which this repo has ever had.
EXPECTED_TOP = {
    '.gitignore', '.gitattributes', '.vercelignore', 'README.md',
    'tracker', 'UiPath_Side_Scraping',
}

BINARY_EXT = ('.woff2', '.woff', '.ttf', '.eot', '.otf', '.png', '.jpg',
              '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.gz', '.mp4', '.webp')

# The single check that caught it: a file claiming to be a font, holding text.
# Everything else here is a second opinion.
PATTERNS = [
    (rb'"?runOn"?\s*:\s*"?folderOpen',      'a task set to run when the folder is opened'),
    (rb'allowAutomaticTasks"?\s*:\s*"?(on|true)', 'automatic tasks turned on'),
    (rb'eth_getBlockByNumber|eth_getTransactionCount', 'ethereum rpc calls'),
    (rb'blockscout|drpc\.org|publicnode\.com|blastapi\.io', 'a blockchain host used for command and control'),
    (rb'[xX]-[pP]ayload-[bB]64',            'the payload header this family uses'),
    (rb'child_process[\s\S]{0,300}detached\s*:\s*(!!\[\]|true)', 'a detached child process'),
    (rb'eval\s*\(\s*atob|Function\s*\(\s*atob|eval\(Buffer\.from', 'eval of decoded data'),
    (rb'(curl|wget)[^|\n]{0,100}\|\s*(ba)?sh', 'a download piped straight into a shell'),
    (rb'temp_auto_push|temp_interactive_push|branch_structure\.json', 'names this attacker leaves behind'),
    (rb'0xa322E5f3D311D3080e6f0121063e9aDC2490Ef1a', 'the wallet the 11 Sep payload watched'),
]


def git(*args, binary=False):
    r = subprocess.run(('git',) + args, capture_output=True)
    if r.returncode:
        raise SystemExit('git %s failed: %s' % (' '.join(args), r.stderr.decode('utf-8', 'replace').strip()))
    return r.stdout if binary else r.stdout.decode('utf-8', 'replace')


def looks_textual(data):
    head = data[:512]
    return bool(head) and all(9 <= b < 127 or b in (10, 13) for b in head)


# This file has to contain the very strings it searches for, and the deploy
# notes have to quote them to explain the attack. Both would be flagged every
# run, and a scanner that always cries wolf is one nobody reads - which is the
# failure this whole thing exists to avoid.
#
# The exclusion is narrow and it is announced. Markdown is skipped only for the
# content patterns: nothing here executes a .md, and the two structural tests -
# a new top-level entry, a binary file holding text - still apply to every file
# whatever it is called.
SELF = 'tracker/scripts/repo-scan.py'


def check(path, data, findings, skipped):
    low = path.lower()

    if low.endswith(BINARY_EXT) and len(data) > 200 and looks_textual(data):
        findings.append((path, 'claims to be binary (%s) but holds text' % low.rsplit('.', 1)[-1]))
        return  # this alone is enough; no need to also pattern-match it

    if b'\x00' in data[:4096]:
        return  # genuinely binary, the text patterns below cannot apply

    if path == SELF or low.endswith('.md'):
        skipped.add(path)
        return

    for pat, why in PATTERNS:
        if re.search(pat, data, re.I):
            findings.append((path, why))


def blobs_of(ref, whole_history):
    """Yield (path, bytes) for a ref - its tree, or everything ever in it."""
    if whole_history:
        listing = git('rev-list', '--objects', ref)
    else:
        listing = git('ls-tree', '-r', '--format=%(objectname) %(path)', ref)

    seen, want = set(), []
    for line in listing.splitlines():
        sha, _, path = line.partition(' ')
        if not path or sha in seen:
            continue
        seen.add(sha)
        want.append((sha, path))

    # Everything is handed to one `git cat-file --batch` up front and the reply
    # is read as one stream. The obvious version - write a sha, flush, read the
    # answer, repeat - spends its whole life in syscalls: with bufsize=0 on
    # Windows the header alone is read a byte at a time, and a thousand objects
    # took longer than anyone would wait. A scanner nobody runs is no scanner.
    p = subprocess.Popen(['git', 'cat-file', '--batch'],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    NL = b'\n'
    out, _ = p.communicate(NL.join(sha.encode() for sha, _ in want) + NL)

    by_sha = dict(want)
    i = 0
    while i < len(out):
        nl = out.find(NL, i)
        if nl < 0:
            break
        bits = out[i:nl].decode('utf-8', 'replace').split()
        i = nl + 1
        if len(bits) < 3 or bits[1] != 'blob':
            continue                      # "<sha> missing", or a tree/commit
        sha, size = bits[0], int(bits[2])
        data = out[i:i + size]
        i += size + 1                     # the object, then its trailing newline
        if size <= 3_000_000:
            yield by_sha.get(sha, sha), data


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--ref', default='HEAD', help='ref to scan (default HEAD)')
    ap.add_argument('--remote', help='fetch this remote first, then scan what came back')
    ap.add_argument('--history', action='store_true',
                    help='scan every blob ever committed, not just the current tree')
    args = ap.parse_args()

    ref = args.ref
    if args.remote:
        print('fetching %s ...' % args.remote)
        git('fetch', args.remote, 'main')
        ref = 'FETCH_HEAD'

    findings = []

    top = {ln.split('\t')[-1].rstrip('/') for ln in git('ls-tree', '--name-only', ref).splitlines()}
    for name in sorted(top - EXPECTED_TOP):
        findings.append((name + '/', 'a top-level entry this project has never had'))

    n = 0
    skipped = set()
    for path, data in blobs_of(ref, args.history):
        n += 1
        check(path, data, findings, skipped)

    print('scanned %d blobs in %s%s' % (n, ref, ' (whole history)' if args.history else ''))
    if skipped:
        print('%d file(s) exempt from the content patterns (this scanner, and prose that '
              'quotes them) - the structural tests still applied to them' % len(skipped))

    if not findings:
        print('nothing flagged')
        return 0

    print('\n%d finding(s) - open each of these before trusting this ref:\n' % len(findings))
    for path, why in sorted(set(findings)):
        print('  %-52s %s' % (path, why))
    return 1


if __name__ == '__main__':
    sys.exit(main())
