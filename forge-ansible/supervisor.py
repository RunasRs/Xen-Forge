import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

WORK_DIR = Path(os.environ.get('WORK_DIR', '/data/ansible-work'))
POLL_SECONDS = 0.5
CANCEL_GRACE_SECONDS = int(os.environ.get('CANCEL_GRACE_SECONDS', '30'))
STOP_GRACE_SECONDS = 10
JOB_ID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
IDENT = 'run'
ALIVE_FILE = WORK_DIR / '.supervisor-alive'
ALIVE_SECONDS = 10

running = {}
stopping = False


def say(message):
    print(message, flush=True)


def work_dirs():
    try:
        entries = list(WORK_DIR.iterdir())
    except FileNotFoundError:
        return []
    return [d for d in entries if JOB_ID.match(d.name) and d.is_dir() and not d.is_symlink()]


def write_json(path, data):
    tmp = path.with_name(f'.{path.name}.tmp')
    tmp.write_text(json.dumps(data))
    os.replace(tmp, path)


def job_id(work):
    return work.name


def kill(proc, sig):
    try:
        os.killpg(proc.pid, sig)
    except ProcessLookupError:
        pass


def recover():
    for work in work_dirs():
        if (work / 'started').exists() and not (work / 'result.json').exists():
            write_json(work / 'result.json', {
                'rc': 1, 'status': 'failed', 'error': 'Exécution interrompue : forge-ansible a redémarré pendant le job'})
            say(f'job {job_id(work)} : interrompu par un redémarrage, marqué en échec')


def start(work):
    (work / 'started').write_text(str(time.time()))
    with open(work / 'runner.err', 'w') as err:
        proc = subprocess.Popen(
            ['ansible-runner', 'run', str(work), '-p', 'playbook.yml', '--ident', IDENT],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=err, cwd=work, start_new_session=True)
    running[work] = {'proc': proc, 'signaled': None}
    say(f'job {job_id(work)} : démarré')


def runner_status(work):
    try:
        return (work / 'artifacts' / IDENT / 'status').read_text().strip()
    except OSError:
        return ''


def close_masters(work):
    try:
        sockets = [p for p in (work / 'cp').iterdir() if p.is_socket()]
    except OSError:
        return
    for sock in sockets:
        try:
            subprocess.run(['ssh', '-o', f'ControlPath={sock}', '-O', 'exit', 'forge'],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False)
        except subprocess.TimeoutExpired:
            say(f'job {job_id(work)} : fermeture de la connexion SSH maîtresse expirée')


def finish(work, proc, error=None):
    del running[work]
    close_masters(work)
    if not work.exists():
        say(f'job {job_id(work)} : dossier retiré par Forge')
        return
    status = runner_status(work) or ('canceled' if (work / 'cancel').exists() else 'failed')
    result = {'rc': proc.returncode, 'status': status}
    if error:
        result['error'] = error
    write_json(work / 'result.json', result)
    say(f'job {job_id(work)} : terminé ({status}, code {proc.returncode})')


def watch(work, job):
    proc = job['proc']
    if proc.poll() is not None:
        finish(work, proc)
        return
    if not work.exists():
        kill(proc, signal.SIGKILL)
        return
    if (work / 'cancel').exists():
        if job['signaled'] is None:
            kill(proc, signal.SIGINT)
            job['signaled'] = time.time()
            say(f'job {job_id(work)} : annulation demandée')
        elif time.time() - job['signaled'] > CANCEL_GRACE_SECONDS:
            kill(proc, signal.SIGKILL)


def stop(_signum, _frame):
    global stopping
    stopping = True


def shutdown():
    for job in running.values():
        kill(job['proc'], signal.SIGINT)
    deadline = time.time() + STOP_GRACE_SECONDS
    while running and time.time() < deadline:
        for work, job in list(running.items()):
            if job['proc'].poll() is not None:
                finish(work, job['proc'], 'Exécution interrompue : arrêt de forge-ansible')
        time.sleep(POLL_SECONDS)
    for work, job in list(running.items()):
        kill(job['proc'], signal.SIGKILL)
        job['proc'].wait()
        finish(work, job['proc'], 'Exécution interrompue : arrêt de forge-ansible')


def main():
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    recover()
    alive_at = 0
    while not stopping:
        if time.time() - alive_at >= ALIVE_SECONDS:
            write_json(ALIVE_FILE, {'at': time.time(), 'running': len(running)})
            alive_at = time.time()
        for work, job in list(running.items()):
            watch(work, job)
        for work in work_dirs():
            if running:
                break
            if work in running or not (work / 'ready').exists() or (work / 'started').exists():
                continue
            try:
                start(work)
            except OSError as e:
                write_json(work / 'result.json', {'rc': 1, 'status': 'failed', 'error': f'Lancement impossible : {e}'})
        time.sleep(POLL_SECONDS)
    shutdown()
    return 0


if __name__ == '__main__':
    sys.exit(main())
