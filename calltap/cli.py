from __future__ import annotations

import argparse
import asyncio

import uvicorn

from calltap.app import create_app
from calltap.config import Settings
from calltap.db import CallDB
from calltap.uploader import CloudUploader


def main() -> None:
    parser = argparse.ArgumentParser(prog="calltap", description="CallTap voice call proxy recorder")
    sub = parser.add_subparsers(dest="command", required=True)

    serve_p = sub.add_parser("serve", help="Run controller, monitor, uploader, and web dashboard")
    serve_p.add_argument("--host", default=None)
    serve_p.add_argument("--port", type=int, default=None)

    sub.add_parser("upload-pending", help="Run one pass of the cloud upload queue and exit")

    args = parser.parse_args()
    settings = Settings()

    if args.command == "serve":
        app = create_app(settings)
        uvicorn.run(
            app,
            host=args.host or settings.host,
            port=args.port or settings.port,
            log_level="info",
        )
    elif args.command == "upload-pending":
        settings.ensure_dirs()
        db = CallDB(settings.db_path)
        uploader = CloudUploader(settings, db)
        count = asyncio.run(uploader.process_pending_once())
        db.close()
        print(f"Processed {count} upload(s).")


if __name__ == "__main__":
    main()
