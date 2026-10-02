/**
 * Enhance Prompt — Desktop plugin
 *
 * Sparkle beside Send. Click to rewrite the composer draft; click again to
 * revert; click while spinning to cancel. A small score badge appears next
 * to the sparkle after a successful rewrite.
 *
 * Uses a direct, tool-free host completion through the plugin API. It uses the
 * active Hermes model/auth but cannot create sessions, invoke skills, or call
 * tools such as prompt-master. Scoring runs separately after the rewrite lands.
 *
 * Ctrl/Cmd+K runs the same action.
 */

import { jsx, jsxs } from "react/jsx-runtime";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  host,
  useValue,
  COMPOSER_AREAS,
  PALETTE_AREA,
  KEYBINDS_AREA,
  Codicon,
  Button,
  Tip,
  cn,
} from "@hermes/plugin-sdk";

/* ─── Tunables ──────────────────────────────────────────────────────────── */

const REQUEST_TIMEOUT_MS = 300_000; // model calls may legitimately take several minutes
const REST_TIMEOUT_MS = REQUEST_TIMEOUT_MS + 10_000;
const MIN_LEN = 8;

/* ─── Composer DOM helpers ────────────────────────────────────────────────── */

const COMPOSER_SLOT = "composer-rich-input";

function composerEl() {
  const nodes = document.querySelectorAll(`[data-slot="${COMPOSER_SLOT}"]`);
  for (const n of nodes) {
    if (!(n instanceof HTMLElement)) continue;
    if (n.offsetParent !== null || n.getClientRects().length) return n;
  }
  return nodes[0] instanceof HTMLElement ? nodes[0] : null;
}

function readDraft() {
  const el = composerEl();
  if (!el) return "";
  return String(el.innerText || el.textContent || "")
    .replace(/\u00a0/g, " ")
    .trim();
}

function writeDraft(text) {
  const el = composerEl();
  if (!el) throw new Error("composer not found");
  const next = String(text ?? "");

  el.focus();
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand("insertText", false, next);
    if (!ok) throw new Error("insertText failed");
  } catch {
    el.textContent = next;
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertReplacementText",
        data: next,
      })
    );
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/* ─── Output cleaning ────────────────────────────────────────────────────── */

function stripQuotes(text) {
  return String(text || "")
    .replace(/<｜[\s\S]*?｜>/g, "")
    .replace(/<\|[\s\S]*?\|>/g, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^<\/?[\w:-]+>[^\n]*\n?/gm, "")
    .replace(/^```[a-zA-Z0-9_-]*\n?/, "")
    .replace(/\n?```$/, "")
    .trim()
    .replace(/^['"`\u201c\u201d\u2018\u2019]+|['"`\u201c\u201d\u2018\u2019]+$/g, "")
    .trim();
}

function abortError() {
  return new DOMException("aborted", "AbortError");
}

function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

async function pluginApiRequest(request, path, body, signal) {
  if (typeof request !== "function") {
    throw new Error("Enhance Prompt backend unavailable; restart or update Hermes Desktop");
  }
  const result = await withAbort(
    Promise.resolve().then(() =>
      request(path, {
        method: "POST",
        body,
        timeoutMs: REST_TIMEOUT_MS,
      })
    ),
    signal
  );
  if (result && result.ok === false) {
    const detail = result.detail || result.error || "request failed";
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return result || {};
}

async function geValScore(request, label, text, signal) {
  if (!text || !text.trim()) {
    return {
      total: 0,
      parts: {
        clarity: 0,
        specificity: 0,
        actionability: 0,
        structure: 0,
        concreteness: 0,
      },
      reason: "empty",
    };
  }
  const result = await pluginApiRequest(
    request,
    "/score",
    { label, text: text.slice(0, 4000) },
    signal
  );
  return result.score || null;
}

async function enhanceOnce(input, signal, maxChars, stage, request) {
  const result = await pluginApiRequest(
    request,
    "/rewrite",
    { input, max_chars: maxChars, stage },
    signal
  );
  return stripQuotes(result.text || "");
}

function scoreClass(s) {
  if (s >= 80) return "text-emerald-500";
  if (s >= 60) return "text-amber-500";
  return "text-muted-foreground/70";
}

/* ─── EnhancementButton ──────────────────────────────────────────────────── */

function EnhanceButton({ request }) {
  const chatBusy = useValue(host.state.busy);
  const [enhancing, setEnhancing] = useState(false);
  const [hasBackup, setHasBackup] = useState(false);
  const [error, setError] = useState("");
  const [hasText, setHasText] = useState(false);
  const lastScore = useRef(null); // { before, after, parts, reason } | null

  const backup = useRef(null);
  const after = useRef(null);
  const abort = useRef(null);
  const scoreAbort = useRef(null);
  // 0 = no enhance yet, 1 = first pass done (2000 char cap), 2 = first extend
  // done (4000 char cap), 3 = second extend (still 4000 cap; further stages
  // are useful mainly for re-applying different framing). Tracked so that
  // a re-click on the sparkle continues the stage sequence instead of
  // re-running the same 2000-char rewrite from scratch.
  const stage = useRef(0);

  // Tiny helper to push a re-render when we update the ref-only score.
  const [, setScoreTick] = useState(0);
  const forceRender = useCallback(() => setScoreTick((n) => n + 1), []);

  const refreshHasText = useCallback(() => {
    const text = readDraft();
    setHasText(text.length >= MIN_LEN);
    if (hasBackup && after.current && text !== after.current) {
      backup.current = null;
      after.current = null;
      setHasBackup(false);
      stage.current = 0;
    }
    if (!text.trim() && lastScore.current) {
      lastScore.current = null;
      forceRender();
    }
  }, [hasBackup, forceRender]);

  useEffect(() => {
    refreshHasText();
    const el = composerEl();
    if (!el) return undefined;
    const on = () => refreshHasText();
    el.addEventListener("input", on);
    el.addEventListener("keyup", on);
    const t = setInterval(on, 800);
    return () => {
      el.removeEventListener("input", on);
      el.removeEventListener("keyup", on);
      clearInterval(t);
    };
  }, [refreshHasText]);

  const cancel = useCallback(() => {
    abort.current?.abort();
    scoreAbort.current?.abort();
    abort.current = null;
    scoreAbort.current = null;
    setEnhancing(false);
  }, []);

  const scheduleScore = useCallback(
    (beforeText, afterText) => {
      scoreAbort.current?.abort();
      const ac = new AbortController();
      scoreAbort.current = ac;
      void (async () => {
        try {
          const [before, afterScore] = await Promise.all([
            geValScore(request, "ORIGINAL", beforeText, ac.signal),
            geValScore(request, "REWRITE", afterText, ac.signal),
          ]);
          if (ac.signal.aborted) return;
          if (before || afterScore) {
            lastScore.current = { before, after: afterScore };
            forceRender();
          } else {
            host.notify({
              kind: "info",
              message: "Scorer unavailable — enhancement is live, no score.",
            });
          }
        } catch (err) {
          if (err?.name !== "AbortError") {
            host.notify({
              kind: "info",
              message: "Scorer unavailable — enhancement is live, no score.",
            });
          }
        } finally {
          if (scoreAbort.current === ac) scoreAbort.current = null;
        }
      })();
    },
    [forceRender, request]
  );

  // stageRun advances the enhance to the next stage and appends the result.
  // stage 0 → 1: first pass
  // stage 1 → 2: deepen
  // stage 2 → 3: horizon
  const stageRun = useCallback(async () => {
    const nextStage = Math.min(stage.current + 1, 3);
    // Soft hint for max_tokens; no hard cap on displayed output.
    const cap =
      nextStage === 1
        ? 3000    // stage 1: clarify
        : nextStage === 2
        ? 6000   // stage 2: detail
        : 10000; // stage 3: horizon

    cancel();
    const ac = new AbortController();
    abort.current = ac;
    setEnhancing(true);
    setError("");
    const current = readDraft();
    try {
      const enhanced = stripQuotes(
        await enhanceOnce(current, ac.signal, cap, nextStage, request)
      );
      if (ac.signal.aborted) return;
      if (!enhanced) throw new Error("empty rewrite");

      // No hard cap on the displayed output. The model is told the
      // cap as a target, not enforced. Whatever the model produces
      // is what the user gets.
      host.notify({
        kind: "info",
        message:
          (nextStage === 2
            ? "Stage 2: detailed task list appended. "
            : nextStage === 3
            ? "Stage 3: phased plan appended. "
            : "Stage " + nextStage + " appended. ") +
          "(" + enhanced.length.toLocaleString() + " chars)",
      });

      // Append with a visual separator between stages.
      const sep = "\n\n---\n\n";
      const merged = current.trimEnd() + sep + enhanced;
      writeDraft(merged);

      requestAnimationFrame(() => {
        after.current = readDraft();
        setHasBackup(true);
        stage.current = nextStage;
      });
      scheduleScore(current, merged);
    } catch (err) {
      if (err?.name === "AbortError") return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      host.notify({ kind: "error", message: "Enhance stage failed: " + msg });
    } finally {
      if (abort.current === ac) abort.current = null;
      setEnhancing(false);
    }
  }, [cancel, request, scheduleScore]);

  // revert restores the original text before any enhance ran.
  const revert = useCallback(() => {
    const text = backup.current;
    if (!text) return;
    scoreAbort.current?.abort();
    scoreAbort.current = null;
    backup.current = null;
    after.current = null;
    setHasBackup(false);
    lastScore.current = null;
    stage.current = 0;
    forceRender();
    setError("");
    requestAnimationFrame(() => {
      try {
        writeDraft(text);
        host.notify({ kind: "info", message: "Reverted to original." });
      } catch (err) {
        host.notify({
          kind: "error",
          message:
            "Revert failed: " +
            (err && err.message ? err.message : String(err)),
        });
      }
    });
  }, [forceRender]);

  // extend re-runs the rewrite with a higher character cap and
  // appends the new section to the existing draft. Used when the
  // extend is an explicit "force 2x cap" button. After the first
  // enhance, the user can click this to get a longer rewrite at the
  // current stage. No hard cap on output.
  const extend = useCallback(async () => {
    if (!hasBackup || !after.current) return;
    cancel();
    const ac = new AbortController();
    abort.current = ac;
    setEnhancing(true);
    setError("");
    const current = readDraft();
    try {
      // Soft cap hint for max_tokens; no hard cap on displayed output.
      const cap = stage.current || 2;
      const extended = stripQuotes(
        await enhanceOnce(current, ac.signal, cap * 3000, cap, request)
      );
      if (ac.signal.aborted) return;
      if (!extended) throw new Error("empty extension");

      const merged = current.trimEnd() + "\n\n" + extended;
      writeDraft(merged);
      host.notify({
        kind: "info",
        message:
          "Extended (" + extended.length.toLocaleString() + " chars) appended.",
      });

      requestAnimationFrame(() => {
        after.current = readDraft();
        setHasBackup(true);
        stage.current = cap;
      });
      scheduleScore(current, merged);
    } catch (err) {
      if (err?.name === "AbortError") return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      host.notify({ kind: "error", message: "Extend failed: " + msg });
    } finally {
      if (abort.current === ac) abort.current = null;
      setEnhancing(false);
    }
  }, [hasBackup, cancel, request, scheduleScore]);

  const run = useCallback(async () => {
    const text = readDraft();
    if (text.length < MIN_LEN) {
      host.notify({
        kind: "error",
        message: "Type a bit more, then enhance.",
      });
      return;
    }
    cancel();
    const ac = new AbortController();
    abort.current = ac;
    setEnhancing(true);
    setError("");
    backup.current = text;
    lastScore.current = null;

    try {
      // Soft hint for max_tokens; no hard cap on displayed output.
      const cap = 3000; // stage 1: clarify
      const enhanced = stripQuotes(
        await enhanceOnce(text, ac.signal, cap, 1, request)
      );
      if (ac.signal.aborted) return;
      if (!enhanced) throw new Error("empty rewrite");

      // No hard cap on the displayed output. Whatever the model
      // produces is what the user gets — truncation would silently
      // drop the very parts of the brief that needed the most space.
      if (enhanced.trim() === backup.current.trim()) {
        backup.current = null;
        after.current = null;
        setHasBackup(false);
        host.notify({
          kind: "info",
          message: "Prompt was already clear — no change needed.",
        });
        return;
      }

      writeDraft(enhanced);
      host.notify({
        kind: "info",
        message:
          "Stage 1: clarified brief (" +
          enhanced.length.toLocaleString() +
          " chars).",
      });

      // Discard icon appears the moment the rewrite lands — scoring is
      // background work that updates the badge without holding the icon back.
      requestAnimationFrame(() => {
        const next = readDraft();
        after.current = next;
        setHasBackup(true);
        stage.current = 1; // first stage (clarify) complete
      });

      scheduleScore(text, enhanced);
    } catch (err) {
      if (err?.name === "AbortError") return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      host.notify({ kind: "error", message: "Enhance failed: " + msg });
      backup.current = null;
      after.current = null;
      setHasBackup(false);
    } finally {
      if (abort.current === ac) abort.current = null;
      setEnhancing(false);
    }
  }, [cancel, request, scheduleScore]);

  const disabled = enhancing ? false : !!chatBusy || !hasText;
  const ls = lastScore.current;
  const buttonTip = (() => {
    if (error) return error;
    if (enhancing) return "Enhancing… click to cancel";
    if (hasBackup) {
      if (stage.current === 1)
        return "Stage 2: break into detailed task list";
      if (stage.current === 2)
        return "Stage 3: convert to phased plan";
      return "Advance to next stage";
    }
    return "Enhance prompt (direct rewrite)";
  })();
  const scoreTip = (() => {
    if (!ls || !ls.after) return null;
    const a = ls.after.parts;
    const lines = [
      `${ls.before ? ls.before.total : "?"} → ${ls.after.total}/100`,
      `${a.clarity}/5 clarity · ${a.specificity}/5 specificity · ${a.actionability}/5 actionability · ${a.structure}/5 structure · ${a.concreteness}/5 concreteness`,
    ];
    if (ls.after.reason) lines.push(ls.after.reason);
    return lines.join("\n");
  })();

  return jsxs("div", {
    className: "flex h-(--composer-control-size) items-center gap-1",
    children: [
      jsx(Tip, {
        label: buttonTip,
        children: jsx(Button, {
          "aria-label": hasBackup
            ? "Advance enhance to next stage"
            : "Enhance prompt",
          className: cn(
            "size-(--composer-control-size) shrink-0 rounded-md",
            "text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground",
            (enhancing || hasBackup) && "text-foreground"
          ),
          disabled,
          onClick: enhancing ? cancel : hasBackup ? stageRun : run,
          size: "icon-xs",
          type: "button",
          variant: "ghost",
          children: jsx(Codicon, {
            name: enhancing
              ? "sync"
              : hasBackup
              ? "arrow-right" // advancing to next stage
              : "sparkle",
            size: 14,
            spinning: enhancing,
          }),
        }),
      }),
      // Discard / revert — appears once an enhanced version is in place,
      // letting the user throw the rewrite away and go back to the
      // original draft. Always available alongside the stage-advance
      // and explicit extend buttons.
      hasBackup && !enhancing
        ? jsx(Tip, {
            label: "Discard enhanced version, revert to original",
            children: jsx(Button, {
              "aria-label": "Revert to original",
              className: cn(
                "size-(--composer-control-size) shrink-0 rounded-md",
                "text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground"
              ),
              onClick: revert,
              size: "icon-xs",
              type: "button",
              variant: "ghost",
              children: jsx(Codicon, { name: "discard", size: 14 }),
            }),
          })
        : null,
      // Extend button — explicit "go deeper" with a fixed 4000-char cap.
      // Distinct from the stage-advance sparkle so the user can force a
      // longer rewrite at any stage.
      hasBackup && !enhancing
        ? jsx(Tip, {
            label: "Extend prompt (force 4000-char cap, appends)",
            children: jsx(Button, {
              "aria-label": "Extend prompt",
              className: cn(
                "size-(--composer-control-size) shrink-0 rounded-md",
                "text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground"
              ),
              onClick: extend,
              size: "icon-xs",
              type: "button",
              variant: "ghost",
              children: jsx(Codicon, { name: "arrow-down", size: 14 }),
            }),
          })
        : null,
      ls && ls.after
        ? jsx(Tip, {
            label: scoreTip,
            children: jsx("span", {
              key: "score",
              className: cn(
                "inline-flex h-(--composer-control-size) shrink-0 cursor-help items-center",
                "font-mono text-[10px] leading-none tabular-nums",
                scoreClass(ls.after.total)
              ),
              children: String(ls.after.total),
            }),
          })
        : ls && ls.before && !ls.after
        ? jsx("span", {
            key: "score-pending",
            className: cn(
              "inline-flex h-(--composer-control-size) shrink-0 items-center",
              "font-mono text-[10px] leading-none tabular-nums text-muted-foreground/60 animate-pulse"
            ),
            children: "…",
          })
        : null,
    ],
  });
}

/* ─── Palette + keybind helpers ──────────────────────────────────────────── */

function clickSparkle() {
  const tips = [
    "Enhance prompt (direct rewrite)",
    "Advance enhance to next stage",
    "Enhancing… click to cancel",
  ];
  const btn = [...document.querySelectorAll("button[aria-label]")].find((el) =>
    tips.includes(el.getAttribute("aria-label") || "")
  );
  if (btn instanceof HTMLElement) {
    btn.click();
  } else {
    host.notify({
      kind: "info",
      message:
        "Type in the composer, then use the sparkle next to Send.",
    });
  }
}

/* ─── Plugin entry point ─────────────────────────────────────────────────── */

export default {
  id: "enhance-prompt",
  name: "Enhance Prompt",
  description:
    "Sparkle beside Send that rewrites the composer draft without sending it. Shows a small quality score next to the sparkle after each rewrite.",
  defaultEnabled: true,

  register(ctx) {
    ctx.register({
      id: "star",
      area: COMPOSER_AREAS.actions,
      order: 40,
      render: () =>
        jsx(EnhanceButton, {
          request: (path, options) => ctx.rest(path, options),
        }),
    });

    ctx.register({
      id: "palette",
      area: PALETTE_AREA,
      data: {
        id: "enhance-prompt.run",
        label: "Enhance prompt",
        keywords: ["enhance", "prompt", "sparkle", "rewrite", "star"],
        run: clickSparkle,
      },
    });

    const KEY = navigator.platform.includes("Mac") ? "cmd+k" : "ctrl+k";
    ctx.register({
      id: "keybind",
      area: KEYBINDS_AREA,
      data: {
        id: "enhance-prompt.keybind",
        label: "Enhance prompt",
        category: "Enhance Prompt",
        defaults: [KEY],
        run: clickSparkle,
      },
    });
  },
};
