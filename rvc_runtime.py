"""Lazy, single-worker RVC session with bounded IPC and idle memory release."""
import json
import queue
import threading
import time


class WarmRVCWorker:
    def __init__(self, spawn, stop, command, idle_seconds=120):
        self.spawn, self.stop, self.command = spawn, stop, command
        self.idle_seconds = idle_seconds
        self.lock = threading.RLock()
        self.request_lock = threading.Lock()
        self.session = None
        self.timer = None
        self.closed = False
        self.last_error = ''

    def _start(self):
        process = self.spawn(self.command)
        session = {'process': process, 'responses': queue.Queue(maxsize=2), 'stderr': '', 'busy': False}
        def responses():
            try:
                while line := process.stdout.readline(65537):
                    if len(line) > 65536:
                        break
                    session['responses'].put_nowait(line)
            except (OSError, ValueError, queue.Full):
                pass
            finally:
                try: session['responses'].put_nowait(None)
                except queue.Full: pass
        def diagnostics():
            try:
                while text := process.stderr.read(1024):
                    session['stderr'] = (session['stderr'] + text)[-12000:]
            except (OSError, ValueError):
                pass
        session['readers'] = [threading.Thread(target=responses, daemon=True), threading.Thread(target=diagnostics, daemon=True)]
        for reader in session['readers']: reader.start()
        self.session = session
        return session

    def _dispose(self, session):
        with self.lock:
            if session.get('disposed'): return
            session['disposed'] = True
        process = session['process']
        self.stop(process, force=True)
        try: process.wait(timeout=3)
        except Exception: pass
        for reader in session['readers']: reader.join(timeout=1)
        for pipe in (process.stdin, process.stdout, process.stderr):
            try: pipe.close()
            except OSError: pass

    def _expire(self, session):
        with self.lock:
            if self.session is not session or session['busy']:
                return
            self.session = None
        self._dispose(session)

    def infer(self, request, cancel, bind, timeout=1200):
        with self.request_lock:
            with self.lock:
                if self.closed or cancel.is_set():
                    raise RuntimeError('変換を中止しました。')
                if self.timer: self.timer.cancel()
                session = self.session or self._start()
                session['busy'] = True
                self.last_error = ''
            process = session['process']
            success = False
            try:
                bind(process)
                if cancel.is_set():
                    raise RuntimeError('変換を中止しました。')
                process.stdin.write(json.dumps(request, ensure_ascii=False) + '\n')
                process.stdin.flush()
                deadline = time.monotonic() + timeout
                while True:
                    if cancel.is_set():
                        raise RuntimeError('変換を中止しました。')
                    if time.monotonic() >= deadline:
                        raise RuntimeError('変換がタイムアウトしました。CPU設定で再試行してください。')
                    try: line = session['responses'].get(timeout=0.1)
                    except queue.Empty: continue
                    if line is None:
                        raise RuntimeError('変換エンジンが停止しました。CPU設定で再試行してください。')
                    response = json.loads(line)
                    if 'result' not in response:
                        raise RuntimeError('変換に失敗しました。CPU設定・モデル・空き容量を確認してください。')
                    success = True
                    return response['result']
            except (OSError, ValueError, TypeError) as exc:
                raise RuntimeError('変換エンジンに接続できませんでした。再試行してください。') from exc
            finally:
                with self.lock:
                    session['busy'] = False
                    if success and self.session is session and not self.closed and not cancel.is_set():
                        self.timer = threading.Timer(self.idle_seconds, self._expire, (session,))
                        self.timer.daemon = True
                        self.timer.start()
                    else:
                        if self.session is session: self.session = None
                        self._dispose(session)
                        self.last_error = session['stderr'][-12000:]

    def close(self):
        with self.lock:
            self.closed = True
            if self.timer: self.timer.cancel()
            session, self.session = self.session, None
        if session: self._dispose(session)
