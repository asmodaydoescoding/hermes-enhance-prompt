"""Direct, tool-free LLM backend for the Enhance Prompt desktop action."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

try:
    from fastapi import APIRouter, HTTPException, Request
except ImportError:  # pragma: no cover - keeps offline plugin tests importable
    class APIRouter:  # type: ignore[no-redef]
        def post(self, *_args, **_kwargs):
            return lambda fn: fn

    class HTTPException(Exception):  # type: ignore[no-redef]
        def __init__(self, status_code: int, detail: str):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

    class Request:  # type: ignore[no-redef]
        pass


_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
_PROMPTS_NAME = "enhance_prompt_backend_prompts"
_PROMPTS_SPEC = importlib.util.spec_from_file_location(
    _PROMPTS_NAME, _PLUGIN_ROOT / "prompts.py"
)
if _PROMPTS_SPEC is None or _PROMPTS_SPEC.loader is None:  # pragma: no cover - packaging failure
    raise RuntimeError("enhance-prompt prompts module could not be loaded")
_PROMPTS = importlib.util.module_from_spec(_PROMPTS_SPEC)
sys.modules[_PROMPTS_NAME] = _PROMPTS
_PROMPTS_SPEC.loader.exec_module(_PROMPTS)

router = APIRouter()

CALL_TIMEOUT_SECONDS = 300
MAX_INPUT_CHARS = 20_000
REWRITE_MAX_TOKENS = 16_384
SCORE_MAX_TOKENS = 512

# The module-level binding is intentionally replaceable by tests. Production
# resolves the host implementation lazily so importing the dashboard route
# does not initialize an LLM client on server startup.
call_llm = None

SCORER_SYSTEM = """You are an expert evaluator of prompts for an AI coding assistant.

Score the prompt on five criteria using a 1–5 scale (5 = excellent, 1 = poor).
Use the full range. Be strict.

Criteria:
1. Clarity (1-5) — Is the language clear, grammatical, and unambiguous?
2. Specificity (1-5) — Is the task scope well-defined, with concrete details?
3. Actionability (1-5) — Can an AI take concrete steps from this prompt?
4. Structure (1-5) — Is it organised (goal line, numbered steps, sections)?
5. Concreteness (1-5) — Does it name real nouns (file, function, table, api)?

Reply ONLY with valid JSON, no prose, no fences:
{"clarity":N,"specificity":N,"actionability":N,"structure":N,"concreteness":N,"reason":"<one short sentence>"}

N must be an integer 1..5. If the prompt is empty, return 1s."""


def _host_call_llm(**kwargs: Any) -> Any:
    runner = call_llm
    if runner is None:
        from agent.auxiliary_client import call_llm as runner  # type: ignore[no-redef]
    return runner(**kwargs)


def _response_text(response: Any) -> str:
    text = getattr(response, "text", None)
    if isinstance(text, str):
        return text
    try:
        content = response.choices[0].message.content
    except (AttributeError, IndexError, TypeError):
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        )
    return ""


def _complete(messages: list[dict[str, str]], max_tokens: int, timeout: float = CALL_TIMEOUT_SECONDS) -> str:
    """Complete one bounded text request without exposing any tool surface."""
    response = _host_call_llm(
        messages=messages,
        tools=[],
        temperature=0.2,
        max_tokens=max_tokens,
        timeout=timeout,
    )
    text = _response_text(response).strip()
    if not text:
        raise RuntimeError("enhance-prompt: host returned an empty response")
    return text


def _json_body_error(exc: Exception) -> HTTPException:
    return HTTPException(status_code=400, detail=f"request body must be JSON: {exc}")


async def _body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception as exc:
        raise _json_body_error(exc) from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="request body must be a JSON object")
    return body


def _input_text(body: dict[str, Any]) -> str:
    text = body.get("input")
    if not isinstance(text, str) or len(text.strip()) < 8:
        raise HTTPException(status_code=400, detail="input must be a string of at least 8 characters")
    text = text.strip()
    if len(text) > MAX_INPUT_CHARS:
        raise HTTPException(status_code=413, detail=f"input exceeds {MAX_INPUT_CHARS} characters")
    return text


def _stage(body: dict[str, Any]) -> int:
    try:
        value = int(body.get("stage", 1))
    except (TypeError, ValueError):
        value = 1
    return max(1, min(value, 3))


def _soft_max_tokens(body: dict[str, Any], stage: int) -> int:
    try:
        requested = int(body.get("max_chars", 0) or 0)
    except (TypeError, ValueError):
        requested = 0
    if requested > 0:
        return min(REWRITE_MAX_TOKENS, max(256, requested * 2))
    return {1: 8_192, 2: 12_288, 3: REWRITE_MAX_TOKENS}[stage]


@router.post("/rewrite")
async def rewrite(request: Request) -> dict[str, Any]:
    """Rewrite text through a direct completion; no Hermes agent is created."""
    body = await _body(request)
    text = _input_text(body)
    stage = _stage(body)
    messages = [
        {"role": "system", "content": _PROMPTS.stage_system(stage)},
        {"role": "user", "content": _PROMPTS.build_user_message(text)},
    ]
    try:
        output = await asyncio.to_thread(_complete, messages, _soft_max_tokens(body, stage))
        output = _PROMPTS.strip_wrappers(output)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"enhance completion failed: {exc}") from exc
    if not output:
        raise HTTPException(status_code=502, detail="enhance completion returned empty text")
    return {"ok": True, "text": output}


def _score_user(label: str, text: str) -> str:
    return f'{label}\n\nPROMPT TO EVALUATE:\n"""\n{text[:4_000]}\n"""\n\nJSON:'


def parse_score(raw: str) -> dict[str, Any] | None:
    match = None
    for start, char in enumerate(raw):
        if char == "{":
            end = raw.find("}", start)
            if end >= 0:
                candidate = raw[start : end + 1]
                try:
                    value = json.loads(candidate)
                except json.JSONDecodeError:
                    continue
                if all(key in value for key in ("clarity", "specificity", "actionability", "structure", "concreteness")):
                    match = value
                    break
    if not isinstance(match, dict):
        return None

    def score(value: Any) -> int:
        try:
            number = round(float(value))
        except (TypeError, ValueError):
            return 0
        return max(0, min(5, int(number)))

    parts = {key: score(match.get(key)) for key in ("clarity", "specificity", "actionability", "structure", "concreteness")}
    reason = match.get("reason") if isinstance(match.get("reason"), str) else ""
    return {
        "total": round(sum(parts.values()) / 25 * 100),
        "parts": parts,
        "reason": reason,
    }


@router.post("/score")
async def score_prompt(request: Request) -> dict[str, Any]:
    """Score one prompt through the same tool-free direct-completion path."""
    body = await _body(request)
    label = body.get("label") if isinstance(body.get("label"), str) else "PROMPT"
    text = body.get("text") if isinstance(body.get("text"), str) else ""
    try:
        raw = await asyncio.to_thread(
            _complete,
            [
                {"role": "system", "content": SCORER_SYSTEM},
                {"role": "user", "content": _score_user(label, text)},
            ],
            SCORE_MAX_TOKENS,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"prompt scoring failed: {exc}") from exc
    return {"ok": True, "score": parse_score(_PROMPTS.strip_wrappers(raw))}
