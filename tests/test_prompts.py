"""Load prompts.py by path — the plugin dir name is not a valid Python package."""

from __future__ import annotations

import importlib.util
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location("enhance_prompts", _ROOT / "prompts.py")
assert _SPEC and _SPEC.loader
_mod = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_mod)

build_user_message = _mod.build_user_message
strip_wrappers = _mod.strip_wrappers
SYSTEM = _mod.SYSTEM
USER_TEMPLATE = _mod.USER_TEMPLATE
MAX_CHARS = _mod.MAX_CHARS


def test_build_user_message_injects_input():
    out = build_user_message("fix the login")
    assert "fix the login" in out
    assert "{input}" not in out
    assert USER_TEMPLATE.split("{input}")[0] in out


def test_strip_wrappers_thinking_and_channels():
    raw = "<think>secret</think><|channel|>x\nFix the login.\n1. Find the bug."
    out = strip_wrappers(raw)
    assert "secret" not in out
    assert "<think>" not in out
    assert "Fix the login" in out


def test_strip_wrappers_empty():
    assert strip_wrappers("") == ""


def test_max_chars_and_system_present():
    # MAX_CHARS = 0 means "no cap" — model decides the brief length.
    assert MAX_CHARS == 0
    assert "Do NOT answer the request" in SYSTEM
    assert "numbered" in SYSTEM.lower()
    # The no-cap rule should be in the system prompt.
    assert "exactly as much" in SYSTEM or "as much as the brief needs" in SYSTEM


def _load_plugin_module():
    import importlib.util
    import sys
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    name = "enhance_prompt_test_package"
    spec = importlib.util.spec_from_file_location(
        name,
        root / "__init__.py",
        submodule_search_locations=[str(root)],
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_enhance_passes_five_minute_timeout_to_host_llm():
    plugin = _load_plugin_module()
    calls = {}

    class FakeLlm:
        def complete(self, messages, **kwargs):
            calls["messages"] = messages
            calls.update(kwargs)
            return type("Result", (), {"text": "Goal\n1. Fix the login."})()

    result = plugin._enhance_text(type("Ctx", (), {"llm": FakeLlm()})(), "fix the login", 0)

    assert result == "Goal\n1. Fix the login."
    assert calls["timeout"] == 300
    assert len(calls["messages"]) == 2
    assert all(message["role"] in {"system", "user"} for message in calls["messages"])


def test_direct_completion_contract_has_no_tool_surface():
    import importlib.util
    from pathlib import Path
    from types import SimpleNamespace

    root = Path(__file__).resolve().parents[1]
    api_path = root / "dashboard" / "plugin_api.py"
    spec = importlib.util.spec_from_file_location("enhance_prompt_api_test", api_path)
    assert spec and spec.loader
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)

    calls = {}

    def fake_call_llm(**kwargs):
        calls.update(kwargs)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="rewritten"))]
        )

    original = api.call_llm
    api.call_llm = fake_call_llm
    try:
        assert api._complete([{"role": "user", "content": "rewrite this"}], 512) == "rewritten"
    finally:
        api.call_llm = original

    assert calls["tools"] == []
    assert calls["timeout"] == 300


if __name__ == "__main__":
    test_build_user_message_injects_input()
    test_strip_wrappers_thinking_and_channels()
    test_strip_wrappers_empty()
    test_max_chars_and_system_present()
    test_enhance_passes_five_minute_timeout_to_host_llm()
    test_direct_completion_contract_has_no_tool_surface()
    print("ok")
