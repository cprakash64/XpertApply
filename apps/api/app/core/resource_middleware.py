"""First application byte boundary, including omitted/false Content-Length."""

import asyncio
import time

from fastapi import HTTPException
from starlette.formparsers import MultiPartException
from starlette.responses import JSONResponse

from app.core import resource_controls as controls
from app.core.config import settings


class ResourceMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope["path"]
        method = scope["method"]
        b = controls.Budget(path, method)
        reset = controls.budget.set(b)
        count = 0
        overflow = False
        response_sent = False
        app_task = None
        heartbeat = None
        started = None
        complete = False
        cap = settings.upload_max_bytes + 65536 if path == "/profile/import/file" else 1024 * 1024

        async def bounded_receive():
            nonlocal count, overflow, started, complete
            if complete:
                return await receive()
            if started is None:
                started = time.monotonic()
            remaining = settings.upload_receive_timeout_seconds - (time.monotonic() - started)
            try:
                if remaining <= 0:
                    raise TimeoutError()
                msg = await asyncio.wait_for(receive(), remaining)
            except TimeoutError:
                raise MultiPartException("Request body receive deadline exceeded.") from None
            if msg["type"] == "http.request":
                complete = not msg.get("more_body", False)
                count += len(msg.get("body", b""))
                if count > cap:
                    overflow = True
                    # Starlette closes partially written spooled multipart files
                    # on this exception. No subsequent attacker bytes are read.
                    raise MultiPartException("Request exceeds the permitted size.")
            return msg

        async def bounded_send(msg):
            nonlocal response_sent
            if overflow:
                if not response_sent:
                    controls.limit_error("UPLOAD_BODY_TOO_LARGE", 413)
                    await JSONResponse(
                        {
                            "detail": "The document or request exceeds its size limit.",
                            "error": {"code": "UPLOAD_BODY_TOO_LARGE", "retryable": False},
                        },
                        status_code=413,
                    )(scope, receive, send)
                    response_sent = True
                return
            await send(msg)

        try:
            # The raw ASGI peer is used; forwarding headers never select keys.
            # Startup disables Uvicorn's forwarding-header rewrite as well.
            public = None
            if path == "/auth/login":
                public = controls.Policy(
                    "login", settings.auth_login_per_minute, aggregate=600, global_slots=16, user_slots=2
                )
            elif path == "/auth/signup":
                public = controls.Policy(
                    "signup", settings.auth_signup_per_hour, window=3600, aggregate=300, global_slots=8, user_slots=1
                )
            elif path.startswith("/auth/google/") or path == "/applications/token":
                public = controls.Policy("auth_exchange", 30, aggregate=300, global_slots=16, user_slots=2)
            elif path.startswith("/jobs/companies/") and path.endswith("/logo"):
                public = controls.Policy("public_logo", 60, aggregate=600, global_slots=8, user_slots=2)
            if public:
                peer = (scope.get("client") or ("unknown", 0))[0]
                b.leases.append(await controls.async_admit(public, "peer:" + peer))

            async def renew_leases():
                while True:
                    await asyncio.sleep(30)
                    for lease in list(b.leases):
                        await asyncio.to_thread(controls.store.renew, *lease)

            app_task = asyncio.create_task(self.app(scope, bounded_receive, bounded_send))
            heartbeat = asyncio.create_task(renew_leases())
            done, _ = await asyncio.wait([app_task, heartbeat], return_when=asyncio.FIRST_COMPLETED)
            if heartbeat in done:
                await heartbeat  # Redis failure cancels active work, never fail open.
            await app_task
        except HTTPException as exc:
            await JSONResponse(
                {
                    "detail": exc.detail,
                    "error": {
                        "code": exc.headers.get("X-Error-Code", "RESOURCE_LIMIT"),
                        "retryable": exc.status_code in (429, 503),
                    },
                },
                status_code=exc.status_code,
                headers=exc.headers,
            )(scope, receive, send)
        finally:
            tasks = [t for t in (app_task, heartbeat) if t is not None]
            for task in tasks:
                if not task.done():
                    task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            with b.lock:
                b.closed = True
                leases = list(reversed(b.leases))
            for lease in leases:
                controls.store.release(*lease)
            controls.budget.reset(reset)
