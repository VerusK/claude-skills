#!/usr/bin/env python3
"""Private state, bounded transport and per-target coverage for read-only observers."""
import argparse
import copy
import datetime as dt
import fcntl
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


class SafeError(Exception):
    """A fixed error code, never remote text or credentials."""


class TransportError(SafeError):
    """Connection or end-to-end transport timeout, safe to retry on GET."""


class ResponseError(SafeError):
    """Rejected status, redirect, size or malformed response; never retry."""


def utc():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def epoch(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def timestamp(value):
    return dt.datetime.fromtimestamp(value, dt.timezone.utc).isoformat().replace('+00:00', 'Z')


def remaining(deadline):
    value = deadline - time.monotonic()
    if value <= 0:
        raise SafeError('Deadline')
    return min(30, value)


def positive(value, maximum=100000):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 < value <= maximum:
        raise SafeError('ConfigNumber')
    return value


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', value):
        raise SafeError('ConfigIdentifier')
    return value


def validate_url(value):
    if not isinstance(value, str):
        raise SafeError('ConfigURL')
    parsed = urllib.parse.urlsplit(value)
    if parsed.username or parsed.password or not parsed.hostname or parsed.fragment:
        raise SafeError('ConfigURL')
    if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', '::1', 'localhost')):
        raise SafeError('ConfigURL')
    return value


def argv(value):
    if not isinstance(value, list) or not value or len(value) > 64 or any(not isinstance(s, str) or not s or '\x00' in s for s in value):
        raise SafeError('ConfigArgv')
    return value


def load_config(path):
    try:
        c = json.loads(Path(path).read_text())
        if not isinstance(c, dict) or not isinstance(c.get('project'), str) or not c['project']:
            raise SafeError('ConfigProject')
        for name in ('poll', 'credentials', 'cloudflare', 'elastic', 'sentry', 'accounts', 'authority', 'hooks'):
            if not isinstance(c.setdefault(name, {}), dict):
                raise SafeError('ConfigSection')
        defaults = dict(interval=300, window=600, deadline=240, max_pages=3, page_size=100, max_new_pages=3, revisit_limit=100, reconcile_pages=1, max_response_bytes=8388608, cf_limit=10000, es_limit=2000)
        limits = dict(interval=86400, window=86400, deadline=240, max_pages=100, page_size=100, max_new_pages=3, revisit_limit=100, reconcile_pages=3, max_response_bytes=8388608, cf_limit=10000, es_limit=10000)
        for k, v in defaults.items():
            c['poll'].setdefault(k, v)
            positive(c['poll'][k], limits[k])
            if k not in ('interval', 'window', 'deadline') and not isinstance(c['poll'][k], int):
                raise SafeError('ConfigInteger')
        for entry in c['credentials'].values():
            if not isinstance(entry, dict) or not re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', entry.get('env', '')) or set(entry) - {'env', 'store_entry', 'store_key'}:
                raise SafeError('ConfigCredential')
            if any(not isinstance(v, str) for v in entry.values()):
                raise SafeError('ConfigCredential')
        cf = c['cloudflare']
        if 'url' in cf: validate_url(cf['url'])
        for key in ('exempt_egress', 'owner_egress'):
            if not isinstance(cf.setdefault(key, []), list): raise SafeError('ConfigNetwork')
            for network in cf[key]: ipaddress.ip_network(network, strict=False)
        if not isinstance(cf.setdefault('zones', {}), dict): raise SafeError('ConfigZones')
        for name, zone in cf['zones'].items():
            if not isinstance(name, str) or not isinstance(zone, dict) or not isinstance(zone.get('hosts'), list) or not zone['hosts'] or any(not isinstance(h, str) or not re.fullmatch(r'[A-Za-z0-9.*-]+', h) for h in zone['hosts']): raise SafeError('ConfigZone')
            if not isinstance(zone.get('id'), str) or not zone['id']: raise SafeError('UnconfiguredZone')
            ids = zone.get('rule_ids', [])
            if not isinstance(ids, list) or any(not isinstance(v, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', v) for v in ids) or len(set(ids)) != len(ids): raise SafeError('ConfigRule')
        signals = cf.setdefault('signals', {})
        if not isinstance(signals, dict): raise SafeError('ConfigSignals')
        for k in ('scanner_pattern','bad_pattern','auth_pattern'):
            if k in signals: re.compile(signals[k], re.I)
        for k in ('scanner_threshold','bad_threshold','paths_threshold','fourxx_threshold','origin_threshold','auth_wave_threshold'):
            if k in signals: positive(signals[k])
        for k in ('public_paths','session_paths'):
            if k in signals and (not isinstance(signals[k], list) or any(not isinstance(p,str) or not p.startswith('/') for p in signals[k])): raise SafeError('ConfigPaths')
        for section in (c['elastic'], c['sentry'], c['accounts'].get('ch', {})):
            if section and not isinstance(section, dict): raise SafeError('ConfigSection')
            if 'url' in section: validate_url(section['url'])
        es = c['elastic']
        if 'password_env' in es: identifier(es['password_env'])
        for idx in es.get('indexes', {}).values():
            if not isinstance(idx, str) or not re.fullmatch(r'[A-Za-z0-9_.*-]+', idx): raise SafeError('ConfigIndex')
        sentry = c['sentry']
        for slug in [sentry.get('org', 'org')] + sentry.get('projects', []):
            if not isinstance(slug, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', slug): raise SafeError('ConfigSlug')
        a = c['accounts']
        if a:
            if type(a.get('initial_cursor')) is not int or not 0 <= a['initial_cursor'] < 2**63: raise SafeError('InitialCursorRequired')
            if a.setdefault('revisit_seconds',86400) != 86400: raise SafeError('RevisitHorizon')
            for name in a.get('tables', {}).values(): identifier(name)
            if a.get('pg'):
                argv(a['pg']['argv'])
                if any(s.startswith('--pset') or s in ('-c','-t','-A','-F') for s in a['pg']['argv']): raise SafeError('PsqlFlags')
                for key in ('resource','user','db'): identifier(a['pg'][key]) if key != 'resource' else None
            if 'db' in a.get('ch', {}): identifier(a['ch']['db'])
        for hook in c['hooks'].values(): argv(hook)
        targets = len(cf['zones']) + len(sentry.get('projects', [])) + (4 if es else 0) + bool(a)
        if targets > 32: raise SafeError('TargetCap')
        return c
    except SafeError:
        raise
    except Exception:
        raise SafeError('ConfigInvalid') from None


def credential(config, source):
    entry = config.get('credentials', {}).get(source)
    if not entry:
        raise SafeError('CredentialMissing')
    value = os.environ.get(entry['env'])
    if not value: raise SafeError('CredentialMissing')
    return value


def _http_worker():
    """Only child process touches the socket. Parent cancels connect, redirects AND body."""
    try:
        args = json.load(sys.stdin)
        body = args['body']
        if body is not None:
            body = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        headers = args['headers'] or {}
        if body is not None: headers.setdefault('Content-Type', 'application/json')
        # Redirects may cross authority boundaries: never forward Authorization to another host.
        class Redirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, hdrs, newurl):
                if urllib.parse.urlsplit(req.full_url).netloc != urllib.parse.urlsplit(newurl).netloc:
                    raise SafeError('RedirectAuthority')
                validate_url(newurl)
                return super().redirect_request(req, fp, code, msg, hdrs, newurl)
        req = urllib.request.Request(args['url'], data=body, headers=headers, method=args['method'])
        opener = urllib.request.build_opener(Redirect())
        with opener.open(req, timeout=args['timeout']) as response:
            raw = response.read(args['max_response_bytes'] + 1)
            if len(raw) > args['max_response_bytes']: raise SafeError('ResponseLimit')
            result = json.loads(raw)
            print(json.dumps({'body': result, 'headers': dict(response.headers)}))
    except urllib.error.HTTPError:
        print('{"error":"response"}')
    except (urllib.error.URLError, OSError):
        print('{"error":"transport"}')
    except Exception:
        print('{"error":"response"}')


def request_json(method, url, headers=None, body=None, timeout=30, *, with_headers=False, max_response_bytes=8388608):
    validate_url(url)
    positive(timeout, 30); positive(max_response_bytes, 8388608)
    args = dict(method=method, url=url, headers=headers, body=body, timeout=timeout, max_response_bytes=max_response_bytes)
    try:
        r = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--http-worker'], input=json.dumps(args), text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout, check=False)
        result = json.loads(r.stdout)
        if r.returncode: raise ResponseError('HTTPResponse')
        if result.get('error')=='transport': raise TransportError('HTTPTransport')
        if 'error' in result: raise ResponseError('HTTPResponse')
        return (result['body'], result['headers']) if with_headers else result['body']
    except subprocess.TimeoutExpired:
        raise TransportError('HTTPTransport') from None
    except SafeError:
        raise
    except Exception:
        raise ResponseError('HTTPResponse') from None


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    fd, name = tempfile.mkstemp(prefix='.state-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, separators=(',', ':')); stream.flush(); os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)


def target(state, name, end, window, operation, events):
    targets = state.setdefault('targets', {})
    previous = targets.setdefault(name, {})
    start = timestamp(epoch(end) - window)
    if not previous.get('last_success'):
        events.append(dict(event='STARTUP', target=name, since=start, until=end))
    elif epoch(previous['last_success']) < epoch(start):
        events.append(dict(event='GAP', target=name, since=previous['last_success'], until=start))
    work = copy.deepcopy(previous.get('data', {}))
    try:
        found, partial = operation(work)
        previous['data'] = work
        previous['status'] = 'partial' if partial else 'success'
        if not partial: previous['last_success'] = end
        events.extend(dict(e, target=name) for e in found)
        if partial: events.append(dict(event='COVERAGE', target=name, reason='limit'))
    except Exception as exc:
        previous['status'] = 'error'
        events.append(dict(event='ERROR', target=name, error=type(exc).__name__))


def deduplicate(state, events, now=None):
    now = time.time() if now is None else now
    seen = state.setdefault('seen', {})
    seen = {k:v for k,v in seen.items() if isinstance(v, (int,float)) and now-v < 1800}
    output = []
    for e in events:
        if e['event'] in ('STARTUP','GAP','ERROR','COVERAGE','HEARTBEAT'):
            output.append(e); continue
        key = hashlib.sha256(json.dumps(e, sort_keys=True).encode()).hexdigest()
        if key not in seen: output.append(e)
        seen[key] = now
    state['seen'] = dict(sorted(seen.items(), key=lambda item:item[1])[-2048:])
    return output


def emit(source, event, **fields):
    print(json.dumps(dict(timestamp=utc(), source=source, event=event, **fields), separators=(',', ':')), flush=True)


def run(source, poll):
    parser = argparse.ArgumentParser(description='Read-only JSONL observer; credentials via configured environment names.')
    parser.add_argument('--config', required=True); parser.add_argument('--state-dir', required=True); parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    try:
        c = load_config(args.config)
        directory = Path(args.state_dir).resolve()
        if Path(__file__).resolve().parents[1] == directory or Path(__file__).resolve().parents[1] in directory.parents: raise SafeError('StateInsideSkill')
        directory.mkdir(parents=True, exist_ok=True, mode=0o700); os.chmod(directory, 0o700)
        lock = os.open(directory / (source+'.lock'), os.O_CREAT | os.O_RDWR, 0o600)
        os.fchmod(lock, 0o600)
        with os.fdopen(lock, 'w') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            path = directory / (source+'.json')
            state = json.loads(path.read_text()) if path.exists() else {}
            while True:
                started = time.monotonic()
                try:
                    events = poll(c, state, started + c['poll']['deadline'])
                    for e in deduplicate(state, events): emit(source, **e)
                    atomic_json(path, state)
                except Exception as exc:
                    emit(source, 'ERROR', error=type(exc).__name__)
                emit(source, 'HEARTBEAT', targets={k:{'status':v.get('status','partial'), 'last_success':v.get('last_success')} for k,v in state.get('targets',{}).items()})
                if args.once: break
                time.sleep(max(0, c['poll']['interval']-(time.monotonic()-started)))
        return 0
    except Exception as exc:
        emit(source, 'ERROR', error=type(exc).__name__)
        return 1


if __name__ == '__main__' and sys.argv[1:] == ['--http-worker']:
    _http_worker()
