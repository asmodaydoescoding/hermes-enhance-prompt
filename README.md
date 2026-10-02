# Hermes Enhance Prompt

![Hero banner](assets/hero-banner.png)

Sparkle beside Send on [Hermes Desktop](https://hermes-agent.nousresearch.com). Click it to rewrite the composer draft. It does **not** send the message.

- Messy draft → sparkle → numbered agent brief
- Score on the button: `40→72` (before → after)
- Click the discard icon to revert (replaces the draft, does not append)
- Click while spinning to cancel the wait
- Ctrl/Cmd+K → **Enhance prompt**

Uses the active Hermes model/auth through a direct, tool-free completion. The rewrite cannot create a Hermes session, invoke skills, or call tools such as `prompt-master`. It does not answer the request — it reformulates it.

## Demo

![Enhance Prompt demo](assets/demo-enhance-prompt.gif)

Messy draft → sparkle → numbered ask. It does not send.

Higher-quality MP4: [assets/demo-enhance-prompt.mp4](assets/demo-enhance-prompt.mp4)

---

## What the rewrite looks like

**Short / already-clear input** → tight 1–3 numbered steps.

**Substantive input** → a production-grade brief, only the sections that apply:

1. Goal
2. Role & context
3. Scope (IN / OUT)
4. Requirements (3–7 numbered, each one action)
5. Deliverable
6. Quality gates
7. Anti-patterns

---

## Desktop: the sparkle

### Install (paste into Hermes to have another agent do it)

```
Install the enhance-prompt plugin from tuancookiez-hub/hermes-enhance-prompt.

1. Clone or pull:
   git clone https://github.com/tuancookiez-hub/hermes-enhance-prompt.git
   cd hermes-enhance-prompt
2. Copy desktop/plugin.js to:
   <HERMES_HOME>/desktop-plugins/enhance-prompt/plugin.js
   Folder name MUST be enhance-prompt.
3. In Hermes Desktop: Ctrl/Cmd+K → Reload desktop plugins
   (or Settings → Plugins → Enhance Prompt on)
4. Type in the composer and click the sparkle next to Send.
```

`HERMES_HOME` is normally `%LOCALAPPDATA%\hermes` on Windows, `~/.hermes` on macOS/Linux.

> **Two plugin systems.** `hermes plugins install` installs the *Python agent* half (`/enhance` + `enhance_prompt` tool). The sparkle is a *Desktop UI* plugin — copy `desktop/plugin.js` as above. Both can live in this one repo.

Manual copy:

```
# default profile
<HERMES_HOME>/desktop-plugins/enhance-prompt/plugin.js

# named profile
<HERMES_HOME>/profiles/<name>/desktop-plugins/enhance-prompt/plugin.js
```

The Desktop watches that folder. Drop the file in; no `npm run pack`.

### How the sparkle works

1. Reads the composer (`data-slot="composer-rich-input"`)
2. Calls the plugin backend's direct, tool-free rewrite endpoint
3. The backend runs one constrained completion and returns text
4. **Selects all** then `insertText` so the draft is replaced, not appended
5. Starts optional before/after scoring in the background
6. Shows the `before→after` quality score beside the sparkle when scoring finishes

Cancel is UI-only: it stops waiting and ignores the late response if the backend call is already in flight.

---

## Agent: `/enhance` + `enhance_prompt` tool

Same rewrite logic from CLI, gateway, and MCP:

```
hermes plugins install tuancookiez-hub/hermes-enhance-prompt
```

Then:

```
/enhance fix the login flow
```

or the tool:

```
enhance_prompt(input="fix the login", max_chars=1200)
```

---

## Limits

- Desktop sparkle needs a live Desktop backend and a working model
- Rewrite calls have a five-minute host timeout
- Scoring is a separate best-effort direct completion and never blocks the rewrite
- No prompt-master or other Hermes skill/tool can run during a rewrite or score
- No public `setComposerDraft` SDK — write path is DOM-based (select-all + insertText)
- Drafts under 8 characters are ignored

## Installing-agent notes

Full install / verify / uninstall: `INSTALL.md`.

## License

MIT — see `LICENSE`.
