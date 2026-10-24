import asyncio
import copy
import io
import json
import math
import unittest
import wave
from unittest.mock import patch

import aiohttp
from aiohttp import web
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from voice.layout import half_extents, resolve
from voice.main import handle, validate_wav
from voice.muse import Muse
from voice.planner import generate


def part(id, size, **fields):
    return {"id": id, "shape": "box", "size": size, "position": [0, 0, 0],
            "rotation": [0, 0, 0], "color": "#4c6ef5", "placement": "absolute", "target": "", "inset": 0,
            **fields}


def chair():
    return {"name": "Blue chair", "maxDimension": None, "parts": [
        part("seat", [.5, .08, .5]),
        part("back", [.5, .45, .08], placement="above", target="seat", position=[0, 0, -.21]),
        part("legs", [.06, .4, .06], placement="corners_below", target="seat", inset=.02),
    ]}


def wav(rate=24000, duration=.2):
    data = io.BytesIO()
    with wave.open(data, "wb") as audio:
        audio.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        audio.writeframes(bytes(int(rate * duration) * 2))
    return data.getvalue()


class LayoutTests(unittest.TestCase):
    def test_chair_is_symmetric_connected_grounded_and_scaled(self):
        spec = resolve(chair())
        self.assertEqual(len(spec["parts"]), 6)
        seat, back, *legs = spec["parts"]
        self.assertAlmostEqual(back["position"][1] - back["size"][1]/2,
                               seat["position"][1] + seat["size"][1]/2)
        for leg in legs:
            self.assertAlmostEqual(leg["position"][1] + leg["size"][1]/2,
                                   seat["position"][1] - seat["size"][1]/2)
            self.assertAlmostEqual(leg["position"][1] - leg["size"][1]/2, 0)
        self.assertAlmostEqual(legs[0]["position"][0], -legs[3]["position"][0])
        self.assertAlmostEqual(legs[0]["position"][2], -legs[3]["position"][2])
        height = max(p["position"][1] + p["size"][1]/2 for p in spec["parts"])
        self.assertAlmostEqual(height, .8)

    def test_forward_references_and_rotated_bounds(self):
        plan = {"name": "Rotated stand", "maxDimension": 1.5, "parts": [
            part("top", [.1, .1, .1], placement="above", target="post"),
            part("post", [.2, 1, .3], rotation=[0, 0, 90]),
        ]}
        spec = resolve(plan)
        low, high = [], []
        for p in spec["parts"]:
            half = half_extents(p["size"], p["quaternion"])
            low.append([p["position"][i] - half[i] for i in range(3)])
            high.append([p["position"][i] + half[i] for i in range(3)])
            self.assertAlmostEqual(sum(v*v for v in p["quaternion"]), 1)
        self.assertAlmostEqual(min(p[1] for p in low), 0)
        self.assertAlmostEqual(max(max(p[i] for p in high) - min(p[i] for p in low) for i in range(3)), 1.5)
        self.assertAlmostEqual(low[0][1], high[1][1])

    def test_invalid_relationships_repetition_and_nonfinite_values(self):
        bad = []
        p = chair(); p["parts"][0].update(placement="above", target="back"); bad.append(p)
        p = chair(); p["parts"][1]["target"] = "missing"; bad.append(p)
        p = chair(); p["parts"][1]["target"] = "legs"; bad.append(p)
        p = chair(); p["parts"][2]["inset"] = 1; bad.append(p)
        p = chair(); p["parts"].append(copy.deepcopy(p["parts"][0])); bad.append(p)
        p = chair(); p["parts"][0]["position"][0] = math.nan; bad.append(p)
        p = chair(); p["parts"] += [part(f"support{i}", [.01]*3, placement="corners_below", target="seat") for i in range(10)]; bad.append(p)
        for plan in bad:
            with self.subTest(plan=plan), self.assertRaises(ValueError):
                resolve(plan)

    def test_wav_limits_and_encoding(self):
        validate_wav(wav())
        for data in (b"not wav", wav(rate=48000), wav(duration=.01), wav(duration=17), wav()[:-20]):
            with self.assertRaises(ValueError):
                validate_wav(data)


class FakeMuse:
    key = "test-key"

    def __init__(self):
        self.calls = []

    async def transcribe(self, audio):
        validate_wav(audio)
        return "A blue chair"

    async def plan(self, messages):
        self.calls.append(copy.deepcopy(messages))
        return chair()


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_one_repair_for_spatial_error(self):
        muse = FakeMuse()
        invalid = chair()
        invalid["parts"][1]["target"] = "missing"
        responses = iter([invalid, chair()])

        async def plan(messages):
            muse.calls.append(copy.deepcopy(messages))
            return next(responses)

        muse.plan = plan
        spec = await generate(muse, "chair")
        self.assertEqual(len(spec["parts"]), 6)
        self.assertIn("Unknown placement target", muse.calls[1][-1]["content"])

    async def test_real_websocket_text_audio_undo_and_error_recovery(self):
        muse = FakeMuse()
        async with serve(lambda ws: handle(ws, muse), "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            async with connect(f"ws://127.0.0.1:{port}") as ws:
                async def recv():
                    return json.loads(await asyncio.wait_for(ws.recv(), 3))
                self.assertEqual((await recv())["type"], "ready")
                await ws.send('{"type":"generate","text":"chair"}')
                self.assertEqual((await recv())["stage"], "designing")
                self.assertEqual(len((await recv())["spec"]["parts"]), 6)
                await ws.send(wav())
                self.assertEqual((await recv())["stage"], "transcribing")
                self.assertEqual((await recv())["text"], "A blue chair")
                self.assertEqual((await recv())["stage"], "designing")
                self.assertEqual((await recv())["type"], "object")
                await ws.send('[]')
                self.assertEqual((await recv())["type"], "error")
                await ws.send(b"bad audio")
                self.assertEqual((await recv())["type"], "error")
                await ws.send('{"type":"generate","text":"undo"}')
                self.assertEqual((await recv())["type"], "undo")

    async def test_meta_multipart_auth_and_structured_output_contract(self):
        calls = []

        async def transcribe(request):
            self.assertEqual(request.headers["Authorization"], "Bearer test-key")
            reader = await request.multipart()
            settings = await reader.next()
            self.assertEqual(settings.name, "request")
            config = json.loads(await settings.text())
            self.assertEqual(config["audioEncoding"], "WAV")
            self.assertEqual(config["mode"], "PUSH_TO_TALK")
            self.assertEqual(config["model"], "muse-voice-transcribe-1.0")
            audio = await reader.next()
            self.assertEqual(audio.name, "audio")
            validate_wav(bytes(await audio.read()))
            return web.json_response({"transcript": "A chair"})

        async def completion(request):
            body = await request.json()
            calls.append(body)
            self.assertEqual(body["model"], "muse-wonder-1.0")
            self.assertEqual(body["response_format"]["type"], "json_schema")
            return web.json_response({"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(chair())}}]})

        app = web.Application()
        app.router.add_post('/asr/transcribe', transcribe)
        app.router.add_post('/chat/completions', completion)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, '127.0.0.1', 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        try:
            with patch('voice.muse.API_URL', f'http://127.0.0.1:{port}'), patch.dict('os.environ', {"MODEL_API_KEY": "test-key"}):
                async with aiohttp.ClientSession() as session:
                    muse = Muse(session)
                    text = await muse.transcribe(wav())
                    spec = await generate(muse, text)
                    self.assertEqual(spec["name"], "Blue chair")
                    self.assertEqual(calls[0]["messages"][1]["content"], "A chair")
        finally:
            await runner.cleanup()


if __name__ == '__main__':
    unittest.main()
