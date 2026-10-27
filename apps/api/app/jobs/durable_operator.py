"""Host-authorized internal recovery CLI; no public administration endpoint.

Requires existing backend environment/DB access. No extra-cycle grant or raw SQL.
"""

import argparse
import json

from app.jobs.durable_runner import runtime_service


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("inspect", "recover", "cancel", "retire"))
    parser.add_argument("--intent-id", type=int)
    parser.add_argument("--batch-size", type=int, default=100, choices=range(1, 101))
    args = parser.parse_args(argv)
    durable = runtime_service()
    if args.action == "inspect":
        result = durable.telemetry()
    elif args.action == "recover":
        from app.db.session import SessionLocal
        from app.jobs.scheduled_ingestion import recover_abandoned_runs

        result = {
            "expired": durable.recover_expired(batch_size=args.batch_size),
            "reconciled": durable.reconcile(batch_size=args.batch_size),
            "orphaned_ingestion_runs": recover_abandoned_runs(SessionLocal, batch_size=args.batch_size),
        }
    elif args.action == "cancel":
        if args.intent_id is None or args.intent_id < 1:
            parser.error("cancel requires positive --intent-id")
        result = {"terminalized": durable.invalidate(args.intent_id, batch_size=args.batch_size)}
    else:
        result = {"retired_roots": durable.retire_terminal(batch_size=args.batch_size)}
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
