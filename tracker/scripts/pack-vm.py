import os, zipfile, fnmatch, re

SRC = 'tracker'
OUT = 'shopify-tracker-vm.zip'

# only what the VM's ingest needs — no deps, no db file, no secrets, no web assets
SKIP_DIRS  = {'node_modules', 'data', 'logs', 'secure', '.vercel', 'public'}
SKIP_FILES = {'.env', 'deploy.log', 'package-lock.json'}
SKIP_GLOB  = ['*.csv', '*.log', 'mycreds.txt', 'client_secrets.json',
              '*service*account*.json']

added = []
with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(SRC):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if f in SKIP_FILES or any(fnmatch.fnmatch(f, g) for g in SKIP_GLOB):
                continue
            full = os.path.join(root, f)
            rel = os.path.join('shopify-tracker', os.path.relpath(full, '.'))
            z.write(full, rel)
            added.append(rel.replace(os.sep, '/'))

print('  %s  -  %.0f KB,  %d files\n' % (OUT, os.path.getsize(OUT) / 1024, len(added)))
for a in sorted(added):
    print('   ', a)

bad = [a for a in added
       if re.search(r'\.env$|mycreds|client_secrets|\.csv$|service.*account', a, re.I)]
print('\n  sensitive files included:', bad if bad else 'none - clean')
