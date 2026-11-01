#!/usr/bin/env python3
"""Trusted privileged state for EXT-FINAL-03: /var/lib/xpertapply-release/extfinal03 (root:root 0700).

Same design as the NET-PROD-08 state helper: root-only, every path component opened with O_NOFOLLOW, ownership/mode/hard-link/pinned-hash
checks, no unexpected entries, nothing read from a user-writable location. It holds TWO files: the Compose override that selects the new web image and the one that
allows exactly the production extension id. The NET-PROD-03 and NET-PROD-08 state directories are left exactly as they are and are verified separately.

    extfinal03_state.py verify      read-only; exit 0 = safe and complete, 10 = not initialised, 11 = UNSAFE, 12 = metadata only (not root)
    extfinal03_state.py init        root only; creates the directory and both files (never overwrites)
    extfinal03_state.py hashes      prints the pinned SHA-256 values
"""
from __future__ import annotations

import hashlib
import os
import stat
import sys

STATE_PARTS = ("var", "lib", "xpertapply-release", "extfinal03")
STATE_PATH = "/" + "/".join(STATE_PARTS)

WEB_NAME = "compose.extfinal03-web-image.yml"
EXT_NAME = "compose.extfinal03-extension-id.yml"

# Selects the web image that carries the sign-out/account-switch teardown and the /support page. Nothing else.
WEB_TEXT = """# EXT-FINAL-03: selects the web image with the extension sign-out fix and /support. No environment is set here.
services:
  web:
    image: xpertapply-web:extfinal03-273f975-prod-amd64
    build: !reset null
    pull_policy: never
"""
# Allows exactly the production Chrome Web Store extension id to receive an authorization code. A public identifier, not a secret.
EXT_TEXT = """# EXT-FINAL-03: EXTENSION_ALLOWED_IDS is exactly the production Chrome Web Store item. Every other variable comes from earlier reviewed files and .env.
services:
  api:
    environment:
      EXTENSION_ALLOWED_IDS: '["gnibjomjfdobadlockphjiibbpmiehcj"]'
"""
EXPECTED = {WEB_NAME: WEB_TEXT.encode(), EXT_NAME: EXT_TEXT.encode()}
PINNED = {name: hashlib.sha256(data).hexdigest() for name, data in EXPECTED.items()}

OK, NOT_INITIALISED, UNSAFE, METADATA_ONLY = 0, 10, 11, 12
_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)


def verify(parts=STATE_PARTS, owner_uid: int = 0, owner_gid: int = 0, root: str = "/", can_read_final: bool | None = None):
    """Return (status, problems). Walks the path component by component with O_NOFOLLOW, so a symlink anywhere is refused."""
    problems: list[str] = []
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        st = os.fstat(fd)
        if st.st_uid != owner_uid or st.st_mode & 0o022:
            problems.append("%s is not trusted (owner %d, mode %o)" % (root, st.st_uid, stat.S_IMODE(st.st_mode)))
        for index, part in enumerate(parts):
            final = index == len(parts) - 1
            try:
                st = os.stat(part, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                return (UNSAFE if problems else NOT_INITIALISED), problems + ["missing component: %s" % part]
            except PermissionError:
                # Could not look: never "safe". A non-root user cannot traverse the root-only directory.
                return (UNSAFE if problems else METADATA_ONLY), problems
            if stat.S_ISLNK(st.st_mode):
                return UNSAFE, problems + ["symlink in the trusted path at component '%s'" % part]
            if not stat.S_ISDIR(st.st_mode):
                return UNSAFE, problems + ["component '%s' is not a directory" % part]
            if st.st_uid != owner_uid:
                problems.append("component '%s' is owned by uid %d" % (part, st.st_uid))
            if final:
                if st.st_gid != owner_gid:
                    problems.append("state directory group is %d, expected %d" % (st.st_gid, owner_gid))
                if stat.S_IMODE(st.st_mode) != 0o700:
                    problems.append("state directory mode is %o, expected 700" % stat.S_IMODE(st.st_mode))
            elif st.st_mode & 0o022:
                problems.append("parent '%s' is writable by group/others (mode %o)" % (part, stat.S_IMODE(st.st_mode)))
            if final and (can_read_final is False or (can_read_final is None and os.geteuid() != owner_uid)):
                return (UNSAFE if problems else METADATA_ONLY), problems
            nfd = os.open(part, _DIR_FLAGS, dir_fd=fd)       # refuses a symlink even if it appeared after the stat
            os.close(fd); fd = nfd
            after = os.fstat(fd)
            if (after.st_ino, after.st_dev) != (st.st_ino, st.st_dev):
                return UNSAFE, problems + ["component '%s' changed while being checked" % part]
        names = sorted(os.listdir(fd))
        unexpected = [n for n in names if n not in EXPECTED]
        if unexpected:
            problems.append("unexpected entries in the state directory: %s" % ", ".join(unexpected))
        missing = [n for n in EXPECTED if n not in names]
        for name in names:
            if name not in EXPECTED:
                continue
            fst = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISLNK(fst.st_mode) or not stat.S_ISREG(fst.st_mode):
                problems.append("%s is not a regular file" % name); continue
            if fst.st_uid != owner_uid or fst.st_gid != owner_gid or stat.S_IMODE(fst.st_mode) != 0o600:
                problems.append("%s must be root:root 0600 (is %d:%d %o)" % (name, fst.st_uid, fst.st_gid, stat.S_IMODE(fst.st_mode)))
            if fst.st_nlink != 1:
                problems.append("%s has %d hard links" % (name, fst.st_nlink))
            ffd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0), dir_fd=fd)
            try:
                data = os.read(ffd, 1 << 20)
                same = os.fstat(ffd)
            finally:
                os.close(ffd)
            if (same.st_ino, same.st_dev) != (fst.st_ino, fst.st_dev):
                problems.append("%s changed while being read" % name)
            if hashlib.sha256(data).hexdigest() != PINNED[name]:
                problems.append("%s does not match its pinned SHA-256" % name)
        if problems:
            return UNSAFE, problems
        if missing:
            return NOT_INITIALISED, ["missing files: %s" % ", ".join(missing)]
        return OK, []
    finally:
        os.close(fd)


def init(parts=STATE_PARTS, owner_uid: int = 0, owner_gid: int = 0, root: str = "/") -> None:
    """Create the trusted directory and write both files. Refuses to overwrite or to follow anything unexpected."""
    if os.geteuid() != owner_uid:
        raise SystemExit("init must run as root")
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        st = os.fstat(fd)
        if st.st_uid != owner_uid or st.st_mode & 0o022:
            raise SystemExit("refusing: %s is not a trusted directory" % root)
        for index, part in enumerate(parts):
            final = index == len(parts) - 1
            try:
                st = os.stat(part, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                if index < 2:
                    raise SystemExit("refusing to create /%s: it must already exist" % "/".join(parts[: index + 1]))
                os.mkdir(part, 0o700 if final else 0o755, dir_fd=fd)
                st = os.stat(part, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
                raise SystemExit("refusing: '%s' is not a plain directory" % part)
            nfd = os.open(part, _DIR_FLAGS, dir_fd=fd)
            os.close(fd); fd = nfd
            os.fchown(fd, owner_uid, owner_gid)
            if final:
                os.fchmod(fd, 0o700)
            elif os.fstat(fd).st_mode & 0o022:
                raise SystemExit("refusing: parent '%s' is writable by group/others" % part)
        for name, data in EXPECTED.items():
            try:
                ffd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
            except FileExistsError:
                continue                                     # verified below; never overwritten
            try:
                os.fchown(ffd, owner_uid, owner_gid); os.fchmod(ffd, 0o600)
                os.write(ffd, data); os.fsync(ffd)
            finally:
                os.close(ffd)
        os.fsync(fd)
    finally:
        os.close(fd)
    status, problems = verify(parts, owner_uid, owner_gid, root)
    if status != OK:
        raise SystemExit("verification after init failed: " + "; ".join(problems))


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "verify"
    if cmd == "hashes":
        for name, digest in PINNED.items():
            print("%s  %s" % (digest, name))
        return 0
    if cmd == "init":
        init()
        print("state directory %s initialised (root:root 0700; 2 files root:root 0600; pinned hashes verified)" % STATE_PATH)
        return 0
    if cmd == "verify":
        status, problems = verify()
        label = {OK: "OK", NOT_INITIALISED: "NOT INITIALISED", UNSAFE: "UNSAFE", METADATA_ONLY: "metadata only (run as root to verify the files)"}[status]
        print("state %s: %s" % (STATE_PATH, label))
        for problem in problems:
            print("  - " + problem)
        return status
    print("usage: extfinal03_state.py verify|init|hashes", file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv))
