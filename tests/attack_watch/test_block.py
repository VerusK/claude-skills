"""Offline mutation contracts: fake transport is the Cloudflare boundary only."""
import copy
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'skills/attack-watch/scripts'))
import cf_block as block
import common


def config():
    return {'project':'fixture', 'poll':{'deadline':240}, 'cloudflare':{
        'url':'https://cf.invalid/client/v4', 'zones':{'z':{'id':'zone1','hosts':['app.invalid'],'rule_ids':['r1','r2']}},
        'exempt_egress':['192.0.2.0/24'], 'owner_egress':['198.51.100.9']},
        'authority':{'owner':'owner','evidence':'grant-ref','project':'fixture','zones':['z'],
        'actions':['ip','ipv6_64'],'expires_at':'2099-01-01T00:00:00Z','review_at':'2098-12-01','owner_egress':['198.51.100.9']},
        'hooks':{'health':['health'], 'verify':['verify']}}


class Clock:
    def __init__(self): self.t = 0
    def monotonic(self): return self.t
    def sleep(self, seconds): self.t += seconds


class CF:
    def __init__(self):
        self.state = {'id':'rs1','version':'1','name':'fixture','rules':[
            {'id':'r1','version':'1','expression':'ip.src eq 203.0.113.1','description':'IR','enabled':True,'action':'block','logging':{'enabled':True}},
            {'id':'r2','expression':'ip.src eq 203.0.113.2','description':'fallback','enabled':True,'action':'block','action_parameters':{'response':{'status_code':403}}},
            {'id':'other','expression':'http.request.uri.path eq "/metrics"','enabled':True,'action':'skip','description':'untouched'}]}
        self.patch_count = 0; self.get_count = 0; self.timeout = False; self.drift = False; self.mismatch = False; self.get_errors = 0
    def __call__(self, method, url, body=None, timeout=30):
        if method == 'GET':
            self.get_count += 1
            if self.get_errors: self.get_errors -= 1; raise common.TransportError('HTTPTransport')
            if self.drift and self.get_count == 2: self.state['version'] = '2'
            return {'success':True,'result':copy.deepcopy(self.state)}
        self.patch_count += 1
        rid = url.rsplit('/',1)[-1]
        next(r for r in self.state['rules'] if r['id']==rid).update(copy.deepcopy(body))
        self.state['version'] = str(int(self.state['version'])+1)
        if self.mismatch: self.state['rules'][-1]['description']='unexpected'
        if self.timeout: raise TimeoutError('remote secret')
        return {'success':True,'result':{}}


class BlockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.c = config(); self.cf = CF(); self.clock=Clock(); self.calls=[]; self.fail_hook=None
    def hook(self, argv, timeout):
        self.calls.append((argv, self.clock.t))
        return 1 if self.fail_hook == argv[0] or self.fail_hook == argv[-2] else 0
    def run_block(self, targets=None, **kw):
        opts = dict(state_dir=self.tmp.name, zone='z', evidence='evidence-ref', apply=True,
                    transport=self.cf, hook_runner=self.hook, clock=self.clock)
        opts.update(kw)
        return block.execute_block(self.c, targets or ['203.0.113.7'], **opts)
    def test_dry_run_never_mutates_or_runs_hooks(self):
        result=self.run_block(apply=False)
        self.assertEqual(result['status'],'planned'); self.assertEqual(self.cf.patch_count,0); self.assertEqual(self.calls,[])
    def test_grant_target_and_hook_gates_precede_mutation(self):
        changes=[('expires_at','2000-01-01T00:00:00Z'),('expires_at','2099-01-01T00:00:00+03:00'),
                 ('project','wrong'),('zones',['else']),('zones','z'),('actions',[]),('owner_egress',[]),('owner',None),('review_at',None)]
        for key,value in changes:
            with self.subTest(key=key,value=value):
                self.c=config(); self.c['authority'][key]=value
                self.assertEqual(self.run_block()['status'],'rejected')
        self.c=config(); self.c['hooks']={}
        self.assertEqual(self.run_block()['status'],'rejected'); self.assertEqual(self.cf.patch_count,0)
    def test_targets_exemptions_and_subscriber_evidence(self):
        for target in ['192.0.2.7','198.51.100.9','203.0.113.0/24','2001:db8::/48','2001:db8::/64']:
            with self.subTest(target=target): self.assertEqual(self.run_block([target])['status'],'rejected')
        self.assertEqual(self.cf.patch_count,0)
        self.assertEqual(self.run_block(['2001:db8::/64'],subscriber_evidence=' ')['status'],'rejected')
        self.assertEqual(self.run_block(['2001:db8::/64'],subscriber_evidence='one-subscriber')['status'],'verified')
        self.c['cloudflare']['exempt_egress'].append('2001:db8::1')
        self.assertEqual(self.run_block(['2001:db8::/64'],subscriber_evidence='one')['status'],'rejected')
    def test_apply_preserves_fields_order_and_verifies_after_propagation(self):
        before=copy.deepcopy(self.cf.state)
        result=self.run_block()
        self.assertEqual(result['status'],'verified'); self.assertEqual(self.cf.patch_count,1)
        self.assertEqual(self.cf.state['rules'][1:],before['rules'][1:])
        self.assertEqual(self.cf.state['rules'][0]['logging'],{'enabled':True})
        self.assertGreaterEqual(next(t for args,t in self.calls if args[0]=='verify'),35)
        operation=Path(result['operation_dir'])
        self.assertEqual(os.stat(operation).st_mode & 0o777,0o700)
        for p in operation.iterdir(): self.assertEqual(os.stat(p).st_mode & 0o777,0o600)
    def test_explicit_fallback_size_disabled_and_description_gates(self):
        self.cf.state['rules'][0]['expression']='x'*4090
        result=self.run_block(); self.assertEqual(result['status'],'verified')
        self.assertIn('203.0.113.7',self.cf.state['rules'][1]['expression'])
        for field,value in [('enabled',False),('action','skip'),('description','x'*501)]:
            with self.subTest(field=field):
                self.cf=CF(); self.c['cloudflare']['zones']['z']['rule_ids']=['r1']; self.cf.state['rules'][0][field]=value
                self.assertEqual(self.run_block()['status'],'rejected')
        self.cf=CF(); self.c['cloudflare']['zones']['z']['rule_ids']=['absent']
        self.assertEqual(self.run_block()['status'],'rejected')
    def test_version_drift_aborts_and_get_retry_is_bounded(self):
        self.cf.drift=True
        self.assertEqual(self.run_block()['status'],'incomplete'); self.assertEqual(self.cf.patch_count,0)
        self.cf=CF(); self.cf.get_errors=2
        self.assertEqual(self.run_block()['status'],'verified'); self.assertEqual(self.cf.patch_count,1)
    def test_real_malformed_response_is_not_retried(self):
        requests=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_GET(self):
                requests.append(self.path)
                self.send_response(200); self.end_headers(); self.wfile.write(b'SECRET invalid JSON')
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        self.c['cloudflare']['url']=f'http://127.0.0.1:{server.server_port}/client/v4'
        self.c['credentials']={'cloudflare':{'env':'FIXTURE_TOKEN'}}
        try:
            with patch.dict(os.environ,{'FIXTURE_TOKEN':'SECRET'}):
                result=self.run_block(transport=None)
            self.assertEqual(result['status'],'rejected')
            self.assertEqual(len(requests),1)
            self.assertNotIn('SECRET',json.dumps(result))
            self.assertEqual(self.clock.t,0)
        finally: server.shutdown(); server.server_close(); thread.join()

    def test_ambiguous_patch_readback_never_repatches(self):
        self.cf.timeout=True
        result=self.run_block(); self.assertEqual(result['status'],'verified'); self.assertEqual(self.cf.patch_count,1)
        self.assertEqual(self.run_block()['status'],'already_present'); self.assertEqual(self.cf.patch_count,1)
    def test_mismatch_and_health_failure_remain_incomplete(self):
        self.fail_hook='before'
        self.assertEqual(self.run_block()['status'],'incomplete'); self.assertEqual(self.cf.patch_count,0)
        self.fail_hook=None; self.cf.mismatch=True
        result=self.run_block(); self.assertEqual(result['status'],'incomplete')
        self.assertEqual(json.loads((Path(result['operation_dir'])/'operation.json').read_text())['status'],'incomplete')
    def test_post_health_and_verify_failure_recover_without_second_patch(self):
        for failure in ['verify','after']:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                self.cf=CF(); self.fail_hook=failure
                result=self.run_block(state_dir=directory); self.assertEqual(result['status'],'incomplete')
                self.fail_hook=None
                result=self.run_block(state_dir=directory); self.assertEqual(result['status'],'verified'); self.assertEqual(self.cf.patch_count,1)
    def test_restart_after_remote_patch_before_journal_update(self):
        real=common.atomic_json
        def crash(path,value):
            if value.get('status')=='applied': raise KeyboardInterrupt()
            real(path,value)
        with patch.object(block,'atomic_json',side_effect=crash):
            with self.assertRaises(KeyboardInterrupt): self.run_block()
        self.assertEqual(self.run_block()['status'],'verified'); self.assertEqual(self.cf.patch_count,1)
    def test_missing_clause_after_intent_is_not_success(self):
        self.fail_hook='verify'; result=self.run_block(); self.cf=CF(); self.fail_hook=None
        result=self.run_block(); self.assertEqual(result['status'],'incomplete'); self.assertEqual(self.cf.patch_count,0)
    def test_rollback_A_preserves_later_B_and_rejects_identity_replay(self):
        a=self.run_block(); self.run_block(['203.0.113.8'])
        self.c['cloudflare']['zones']['z']['id']='other-zone'
        count=self.cf.patch_count
        result=self.run_block(rollback=a['operation_dir']); self.assertEqual(result['status'],'rejected'); self.assertEqual(self.cf.patch_count,count)
        self.c=config()
        result=self.run_block(rollback=a['operation_dir']); self.assertEqual(result['status'],'verified')
        expr=self.cf.state['rules'][0]['expression']; self.assertNotIn('203.0.113.7',expr); self.assertIn('203.0.113.8',expr)
    def test_recovery_rejects_changed_cli_target_before_hooks(self):
        self.fail_hook='verify'; self.run_block(); self.fail_hook=None; self.calls=[]
        result=self.run_block(['203.0.113.8'])
        self.assertEqual(result['status'],'rejected'); self.assertEqual(self.calls,[]); self.assertEqual(self.cf.patch_count,1)
    def test_duplicate_clause_is_ambiguous_and_never_appended(self):
        result=self.run_block(); expr=self.cf.state['rules'][0]['expression']
        clause=json.loads((Path(result['operation_dir'])/'operation.json').read_text())['clause']
        self.cf.state['rules'][0]['expression']='('+expr+') or ('+clause+')'
        result=self.run_block()
        self.assertEqual(result['status'],'rejected'); self.assertEqual(self.cf.patch_count,1)
    def test_config_rejects_unsafe_mutation_url_and_bad_rule_ids(self):
        for change in ['url','rule_ids']:
            c=config()
            if change=='url': c['cloudflare']['url']='http://remote.invalid/api'
            else: c['cloudflare']['zones']['z']['rule_ids']=['r1',17]
            path=Path(self.tmp.name)/'config.json'; path.write_text(json.dumps(c))
            with self.assertRaises(common.SafeError): common.load_config(path)
    def test_existing_fallback_clause_prevents_duplicate_primary_patch(self):
        self.cf.state['rules'][0]['expression']='x'*4090
        self.assertEqual(self.run_block()['status'],'verified')
        self.cf.state['rules'][0]['expression']='ip.src eq 203.0.113.1'
        self.assertEqual(self.run_block()['status'],'already_present'); self.assertEqual(self.cf.patch_count,1)
    def test_nested_parameter_version_is_stable_content(self):
        self.cf.state['rules'][0]['action_parameters']={'version':'real-setting'}
        transport=self.cf
        def corrupt(method,url,body=None,timeout=30):
            result=transport(method,url,body=body,timeout=timeout)
            if method=='PATCH': self.cf.state['rules'][0]['action_parameters']['version']='changed'
            return result
        self.assertEqual(self.run_block(transport=corrupt)['status'],'incomplete')
    def test_pending_write_cannot_be_hidden_by_zone_key_alias(self):
        self.fail_hook='verify'; self.run_block(); self.fail_hook=None; self.calls=[]
        self.c['cloudflare']['zones']['alias']=copy.deepcopy(self.c['cloudflare']['zones']['z'])
        self.c['authority']['zones'].append('alias')
        result=self.run_block(zone='alias')
        self.assertEqual(result['status'],'rejected'); self.assertEqual(self.cf.patch_count,1); self.assertEqual(self.calls,[])
    def test_local_lock_and_atomic_replace_preserve_state(self):
        lock=open(Path(self.tmp.name)/'cf-writer.lock','w'); self.addCleanup(lock.close)
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        self.assertEqual(self.run_block()['status'],'rejected'); self.assertEqual(self.cf.patch_count,0)
        p=Path(self.tmp.name)/'state.json'; common.atomic_json(p,{'old':True})
        with patch.object(os,'replace',side_effect=OSError('disk')):
            with self.assertRaises(OSError): common.atomic_json(p,{'new':True})
        self.assertEqual(json.loads(p.read_text()),{'old':True})

if __name__=='__main__': unittest.main()
