# Installing Enhance Prompt (for agents)

One package, two runtimes. Do both.

## Desktop sparkle

Install the full plugin through Hermes so both the desktop UI and its direct backend are present:

```
hermes plugins install tuancookiez-hub/hermes-enhance-prompt
hermes plugins enable enhance-prompt
```

For a manual checkout, copy the complete plugin directory (including `dashboard/`) to
`<HERMES_HOME>/plugins/enhance-prompt/`, and copy `desktop/plugin.js` to the matching Desktop plugin path if your Desktop build only scans `desktop-plugins/`.

Disk plugins load uncompiled. Only these imports resolve:
- `jsx` / `jsxs` from `react/jsx-runtime`
- `useState` / `useEffect` / `useCallback` / `useRef` from `react`
- `useValue`, `Button`, `Tip`, `Codicon`, `COMPOSER_AREAS` from `@hermes/plugin-sdk`

Composer `actions` is a tight icon row — extra siblings next to the button get clipped. Score lives **inside** the button as `40→72`.

`writeDraft` must select-all (`selectNodeContents`) then `insertText`. Collapse-to-end appends on revert.

Reload: Ctrl/Cmd+K → Reload desktop plugins. If the backend manifest or `dashboard/plugin_api.py` was newly added, restart Hermes Desktop once so `/api/plugins/enhance-prompt/` is mounted.

## Agent tool

```
hermes plugins install tuancookiez-hub/hermes-enhance-prompt
hermes plugins enable enhance-prompt
```

Shared templates: `prompts.py`. Keep in sync with the SYSTEM string in `desktop/plugin.js`.
