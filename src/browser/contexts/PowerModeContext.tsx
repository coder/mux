import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { matchesKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { POWER_MODE_ENABLED_KEY } from "@/common/constants/storage";
import {
  PowerModeEngine,
  type PowerModeBurstKind,
} from "@/browser/utils/powerMode/PowerModeEngine";
import { PowerModeOverlay } from "@/browser/components/PowerMode/PowerModeOverlay";

interface PowerModeContextValue {
  enabled: boolean;
  burstFromTextarea: (
    textarea: HTMLTextAreaElement,
    intensity?: number,
    kind?: PowerModeBurstKind
  ) => void;
}

const PowerModeContext = createContext<PowerModeContextValue | null>(null);

export function usePowerMode(): PowerModeContextValue {
  const ctx = useContext(PowerModeContext);
  if (!ctx) {
    throw new Error("usePowerMode must be used within a PowerModeProvider");
  }
  return ctx;
}

interface MirrorState {
  el: HTMLDivElement;
  textNode: Text;
  caretSpan: HTMLSpanElement;
}

function getLineHeightPx(computed: CSSStyleDeclaration): number {
  const lineHeight = Number.parseFloat(computed.lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) {
    return lineHeight;
  }

  const fontSize = Number.parseFloat(computed.fontSize);
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.2 : 16;
}

function ensureMirror(mirrorRef: React.MutableRefObject<MirrorState | null>) {
  if (mirrorRef.current) {
    return mirrorRef.current;
  }

  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.style.position = "fixed";
  el.style.visibility = "hidden";
  el.style.pointerEvents = "none";
  el.style.whiteSpace = "pre-wrap";
  el.style.wordWrap = "break-word";
  el.style.overflowWrap = "break-word";
  el.style.top = "0";
  el.style.left = "0";
  el.style.zIndex = "-1";

  const textNode = document.createTextNode("");
  const caretSpan = document.createElement("span");
  caretSpan.textContent = ".";

  el.appendChild(textNode);
  el.appendChild(caretSpan);

  document.body.appendChild(el);

  mirrorRef.current = { el, textNode, caretSpan };
  return mirrorRef.current;
}

function syncMirrorStyles(textarea: HTMLTextAreaElement, mirrorEl: HTMLDivElement) {
  const computed = window.getComputedStyle(textarea);

  // Position/size must be recomputed as the textarea auto-resizes.
  const rect = textarea.getBoundingClientRect();
  mirrorEl.style.top = `${rect.top}px`;
  mirrorEl.style.left = `${rect.left}px`;
  mirrorEl.style.width = computed.width;
  mirrorEl.style.height = computed.height;

  // Typography + box model.
  mirrorEl.style.boxSizing = computed.boxSizing;
  mirrorEl.style.padding = computed.padding;
  mirrorEl.style.border = computed.border;
  mirrorEl.style.font = computed.font;
  mirrorEl.style.letterSpacing = computed.letterSpacing;
  mirrorEl.style.lineHeight = computed.lineHeight;
  mirrorEl.style.tabSize = computed.tabSize;
  mirrorEl.style.textTransform = computed.textTransform;
  mirrorEl.style.textAlign = computed.textAlign;

  // Match wrapping behavior.
  mirrorEl.style.whiteSpace = "pre-wrap";
  mirrorEl.style.wordBreak = computed.wordBreak;
  mirrorEl.style.overflowWrap = computed.overflowWrap;

  return { computed, rect };
}

function getCaretViewportPosition(
  textarea: HTMLTextAreaElement,
  mirror: MirrorState
): {
  x: number;
  y: number;
} | null {
  try {
    const caret = textarea.selectionStart ?? textarea.value.length;

    const { computed } = syncMirrorStyles(textarea, mirror.el);

    mirror.textNode.textContent = textarea.value.slice(0, caret);
    mirror.caretSpan.textContent = textarea.value.slice(caret) || ".";

    const spanRect = mirror.caretSpan.getBoundingClientRect();

    // Mirror is unscrolled; subtract textarea scroll offsets to match the visible caret.
    const x = spanRect.left - textarea.scrollLeft;
    const y = spanRect.top - textarea.scrollTop + getLineHeightPx(computed) / 2;

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }

    return { x, y };
  } catch {
    return null;
  }
}

export function PowerModeProvider(props: { children: ReactNode }) {
  const [enabled, setEnabled] = usePersistedState(POWER_MODE_ENABLED_KEY, false, {
    listener: true,
  });

  const engineRef = useRef(new PowerModeEngine());
  const mirrorRef = useRef<MirrorState | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (!matchesKeybind(e, KEYBINDS.TOGGLE_POWER_MODE)) return;

      e.preventDefault();
      stopKeyboardPropagation(e);
      setEnabled((prev) => !prev);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [setEnabled]);

  useEffect(() => {
    const engine = engineRef.current;

    return () => {
      mirrorRef.current?.el.remove();
      mirrorRef.current = null;

      engine.stop();
    };
  }, []);

  const burstFromTextarea = useCallback<PowerModeContextValue["burstFromTextarea"]>(
    (textarea, intensity = 1, kind: PowerModeBurstKind = "insert") => {
      if (!enabled) return;

      const engine = engineRef.current;

      const rect = textarea.getBoundingClientRect();
      const fallback = {
        x: rect.left + rect.width - 12,
        y: rect.top + rect.height - 12,
      };

      const mirror = ensureMirror(mirrorRef);
      const caretPos = getCaretViewportPosition(textarea, mirror) ?? fallback;

      engine.burst(caretPos.x, caretPos.y, intensity, { kind });
    },
    [enabled]
  );

  const value = useMemo<PowerModeContextValue>(
    () => ({
      enabled,
      burstFromTextarea,
    }),
    [enabled, burstFromTextarea]
  );

  return (
    <PowerModeContext.Provider value={value}>
      {props.children}
      {enabled && <PowerModeOverlay engine={engineRef.current} />}
    </PowerModeContext.Provider>
  );
}
