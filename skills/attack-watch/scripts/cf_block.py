#!/usr/bin/env python3
"""Guarded exact-IP Cloudflare edits with a private, recoverable operation journal."""
import argparse
import copy
import datetime as dt
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid
from common import SafeError, TransportError, argv, atomic_json, credential, epoch, load_config, request_json, utc, validate_url

# These are writable rule fields; identifiers/version/timestamps belong to the API.
WRITABLE = ('action', 'expression', 'description', 'enabled', 'action_parameters', 'logging', 'ratelimit', 'exposed_credential_check', 'ref')
VOLATILE = {'version', 'last_updated', 'created_on', 'modified_on'}
UNRESOLVED = {'mutation_intent', 'applied', 'incomplete'}


def stable(value):
    """Ignore API metadata at ruleset/rule level; nested action settings stay exact."""
    result=copy.deepcopy(value)
    for key in VOLATILE: result.pop(key,None)
    for rule in result.get('rules',[]):
        for key in VOLATILE: rule.pop(key,None)
    return result


def normalize(config, targets, subscriber_evidence):
    if not isinstance(targets, list) or not 1 <= len(targets) <= 100: raise SafeError('Targets')
    if subscriber_evidence is not None and (not isinstance(subscriber_evidence,str) or not subscriber_evidence.strip()): raise SafeError('SubscriberEvidenceRequired')
    networks=[]
    for value in targets:
        try:
            if not isinstance(value,str): raise ValueError()
            n=ipaddress.ip_network(value, strict=True)
        except (ValueError, TypeError): raise SafeError('TargetNetwork') from None
        if n.prefixlen != n.max_prefixlen and not (n.version==6 and n.prefixlen==64 and subscriber_evidence):
            raise SafeError('SubscriberEvidenceRequired')
        if n.is_multicast or n.is_unspecified or n.is_loopback or n.is_link_local: raise SafeError('TargetNetwork')
        networks.append(n)
    cf=config['cloudflare']
    exempt=[ipaddress.ip_network(v,strict=False) for v in cf.get('exempt_egress',[])+cf.get('owner_egress',[])]
    if any(a.version==b.version and a.overlaps(b) for a in networks for b in exempt): raise SafeError('ExemptOverlap')
    targets=sorted(set(str(n.network_address) if n.prefixlen==n.max_prefixlen else str(n) for n in networks))
    exclusions=sorted(set(str(n.network_address) if n.prefixlen==n.max_prefixlen else str(n) for n in exempt))
    if not exclusions: raise SafeError('ExemptMissing')
    clause='(ip.src in {'+' '.join(targets)+'} and not ip.src in {'+' '.join(exclusions)+'})'
    actions={'ipv6_64' if n.version==6 and n.prefixlen==64 else 'ip' for n in networks}
    return targets,clause,actions


def gate(config, zone, actions, evidence):
    cf=config.get('cloudflare',{}); z=cf.get('zones',{}).get(zone)
    if not z or not isinstance(z.get('id'),str) or not re.fullmatch(r'[A-Za-z0-9_-]+',z['id']): raise SafeError('Zone')
    ids=z.get('rule_ids')
    if not isinstance(ids,list) or not ids or len(set(ids))!=len(ids) or any(not isinstance(v,str) or not re.fullmatch(r'[A-Za-z0-9_-]+',v) for v in ids): raise SafeError('RuleIDs')
    grant=config.get('authority',{})
    for key in ('zones','actions'):
        if not isinstance(grant.get(key),list) or any(not isinstance(v,str) or not v for v in grant[key]): raise SafeError('GrantScope')
    for k in ('owner','evidence','review_at'):
        if not isinstance(grant.get(k),str) or not grant[k].strip(): raise SafeError('Grant')
    if grant.get('enabled') is False or grant.get('project')!=config['project'] or zone not in grant.get('zones',[]) or not actions.issubset(set(grant.get('actions',[]))): raise SafeError('GrantScope')
    expiry=grant.get('expires_at','')
    if not isinstance(expiry,str) or not expiry.endswith(('Z','+00:00')) or epoch(expiry)<=time.time(): raise SafeError('GrantExpiry')
    if not isinstance(evidence,str) or not evidence.strip(): raise SafeError('Evidence')
    owner=cf.get('owner_egress',[])
    if not owner or {str(ipaddress.ip_network(v,strict=False)) for v in owner}!={str(ipaddress.ip_network(v,strict=False)) for v in grant.get('owner_egress',[])}: raise SafeError('OwnerEgress')
    for name in ('health','verify'): argv(config.get('hooks',{}).get(name))
    return z


def remove_clause(expression, clause):
    """Remove one exact generated OR branch, retaining later wrappers and edits."""
    count=[0]
    def outer(s):
        if not s.startswith('(') or not s.endswith(')'): return False
        depth=0; quote=False; escaped=False
        for i,ch in enumerate(s):
            if quote:
                if escaped: escaped=False
                elif ch=='\\': escaped=True
                elif ch=='"': quote=False
            elif ch=='"': quote=True
            elif ch=='(': depth+=1
            elif ch==')':
                depth-=1
                if depth==0 and i!=len(s)-1: return False
        return depth==0 and not quote
    def walk(s):
        depth=0; quote=False; escaped=False
        for i,ch in enumerate(s):
            if quote:
                if escaped: escaped=False
                elif ch=='\\': escaped=True
                elif ch=='"': quote=False
                continue
            if ch=='"': quote=True; continue
            if ch=='(': depth+=1
            elif ch==')': depth-=1
            if depth==0 and s[i:i+4]==' or ':
                left,right=s[:i],s[i+4:]
                if outer(left) and right=='('+clause+')':
                    count[0]+=1
                    return walk(left[1:-1])
                return walk(left)+' or '+walk(right)
        return '('+walk(s[1:-1])+')' if outer(s) else s
    result=walk(expression)
    if count[0]!=1: raise SafeError('RollbackAmbiguous' if count[0] else 'ClauseMissing')
    return result


def run_hook(args, timeout):
    return subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, timeout=timeout, shell=False, check=False).returncode


def save(path, record):
    atomic_json(path, record)
    # A renamed intent must survive process/host failure before PATCH is sent.
    fd=os.open(str(Path(path).parent),os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)


def execute_block(config, targets, *, state_dir, zone, evidence, apply=False, subscriber_evidence=None,
                  rollback=None, transport=None, hook_runner=None, clock=None):
    """Return status + operation_dir; only verified/already_present/planned have exit_code=0.

    transport(method,url,body=None,timeout=seconds) returns the CF JSON envelope.
    hook_runner(argv,timeout=seconds) returns an exit code. clock provides monotonic/sleep.
    """
    clock=clock or time; hook_runner=hook_runner or run_hook
    record=None; operation=None; lock=None
    try:
        original=None
        if rollback:
            original=json.loads((Path(rollback)/'operation.json').read_text())
            targets=original['targets']; subscriber_evidence=original.get('subscriber_evidence')
        targets,clause,actions=normalize(config,targets,subscriber_evidence)
        z=gate(config,zone,actions,evidence) if apply else config['cloudflare']['zones'][zone]
        if not isinstance(z.get('id'),str) or not z.get('rule_ids'): raise SafeError('UnconfiguredZone')
        if original:
            if any(original.get(k)!=v for k,v in dict(project=config['project'],zone=zone,zone_id=z['id'],targets=targets,clause=clause).items()) or original.get('kind')!='block' or original.get('rule_id') not in z['rule_ids']:
                raise SafeError('OperationIdentity')
            if original.get('status')!='verified': raise SafeError('RollbackSourceUnverified')
        directory=Path(state_dir).resolve()
        skill=Path(__file__).resolve().parents[1]
        if directory==skill or skill in directory.parents: raise SafeError('StateInsideSkill')
        directory.mkdir(parents=True,exist_ok=True,mode=0o700); os.chmod(directory,0o700)
        lock=os.open(directory/'cf-writer.lock',os.O_CREAT|os.O_RDWR,0o600); os.fchmod(lock,0o600)
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        deadline=clock.monotonic()+min(config.get('poll',{}).get('deadline',240),240)
        def budget():
            left=deadline-clock.monotonic()
            if left<=0: raise SafeError('Deadline')
            return min(30,left)
        base=config['cloudflare'].get('url','https://api.cloudflare.com/client/v4').rstrip('/')
        validate_url(base)
        if transport is None:
            headers={'Authorization':'Bearer '+credential(config,'cloudflare')}
            def transport(method,url,body=None,timeout=30):
                return request_json(method,url,headers=headers,body=body,timeout=timeout,
                                    max_response_bytes=config.get('poll',{}).get('max_response_bytes',8388608))
        endpoint=base+'/zones/'+z['id']+'/rulesets/phases/http_request_firewall_custom/entrypoint'
        def get():
            for attempt in range(3):
                try:
                    response=transport('GET',endpoint,timeout=budget())
                except TransportError:
                    if attempt==2: raise SafeError('ReadFailure') from None
                    clock.sleep(min(attempt+1,budget())); continue
                if not isinstance(response,dict) or response.get('success') is not True: raise SafeError('ReadFailure')
                rs=response.get('result')
                if not isinstance(rs,dict) or not isinstance(rs.get('rules'),list) or not rs.get('id') or not rs.get('version'): raise SafeError('Ruleset')
                if len({r['id'] for r in rs['rules']})!=len(rs['rules']): raise SafeError('DuplicateRule')
                return rs
        def health(phase):
            if hook_runner(config['hooks']['health']+[phase,str(operation)],timeout=budget())!=0: raise SafeError('Health')
        def finish(live):
            if stable(live)!=record['expected']: raise SafeError('ReadbackMismatch')
            atomic_json(operation/'after.json',live)
            record['status']='applied'; save(operation/'operation.json',record)
            # Recovered operations wait a fresh propagation interval as conservative evidence.
            if deadline-clock.monotonic()<35: raise SafeError('Deadline')
            clock.sleep(35)
            if hook_runner(config['hooks']['verify']+[str(operation)],timeout=budget())!=0: raise SafeError('Verify')
            health('after')
            record['status']='verified'; record['verified_at']=utc(); save(operation/'operation.json',record)
            return dict(status='verified',exit_code=0,operation_dir=str(operation))
        live=get()
        if apply:
            # Reconcile all unresolved writes in this zone before idempotency or another write.
            for path in sorted(directory.glob('op-*/operation.json')):
                pending=json.loads(path.read_text())
                if pending.get('zone')!=zone and pending.get('zone_id')!=z['id']: continue
                if pending.get('status') not in UNRESOLVED or not pending.get('mutation_started'): continue
                if pending.get('project')!=config['project'] or pending.get('zone')!=zone or pending.get('zone_id')!=z['id'] or pending.get('ruleset_id')!=live['id'] or pending.get('rule_id') not in z['rule_ids']:
                    raise SafeError('OperationIdentity')
                pt,pc,pa=normalize(config,pending['targets'],pending.get('subscriber_evidence'))
                if pt!=pending['targets'] or pc!=pending['clause'] or pt!=targets: raise SafeError('OperationIdentity')
                if original and pending.get('rollback_of')!=str(Path(rollback).resolve()): raise SafeError('OperationIdentity')
                if not original and pending.get('kind')!='block': raise SafeError('OperationIdentity')
                gate(config,zone,pa,evidence)
                record=pending; operation=path.parent
                result=finish(live)
                if (original and pending.get('rollback_of')==str(Path(rollback).resolve())) or (not original and pending['kind']=='block' and pt==targets): return result
                record=None; operation=None
                live=get()
        if original and original['ruleset_id']!=live['id']: raise SafeError('OperationIdentity')
        chosen=None; new_expr=None
        eligible=[]
        for rid in ([original['rule_id']] if original else z['rule_ids']):
            rule=next((r for r in live['rules'] if r['id']==rid),None)
            if rule is None or rule.get('enabled') is not True or rule.get('action')!='block' or not isinstance(rule.get('expression'),str) or len(rule.get('description',''))>500: continue
            eligible.append(rule)
        # Search every configured eligible rule before selecting space in the primary.
        if not original:
            for rule in eligible:
                try: remove_clause(rule['expression'],clause)
                except SafeError as exc:
                    if str(exc)!='ClauseMissing': raise
                else: return dict(status='already_present',exit_code=0)
                if rule['expression']==clause: return dict(status='already_present',exit_code=0)
        for rule in eligible:
            expr=remove_clause(rule['expression'],clause) if original else '('+rule['expression']+') or ('+clause+')'
            if len(expr)<=4096: chosen=rule; new_expr=expr; break
        if chosen is None: raise SafeError('NoEligibleRule')
        operation=directory/('op-'+uuid.uuid4().hex)
        operation.mkdir(mode=0o700)  # exclusive unique name, never reuse another snapshot
        record=dict(status='planned',kind='rollback' if original else 'block',project=config['project'],zone=zone,zone_id=z['id'],
                    ruleset_id=live['id'],rule_id=chosen['id'],targets=targets,clause=clause,evidence=evidence,
                    subscriber_evidence=subscriber_evidence,created_at=utc(),mutation_started=False)
        if original: record['rollback_of']=str(Path(rollback).resolve())
        expected=copy.deepcopy(live)
        next(r for r in expected['rules'] if r['id']==chosen['id'])['expression']=new_expr
        record['expected']=stable(expected)
        save(operation/'operation.json',record); atomic_json(operation/'before.json',live)
        if not apply: return dict(status='planned',exit_code=0,operation_dir=str(operation))
        health('before')
        guard=get()
        if guard['version']!=live['version'] or stable(guard)!=stable(live): raise SafeError('VersionConflict')
        gate(config,zone,actions,evidence)  # grants can expire during preparation/hooks
        body={k:chosen[k] for k in WRITABLE if k in chosen}; body['expression']=new_expr
        record['status']='mutation_intent'; record['mutation_started']=True; save(operation/'operation.json',record)
        try:
            response=transport('PATCH',base+'/zones/'+z['id']+'/rulesets/'+live['id']+'/rules/'+chosen['id'],body=body,timeout=budget())
            # Even an explicit error can be ambiguous: read back, never PATCH twice.
        except Exception: pass
        return finish(get())
    except Exception as exc:
        if record is not None and operation is not None:
            record['status']='incomplete'; record['error']=type(exc).__name__
            try: save(operation/'operation.json',record)
            except Exception: pass  # durable mutation_intent still demands recovery
        return dict(status='incomplete' if record is not None else 'rejected',exit_code=1,
                    error=str(exc) if isinstance(exc,SafeError) else type(exc).__name__,
                    **({'operation_dir':str(operation)} if operation else {}))
    finally:
        if lock is not None: os.close(lock)


def main():
    p=argparse.ArgumentParser(description='Dry-run by default. Exact IP or IPv6 /64 with subscriber evidence. Rollback removes a recorded clause from live state; same live grant and hooks required.')
    p.add_argument('--config',required=True); p.add_argument('--state-dir',required=True); p.add_argument('--zone',required=True)
    mode=p.add_mutually_exclusive_group(required=True); mode.add_argument('--ip',action='append',help='Repeat for exact IPs; /64 requires --subscriber-evidence and ipv6_64 grant'); mode.add_argument('--rollback',metavar='OPERATION_DIR')
    p.add_argument('--subscriber-evidence'); p.add_argument('--evidence',required=True); p.add_argument('--apply',action='store_true')
    a=p.parse_args()
    try:
        result=execute_block(load_config(a.config),a.ip,state_dir=a.state_dir,zone=a.zone,evidence=a.evidence,
                             apply=a.apply,subscriber_evidence=a.subscriber_evidence,rollback=a.rollback)
    except Exception as exc: result=dict(status='rejected',exit_code=1,error=type(exc).__name__)
    print(json.dumps(result)); return result['exit_code']

if __name__=='__main__': sys.exit(main())
