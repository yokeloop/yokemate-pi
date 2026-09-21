#!/usr/bin/env python3
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

command = json.loads(base64.b64decode(os.environ["WORKFLOW_PTY_COMMAND"]).decode("utf-8"))
cwd = os.environ["WORKFLOW_PTY_CWD"]
pid, master = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(command[0], command, os.environ)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 120, 0, 0))
buffer = ""
limit = 256 * 1024

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()

def read_pty(timeout):
    global buffer
    ready, _, _ = select.select([master], [], [], timeout)
    if not ready:
        return True
    try:
        chunk = os.read(master, 65536)
    except OSError:
        return False
    if not chunk:
        return False
    buffer = (buffer + chunk.decode("utf-8", "ignore"))[-limit:]
    return True

def wait_for(needle, timeout):
    deadline = time.monotonic() + timeout
    while needle not in buffer and time.monotonic() < deadline:
        if not read_pty(min(0.05, max(0, deadline - time.monotonic()))):
            break
    return needle in buffer

emit({"event": "ready", "pid": pid})
try:
    for line in sys.stdin:
        request = json.loads(line)
        ident = request.get("id")
        action = request.get("action")
        if action == "write":
            os.write(master, request.get("text", "").encode("utf-8"))
            emit({"id": ident, "ok": True})
        elif action == "enter":
            os.write(master, b"\r")
            emit({"id": ident, "ok": True})
        elif action == "key":
            os.write(master, base64.b64decode(request["data"]))
            emit({"id": ident, "ok": True})
        elif action == "wait":
            emit({"id": ident, "found": wait_for(request["needle"], float(request.get("timeout", 10)))})
        elif action == "snapshot":
            read_pty(0)
            emit({"id": ident, "contains": [needle in buffer for needle in request.get("needles", [])], "bytes": len(buffer.encode("utf-8"))})
        elif action == "signal":
            os.kill(pid, signal.SIGTERM)
            emit({"id": ident, "ok": True})
        elif action == "terminate":
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            emit({"id": ident, "ok": True})
            break
finally:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        ended, _ = os.waitpid(pid, os.WNOHANG)
        if ended:
            break
        read_pty(0.05)
    else:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
    os.close(master)
