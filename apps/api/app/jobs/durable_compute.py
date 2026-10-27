"""Pure bounded deterministic compute; no database or provider credentials."""

from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict
from types import SimpleNamespace


def compute(payload):
    from app.jobs.job_matching_service import ProfileView
    from app.jobs.job_search_criteria_service import SearchCriteria
    from app.jobs.scoring_intents import SyntheticResult
    from app.jobs.scoring_service import _compute_match

    if payload["profile_incomplete"]:
        return asdict(SyntheticResult(None, profile_incomplete=True))
    profile = ProfileView(**payload["profile"])
    criteria = SearchCriteria.model_validate(payload["criteria"])
    view = payload["job"]
    job = SimpleNamespace(
        title=view["title"],
        description_clean=view["description"],
        required_skills=view["required_skills"],
        preferred_skills=view["preferred_skills"],
        location=view["location"],
        remote_type=view["workplace_type"],
        seniority_level=view["seniority"],
        work_authorization_notes=view["work_authorization_notes"],
    )
    result = _compute_match(profile, job, criteria)
    return asdict(
        SyntheticResult(
            float(result.fit_score),
            fit_summary="; ".join(result.match_reasons) or "Reviewed against your profile.",
            fit_label=result.fit_label,
            reasons=tuple(result.match_reasons),
            gaps=tuple(result.missing_skills),
            risks=tuple(result.risk_factors),
            resume_angle=result.recommended_resume_angle,
            confidence=result.confidence,
        )
    )


def main():
    # Linux production worker only. Do not silently omit process resource bounds.
    if sys.platform != "linux":
        return 2
    import ctypes
    import resource
    import signal

    parent = int(sys.argv[1])
    if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        return 2
    if os.getppid() != parent:
        return 2
    resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
    try:
        blob = sys.stdin.buffer.read(262145)
        if len(blob) > 262144:
            output = {"error": "INPUT_TOO_LARGE"}
        else:
            output = {"result": compute(json.loads(blob))}
        encoded = json.dumps(output, allow_nan=False).encode()
        if len(encoded) > 65536:
            output = {"error": "INPUT_INVALID"}
            encoded = json.dumps(output).encode()
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()
        return 0
    except (KeyError, ValueError, TypeError):
        sys.stdout.write('{"error":"INPUT_INVALID"}')
        return 0
    except MemoryError:
        sys.stdout.write('{"error":"INPUT_TOO_LARGE"}')
        return 0
    except Exception:  # Never serialize exception contents or scorer inputs.
        sys.stdout.write('{"error":"INTERNAL_SCORING_ERROR"}')
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
