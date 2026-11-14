"""Behavioral boundaries: wrong evidence, unsafe I/O or skipped checkpoints must fail."""
import copy
import contextlib
import io
import fcntl
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'skills/attack-watch/scripts'
sys.path.insert(0, str(SCRIPTS))


def config():
    return dict(project='fixture', poll={}, credentials={}, cloudflare={'zones': {}, 'exempt_egress': ['192.0.2.1'], 'owner_egress': [], 'signals': {}}, elastic={}, sentry={}, accounts={})


def group(ip='203.0.113.7', origin=200, edge=200, count=10, path='/api/users/me', ua='sqlmap', minute='2026-11-14T00:01:00Z', method='GET'):
    return {'count': count, 'dimensions': dict(clientIP=ip, originResponseStatus=origin, edgeResponseStatus=edge, clientRequestPath=path, userAgent=ua, datetimeMinute=minute, clientRequestHTTPMethodName=method, clientCountryName='US', securityAction='', clientRequestHTTPHost='app.example.com')}


class ObserverTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.common = importlib.import_module('common')
        cls.cf = importlib.import_module('cf_watch')
        cls.es = importlib.import_module('es_watch')
        cls.sentry = importlib.import_module('sentry_watch')
        cls.accounts = importlib.import_module('accounts_watch')

    def events(self, rows):
        return self.cf.detect_cf(rows, config())

    def test_cf_fingerprint_origin_public_and_exempt(self):
        for rows, expected in [([group(origin=0, count=200)], False),
                               ([group(path='/api/landing/a', count=5), group(path='/api/api-keys', count=1, edge=404, origin=404, ua='')], False),
                               ([group(path='/api/api-keys', count=2, ua='')], False),
                               ([group(path='/api/api-keys', count=5)], True),
                               ([group(path='/api/api-keys', count=5, ip='192.0.2.1')], False),
                               ([group(path='/api/api-keys', count=5, ip='192.0.2.10')], True)]:
            with self.subTest(rows=rows):
                self.assertEqual(any(e['event'] == 'CANDIDATE' for e in self.events(rows)), expected)
        rows = [group(path='/probe/'+str(i), count=2, edge=404, origin=404, ua='') for i in range(80)]
        self.assertTrue(any(e['event']=='CANDIDATE' for e in self.events(rows)))

    def test_cf_key_session_wallet_and_auth_minute_order(self):
        rows = [group(path='/api/api-keys/17', method='POST'), group(path='/api/users/me'), group(path='/api/wallet/42/recovery-phrase'), group(path='/api/auth/google/complete-2fa', method='POST', edge=401, origin=401), group(path='/api/auth/google/complete-2fa', method='POST', minute='2026-11-14T00:02:00Z')]
        events = self.events(rows)
        self.assertTrue({'KEY','SESSION','RP-ENUM','AUTH-HIT'}.issubset({e['event'] for e in events}))
        self.assertEqual(next(e for e in events if e['event']=='RP-ENUM')['wallet_ids'], ['42'])
        rows[-1]['dimensions']['datetimeMinute'] = '2026-11-14T00:01:00Z'
        self.assertFalse(any(e['event']=='AUTH-HIT' for e in self.events(rows)))
        self.assertFalse(any(e['event']=='SESSION' for e in self.events([group(ua='')])) )
        self.assertTrue(any(e['event']=='AUTH-WAVE' for e in self.events([group(path='/api/auth/set-initial-password', method='POST', count=80)])))
        self.assertFalse(any(e['event']=='AUTH-WAVE' for e in self.events([group(path='/api/auth/login', method='POST', count=100)])))
        self.assertTrue(any(e['event']=='KEY' for e in self.events([group(path='/api/api-keys',method='POST',origin=0,count=1)])))
        self.assertNotIn('sqlmap', json.dumps(events))
        self.assertNotIn('/api/', json.dumps(events))

    def test_es_detectors_only_emit_safe_signatures_and_counts(self):
        rows = [{'_source': {'message': "'GET /api/private?token=SECRET HTTP/1.1' 500 3ms"}}] * 3
        self.assertEqual(self.es.detect_app(rows)[0]['count'], 3)
        self.assertFalse(self.es.detect_app(rows[:2]))
        err = self.es.detect_errors([{'_source': {'message': 'Traceback\nValueError: alice@example.com token=SECRET'}}])
        self.assertEqual(err, [{'event':'APPERR', 'exception':'ValueError', 'count':1}])
        self.assertEqual(self.es.detect_ingress([{'_source': {'message':'1.2.3.4 - - [date] "GET /secret HTTP/1.1" 403 0'}}])[0]['statuses'], {'403':1})
        agg = {'key': {'buckets':[{'key':'cc_sudoers','doc_count':2}, {'key':'jg_root_exec','doc_count':50}]}, 'auth':{'doc_count':100}}
        self.assertEqual(len(self.es.detect_hostsec(agg, {})), 2)
        agg['auth']['doc_count']=99
        self.assertEqual(len(self.es.detect_hostsec(agg, {})), 1)

    def test_config_rejects_unsafe_values_and_requires_initial_cursor(self):
        for change in [{'poll':{'interval':float('nan')}}, {'poll':{'page_size':0}}, {'elastic':{'url':'http://external.example.com'}}, {'accounts':{'initial_cursor':None}}, {'accounts':{'initial_cursor':0, 'tables':{'users':'users;DELETE'}}}, {'credentials':{'cf':{'env':'$TOKEN'}}}, {'cloudflare':{'zones':{str(i):{'id':'x','hosts':['x']} for i in range(33)}}}]:
            c=config(); c.update(change)
            with tempfile.TemporaryDirectory() as d:
                p=Path(d)/'c.json'; p.write_text(json.dumps(c))
                with self.subTest(change=change), self.assertRaises(self.common.SafeError): self.common.load_config(p)
        c=config(); c['accounts']={'initial_cursor':0, 'ch':{'url':'http://127.0.0.1:18224'}}
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'c.json'; p.write_text(json.dumps(c)); self.assertEqual(self.common.load_config(p)['poll']['window'],600)

    def test_private_atomic_state_preserves_old_on_replace_failure(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'state'/'x.json'; self.common.atomic_json(p, {'old':1})
            self.assertEqual(p.stat().st_mode & 0o777,0o600)
            self.assertEqual(p.parent.stat().st_mode & 0o777,0o700)
            with patch('common.os.replace', side_effect=OSError('SECRET')):
                with self.assertRaises(OSError): self.common.atomic_json(p, {'new':2})
            self.assertEqual(json.loads(p.read_text()),{'old':1})

    def test_target_gap_failure_and_partial_do_not_move_full_coverage(self):
        state={'targets':{'bad':{'last_success':'2026-11-14T00:00:00Z'}, 'ok':{'last_success':'2026-11-14T00:00:00Z'}}}
        end='2026-11-14T00:25:00Z'
        events=[]
        self.common.target(state,'bad',end,600,lambda s: (_ for _ in ()).throw(ValueError('SECRET')),events)
        self.common.target(state,'ok',end,600,lambda s: ([{'event':'X'}],False),events)
        self.assertEqual(state['targets']['bad']['last_success'],'2026-11-14T00:00:00Z')
        self.assertEqual(state['targets']['ok']['last_success'],end)
        gap=next(e for e in events if e['event']=='GAP')
        self.assertEqual((gap['since'],gap['until']),('2026-11-14T00:00:00Z','2026-11-14T00:15:00Z'))
        self.assertNotIn('SECRET',json.dumps(events))
        self.common.target(state,'ok','2026-11-14T00:30:00Z',600,lambda s: ([],True),events)
        self.assertEqual(state['targets']['ok']['last_success'],end)

    def test_sentry_paging_persisted_counts_and_cap_continuation(self):
        c=config(); c['sentry']={'url':'https://sentry.example/api/0','org':'org','projects':['p']}; c['poll']={'max_pages':1,'window':600}
        state={}; issue={'id':'17','count':'1','firstSeen':'2999-01-01T00:00:00Z','title':'SECRET'}
        pages=[([issue], {'Link':'<https://sentry.example/api/0/projects/org/p/issues/?cursor=next>; rel="next"; results="true"'})]
        with patch('sentry_watch.request_json',side_effect=pages): events=self.sentry.poll(c,state,time.monotonic()+10)
        self.assertTrue(any(e['event']=='COVERAGE' for e in events))
        self.assertIn('next',state['targets']['p']['data']['next'])
        state=json.loads(json.dumps(state))
        second={'id':'18','count':'2','firstSeen':'2999-01-01T00:00:00Z','title':'SECRET'}
        with patch('sentry_watch.request_json',return_value=([second],{})) as transport:
            self.sentry.poll(c,state,time.monotonic()+10)
        self.assertIn('cursor=next',transport.call_args.args[1])
        self.assertIsNone(state['targets']['p']['data']['next'])
        issue['count']='21'
        with patch('sentry_watch.request_json',return_value=([issue],{})): events=self.sentry.poll(c,state,time.monotonic()+10)
        self.assertTrue(any(e.get('delta')==20 for e in events)); self.assertNotIn('SECRET',json.dumps(events))

    def test_runner_failed_target_heartbeat_private_lock_and_lock_contention(self):
        with tempfile.TemporaryDirectory() as d:
            directory=Path(d)/'incident'; directory.mkdir()
            lock=directory/'fixture.lock'; lock.write_text(''); lock.chmod(0o644)
            cfg=Path(d)/'config.json'; cfg.write_text(json.dumps(config()))
            args=['observer','--config',str(cfg),'--state-dir',str(directory),'--once']
            def failed_poll(c,state,deadline):
                events=[]
                self.common.target(state,'remote',self.common.utc(),600,lambda work: (_ for _ in ()).throw(ValueError('SECRET')),events)
                return events
            output=io.StringIO()
            with patch('sys.argv',args), contextlib.redirect_stdout(output):
                self.assertEqual(self.common.run('fixture',failed_poll),0)
            lines=[json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual(lines[-1]['event'],'HEARTBEAT')
            self.assertEqual(lines[-1]['targets']['remote'],{'status':'error','last_success':None})
            self.assertNotIn('SECRET',output.getvalue())
            self.assertEqual(lock.stat().st_mode & 0o777,0o600)
            with lock.open('w') as handle:
                fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
                with patch('sys.argv',args), contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(self.common.run('fixture',failed_poll),1)

    def test_restart_dedup_is_bounded_and_heartbeats_remain_visible(self):
        state={}
        events=[{'event':'KEY','id':'1'},{'event':'HEARTBEAT'}]
        self.assertEqual(len(self.common.deduplicate(state,events,now=100)),2)
        state=json.loads(json.dumps(state))
        self.assertEqual(self.common.deduplicate(state,events,now=200),[{'event':'HEARTBEAT'}])
        self.assertEqual(len(self.common.deduplicate(state,events,now=2000)),2)
        self.common.deduplicate(state,[{'event':'KEY','id':str(i)} for i in range(3000)],now=2001)
        self.assertLessEqual(len(state['seen']),2048)

    def test_deadline_is_checked_before_next_request(self):
        with self.assertRaises(self.common.SafeError): self.common.remaining(time.monotonic()-1)

    def test_es_failed_sibling_keeps_coverage_and_other_targets_advance(self):
        c=config(); c['elastic']={'url':'https://es.example','indexes':{'app':'app','ingress':'ingress','hostsec':'hostsec'}}
        state={}
        empty={'hits':{'hits':[],'total':{'value':0,'relation':'eq'}}}
        host={'aggregations':{'key':{'buckets':[]},'auth':{'doc_count':0}}}
        with patch('es_watch.request_json',side_effect=[ValueError('SECRET'),empty,empty,host]):
            events=self.es.poll(c,state,time.monotonic()+10)
        self.assertEqual(state['targets']['app']['status'],'error')
        self.assertNotIn('last_success',state['targets']['app'])
        self.assertTrue(all(state['targets'][k]['status']=='success' for k in ('errors','ingress','hostsec')))
        self.assertNotIn('SECRET',json.dumps(events))

    def test_cf_poll_sends_minute_and_host_bounds_and_rejects_remote_errors(self):
        c=config(); c['poll']={'max_response_bytes':1024}; c['cloudflare']['zones']={'zone':{'id':'z','hosts':['app.example']}}
        sent=[]
        def transport(*args,**kwargs):
            sent.append(kwargs)
            return {'data':{'viewer':{'zones':[{'httpRequestsAdaptiveGroups':[]}]}}}
        with patch.dict(os.environ,{'FIXTURE_TOKEN':'SECRET'}), patch('cf_watch.request_json',side_effect=transport):
            c['credentials']={'cloudflare':{'env':'FIXTURE_TOKEN'}}
            state={}; events=self.cf.poll(c,state,time.monotonic()+10)
        self.assertEqual(sent[0].get('max_response_bytes'),1024)
        self.assertEqual(sent[0]['body']['variables']['hosts'],['app.example'])
        self.assertIn('datetimeMinute',sent[0]['body']['query'])
        self.assertEqual(state['targets']['zone']['status'],'success')
        with patch.dict(os.environ,{'FIXTURE_TOKEN':'SECRET'}), patch('cf_watch.request_json',return_value={'errors':[{'message':'SECRET'}]}):
            events=self.cf.poll(c,state,time.monotonic()+10)
        self.assertEqual(state['targets']['zone']['status'],'error')
        self.assertNotIn('SECRET',json.dumps(events))

    def test_accounts_readonly_epoch_empty_login_and_failure_checkpoint(self):
        c=config(); c['accounts']={'initial_cursor':0,'revisit_seconds':86400,'pg':{'argv':['tsh','db','connect','resource'],'resource':'resource','user':'reader','db':'db'}, 'ch':{'url':'http://127.0.0.1:1','db':'db'},'tables':{}}
        c['poll']={'max_new_pages':1,'page_size':100,'revisit_limit':100,'window':600}
        row={'id':1,'company':1,'created':int(time.time()),'active':True,'verified':False,'wallets':0}
        captured=[]
        def pg(cfg,sql,deadline):
            captured.append(sql)
            return [row] if 'u.id > 0' in sql else []
        state={}
        with patch('accounts_watch.pg_rows',side_effect=pg), patch('accounts_watch.request_json',return_value={'data':[]}):
            events=self.accounts.poll(c,state,time.monotonic()+10)
        self.assertEqual(state['targets']['accounts']['data']['cursor'],1)
        self.assertTrue(all(s.startswith('set default_transaction_read_only = on;') for s in captured))
        self.assertTrue(all('to_timestamp' not in s for s in captured))
        self.assertIsNone(next(e for e in events if e['event']=='NEWUSER')['login'])
        state={}
        with patch('accounts_watch.pg_rows',side_effect=pg), patch('accounts_watch.request_json',side_effect=ValueError('SECRET')):
            events=self.accounts.poll(c,state,time.monotonic()+10)
        self.assertNotIn('cursor',state['targets']['accounts'].get('data',{}))
        self.assertTrue(any(e['event']=='ERROR' for e in events))

    def test_recent_time_reconciliation_reports_late_lower_id_without_rewinding_cursor(self):
        c=config(); c['accounts']={'initial_cursor':100,'pg':{},'ch':{'url':'http://127.0.0.1:1','db':'db'},'tables':{}}
        row={'id':5,'company':5,'created':int(time.time()),'active':False,'verified':False,'wallets':0}
        def pg(cfg,sql,deadline): return [row] if 'u.ts_spawn >=' in sql else []
        state={}
        with patch('accounts_watch.pg_rows',side_effect=pg), patch('accounts_watch.request_json',return_value={'data':[]}):
            events=self.accounts.poll(c,state,time.monotonic()+10)
        self.assertEqual(state['targets']['accounts']['data']['cursor'],100)
        self.assertEqual(next(e['id'] for e in events if e['event']=='NEWUSER'),5)

    def test_accounts_batched_new_revisit_and_reconciliation_across_restart(self):
        c=config(); c['accounts']={'initial_cursor':100,'revisit_seconds':86400,'pg':{},'ch':{'url':'http://127.0.0.1:1','db':'db'},'tables':{}}; c['poll']={'max_new_pages':3,'page_size':100,'revisit_limit':100,'window':600}
        now=int(time.time()); calls=[]
        def row(i): return {'id':i,'company':i,'created':now,'active':True,'verified':False,'wallets':0}
        state={'targets':{'accounts':{'data':{'cursor':100,'recent':{str(i):{'created':now,'checked':0,'signature':''} for i in range(1,101)}}}}}
        def pg(cfg,sql,deadline):
            import re
            if 'u.id >' in sql:
                n=int(re.search(r'u.id > (\d+)',sql)[1]); return [row(i) for i in range(n+1,min(n+101,401))]
            if 'u.id IN' in sql: return [row(i) for i in range(1,101)]
            return [row(50)] if 'u.ts_spawn >=' in sql else []
        def ch(*args,**kwargs): calls.append(kwargs['body']); return {'data':[]}
        with patch('accounts_watch.pg_rows',side_effect=pg), patch('accounts_watch.request_json',side_effect=ch):
            events=self.accounts.poll(c,state,time.monotonic()+10)
        data=state['targets']['accounts']['data']; self.assertEqual(data['cursor'],400)
        self.assertLessEqual(len(calls),4); self.assertTrue(all(len(sql.split(' IN (')[1].split(')')[0].split(','))<=100 for sql in calls))
        self.assertTrue(all(data['recent'][str(i)]['checked']>0 for i in range(1,101)))
        self.assertEqual(len([e for e in events if e['event']=='NEWUSER']),400)
        state=json.loads(json.dumps(state)); state['targets']['accounts']['data']['recent']['1']['created']=now-86401
        with patch('accounts_watch.pg_rows',return_value=[]), patch('accounts_watch.request_json',return_value={'data':[]}): events=self.accounts.poll(c,state,time.monotonic()+10)
        self.assertTrue(any(e['event']=='REVISIT_EXPIRED' for e in events))
        self.assertNotIn('1',state['targets']['accounts']['data']['recent'])


class HttpBoundaries(unittest.TestCase):
    def test_real_local_trickle_oversize_malformed_and_empty(self):
        common=importlib.import_module('common')
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*a): pass
            def do_GET(self):
                self.send_response(200); self.end_headers()
                try:
                    if self.path=='/trickle':
                        for _ in range(30): self.wfile.write(b' '); self.wfile.flush(); threading.Event().wait(.1)
                    else: self.wfile.write({'/large':b'"'+b'x'*10000+b'"','/bad':b'SECRET','/empty':b'[]'}[self.path])
                except (BrokenPipeError,ConnectionResetError): pass
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler); server.daemon_threads=True
        t=threading.Thread(target=server.serve_forever,daemon=True); t.start()
        url=f'http://127.0.0.1:{server.server_port}'
        try:
            self.assertEqual(common.request_json('GET',url+'/empty'),[])
            body,headers=common.request_json('GET',url+'/empty',with_headers=True)
            self.assertEqual(body,[]); self.assertIn('Server',headers)
            for path,kw in [('/trickle',{'timeout':.35}),('/large',{'max_response_bytes':100}),('/bad',{})]:
                start=time.monotonic()
                with self.assertRaises(common.SafeError) as ctx: common.request_json('GET',url+path,**kw)
                self.assertLess(time.monotonic()-start,1.5); self.assertNotIn('SECRET',str(ctx.exception))
        finally: server.shutdown(); server.server_close(); t.join()

if __name__=='__main__': unittest.main()
