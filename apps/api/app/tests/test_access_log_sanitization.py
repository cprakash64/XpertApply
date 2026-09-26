from __future__ import annotations

import socket
import subprocess
import sys
import time

import httpx


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def test_real_uvicorn_access_log_never_serializes_query_values() -> None:
    port = _free_port()
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--no-use-colors",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    canaries = [
        ("/auth/google/callback", "code=CANARY_CODE&state=CANARY_STATE"),
        ("/some/path", "token=CANARY_TOKEN"),
        ("/some/path", "password=CANARY_PASSWORD&normal=value"),
        ("/encoded", "value=CANARY%5FENCODED"),
        ("/multiple", "a=one&a=two&b=three"),
        ("/long", "value=" + "x" * 4096),
    ]
    try:
        deadline = time.monotonic() + 15
        while True:
            try:
                response = httpx.get(f"http://127.0.0.1:{port}/healthz", timeout=0.5)
                if response.status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            if process.poll() is not None or time.monotonic() >= deadline:
                raise AssertionError("Uvicorn did not become ready")
            time.sleep(0.05)

        for path, query in canaries:
            httpx.get(f"http://127.0.0.1:{port}{path}?{query}", timeout=2)
    finally:
        process.terminate()
        output, _ = process.communicate(timeout=10)

    for path, _query in canaries:
        assert f"GET {path} HTTP/1.1" in output
    assert "CANARY" not in output
    assert "?" not in "\n".join(line for line in output.splitlines() if 'HTTP/1.1"' in line)
