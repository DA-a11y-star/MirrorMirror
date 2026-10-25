"""Meta Model API adapters. Credentials never leave this process except to Meta."""

import json
import os
from pathlib import Path

import aiohttp

from voice.schema import PLAN_SCHEMA

API_URL = "https://api.meta.ai/v1"
ENV_PATH = Path(__file__).resolve().parent.parent / ".env"  


def load_env(path=ENV_PATH):
    """KEY=VALUE lines from a .env file: blank lines and # comments skipped, `export ` and quotes tolerated."""
    values = {}
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return values
    for line in lines:
        line = line.strip()
        if not line or "=" not in line:
            continue
        name, _, value = line.removeprefix("export ").partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[name.strip()] = value
    return values


class Muse:
    def __init__(self, session, env_path=ENV_PATH):
        self.session = session
        self.env_path = env_path

    def setting(self, name, default=""):
        """The .env file wins; a variable in the terminal is only a fallback. Re-read each time, so editing .env
        takes effect without restarting the service."""
        return load_env(self.env_path).get(name) or os.environ.get(name) or default

    @property
    def key(self):
        return self.setting("MODEL_API_KEY")

    async def post(self, path, **kwargs):
        if not self.key:
            raise ValueError("Add MODEL_API_KEY to the .env file in the project folder (see .env.example)")
        async with self.session.post(API_URL + path, headers={"Authorization": f"Bearer {self.key}"}, **kwargs) as response:
            if response.status >= 400:
                # Do not relay arbitrary upstream bodies (or credentials) to the UI.
                messages = {401: "API key rejected", 403: "Model access denied", 429: "Model rate limit reached; try again shortly"}
                raise ValueError(messages.get(response.status, f"Meta API returned HTTP {response.status}"))
            return await response.json()

    async def transcribe(self, wav):
        form = aiohttp.FormData()
        form.add_field("request", json.dumps({"mode": "PUSH_TO_TALK", "audioEncoding": "WAV",
                       "model": self.setting("ASR_MODEL", "muse-voice-transcribe-1.0"),
                       "languageBias": ["English"], "keywords": ["cylinder", "sphere", "cone", "chair"]}),
                       content_type="application/json")
        form.add_field("audio", wav, filename="command.wav", content_type="audio/wav")
        result = await self.post("/asr/transcribe", data=form)
        text = result.get("transcript", "").strip()
        if not text:
            raise ValueError("No speech recognized. Try again or type a description")
        return text

    async def plan(self, messages):
        result = await self.post("/chat/completions", json={
            "model": self.setting("OBJECT_MODEL", "muse-wonder-1.0"),
            "messages": messages,
            "reasoning_effort": "low",
            "max_completion_tokens": 10000,
            "response_format": {"type": "json_schema", "json_schema": {
                "name": "PrimitiveAssembly", "strict": True, "schema": PLAN_SCHEMA}},
        })
        choice = result["choices"][0]
        if choice.get("finish_reason") != "stop" or not choice["message"].get("content"):
            raise ValueError("Object design was incomplete. Try a simpler description")
        return json.loads(choice["message"]["content"])
