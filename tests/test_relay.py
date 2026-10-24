import asyncio
import unittest
from contextlib import AsyncExitStack

from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from relay.relay import Relay


class RelayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.relay = Relay()
        self.server = await serve(self.relay.handle, "127.0.0.1", 0, compression=None)
        self.url = f"ws://127.0.0.1:{self.server.sockets[0].getsockname()[1]}"

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()

    async def online(self, count):
        for _ in range(100):  # the server registers a client just after the handshake completes
            if len(self.relay.clients) == count:
                return
            await asyncio.sleep(.01)
        self.fail(f"relay never reached {count} clients, has {len(self.relay.clients)}")

    async def join(self, stack, count):
        client = await stack.enter_async_context(connect(self.url, proxy=None))
        await self.online(count)
        return client

    async def silent(self, client):
        with self.assertRaises(TimeoutError):
            await asyncio.wait_for(client.recv(), .05)

    async def test_forwards_to_every_other_client_but_not_the_sender(self):
        async with AsyncExitStack() as stack:
            a, b, c = [await self.join(stack, n) for n in (1, 2, 3)]
            await a.send('{"type":"state","user":"A"}')
            for other in (b, c):
                self.assertEqual(await asyncio.wait_for(other.recv(), 1), '{"type":"state","user":"A"}')
            await self.silent(a)

    async def test_messages_pass_through_untouched(self):
        async with AsyncExitStack() as stack:
            a, b = [await self.join(stack, n) for n in (1, 2)]
            for text in ("not json at all", '{"a": 1,   "b": [1.50, "é"]}'):
                await a.send(text)
                self.assertEqual(await asyncio.wait_for(b.recv(), 1), text)

    async def test_a_departing_client_does_not_affect_the_others(self):
        async with AsyncExitStack() as stack:
            a, b = [await self.join(stack, n) for n in (1, 2)]
            async with connect(self.url, proxy=None):
                await self.online(3)
            await self.online(2)
            await a.send("still here")
            self.assertEqual(await asyncio.wait_for(b.recv(), 1), "still here")

    async def test_keeps_no_state_for_late_joiners(self):
        async with AsyncExitStack() as stack:
            a = await self.join(stack, 1)
            await a.send('{"type":"scene"}')
            await asyncio.sleep(.05)
            late = await self.join(stack, 2)
            await self.silent(late)  # catching up is the host's job: it rebroadcasts the scene about every 100 ms


if __name__ == "__main__":
    unittest.main()
