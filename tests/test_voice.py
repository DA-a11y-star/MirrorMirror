import asyncio
import copy
import io
import json
import math
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import aiohttp
from aiohttp import web
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from voice.layout import half_extents, resolve
from voice.main import clean_command, handle, validate_wav
from voice.muse import Muse, load_env
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
            env = Path(tempfile.mkdtemp()) / ".env"
            env.write_text("MODEL_API_KEY=test-key\n")
            with patch('voice.muse.API_URL', f'http://127.0.0.1:{port}'), patch.dict('os.environ', {}, clear=True):
                async with aiohttp.ClientSession() as session:
                    muse = Muse(session, env_path=env)
                    text = await muse.transcribe(wav())
                    spec = await generate(muse, text)
                    self.assertEqual(spec["name"], "Blue chair")
                    self.assertEqual(calls[0]["messages"][1]["content"], "A chair")
        finally:
            await runner.cleanup()


class CommandCleaningTests(unittest.TestCase):
    def test_wake_phrase_and_verb_are_stripped(self):
        for spoken, expected in [
            ("Mirror mirror, make a blue chair.", "a blue chair"),
            ("Mirror, mirror, make an oak table", "an oak table"),
            ("mirror mirror build me a tall lamp!", "a tall lamp"),
            ("Mirror mirror on the wall, create a red house", "a red house"),
            ("Mirror mirror, could you give us a tree?", "a tree"),
            ("Mirror mirror, undo", "undo"),
            ("A blue chair with wooden legs", "A blue chair with wooden legs"),
            ("a table that makes sense", "a table that makes sense"),
        ]:
            self.assertEqual(clean_command(spoken), expected, spoken)

    def test_only_the_wake_phrase_leaves_nothing(self):
        self.assertEqual(clean_command("Mirror mirror."), "")
        self.assertEqual(clean_command("Mirror mirror, make"), "make")


class EnvFileTests(unittest.TestCase):
    def write(self, text):
        path = Path(tempfile.mkdtemp()) / ".env"
        path.write_text(text)
        return path

    def test_parses_comments_quotes_export_and_blank_lines(self):
        path = self.write('# MODEL_API_KEY=old-commented-out\n\nMODEL_API_KEY="abc=123"\nexport ASR_MODEL=\'asr-x\'\n  OBJECT_MODEL = obj-y  \nnot a setting\n')
        self.assertEqual(load_env(path), {"MODEL_API_KEY": "abc=123", "ASR_MODEL": "asr-x", "OBJECT_MODEL": "obj-y"})

    def test_missing_file_is_empty_not_an_error(self):
        self.assertEqual(load_env(Path(tempfile.mkdtemp()) / "nope"), {})

    def test_key_comes_from_the_env_file_which_beats_the_terminal(self):
        muse = Muse(None, env_path=self.write("MODEL_API_KEY=from-file\n"))
        with patch.dict('os.environ', {"MODEL_API_KEY": "from-terminal"}):
            self.assertEqual(muse.key, "from-file")

    def test_terminal_variable_is_only_a_fallback(self):
        muse = Muse(None, env_path=self.write("# no key here\n"))
        with patch.dict('os.environ', {"MODEL_API_KEY": "from-terminal"}):
            self.assertEqual(muse.key, "from-terminal")
        with patch.dict('os.environ', {}, clear=True):
            self.assertEqual(muse.key, "")

    def test_editing_the_file_takes_effect_without_a_restart(self):
        path = self.write("")
        muse = Muse(None, env_path=path)
        with patch.dict('os.environ', {}, clear=True):
            self.assertEqual(muse.key, "")
            path.write_text("MODEL_API_KEY=added-later\n")
            self.assertEqual(muse.key, "added-later")

    def test_model_ids_can_be_overridden_in_the_file(self):
        muse = Muse(None, env_path=self.write("OBJECT_MODEL=custom-model\n"))
        with patch.dict('os.environ', {}, clear=True):
            self.assertEqual(muse.setting("OBJECT_MODEL", "muse-wonder-1.0"), "custom-model")
            self.assertEqual(muse.setting("ASR_MODEL", "muse-voice-transcribe-1.0"), "muse-voice-transcribe-1.0")

    def test_missing_key_error_points_at_the_env_file(self):
        async def run():
            muse = Muse(None, env_path=self.write(""))
            with patch.dict('os.environ', {}, clear=True):
                with self.assertRaisesRegex(ValueError, r"\.env"):
                    await muse.post("/x")
        asyncio.run(run())


if __name__ == '__main__':
    unittest.main()
