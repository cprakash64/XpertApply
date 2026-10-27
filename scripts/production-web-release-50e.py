#!/usr/bin/env python3
"""Stage 50E: web-only PRODUCTION release of the Tracker-download candidate (cb76c3d).

Uses the protected NAV02 cutover controls (corrected API release override + Redis preserve file),
never the checkout's stale compose.nav02-api.release.yml. Recreates ONLY xpertapply-web-1.
Prints no environment values except public NEXT_PUBLIC_* settings.

  sudo -v
  sudo -n python3 production-web-release-50e.py plan                                   # read-only preflight + dry run
  sudo -n python3 production-web-release-50e.py apply --approve-production-web-release  # deploy (separate approval)
  sudo -n python3 production-web-release-50e.py rollback --approve-production-web-release
"""
import json
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path('/home/xpertapply/apps/production')
CONTROLS = Path('/home/luna/xpertapply-production-backups/nav02-final-20261026T101651Z-nvrya78c/controls')
BASE_FILES = ('docker-compose.yml', 'compose.production.yml', 'compose.redis-preserve.yml')
HERE = Path(__file__).resolve().parent
WEB = 'xpertapply-web-1'
API = 'xpertapply-api-1'
PROD_DB = 'xpertapply-postgres-1'
NEW_TAG, NEW_ID = 'xpertapply-web:stage50d-cb76c3d-prod', 'sha256:3c1639711470ed4ab00899e3fa8e44e98d1e5a786d2b640ea8a239c0fdb315a8'
OLD_TAG, OLD_ID = 'xpertapply-web:rollback-pre-50d', 'sha256:6b299869db426912c3017ee13a9afd7c720c73598b96a67581944ab858a5546a'
API_TAG, API_ID = 'xpertapply-api:nav02-gated-1516f23', 'sha256:436c05e7dff8eebf2edefef402d3194046050c4cffd5fbbb58e0ca679746b020'
REVISION = 'cb76c3d159519d20d7c5db13f5b727b42eab5187'
SCHEMA = '0036_application_doc_snapshots'
PUBLIC = {'NEXT_PUBLIC_API_URL': 'https://api.xpertapply.com', 'NEXT_PUBLIC_SITE_URL': 'https://xpertapply.com',
          'NEXT_PUBLIC_CHROME_EXTENSION_URL': '', 'NEXT_PUBLIC_CHROME_EXTENSION_ID': 'gnibjomjfdobadlockphjiibbpmiehcj'}
WATCH = (WEB, API, 'xpertapply-worker-1', 'xpertapply-scheduler-1', PROD_DB, 'xpertapply-redis-1',
         'xpertapply-staging-web', 'xpertapply-staging-api', 'xpertapply-staging-postgres', 'xpertapply-staging-redis')
SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
UP = ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'web']


class Blocked(Exception):
    pass


def require(cond, msg):
    if not cond:
        raise Blocked(msg)


def run(args, env=None, timeout=120):
    r = subprocess.run(args, cwd=str(ROOT), env=env or {'PATH': SAFE_PATH, 'HOME': '/root'},
                       capture_output=True, text=True, timeout=timeout, check=False)
    require(r.returncode == 0, 'command exited %d: %s (raw output withheld)' % (r.returncode, ' '.join(args[:3])))
    return r.stdout, r.stderr


def inspect(name):
    return json.loads(run(['docker', 'inspect', name])[0])[0]


def env_map(obj):
    return dict(e.split('=', 1) for e in obj['Config']['Env'])


def image_id(tag):
    return run(['docker', 'image', 'inspect', '-f', '{{.Id}}', tag])[0].strip()


def snapshot():
    return {n: (inspect(n)['Id'], inspect(n)['Image']) for n in WATCH}


def parse_actions(output, require_recreate):
    pat = re.compile(r'\b(Container|Network|Volume)\s+([A-Za-z0-9_.-]+)\s+([A-Za-z][A-Za-z_-]*)\b')
    acts = []
    for line in output.splitlines():
        if not re.search(r'\b(Container|Network|Volume)\b', line):
            continue
        m = pat.findall(line)
        require(m, 'unrecognized dry-run resource line')
        for kind, name, action in m:
            require(kind == 'Container' and (name == WEB or re.fullmatch(r'[0-9a-f]{12}_' + WEB, name)),
                    'dry run touches a non-web resource: %s %s' % (kind, name))
            acts.append((name, action))
    require(acts, 'dry run returned no recognized actions')
    if require_recreate:
        require(any(n == WEB and a.lower() == 'recreate' for n, a in acts), 'web recreation not proposed')
    return acts


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'plan'
    require(mode in ('plan', 'apply', 'rollback'), 'usage: plan | apply|rollback --approve-production-web-release')
    if mode != 'plan':
        require('--approve-production-web-release' in sys.argv, 'apply/rollback need --approve-production-web-release')
    require(subprocess.run(['id', '-u'], capture_output=True, text=True).stdout.strip() == '0', 'run with sudo')
    require(socket.gethostname() == 'srv738314', 'unexpected host')
    for f in BASE_FILES:
        require((ROOT / f).is_file(), 'missing ' + f)
    require((CONTROLS / 'release.yml').is_file(), 'NAV02 controls/release.yml missing')

    print('== 1. images and live production state')
    require(image_id(NEW_TAG) == NEW_ID, 'candidate image id mismatch')
    require(image_id(OLD_TAG) == OLD_ID, 'rollback image id mismatch')
    new = json.loads(run(['docker', 'image', 'inspect', NEW_TAG])[0])[0]
    require(new['Config']['Labels'].get('org.opencontainers.image.revision') == REVISION, 'candidate revision label')
    require({k: v for k, v in env_map(new).items() if k in PUBLIC} == PUBLIC, 'candidate NEXT_PUBLIC_* differ')
    web, api = inspect(WEB), inspect(API)
    expect_web = OLD_ID if mode in ('plan', 'apply') else NEW_ID
    require(web['Image'] == expect_web, 'production web is not on the expected image')
    require(api['Image'] == API_ID, 'production API is not the NAV02 image')
    require(api['State'].get('Health', {}).get('Status') == 'healthy', 'production API unhealthy')
    live_api = env_map(api)
    require(str(live_api.get('APPLICATION_ANSWER_DRAFTING_ENABLED', 'false')).lower() in ('', '0', 'false', 'no', 'off'),
            'AI answer drafting is enabled')
    pg = env_map(inspect(PROD_DB))
    rev = run(['docker', 'exec', PROD_DB, 'psql', '-U', pg['POSTGRES_USER'], '-d', pg['POSTGRES_DB'], '-tAc',
               'select version_num from alembic_version'])[0].strip()
    require(rev == SCHEMA, 'production schema is not ' + SCHEMA)
    print('PASS: candidate %s, rollback %s, web on %s, API NAV02 healthy, drafting off, schema %s'
          % (NEW_ID[:19], OLD_ID[:19], expect_web[:19], rev))

    print('== 2. effective Compose config (NAV02 controls; clean environment)')
    db_url = live_api.get('DATABASE_URL')
    require(db_url, 'live API DATABASE_URL missing')
    cenv = {'PATH': SAFE_PATH, 'HOME': '/root', 'NAV02_PROD_DATABASE_URL': db_url}  # env -i: no /etc/environment leakage
    base = ['docker', 'compose', '--ansi', 'never', '-p', 'xpertapply', '--project-directory', str(ROOT)]
    for f in BASE_FILES:
        base += ['-f', str(ROOT / f)]
    base += ['-f', str(CONTROLS / 'release.yml')]
    for name, tag in (('production-web.release.yml', NEW_TAG), ('production-web.rollback.yml', OLD_TAG)):
        (HERE / name).write_text('services:\n  web:\n    image: %s\n' % tag)
    rel, rbk = HERE / 'production-web.release.yml', HERE / 'production-web.rollback.yml'
    cfg = lambda extra: json.loads(run(base + extra + ['config', '--format', 'json'], env=cenv)[0])
    c0, c1, c2 = cfg([]), cfg(['-f', str(rel)]), cfg(['-f', str(rbk)])
    a = c0['services']['api']
    require(a.get('image') == API_TAG, 'controls API image is not ' + API_TAG)
    aenv = a.get('environment') or {}
    drift = sorted(k for k, v in aenv.items() if live_api.get(k) != v)
    require(not drift, 'controls API config drifts from live API: ' + ','.join(drift))
    for c in (c1, c2):
        x, y = json.loads(json.dumps(c0)), json.loads(json.dumps(c))
        x['services']['web'].pop('image', None), y['services']['web'].pop('image', None)
        require(x == y, 'effective config differs beyond services.web.image')
    w = c1['services']['web']
    require(w['image'] == NEW_TAG, 'release web image not applied')
    live_web = env_map(web)
    wenv = w.get('environment') or {}
    wdrift = sorted(k for k, v in wenv.items() if live_web.get(k) != v)
    require(not wdrift, 'web runtime env differs from live web: ' + ','.join(wdrift))
    require({k: v for k, v in wenv.items() if k in PUBLIC} == {k: PUBLIC[k] for k in wenv if k in PUBLIC},
            'web NEXT_PUBLIC_* runtime values are not production values')
    ports = [(p.get('host_ip'), str(p.get('published')), p.get('target')) for p in w.get('ports', [])]
    require(ports == [('127.0.0.1', '3000', 3000)], 'web ports differ: %r' % ports)
    require(w.get('restart') == 'unless-stopped', 'web restart policy differs')
    require(web['HostConfig']['PortBindings'] == {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3000'}]}, 'live web ports')
    print('PASS: config identical except web.image; API controls match live API; web env/ports/restart match live web')
    print('      public web env:', json.dumps({k: wenv[k] for k in sorted(wenv) if k.startswith('NEXT_PUBLIC_')}))

    print('== 3. dry runs')
    out, err = run(base + ['--dry-run', 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'api'], env=cenv)
    require(not re.search(r'\bRecreat', out + err), 'controls would recreate the API - STOP')
    print('PASS: API is current under the NAV02 controls (no API recreation)')
    target = rel if mode in ('plan', 'apply') else rbk
    for label, f, need in (('release', rel, mode != 'rollback'), ('rollback', rbk, mode == 'rollback')):
        out, err = run(base + ['-f', str(f), '--dry-run'] + UP, env=cenv)
        for n, act in parse_actions(out + '\n' + err, need):
            print('DRY_RUN[%s]=%s|%s' % (label, n, act))
    before = snapshot()
    if mode == 'plan':
        require(snapshot() == before, 'containers changed during preflight')
        print('PLAN PASS: only %s would be recreated (%s). Nothing was changed.' % (WEB, NEW_TAG))
        return

    print('== 4. %s' % mode.upper())
    run(base + ['-f', str(target)] + UP, env=cenv, timeout=240)
    want = NEW_ID if mode == 'apply' else OLD_ID
    after = snapshot()
    require(after[WEB][1] == want, 'web not on target image')
    require({k: v for k, v in after.items() if k != WEB} == {k: v for k, v in before.items() if k != WEB},
            'a non-web container changed')
    ok = False
    for _ in range(60):
        r = subprocess.run(['curl', '-s', '-o', '/dev/null', '-D', '-', '-w', '%{http_code}', 'http://127.0.0.1:3000/'],
                           capture_output=True, text=True)
        if r.stdout.endswith('200') and 'content-security-policy-report-only' in r.stdout.lower():
            ok = True
            break
        time.sleep(2)
    require(ok, 'web did not return 200 with CSP report-only - run rollback')
    print('%s PASS: %s on %s; all other containers unchanged; HTTP 200 + CSP report-only' % (mode.upper(), WEB, want[:19]))


if __name__ == '__main__':
    try:
        main()
    except Blocked as e:
        print('BLOCKED:', e)
        sys.exit(2)
