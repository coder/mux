import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type WheelEvent,
} from "react";
import { TriangleAlert } from "lucide-react";
import { useAPI } from "@/browser/contexts/API";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { cn } from "@/common/lib/utils";
import { clamp } from "@/common/utils/clamp";
import type {
  BrowserFrameMetadata,
  BrowserInputEvent,
  BrowserKeyboardInput,
  BrowserMouseInput,
  BrowserSession,
} from "@/common/types/browserSession";
import assert from "@/common/utils/assert";

interface BrowserViewportProps {
  workspaceId: string;
  session: BrowserSession | null;
  screenshotSrc: string | null;
  visibleError: string | null;
  placeholder: ReactNode;
  onRestart?: () => void;
}

interface ViewportInteractionState {
  canInteract: boolean;
  blockingMessage: string | null;
  showRestartCta?: boolean;
}

interface MeasuredViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ViewportPoint {
  x: number;
  y: number;
}

interface BrowserViewportSessionSnapshot {
  sessionId: string | null;
  canInteract: boolean;
}

interface QueuedPointerMove {
  clientX: number;
  clientY: number;
  buttons: number;
  modifiers: number;
  sessionId: string;
}

export function BrowserViewport(props: BrowserViewportProps) {
  assert(props.workspaceId.trim().length > 0, "BrowserViewport requires a workspaceId");

  const { api } = useAPI();
  const [hasFocus, setHasFocus] = useState(false);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);
  const sessionSnapshotRef = useRef<BrowserViewportSessionSnapshot>({
    sessionId: null,
    canInteract: false,
  });
  const activePointerIdRef = useRef<number | null>(null);
  const activeGestureSessionIdRef = useRef<string | null>(null);
  const lastInteractionSessionIdRef = useRef<string | null>(null);
  const lastPointerButtonRef = useRef<BrowserMouseInput["button"]>("none");
  const latestMoveRef = useRef<QueuedPointerMove | null>(null);
  const moveAnimationFrameRef = useRef<number | null>(null);
  const browserSessionApi = api?.browserSession ?? null;
  const interactionState = getViewportInteractionState(props.session);
  const currentSessionId = props.session?.id ?? null;

  sessionSnapshotRef.current = {
    sessionId: currentSessionId,
    canInteract: interactionState.canInteract,
  };

  const cancelQueuedMove = () => {
    if (moveAnimationFrameRef.current !== null) {
      cancelAnimationFrame(moveAnimationFrameRef.current);
      moveAnimationFrameRef.current = null;
    }
    latestMoveRef.current = null;
  };

  const resetPointerState = () => {
    cancelQueuedMove();
    activePointerIdRef.current = null;
    activeGestureSessionIdRef.current = null;
    lastPointerButtonRef.current = "none";
  };

  const releasePointerCapture = () => {
    const activePointerId = activePointerIdRef.current;
    if (surfaceRef.current == null || activePointerId === null) {
      return;
    }

    if (
      "hasPointerCapture" in surfaceRef.current &&
      typeof surfaceRef.current.hasPointerCapture === "function" &&
      !surfaceRef.current.hasPointerCapture(activePointerId)
    ) {
      return;
    }

    if (
      "releasePointerCapture" in surfaceRef.current &&
      typeof surfaceRef.current.releasePointerCapture === "function"
    ) {
      surfaceRef.current.releasePointerCapture(activePointerId);
    }
  };

  const sendInput = (input: BrowserInputEvent, expectedSessionId: string): void => {
    const currentSessionSnapshot = sessionSnapshotRef.current;
    if (
      browserSessionApi == null ||
      !mountedRef.current ||
      !currentSessionSnapshot.canInteract ||
      currentSessionSnapshot.sessionId !== expectedSessionId
    ) {
      return;
    }

    const sendPromise = browserSessionApi.sendInput({
      workspaceId: props.workspaceId,
      input,
    });
    sendPromise.catch(() => {
      // Browser session churn is expected during sidebar remounts and session restarts; the
      // surrounding status UI already surfaces durable backend failures, so dropped input sends
      // should fail closed here instead of throwing in the event loop.
    });
  };

  const flushQueuedPointerMove = () => {
    moveAnimationFrameRef.current = null;
    const queuedMove = latestMoveRef.current;
    latestMoveRef.current = null;
    if (queuedMove == null) {
      return;
    }

    const currentSurface = surfaceRef.current;
    const session = props.session;
    if (
      currentSurface == null ||
      session == null ||
      !interactionState.canInteract ||
      queuedMove.sessionId !== session.id ||
      activePointerIdRef.current === null ||
      activeGestureSessionIdRef.current !== session.id
    ) {
      return;
    }

    const mappedPoint = mapDomPointToViewport(
      queuedMove.clientX,
      queuedMove.clientY,
      currentSurface.getBoundingClientRect(),
      session.lastFrameMetadata,
      { clampOutsideContent: true }
    );
    if (mappedPoint == null) {
      return;
    }

    sendInput(
      {
        kind: "mouse",
        eventType: "mouseMoved",
        x: mappedPoint.x,
        y: mappedPoint.y,
        button: getMouseButtonFromButtons(queuedMove.buttons),
        modifiers: queuedMove.modifiers,
      },
      session.id
    );
  };

  useEffect(() => {
    mountedRef.current = true;
    const cleanupSurface = surfaceRef.current;
    return () => {
      mountedRef.current = false;
      if (moveAnimationFrameRef.current !== null) {
        cancelAnimationFrame(moveAnimationFrameRef.current);
        moveAnimationFrameRef.current = null;
      }
      latestMoveRef.current = null;

      const activePointerId = activePointerIdRef.current;
      const currentSurface = cleanupSurface;
      if (
        currentSurface != null &&
        activePointerId !== null &&
        (!("hasPointerCapture" in currentSurface) ||
          typeof currentSurface.hasPointerCapture !== "function" ||
          currentSurface.hasPointerCapture(activePointerId)) &&
        "releasePointerCapture" in currentSurface &&
        typeof currentSurface.releasePointerCapture === "function"
      ) {
        currentSurface.releasePointerCapture(activePointerId);
      }

      activePointerIdRef.current = null;
      activeGestureSessionIdRef.current = null;
      lastPointerButtonRef.current = "none";
    };
  }, []);

  useEffect(() => {
    const sessionIdChanged = lastInteractionSessionIdRef.current !== currentSessionId;
    if (sessionIdChanged || !interactionState.canInteract) {
      if (moveAnimationFrameRef.current !== null) {
        cancelAnimationFrame(moveAnimationFrameRef.current);
        moveAnimationFrameRef.current = null;
      }
      latestMoveRef.current = null;

      const activePointerId = activePointerIdRef.current;
      const currentSurface = surfaceRef.current;
      if (
        currentSurface != null &&
        activePointerId !== null &&
        (!("hasPointerCapture" in currentSurface) ||
          typeof currentSurface.hasPointerCapture !== "function" ||
          currentSurface.hasPointerCapture(activePointerId)) &&
        "releasePointerCapture" in currentSurface &&
        typeof currentSurface.releasePointerCapture === "function"
      ) {
        currentSurface.releasePointerCapture(activePointerId);
      }

      activePointerIdRef.current = null;
      activeGestureSessionIdRef.current = null;
      lastPointerButtonRef.current = "none";
    }
    lastInteractionSessionIdRef.current = currentSessionId;
  }, [interactionState.canInteract, currentSessionId]);

  const focusSurface = () => {
    surfaceRef.current?.focus({ preventScroll: true });
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactionState.canInteract || props.session == null) {
      return;
    }

    const mappedPoint = mapDomPointToViewport(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
      props.session.lastFrameMetadata
    );
    if (mappedPoint == null) {
      return;
    }

    event.preventDefault();
    focusSurface();
    activePointerIdRef.current = event.pointerId;
    activeGestureSessionIdRef.current = props.session.id;
    lastPointerButtonRef.current = getMouseButtonFromPointerButton(event.button);
    if (
      "setPointerCapture" in event.currentTarget &&
      typeof event.currentTarget.setPointerCapture === "function"
    ) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }

    sendInput(
      {
        kind: "mouse",
        eventType: "mousePressed",
        x: mappedPoint.x,
        y: mappedPoint.y,
        button: lastPointerButtonRef.current,
        clickCount: Math.max(1, event.detail || 1),
        modifiers: getModifierBits(event),
      },
      props.session.id
    );
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (
      !interactionState.canInteract ||
      props.session == null ||
      activePointerIdRef.current !== event.pointerId ||
      activeGestureSessionIdRef.current !== props.session.id ||
      event.buttons === 0
    ) {
      return;
    }

    event.preventDefault();
    latestMoveRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      buttons: event.buttons,
      modifiers: getModifierBits(event),
      sessionId: props.session.id,
    };
    if (moveAnimationFrameRef.current !== null) {
      return;
    }

    moveAnimationFrameRef.current = requestAnimationFrame(() => {
      flushQueuedPointerMove();
    });
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (
      !interactionState.canInteract ||
      props.session == null ||
      activePointerIdRef.current !== event.pointerId ||
      activeGestureSessionIdRef.current !== props.session.id
    ) {
      resetPointerState();
      return;
    }

    event.preventDefault();
    const mappedPoint = mapDomPointToViewport(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
      props.session.lastFrameMetadata,
      { clampOutsideContent: true }
    );
    if (mappedPoint != null) {
      sendInput(
        {
          kind: "mouse",
          eventType: "mouseReleased",
          x: mappedPoint.x,
          y: mappedPoint.y,
          button: lastPointerButtonRef.current,
          clickCount: Math.max(1, event.detail || 1),
          modifiers: getModifierBits(event),
        },
        props.session.id
      );
    }

    releasePointerCapture();
    resetPointerState();
  };

  const handlePointerCancel = () => {
    releasePointerCapture();
    resetPointerState();
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!interactionState.canInteract || props.session == null) {
      return;
    }

    const mappedPoint = mapDomPointToViewport(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
      props.session.lastFrameMetadata
    );
    if (mappedPoint == null) {
      return;
    }

    event.preventDefault();
    sendInput(
      {
        kind: "mouse",
        eventType: "mouseWheel",
        x: mappedPoint.x,
        y: mappedPoint.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: getModifierBits(event),
      },
      props.session.id
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      !interactionState.canInteract ||
      props.session == null ||
      !shouldHandleKeyboardEvent(event)
    ) {
      return;
    }

    event.preventDefault();
    stopKeyboardPropagation(event);

    const sharedKeyboardFields = {
      key: event.key,
      code: event.code,
      modifiers: getModifierBits(event),
    } satisfies Pick<BrowserKeyboardInput, "key" | "code" | "modifiers">;
    sendInput(
      {
        kind: "keyboard",
        eventType: "keyDown",
        ...sharedKeyboardFields,
      },
      props.session.id
    );

    const printableText = getPrintableText(event);
    if (printableText != null) {
      sendInput(
        {
          kind: "keyboard",
          eventType: "char",
          ...sharedKeyboardFields,
          text: printableText,
        },
        props.session.id
      );
    }
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      !interactionState.canInteract ||
      props.session == null ||
      !shouldHandleKeyboardEvent(event)
    ) {
      return;
    }

    event.preventDefault();
    stopKeyboardPropagation(event);
    sendInput(
      {
        kind: "keyboard",
        eventType: "keyUp",
        key: event.key,
        code: event.code,
        modifiers: getModifierBits(event),
      },
      props.session.id
    );
  };

  const blockingOverlay =
    interactionState.blockingMessage != null ? (
      <div className="absolute inset-0 flex items-center justify-center p-6">
        <div className="border-border-light bg-background/90 flex max-w-xs flex-col items-center gap-3 rounded-md border px-4 py-3 text-center shadow-lg backdrop-blur-sm">
          <p className="text-foreground text-xs font-medium">{interactionState.blockingMessage}</p>
          {interactionState.showRestartCta && props.onRestart != null && (
            <button
              type="button"
              onClick={props.onRestart}
              className="bg-accent hover:bg-accent/80 text-accent-foreground inline-flex items-center rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
            >
              Restart
            </button>
          )}
        </div>
      </div>
    ) : null;

  const interactiveSurface =
    props.screenshotSrc != null ? (
      <>
        <img
          src={props.screenshotSrc}
          alt={props.session?.title ?? props.session?.currentUrl ?? "Browser session screenshot"}
          className="pointer-events-none h-full w-full object-contain select-none"
          draggable={false}
        />
        <div
          ref={surfaceRef}
          role="region"
          aria-label="Browser viewport"
          aria-disabled={!interactionState.canInteract}
          tabIndex={interactionState.canInteract ? 0 : -1}
          onFocus={() => {
            setHasFocus(true);
          }}
          onBlur={() => {
            setHasFocus(false);
            releasePointerCapture();
            resetPointerState();
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onContextMenu={(event) => {
            if (interactionState.canInteract) {
              event.preventDefault();
            }
          }}
          className={cn(
            "absolute inset-0 touch-none outline-none",
            interactionState.canInteract ? "cursor-default" : "cursor-not-allowed",
            hasFocus && "ring-accent ring-2 ring-inset"
          )}
        />
      </>
    ) : (
      props.placeholder
    );

  return (
    <div className="bg-background-secondary relative min-h-0 flex-1 overflow-hidden">
      {interactiveSurface}
      {blockingOverlay}
      {props.visibleError && props.screenshotSrc && (
        <div className="pointer-events-none absolute inset-x-3 top-3">
          <div className="bg-background-secondary border-destructive/20 text-destructive flex items-start gap-2 rounded-md border px-3 py-2 text-xs shadow-md">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{props.visibleError}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function getViewportInteractionState(session: BrowserSession | null): ViewportInteractionState {
  if (session == null) {
    return {
      canInteract: false,
      blockingMessage: null,
    };
  }

  if (session.status !== "live") {
    return {
      canInteract: false,
      blockingMessage: null,
    };
  }

  switch (session.streamState) {
    case "restart_required":
      return {
        canInteract: false,
        blockingMessage: "Restart browser to enable live control",
        showRestartCta: true,
      };
    case "fallback":
      return {
        canInteract: false,
        blockingMessage: "Screenshots only — streaming unavailable",
      };
    case "connecting":
      return {
        canInteract: false,
        blockingMessage: "Connecting to browser stream...",
      };
    case "error":
      return {
        canInteract: false,
        blockingMessage: `Stream error: ${session.streamErrorMessage ?? "unknown"}`,
      };
    case "disconnected":
    case null:
      return {
        canInteract: false,
        blockingMessage: null,
      };
    case "live":
      if (session.lastFrameMetadata == null) {
        return {
          canInteract: false,
          blockingMessage: "Waiting for first frame...",
        };
      }

      return {
        canInteract: true,
        blockingMessage: null,
      };
  }
}

function shouldHandleKeyboardEvent(event: KeyboardEvent<HTMLDivElement>): boolean {
  if (event.key === "Escape" || event.key === "Tab") {
    return false;
  }

  return true;
}

function getPrintableText(event: KeyboardEvent<HTMLDivElement>): string | null {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return null;
  }

  return event.key.length === 1 ? event.key : null;
}

function getModifierBits(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  let modifiers = 0;
  if (event.altKey) {
    modifiers |= 1;
  }
  if (event.ctrlKey) {
    modifiers |= 2;
  }
  if (event.metaKey) {
    modifiers |= 4;
  }
  if (event.shiftKey) {
    modifiers |= 8;
  }
  return modifiers;
}

function getMouseButtonFromPointerButton(button: number): BrowserMouseInput["button"] {
  switch (button) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    default:
      return "none";
  }
}

function getMouseButtonFromButtons(buttons: number): BrowserMouseInput["button"] {
  if ((buttons & 1) !== 0) {
    return "left";
  }
  if ((buttons & 4) !== 0) {
    return "middle";
  }
  if ((buttons & 2) !== 0) {
    return "right";
  }
  return "none";
}

export function mapDomPointToViewport(
  clientX: number,
  clientY: number,
  surfaceRect: MeasuredViewportRect,
  metadata: BrowserFrameMetadata | null,
  options?: { clampOutsideContent?: boolean }
): ViewportPoint | null {
  assert(metadata != null, "BrowserViewport requires frame metadata to map viewport coordinates");
  assert(Number.isFinite(metadata.deviceWidth), "BrowserViewport deviceWidth must be finite");
  assert(Number.isFinite(metadata.deviceHeight), "BrowserViewport deviceHeight must be finite");
  assert(metadata.deviceWidth > 0, "BrowserViewport deviceWidth must be positive");
  assert(metadata.deviceHeight > 0, "BrowserViewport deviceHeight must be positive");
  assert(surfaceRect.width > 0, "BrowserViewport surface width must be positive");
  assert(surfaceRect.height > 0, "BrowserViewport surface height must be positive");

  const viewportAspectRatio = metadata.deviceWidth / metadata.deviceHeight;
  const surfaceAspectRatio = surfaceRect.width / surfaceRect.height;
  const renderedWidth =
    surfaceAspectRatio > viewportAspectRatio
      ? surfaceRect.height * viewportAspectRatio
      : surfaceRect.width;
  const renderedHeight =
    surfaceAspectRatio > viewportAspectRatio
      ? surfaceRect.height
      : surfaceRect.width / viewportAspectRatio;
  const renderedLeft = surfaceRect.left + (surfaceRect.width - renderedWidth) / 2;
  const renderedTop = surfaceRect.top + (surfaceRect.height - renderedHeight) / 2;
  const relativeX = clientX - renderedLeft;
  const relativeY = clientY - renderedTop;
  const clampOutsideContent = options?.clampOutsideContent ?? false;

  if (
    !clampOutsideContent &&
    (relativeX < 0 || relativeX > renderedWidth || relativeY < 0 || relativeY > renderedHeight)
  ) {
    return null;
  }

  const normalizedX = clamp(relativeX, 0, renderedWidth) / renderedWidth;
  const normalizedY = clamp(relativeY, 0, renderedHeight) / renderedHeight;
  return {
    x: Math.round(clamp(normalizedX * metadata.deviceWidth, 0, metadata.deviceWidth)),
    y: Math.round(clamp(normalizedY * metadata.deviceHeight, 0, metadata.deviceHeight)),
  };
}
