"""Run: python relay/relay.py. Forwards every message to every other client; no parsing, no state.

Ordering, ownership and the scene live in the browsers (see CLAUDE.md). Run it on laptop A only.
"""

import argparse
import asyncio

from websockets.asyncio.server import broadcast, serve
from websockets.exceptions import ConnectionClosed

# The host's scene is mostly poses now (a few KB), but a full scene with every recipe can reach ~0.5 MB at the
# object cap, and the library default of 1 MiB would drop the connection. Headroom, not a target.
MAX_MESSAGE_BYTES = 4 * 1024 * 1024
SERVER_OPTIONS = dict(compression=None, max_size=MAX_MESSAGE_BYTES)


class Relay:
    def __init__(self):
        self.clients = set()

    async def handle(self, websocket):
        self.clients.add(websocket)
        print(f"Client connected ({len(self.clients)} online)", flush=True)
        try:
            async for message in websocket:
                broadcast(self.clients - {websocket}, message)
        except ConnectionClosed:
            pass  # an abnormal close (a message over the limit, a dropped link); the client is removed below
        finally:
            self.clients.discard(websocket)
            print(f"Client left ({len(self.clients)} online)", flush=True)


async def run(host="0.0.0.0", port=8765):
    async with serve(Relay().handle, host, port, close_timeout=1, **SERVER_OPTIONS) as server:
        print(f"Relay listening on ws://{host}:{port}; Ctrl+C to stop.", flush=True)
        await server.serve_forever()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="0.0.0.0", help="Interface to listen on (default: all, so the LAN can reach it)")
    parser.add_argument("--port", type=int, default=8765, help="WebSocket port (default: 8765)")
    args = parser.parse_args()
    try:
        asyncio.run(run(args.host, args.port))
    except KeyboardInterrupt:
        pass
    except OSError as exc:
        raise SystemExit(f"Relay stopped: {exc}") from exc


if __name__ == "__main__":
    main()
