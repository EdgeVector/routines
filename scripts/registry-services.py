#!/usr/bin/env python3
"""Drain active routines and reload only already loaded services onto registry source."""
import json
import os
from pathlib import Path
import plistlib
import subprocess
import time
import sys


def run(args, check=True):
    return subprocess.run(args, capture_output=True, check=check, timeout=45)


def main():
    if sys.platform != "darwin":
        return
    home = Path.home()
    root = Path(os.environ.get('LASTDB_APPS_ROOT', home / '.local/share/lastdb-apps'))
    command = str(root / 'routines/current/source/bin/registry-routines')
    domain = f'gui/{os.getuid()}'
    labels = ['com.edgevector.routinesd', 'com.edgevector.routines-web',
              'com.edgevector.routines-freeze-watch', 'com.edgevector.routines-hygiene']
    loaded = [label for label in labels if run(['launchctl', 'print', domain + '/' + label], False).returncode == 0]
    if not loaded:
        print('No existing Routines services to reload')
        return
    deadline = time.monotonic() + 480
    while 'com.edgevector.routinesd' in loaded:
        status = json.loads(run([command, 'status', '--json']).stdout)
        if 'rows' not in status or not isinstance(status['rows'], list):
            raise RuntimeError('Routines in-flight state unavailable; refusing restart')
        active = [row for row in status['rows'] if row.get('running') is True]
        if not active:
            break
        if time.monotonic() > deadline:
            raise RuntimeError('Routines still has active work; defer registry activation')
        time.sleep(10)
    originals = {}
    try:
        for label in loaded:
            path = home / 'Library/LaunchAgents' / (label + '.plist')
            originals[label] = (path, path.read_bytes())
            plist = plistlib.loads(originals[label][1])
            env = plist.setdefault('EnvironmentVariables', {})
            if 'LAST_STACK_APPS_OFF' in os.environ:
                env['LAST_STACK_APPS_OFF'] = os.environ['LAST_STACK_APPS_OFF']
            if label.endswith('routinesd'):
                args = ['daemon', '--stagger-ms', env.get('ROUTINES_STAGGER_MS', '60000')]
            elif label.endswith('routines-web'):
                args = ['web', '--port', env.get('ROUTINES_WEB_PORT', '4778'), '--host', env.get('ROUTINES_WEB_HOST', '127.0.0.1')]
            elif label.endswith('routines-hygiene'):
                args = ['hygiene', '--json', '--ff-install']
            else:
                old = plist['ProgramArguments']
                index = old.index('freeze-watch')
                args = old[index:]
            plist['ProgramArguments'] = [command, *args]
            run(['launchctl', 'bootout', domain + '/' + label])
            path.write_bytes(plistlib.dumps(plist))
            run(['launchctl', 'bootstrap', domain, str(path)])
            run(['launchctl', 'print', domain + '/' + label])
            print('Reloaded registry service', label)
    except Exception:
        for label, (path, data) in originals.items():
            run(['launchctl', 'bootout', domain + '/' + label], False)
            path.write_bytes(data)
            run(['launchctl', 'bootstrap', domain, str(path)], False)
        raise


if __name__ == '__main__':
    main()
