#!/usr/bin/env python3
"""Separate bounded ES app/access/error, ingress and host-security targets."""
import base64
from collections import Counter
import os
import re
import time
from common import SafeError, epoch, request_json, remaining, run, target, timestamp, utc

ACCESS = re.compile(r'''["'](?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD) \S+ HTTP/[\d.]+["'] (\d{3})''')


def statuses(rows):
    result=Counter()
    for row in rows:
        m=ACCESS.search(row['_source'].get('message',''))
        if m: result[m[1]]+=1
    return result


def detect_app(rows):
    count=sum(n for status,n in statuses(rows).items() if 500<=int(status)<600)
    return [dict(event='APP5XX',count=count)] if count>=3 else []


def detect_errors(rows):
    counts=Counter()
    for row in rows:
        # Class only, no message, address, request data or traceback frames.
        for line in row['_source'].get('message','').splitlines():
            m=re.match(r'^\s*((?:[A-Za-z_][A-Za-z_0-9.]*)?(?:Error|Exception))(?::|\s*$)',line)
            if m: counts[m[1].split('.')[-1]]+=1
    return [dict(event='APPERR',exception=k,count=v) for k,v in counts.items()]


def detect_ingress(rows):
    return [dict(event='INGRESS',statuses=dict(statuses(rows)))]


def detect_hostsec(aggregations, config):
    baseline=config.get('baseline_keys',['jg_root_exec','(null)','cc_secrets'])
    result=[dict(event='HOSTSEC',rule=b['key'],count=b['doc_count']) for b in aggregations['key']['buckets'] if b['key'] not in baseline and re.fullmatch(r'[A-Za-z_0-9.-]{1,64}',b['key'])]
    if aggregations['auth']['doc_count']>=100: result.append(dict(event='HOSTSEC',kind='auth',count=aggregations['auth']['doc_count']))
    return result


def poll(config,state,deadline):
    es=config['elastic']; events=[]; end=utc(); p=config.get('poll',{}); window=p.get('window',600)
    count=4
    for name,index_key,detector in [('app','app',detect_app),('errors','app',detect_errors),('ingress','ingress',detect_ingress),('hostsec','hostsec',None)]:
        per_deadline=min(deadline,time.monotonic()+max(.01,(deadline-time.monotonic())/count)); count-=1
        def fetch(data):
            limit=p.get('es_limit',2000)
            body={'size':limit,'track_total_hits':True,'_source':['message','kubernetes.deployment.name'],'query':{'bool':{'filter':[{'range':{'@timestamp':{'gte':timestamp(epoch(end)-window),'lte':end}}}]}}}
            filters=body['query']['bool']['filter']
            if index_key=='app' and es.get('deployments'): filters.append({'terms':{'kubernetes.deployment.name.keyword':es['deployments']}})
            if name=='errors':
                body['query']['bool'].update(should=[{'match_phrase':{'message':v}} for v in ('Traceback','Exception','ERROR','CRITICAL')],minimum_should_match=1)
            if name=='hostsec':
                body['size']=0
                body['aggs']={'key':{'terms':{'field':'auditd.rule_key.keyword','size':100}},'auth':{'filter':{'term':{'fields.kind.keyword':'auth'}}}}
            headers={}
            if es.get('username'):
                password=os.environ.get(es['password_env'])
                if not password: raise SafeError('CredentialMissing')
                headers['Authorization']='Basic '+base64.b64encode((es['username']+':'+password).encode()).decode()
            r=request_json('POST',es['url'].rstrip('/')+'/'+es['indexes'][index_key]+'/_search',headers=headers,body=body,timeout=remaining(per_deadline),max_response_bytes=p.get('max_response_bytes',8388608))
            if not isinstance(r,dict) or r.get('error') or r.get('timed_out') or r.get('_shards',{}).get('failed',0): raise SafeError('ESResponse')
            if name=='hostsec':
                agg=r['aggregations']; found=detect_hostsec(agg,es)
                partial=agg['key'].get('sum_other_doc_count',0)>0
            else:
                hits=r['hits']['hits']; total=r['hits']['total']; total=total['value'] if isinstance(total,dict) else total
                if not isinstance(hits,list): raise SafeError('ESResponse')
                found=detector(hits); partial=total>len(hits)
            return found,partial
        target(state,name,end,window,fetch,events)
    return events


if __name__=='__main__': raise SystemExit(run('elastic',poll))
