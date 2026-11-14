#!/usr/bin/env python3
"""Bounded issue snapshots, persisted counts and continuation; never full events."""
import re
import time
import urllib.parse
from common import credential, epoch, request_json, remaining, run, target, utc


def next_page(headers,current,base):
    link=next((v for k,v in headers.items() if k.lower()=='link'),'')
    for item in link.split(','):
        if 'rel="next"' in item and 'results="true"' in item:
            m=re.search(r'<([^>]+)>',item)
            if not m: raise ValueError('Pagination')
            result=urllib.parse.urljoin(current,m[1])
            if urllib.parse.urlsplit(result)[:2]!=urllib.parse.urlsplit(base)[:2] or urllib.parse.urlsplit(result).path!=urllib.parse.urlsplit(current).path: raise ValueError('PaginationAuthority')
            return result
    return None


def poll(config,state,deadline):
    s=config['sentry']; p=config.get('poll',{}); window=p.get('window',600); end=utc(); events=[]
    projects=s['projects']; count=max(1,len(projects))
    for project in projects:
        per_deadline=min(deadline,time.monotonic()+max(.01,(deadline-time.monotonic())/count)); count-=1
        def fetch(data):
            root=s['url'].rstrip('/')+'/projects/'+s['org']+'/'+project+'/issues/'
            current=data.get('next') or root+'?query=&statsPeriod=24h&sort=date&limit=100'
            counts=data.setdefault('counts',{}); found=[]
            for _ in range(p.get('max_pages',3)):
                headers={}
                if config.get('credentials',{}).get('sentry'): headers['Authorization']='Bearer '+credential(config,'sentry')
                rows,headers=request_json('GET',current,headers=headers,timeout=remaining(per_deadline),with_headers=True,max_response_bytes=p.get('max_response_bytes',8388608))
                if not isinstance(rows,list): raise ValueError('SentryResponse')
                for row in rows:
                    iid=str(row['id']); n=int(row['count'])
                    if not re.fullmatch(r'\d+',iid) or n<0: raise ValueError('SentryIssue')
                    before=counts.get(iid)
                    if before is None and epoch(row['firstSeen'])>=epoch(end)-window:
                        found.append(dict(event='SENTRY',kind='new',id=iid,count=n))
                    elif before is not None and n-before>=20: found.append(dict(event='SENTRY',kind='jump',id=iid,count=n,delta=n-before))
                    counts[iid]=n
                current=next_page(headers,current,root)
                if not current: break
            data['next']=current
            # Bound private baseline memory; deletion only loses older snapshot deltas.
            if len(counts)>10000:
                data['counts']=dict(list(counts.items())[-10000:]); found.append(dict(event='COVERAGE',reason='baseline_cap'))
            if current: found.append(dict(event='COVERAGE',reason='snapshot_cap_historical_deltas_unavailable'))
            return found,bool(current)
        target(state,project,end,window,fetch,events)
    return events


if __name__=='__main__': raise SystemExit(run('sentry',poll))
