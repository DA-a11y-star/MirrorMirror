"""Run: python -m voice.main. Separate from sensing so model requests cannot stall tracking."""

import argparse
import asyncio
import io
import json
import re
import ssl
import time
import wave

import aiohttp
import certifi
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from voice.muse import Muse
from voice.planner import generate

MAX_AUDIO_BYTES = 24_000 * 2 * 16 + 1024


def validate_wav(data):
    try:
        with wave.open(io.BytesIO(data), "rb") as audio:
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, 24000, "NONE"):
                raise ValueError("Audio must be mono 16-bit PCM WAV at 24 kHz")
            frames = audio.getnframes()
            if not 2400 <= frames <= 24_000 * 16:
                raise ValueError("Record between 0.1 and 16 seconds")
            if len(audio.readframes(frames)) != frames * 2:
                raise ValueError("Incomplete WAV recording")
    except (wave.Error, EOFError) as exc:
        raise ValueError("Invalid WAV recording") from exc


WAKE = re.compile(r"^\W*mirror[\s,.\-]+mirror\b(?:\W+on the wall\b)?[\s,.:;!?\-]*", re.I)
VERB = re.compile(r"^(?:(?:please|hey)\W+)?(?:(?:can|could|would) you\s+)?(?:make|build|create|generate|give|get|add|summon|spawn)(?:\s+(?:me|us))?\s+", re.I)


def clean_command(text):
    """'Mirror mirror, make a blue chair.' -> 'a blue chair'. Leaves text without the wake phrase or a verb alone."""
    text = WAKE.sub("", text.strip(), count=1)
    text = VERB.sub("", text, count=1)
    return text.strip(" ,.;:!?-\t\n")


async def handle(websocket, muse):
    async def send(kind, **fields):
        await websocket.send(json.dumps({"type": kind, **fields}, allow_nan=False))

    await send("ready", configured=bool(muse.key))
    # {"type": "options", "designAudio": false} makes audio requests stop at the transcript, so the browser can
    # check its object library before asking Muse to design anything (it then sends a text generate request).
    design_audio = True
    async for message in websocket:
        started = time.monotonic()
        try:
            async with asyncio.timeout(150):
                if isinstance(message, bytes):
                    validate_wav(message)
                    await send("status", stage="transcribing")
                    text = await muse.transcribe(message)
                    await send("transcript", text=text)
                    if not design_audio:
                        continue
                else:
                    request = json.loads(message)
                    if isinstance(request, dict) and request.get("type") == "options":
                        design_audio = bool(request.get("designAudio", True))
                        continue
                    if not isinstance(request, dict) or request.get("type") != "generate":
                        raise ValueError("Expected a generate request")
                    text = request.get("text")
                if not isinstance(text, str) or not 1 <= len(text.strip()) <= 2000:
                    raise ValueError("Describe an object in 1–2000 characters")
                text = clean_command(text)
                if not text:
                    raise ValueError("Say what to make, like “mirror mirror, make a blue chair”")
                if text.lower().rstrip(".!?") in ("undo", "undo last", "undo the last creation", "undo last creation"):
                    await send("undo")
                    continue
                await send("status", stage="designing")
                spec = await generate(muse, text)
                await send("object", spec=spec, seconds=round(time.monotonic()-started, 2))
        except ConnectionClosed:
            return
        except (ValueError, json.JSONDecodeError) as exc:
            await send("error", message=str(exc))
        except TimeoutError:
            await send("error", message="Model request timed out. Please try again")
        except aiohttp.ClientError:
            await send("error", message="Could not reach Meta API. Check internet connectivity")
        except (KeyError, IndexError, TypeError):
            await send("error", message="Unexpected model response. Please try again")


async def run(port=8767):
    timeout = aiohttp.ClientTimeout(total=120)
    connector = aiohttp.TCPConnector(ssl=ssl.create_default_context(cafile=certifi.where()))
    async with aiohttp.ClientSession(timeout=timeout, connector=connector, trust_env=True) as session:
        muse = Muse(session)
        async with serve(lambda ws: handle(ws, muse), "localhost", port,
                         origins=["http://localhost:8000", "http://127.0.0.1:8000"],
                         max_size=MAX_AUDIO_BYTES, compression=None, close_timeout=1):
            print(f"Voice service: ws://localhost:{port} (API key {'configured' if muse.key else 'missing'})", flush=True)
            await asyncio.Future()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8767)
    try:
        asyncio.run(run(parser.parse_args().port))
    except KeyboardInterrupt:
        pass
