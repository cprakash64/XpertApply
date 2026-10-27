"""One internally named file, one bounded result; no network or user paths."""

import json
import sys
from pathlib import Path

from app.core.config import settings


def main():
    # Hard address-space and CPU limits are authoritative on Linux production.
    # macOS address-space enforcement is not equivalent; wall termination and
    # structural limits remain enforced there. Do not advertise a macOS RSS cap.
    if sys.platform == "linux":
        import resource

        memory = settings.document_memory_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
        cpu = int(settings.document_timeout_seconds) + 1
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
        resource.setrlimit(resource.RLIMIT_FSIZE, (settings.document_max_chars * 8 + 4096,) * 2)
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    sys.setrecursionlimit(1000)
    from fastapi import UploadFile
    from starlette.datastructures import Headers

    from app.services.document_parser import DocumentLimitError, extract_uploaded_file_text

    source, output, extension, mime = sys.argv[1:]
    try:
        with open(source, "rb") as stream:
            content = stream.read(settings.upload_max_bytes + 1)
        file = UploadFile(filename="document" + extension, file=None, headers=Headers({"content-type": mime}))
        result = {"text": extract_uploaded_file_text(file, content)}
    except DocumentLimitError:
        result = {"limit": True}
    except (MemoryError, RecursionError):
        result = {"limit": True}
    except Exception:
        # No exception string/traceback or uploaded content enters the protocol.
        result = {"error": True}
    Path(output).write_text(json.dumps(result, ensure_ascii=True), encoding="utf-8")


if __name__ == "__main__":
    main()
