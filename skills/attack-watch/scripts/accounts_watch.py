#!/usr/bin/env python3
"""Bounded read-only account scan, fair revisit lane and recent-time reconciliation."""
import hashlib
import ipaddress
import json
import subprocess
import time
from common import SafeError, identifier, request_json, remaining, run, target, utc


def integer(value):
    if type(value) is not int or not 0<=value<2**63: raise SafeError('AccountInteger')
    return value


class LaneBudget(SafeError):
    """The reserved local lane deadline elapsed; successful pages remain usable."""


def pg_rows(config, sql, deadline):
    budget=deadline-time.monotonic()
    if budget <= 0:
        raise LaneBudget('LaneBudget')
    try:
        pg=config['accounts']['pg']
        command=list(pg['argv'])
        if '--db-user' not in command: command+=['--db-user',pg['user']]
        if '--db-name' not in command: command+=['--db-name',pg['db']]
        sql='\\set ON_ERROR_STOP on\n'+sql+'\\echo ATTACK_WATCH_QUERY_COMPLETE\n'
        result=subprocess.run(command,input=sql,text=True,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=min(30,budget),check=False)
        if result.returncode: raise SafeError('PGFailure')
        rows=[]; completed=False
        for line in result.stdout.splitlines():
            line=line.strip()
            if line=='ATTACK_WATCH_QUERY_COMPLETE':
                completed=True; continue
            if completed and line: raise SafeError('PGTrailingOutput')
            # psql settings acknowledgements are not rows; unexpected response is a failure.
            if not line or line.startswith(('Output format','Tuples only','SET')): continue
            item=json.loads(line)
            if not isinstance(item,dict): raise SafeError('PGShape')
            rows.append(item)
        if not completed: raise SafeError('PGIncomplete')
        return rows
    except subprocess.TimeoutExpired:
        if time.monotonic() >= deadline:
            raise LaneBudget('LaneBudget') from None
        raise SafeError('PGFailure') from None
    except Exception:
        raise SafeError('PGFailure') from None


def select_sql(a,predicate,order,limit):
    tables=a.get('tables',{})
    users=identifier(tables.get('users','users')); wallets=identifier(tables.get('wallets','wallets'))
    return ('set default_transaction_read_only = on;\n'
            '\\pset tuples_only on\n\\pset format unaligned\n'
            'SELECT row_to_json(account_row) FROM (SELECT u.id, coalesce(u.owner_id,u.id) AS company, '
            'u.ts_spawn AS created, u.is_active AS active, u.is_verified AS verified, '
            f'(SELECT count(*) FROM {wallets} w WHERE w.user_id=u.id) AS wallets FROM {users} u WHERE {predicate} '
            f'ORDER BY {order} LIMIT {integer(limit)}) account_row;\n')


def normalize(row):
    for name in ('id','company','created','wallets'): integer(row[name])
    for name in ('active','verified'):
        if type(row[name]) is not bool: raise SafeError('AccountBoolean')
    return {name:row[name] for name in ('id','company','created','active','verified','wallets')}


def enrich(config,ids,deadline):
    a=config['accounts']; ch=a['ch']; db=identifier(ch['db']); table=identifier(a.get('tables',{}).get('login_history','login_history'))
    result={}
    for offset in range(0,len(ids),100):
        chunk=ids[offset:offset+100]
        values=','.join(str(integer(i)) for i in chunk)
        sql=(f'SELECT user_id, argMin(ip,ts_spawn) AS first_ip, argMin(country,ts_spawn) AS first_country, '
             f'min(ts_spawn) AS first_created, count() AS login_count FROM {db}.{table} WHERE user_id IN ({values}) '
             'GROUP BY user_id FORMAT JSON')
        response=request_json('POST',ch['url'],body=sql,timeout=remaining(deadline),max_response_bytes=config.get('poll',{}).get('max_response_bytes',8388608))
        if not isinstance(response,dict) or not isinstance(response.get('data'),list): raise SafeError('CHShape')
        for row in response['data']:
            uid=int(row['user_id']); integer(uid)
            if uid not in chunk: raise SafeError('CHUnexpectedID')
            ip=str(ipaddress.ip_address(row['first_ip'])); country=row['first_country']
            if not isinstance(country,str) or len(country)>64 or not all(c.isalpha() or c in ' -_' for c in country): raise SafeError('CHCountry')
            result[uid]={'ip':ip,'country':country}
    return result


def poll(config,state,deadline):
    a=config['accounts']; p=config.get('poll',{}); events=[]; now=int(time.time())
    if type(a.get('initial_cursor')) is not int: raise SafeError('InitialCursorRequired')
    def scan(data):
        horizon=a.get('revisit_seconds',86400)
        if horizon!=86400: raise SafeError('RevisitHorizon')
        recent=data.setdefault('recent',{}); found=[]
        expired=[uid for uid,item in recent.items() if now-item['created']>horizon]
        if expired:
            found.append(dict(event='REVISIT_EXPIRED',count=len(expired),no_login=sum(1 for uid in expired if recent[uid].get('no_login',True))))
            for uid in expired: del recent[uid]
        cursor=integer(data.get('cursor',a['initial_cursor'])); page_size=p.get('page_size',100)
        rows={}; new_cursor=cursor; full=False; budget_limited=False
        # Reserve a third of elapsed budget for revisits and a third for enrichment;
        # each lane is bounded independently so busy forward streams cannot starve it.
        start=time.monotonic(); duration=max(0,deadline-start)
        forward_deadline=min(deadline,start+duration/3)
        for _ in range(p.get('max_new_pages',3)):
            try:
                page=pg_rows(config,select_sql(a,f'u.id > {new_cursor}','u.id ASC',page_size),forward_deadline)
            except LaneBudget:
                budget_limited=True
                break
            page=[normalize(r) for r in page]
            if len(page)>page_size or any(r['id']<=new_cursor for r in page) or [r['id'] for r in page]!=sorted({r['id'] for r in page}): raise SafeError('PGOrder')
            for row in page: rows[row['id']]=row
            if page: new_cursor=page[-1]['id']
            full=len(page)==page_size
            if not full: break
        # Oldest checked first; bounded persistent fairness across restarts.
        revisit=sorted(recent,key=lambda uid:(recent[uid].get('checked',0),int(uid)))[:p.get('revisit_limit',100)]
        revisit_deadline=min(deadline,start+duration*2/3)
        revisited=[]
        if revisit:
            ids=','.join(str(integer(int(uid))) for uid in revisit)
            try:
                page=pg_rows(config,select_sql(a,f'u.id IN ({ids})','u.id ASC',100),revisit_deadline)
                revisited=revisit
            except LaneBudget:
                budget_limited=True
                page=[]
            for r in page:
                row=normalize(r)
                if str(row['id']) not in revisit: raise SafeError('PGUnexpectedID')
                rows[row['id']]=row
        # Reconciliation cycles over the recent epoch window independently of forward id.
        # Stable (ts_spawn,id) keyset finds late lower ids on the next cycle.
        checkpoint=data.get('reconcile',{'created':now-horizon,'id':0})
        reconcile_full=False
        for _ in range(p.get('reconcile_pages',1)):
            ts=integer(max(now-horizon,checkpoint['created'])); uid=integer(checkpoint['id'])
            predicate=f'u.ts_spawn >= {now-horizon} AND (u.ts_spawn > {ts} OR (u.ts_spawn = {ts} AND u.id > {uid}))'
            try:
                page=pg_rows(config,select_sql(a,predicate,'u.ts_spawn ASC, u.id ASC',page_size),revisit_deadline)
            except LaneBudget:
                budget_limited=True
                break
            page=[normalize(r) for r in page]
            if len(page)>page_size: raise SafeError('PGPageLimit')
            ordering=[(r['created'],r['id']) for r in page]
            if ordering!=sorted(set(ordering)) or any(pair<=(ts,uid) for pair in ordering): raise SafeError('PGReconcileOrder')
            for row in page: rows[row['id']]=row
            reconcile_full=len(page)==page_size
            checkpoint={'created':page[-1]['created'],'id':page[-1]['id']} if reconcile_full else {'created':now-horizon,'id':0}
            if not reconcile_full: break
        # One CH request per <=100 unique ids across ALL lanes; empty aggregate is valid.
        logins=enrich(config,sorted(rows),deadline)
        for uid,row in sorted(rows.items()):
            login=logins.get(uid)
            signature=hashlib.sha256(json.dumps(dict(row,login=login),sort_keys=True).encode()).hexdigest()
            if recent.get(str(uid),{}).get('signature')!=signature:
                found.append(dict(event='NEWUSER',**row,login=login))
            if now-row['created']<=horizon:
                recent[str(uid)]={'created':row['created'],'checked':now,'signature':signature,'no_login':login is None}
        for uid in revisited:
            if uid in recent: recent[uid]['checked']=now
        if len(recent)>10000: raise SafeError('RecentAccountCap')
        data.update(cursor=new_cursor,reconcile=checkpoint)
        return found,budget_limited or full or reconcile_full
    target(state,'accounts',utc(),p.get('window',600),scan,events)
    return events


if __name__=='__main__': raise SystemExit(run('accounts',poll))
