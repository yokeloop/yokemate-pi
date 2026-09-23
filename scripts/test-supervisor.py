#!/usr/bin/env python3
import argparse
import ctypes
import errno
import fcntl
import json
import os
import pathlib
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

PR_SET_CHILD_SUBREAPER = 36
ABSOLUTE_ENV = "YOKEMATE_TEST_ABSOLUTE_DEADLINE"
RESOURCE_ROOT_ENV = "YOKEMATE_TEST_RESOURCE_ROOT"
REGISTRY_ENV = "YOKEMATE_TEST_RESOURCE_REGISTRY"
ADMISSION_ENV = "YOKEMATE_TEST_ADMISSION_HELD"


def process_identity(pid):
    try:
        raw = pathlib.Path(f"/proc/{pid}/stat").read_text()
        tail = raw[raw.rfind(")") + 2:].split()
        return {"pid": pid, "ppid": int(tail[1]), "pgrp": int(tail[2]), "session": int(tail[3]), "starttime": tail[19]}
    except (FileNotFoundError, ProcessLookupError, PermissionError, ValueError, IndexError):
        return None


def process_matches(identity):
    current = process_identity(identity["pid"])
    return current is not None and current["starttime"] == identity["starttime"]


def descendants(supervisor_pid, root_identity, known):
    table = {}
    for entry in pathlib.Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        identity = process_identity(int(entry.name))
        if identity:
            table[identity["pid"]] = identity
    owned = {pid for pid, identity in known.items() if process_matches(identity)}
    if process_matches(root_identity):
        owned.add(root_identity["pid"])
    changed = True
    while changed:
        changed = False
        for pid, identity in table.items():
            if pid in owned:
                continue
            if identity["ppid"] in owned or identity["ppid"] == supervisor_pid:
                owned.add(pid)
                changed = True
    result = {}
    for pid in owned:
        identity = table.get(pid)
        if identity:
            result[pid] = identity
    known.update(result)
    return result


def signal_identity(identity, signo):
    if not process_matches(identity):
        return
    try:
        os.kill(identity["pid"], signo)
    except ProcessLookupError:
        pass


def reap_identities(identities):
    for identity in identities.values():
        try:
            os.waitpid(identity["pid"], os.WNOHANG)
        except (ChildProcessError, ProcessLookupError):
            pass


def terminate_owned_tree(supervisor_pid, root_identity, known, cleanup_timeout):
    deadline = time.monotonic() + cleanup_timeout
    owned = descendants(supervisor_pid, root_identity, known)
    for identity in owned.values():
        signal_identity(identity, signal.SIGTERM)
    term_deadline = min(deadline, time.monotonic() + min(5.0, cleanup_timeout * 0.6))
    while time.monotonic() < term_deadline:
        reap_identities(owned)
        owned = descendants(supervisor_pid, root_identity, known)
        if not owned:
            return []
        time.sleep(0.02)
    for identity in owned.values():
        signal_identity(identity, signal.SIGKILL)
    while time.monotonic() < deadline:
        reap_identities(owned)
        owned = descendants(supervisor_pid, root_identity, known)
        if not owned:
            return []
        time.sleep(0.02)
    return list(owned.values())


def safe_root(path):
    candidate = pathlib.Path(path)
    parent = candidate.parent.resolve()
    resolved = candidate.resolve(strict=False)
    return resolved.parent == parent and not candidate.is_symlink()


def cleanup_resources(root, registry):
    root_path = pathlib.Path(root)
    allowed = []
    try:
        lines = pathlib.Path(registry).read_text().splitlines()
    except FileNotFoundError:
        lines = []
    for line in lines:
        try:
            item = json.loads(line)
            candidate = pathlib.Path(item["path"])
            candidate.relative_to(root_path)
            allowed.append(candidate)
        except (json.JSONDecodeError, KeyError, ValueError):
            continue
    for candidate in sorted(allowed, key=lambda value: len(value.parts), reverse=True):
        try:
            if candidate.is_symlink() or candidate.is_file() or candidate.is_socket():
                candidate.unlink(missing_ok=True)
            elif candidate.is_dir():
                shutil.rmtree(candidate)
        except OSError:
            pass
    if safe_root(root):
        shutil.rmtree(root, ignore_errors=True)


def remaining_absolute(default_seconds):
    now = time.monotonic()
    raw = os.environ.get(ABSOLUTE_ENV)
    deadline = float(raw) if raw else now + default_seconds
    return deadline, max(0.0, deadline - now)


def supervise(command, timeout, cleanup_timeout, resource_root=None, absolute_timeout=1500.0):
    if sys.platform != "linux":
        print("test supervisor requires Linux", file=sys.stderr)
        return 1, False
    ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)
    absolute_deadline, absolute_remaining = remaining_absolute(absolute_timeout)
    active_timeout = min(timeout, max(0.0, absolute_remaining - cleanup_timeout))
    if active_timeout <= 0:
        print("watchdog: absolute deadline exhausted before start", file=sys.stderr)
        return 124, False
    env = dict(os.environ)
    env[ABSOLUTE_ENV] = str(absolute_deadline)
    owned_root = resource_root or tempfile.mkdtemp(prefix="ym284-supervisor-")
    pathlib.Path(owned_root).mkdir(parents=True, exist_ok=True)
    registry = str(pathlib.Path(owned_root) / "resources.jsonl")
    pathlib.Path(registry).touch(mode=0o600, exist_ok=True)
    env[RESOURCE_ROOT_ENV] = owned_root
    env[REGISTRY_ENV] = registry
    child = subprocess.Popen(command, env=env, start_new_session=True)
    root_identity = process_identity(child.pid)
    if root_identity is None:
        return 1, False
    known = {child.pid: root_identity}
    interrupted = {"signal": None}

    def handle_signal(signo, _frame):
        interrupted["signal"] = signo

    previous = {}
    for signo in (signal.SIGINT, signal.SIGTERM):
        previous[signo] = signal.signal(signo, handle_signal)
    deadline = time.monotonic() + active_timeout
    timed_out = False
    try:
        while child.poll() is None and interrupted["signal"] is None:
            current = descendants(os.getpid(), root_identity, known)
            reap_identities({pid: identity for pid, identity in current.items() if pid != child.pid})
            if time.monotonic() >= deadline:
                timed_out = True
                break
            time.sleep(0.02)
        direct_code = child.poll()
        owned = descendants(os.getpid(), root_identity, known)
        leftovers = [identity for pid, identity in owned.items() if pid != child.pid or direct_code is None]
        settle_deadline = min(absolute_deadline, time.monotonic() + 0.25)
        while direct_code is not None and leftovers and time.monotonic() < settle_deadline:
            reap_identities({identity["pid"]: identity for identity in leftovers})
            time.sleep(0.02)
            owned = descendants(os.getpid(), root_identity, known)
            leftovers = [identity for pid, identity in owned.items() if pid != child.pid]
        cleanup_needed = timed_out or interrupted["signal"] is not None or direct_code is None or bool(leftovers)
        remaining = max(0.1, min(cleanup_timeout, absolute_deadline - time.monotonic()))
        survivors = terminate_owned_tree(os.getpid(), root_identity, known, remaining) if cleanup_needed else []
        reap_identities(known)
        clean = len(survivors) == 0
        if clean:
            cleanup_resources(owned_root, registry)
        else:
            print("failed cleanup: " + json.dumps(survivors, sort_keys=True), file=sys.stderr)
        if interrupted["signal"] == signal.SIGINT:
            return 130, clean
        if interrupted["signal"] == signal.SIGTERM:
            return 143, clean
        if timed_out:
            print(f"watchdog: deadline exceeded after {active_timeout:.3f}s", file=sys.stderr)
            return 124, clean
        if not clean or leftovers:
            if leftovers:
                print("resource failure: descendants remained after file exit: " + json.dumps(leftovers, sort_keys=True), file=sys.stderr)
            return 1, clean
        return direct_code if direct_code is not None else 1, clean
    finally:
        for signo, handler in previous.items():
            signal.signal(signo, handler)


def secure_admission(root):
    root_path = pathlib.Path(root)
    if root_path.exists():
        info = root_path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise RuntimeError("admission root is not an owned directory")
        os.chmod(root_path, 0o700)
    else:
        root_path.mkdir(mode=0o700, parents=False)
    lock_path = root_path / "runtime.lock"
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(lock_path, flags, 0o600)
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        os.close(descriptor)
        raise RuntimeError("admission lock is not an owned regular file")
    os.fchmod(descriptor, 0o600)
    return descriptor, root_path / "owner.json"


def acquire_runtime_admission(root, timeout):
    descriptor, owner_path = secure_admission(root)
    deadline = time.monotonic() + timeout
    while True:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                os.close(descriptor)
                raise TimeoutError("admission_timeout")
            time.sleep(0.05)
    prior = None
    try:
        prior = json.loads(owner_path.read_text())
    except FileNotFoundError:
        pass
    except json.JSONDecodeError:
        prior = {"outcome": "unclear"}
    if prior and prior.get("outcome") not in ("clean",):
        pid = prior.get("pid")
        starttime = prior.get("starttime")
        if pid and starttime and process_matches({"pid": pid, "starttime": starttime}):
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)
            raise RuntimeError("admission owner record conflicts with acquired lock")
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)
        raise RuntimeError("admission_dirty")
    identity = process_identity(os.getpid())
    record = {"runId": str(uuid.uuid4()), "uid": os.getuid(), "bootId": pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip(), "pid": os.getpid(), "starttime": identity["starttime"], "phase": "runtime", "outcome": "running"}
    temporary = owner_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(record, sort_keys=True))
    os.chmod(temporary, 0o600)
    os.replace(temporary, owner_path)
    return descriptor, owner_path, record


def finish_admission(descriptor, owner_path, record, clean):
    record["outcome"] = "clean" if clean else "dirty"
    record["finishedAt"] = time.time()
    temporary = owner_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(record, sort_keys=True))
    os.chmod(temporary, 0o600)
    os.replace(temporary, owner_path)
    fcntl.flock(descriptor, fcntl.LOCK_UN)
    os.close(descriptor)


def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("suite", "worker", "runtime"))
    parser.add_argument("--timeout", type=float)
    parser.add_argument("--active-timeout", type=float)
    parser.add_argument("--admission-timeout", type=float, default=750.0)
    parser.add_argument("--cleanup-timeout", type=float, default=30.0)
    parser.add_argument("--absolute-timeout", type=float, default=1500.0)
    parser.add_argument("--admission-root")
    try:
        separator = sys.argv.index("--")
    except ValueError:
        parser.error("a command is required after --")
    args = parser.parse_args(sys.argv[1:separator])
    args.command = sys.argv[separator + 1:]
    if not args.command:
        parser.error("a command is required after --")
    return args


def main():
    args = parse_arguments()
    if args.mode == "runtime":
        root = args.admission_root or f"/tmp/yokemate-tests-{os.getuid()}"
        admission_started = time.monotonic()
        try:
            descriptor, owner_path, record = acquire_runtime_admission(root, args.admission_timeout)
        except TimeoutError as error:
            print(str(error), file=sys.stderr)
            return 124
        except RuntimeError as error:
            print(str(error), file=sys.stderr)
            return 1
        os.environ[ADMISSION_ENV] = "1"
        os.environ["YOKEMATE_TEST_ADMISSION_WAIT_MS"] = str(round((time.monotonic() - admission_started) * 1000))
        try:
            code, clean = supervise(args.command, args.active_timeout or 720.0, args.cleanup_timeout, absolute_timeout=args.absolute_timeout)
            finish_admission(descriptor, owner_path, record, clean)
            return code
        except BaseException:
            finish_admission(descriptor, owner_path, record, False)
            raise
    timeout = args.timeout or (600.0 if args.mode == "worker" else args.absolute_timeout)
    code, _clean = supervise(args.command, timeout, args.cleanup_timeout, absolute_timeout=args.absolute_timeout)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
