#!/usr/bin/env python3
"""Forward container-IP:9222 -> 127.0.0.1:9222 so sidecars can reach Chrome CDP.

Modern Google Chrome ignores --remote-debugging-address=0.0.0.0 and binds CDP
strictly to 127.0.0.1:9222. Binding only the container's eth0 IP on port 9222
avoids EADDRINUSE with Chrome while keeping http://neko:9222 reachable on the
Docker compose network.
"""

from __future__ import annotations

import asyncio
import contextlib
import socket

TARGET_HOST = "127.0.0.1"
TARGET_PORT = 9222
LISTEN_PORT = 9222


def resolve_bind_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("10.255.255.255", 1))
            ip = sock.getsockname()[0]
            if ip and not ip.startswith("127."):
                return ip
    except OSError:
        pass
    ip = socket.gethostbyname(socket.gethostname())
    if ip.startswith("127."):
        raise RuntimeError(f"Container hostname resolved to loopback {ip}")
    return ip


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while chunk := await reader.read(65536):
            writer.write(chunk)
            await writer.drain()
    except (OSError, asyncio.CancelledError):
        pass
    finally:
        with contextlib.suppress(OSError):
            writer.close()


async def handle_client(
    client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter
) -> None:
    try:
        upstream_reader, upstream_writer = await asyncio.open_connection(TARGET_HOST, TARGET_PORT)
    except OSError:
        with contextlib.suppress(OSError):
            client_writer.close()
        return

    await asyncio.gather(
        pipe(client_reader, upstream_writer),
        pipe(upstream_reader, client_writer),
    )


async def main() -> None:
    bind_ip = resolve_bind_ip()
    server = await asyncio.start_server(handle_client, host=bind_ip, port=LISTEN_PORT)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
