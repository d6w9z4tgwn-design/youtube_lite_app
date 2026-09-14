import json
import os
import subprocess
import sys
import threading
import time
import unittest

from rvc_runtime import WarmRVCWorker
from rvc_service import RVCService

PROGRAM = '''
import json,os,sys,time
for line in sys.stdin:
    request=json.loads(line)
    if request.get('slow'): time.sleep(10)
    if request.get('crash'): sys.exit(1)
    if request.get('malformed'):
        print('not json',flush=True)
    else:
        print(json.dumps({'result':{'pid':os.getpid(),'value':request.get('value')}}),flush=True)
'''


class WarmWorkerTests(unittest.TestCase):
    def setUp(self):
        self.processes = []
        def spawn(command):
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       text=True, start_new_session=os.name != 'nt')
            process._clipnest_group = os.name != 'nt'
            self.processes.append(process)
            return process
        self.worker = WarmRVCWorker(spawn, RVCService.stop_process, [sys.executable, '-u', '-c', PROGRAM])
        self.addCleanup(self.worker.close)

    def infer(self, request, cancel=None, timeout=3):
        return self.worker.infer(request, cancel or threading.Event(), lambda process: None, timeout=timeout)

    def test_lazy_and_reuses_one_process_for_multiple_chunks(self):
        self.assertEqual(self.processes, [])
        first = self.infer({'value': 1})
        second = self.infer({'value': 2})
        self.assertEqual(first['pid'], second['pid'])
        self.assertEqual(second['value'], 2)
        self.assertEqual(len(self.processes), 1)
        self.worker.close()
        self.assertIsNotNone(self.processes[0].poll())

    def test_cancel_before_start_never_spawns(self):
        cancel = threading.Event(); cancel.set()
        with self.assertRaisesRegex(RuntimeError, '中止'): self.infer({}, cancel)
        self.assertEqual(self.processes, [])

    def test_cancel_during_work_kills_worker_and_next_request_is_fresh(self):
        cancel = threading.Event()
        timer = threading.Timer(.15, cancel.set); timer.daemon = True; timer.start()
        try:
            began = time.monotonic()
            with self.assertRaisesRegex(RuntimeError, '中止'): self.infer({'slow': True}, cancel)
            self.assertLess(time.monotonic() - began, 3)
            self.assertIsNotNone(self.processes[0].poll())
            self.assertEqual(self.infer({'value': 'fresh'})['value'], 'fresh')
            self.assertEqual(len(self.processes), 2)
        finally: timer.cancel()

    def test_timeout_and_invalid_responses_do_not_poison_next_job(self):
        for request in ({'slow': True}, {'crash': True}, {'malformed': True}):
            with self.assertRaises(RuntimeError): self.infer(request, timeout=.2)
            self.assertIsNotNone(self.processes[-1].poll())
        self.assertEqual(self.infer({'value': 'ok'})['value'], 'ok')

    def test_idle_worker_releases_memory_and_closed_worker_cannot_restart(self):
        self.worker.idle_seconds = .02
        self.infer({})
        self.processes[0].wait(timeout=2)
        self.assertIsNone(self.worker.session)
        self.worker.close()
        with self.assertRaises(RuntimeError): self.infer({})
        self.assertEqual(len(self.processes), 1)


if __name__ == '__main__': unittest.main()
