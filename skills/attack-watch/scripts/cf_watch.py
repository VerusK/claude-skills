#!/usr/bin/env python3
"""Sampled Cloudflare analytics; evidence only, never a blocking decision."""
from collections import defaultdict
import ipaddress
import re
import time
from common import epoch, credential, request_json, remaining, run, target, timestamp, utc

SCANNER = r'curl/|sqlmap|ffuf|nuclei|nikto|gobuster|feroxbuster|python-requests|go-http-client|httpx|zgrab|wfuzz'
BAD = r'\.\.%2f|\.\./|%2e%2e|etc/passwd|<script|union.+select|/\.env|/\.git|wp-|phpmyadmin|jmx-console|/manager/html|cgi-bin|disable-2fa|reset-2fa|two-factor-auth/disable|/api/api-keys|/api/users/all|/api/admin|recovery-phrase|/api/passkeys/register|import_phrase|/pdf/to_chat|bulk/update'
AUTH = r'/api/auth/(google/complete-2fa|google/2fa-challenge|set-initial-password)(?:$|[/?])'
QUERY = '''query($zone:String!,$since:Time!,$until:Time!,$hosts:[String!]!,$limit:Int!){viewer{zones(filter:{zoneTag:$zone}){httpRequestsAdaptiveGroups(filter:{datetime_geq:$since,datetime_leq:$until,requestSource:"eyeball",clientRequestHTTPHost_in:$hosts},limit:$limit,orderBy:[count_DESC]){count dimensions{datetimeMinute clientIP clientCountryName clientRequestHTTPHost clientRequestPath clientRequestHTTPMethodName edgeResponseStatus originResponseStatus userAgent securityAction}}}}}'''


def detect_cf(rows, config):
    cf = config.get('cloudflare', config)
    s = cf.get('signals', {})
    scanner = re.compile(s.get('scanner_pattern', SCANNER), re.I)
    bad = re.compile(s.get('bad_pattern', BAD), re.I)
    auth = re.compile(s.get('auth_pattern', AUTH), re.I)
    public = tuple(s.get('public_paths', ['/api/landing/', '/api/check_pd/', '/api/track']))
    sessions = s.get('session_paths', ['/api/users/owner','/api/users/me','/api/api-keys'])
    networks = [ipaddress.ip_network(n, strict=False) for n in cf.get('exempt_egress', []) + cf.get('owner_egress', [])]
    per = defaultdict(lambda:dict(origin=0, scanner=0, bad=0, fourxx=0, ok=0, paths=set(), session=0, blocked=0))
    failures = defaultdict(list); successes = defaultdict(list)
    events = []; wave = 0; wallets = set(); recovery = 0
    for row in rows:
        d = row['dimensions']; n = row['count']
        if type(n) is not int or n < 0: raise ValueError('Count')
        ip = str(ipaddress.ip_address(d['clientIP'])); p = per[ip]
        path=d['clientRequestPath']; method=d['clientRequestHTTPMethodName']; status=int(d['edgeResponseStatus']); origin=int(d['originResponseStatus'] or 0)
        if d.get('securityAction') == 'block' or (origin == 0 and status == 403):
            p['blocked'] += n; continue
        p['origin'] += n if origin > 0 else 0
        p['scanner'] += n if scanner.search(d.get('userAgent') or '') else 0
        p['bad'] += n if bad.search(path) else 0
        p['paths'].add(path)
        p['fourxx'] += n if 400 <= status < 500 else 0
        ok = 200 <= origin < 300 and 200 <= status < 300
        if ok and path.startswith('/api/') and not path.startswith(public): p['ok'] += n
        if ok and path.split('?')[0] in sessions: p['session'] += n
        if 200 <= status < 300 and path.lower().startswith('/api/api-keys') and method in ('POST','PUT','PATCH','DELETE'):
            events.append(dict(event='KEY', ip=ip, count=n, method=method, origin_status=origin))
        if 'recovery-phrase' in path:
            recovery += n
            match = re.search(r'/wallet/(\d+)/',path)
            if ok and match: wallets.add(match[1])
        if auth.search(path) and method == 'POST':
            wave += n
            key = (ip, auth.search(path).group(0).rstrip('/?'))
            minute = d.get('datetimeMinute')
            if minute:
                if ok: successes[key].append(minute)
                elif 400 <= status < 600: failures[key].append(minute)
    for ip,p in per.items():
        categories = [p['scanner'] >= s.get('scanner_threshold',5), p['bad'] >= s.get('bad_threshold',3), len(p['paths']) >= s.get('paths_threshold',80), p['fourxx'] >= s.get('fourxx_threshold',150)]
        fingerprint = sum(categories) >= 2 or (categories[0] and p['bad'] >= 1)
        exempt = any(ipaddress.ip_address(ip) in net for net in networks)
        if fingerprint and (p['origin'] >= s.get('origin_threshold',10) or p['ok'] >= 1) and not exempt:
            events.append(dict(event='CANDIDATE', ip=ip, origin=p['origin'], blocked=p['blocked'], protected_success=p['ok']))
        if fingerprint and p['session']:
            events.append(dict(event='SESSION', ip=ip, count=p['session']))
    for key, mins in successes.items():
        if failures[key] and min(failures[key]) < max(mins): events.append(dict(event='AUTH-HIT',ip=key[0]))
    if wave >= s.get('auth_wave_threshold',80): events.append(dict(event='AUTH-WAVE',count=wave))
    if recovery: events.append(dict(event='RP-ENUM',count=recovery,wallet_ids=sorted(wallets)))
    return events


def poll(config, state, deadline):
    events=[]; end=utc(); window=config.get('poll',{}).get('window',600)
    zones=config['cloudflare']['zones']; count=max(1,len(zones))
    for name,z in zones.items():
        per_deadline=min(deadline,time.monotonic()+max(.01,(deadline-time.monotonic())/count)); count-=1
        def fetch(data):
            limit=config.get('poll',{}).get('cf_limit',10000)
            variables=dict(zone=z['id'],hosts=z['hosts'],since=timestamp(epoch(end)-window),until=end,limit=limit)
            r=request_json('POST',config['cloudflare'].get('url','https://api.cloudflare.com/client/v4').rstrip('/')+'/graphql',headers={'Authorization':'Bearer '+credential(config,'cloudflare')},body=dict(query=QUERY,variables=variables),timeout=remaining(per_deadline),max_response_bytes=config.get('poll',{}).get('max_response_bytes',8388608))
            if not isinstance(r,dict) or r.get('errors'): raise ValueError('GraphQL')
            groups=r['data']['viewer']['zones'][0]['httpRequestsAdaptiveGroups']
            if not isinstance(groups,list): raise ValueError('Groups')
            found=detect_cf(groups,config)
            found.append(dict(event='COVERAGE',reason='sampled',groups=len(groups)))
            return found,len(groups)>=limit
        target(state,name,end,window,fetch,events)
    return events


if __name__=='__main__': raise SystemExit(run('cloudflare',poll))
