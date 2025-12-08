"use client";

import { cn } from "@/common/lib/utils";
import * as Comlink from "comlink";
import type { ElementType } from "react";
import { memo, useEffect, useRef } from "react";
import type { ShimmerWorkerAPI } from "@/browser/workers/shimmerWorker";

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
  colorClass?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker Management (singleton)
// ─────────────────────────────────────────────────────────────────────────────

let workerAPI: Comlink.Remote<ShimmerWorkerAPI> | null = null;
let workerFailed = false;

function getWorkerAPI(): Comlink.Remote<ShimmerWorkerAPI> | null {
  if (workerFailed) return null;
  if (workerAPI) return workerAPI;

  try {
    const worker = new Worker(new URL("../../workers/shimmerWorker.ts", import.meta.url), {
      type: "module",
      name: "shimmer-animation",
    });

    worker.onerror = (e) => {
      console.error("[Shimmer] Worker failed to load:", e);
      workerFailed = true;
      workerAPI = null;
    };

    workerAPI = Comlink.wrap<ShimmerWorkerAPI>(worker);
    return workerAPI;
  } catch (e) {
    console.error("[Shimmer] Failed to create worker:", e);
    workerFailed = true;
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shimmer Component
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GPU-accelerated shimmer text effect using OffscreenCanvas in a Web Worker.
 *
 * Renders text with a sweeping highlight animation entirely off the main thread.
 * All animation logic runs in a dedicated worker, leaving the main thread free
 * for streaming and other UI work.
 */
const ShimmerComponent = ({
  children,
  as: Component = "span",
  className,
  duration = 2,
  spread = 2,
  colorClass = "var(--color-muted-foreground)",
}: TextShimmerProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const instanceIdRef = useRef<number | null>(null);
  const transferredRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const api = getWorkerAPI();

    // Get computed styles for font matching
    const computedStyle = getComputedStyle(canvas);
    const font = `${computedStyle.fontWeight} ${computedStyle.fontSize} ${computedStyle.fontFamily}`;

    // Resolve CSS variable to actual color
    const tempEl = document.createElement("span");
    tempEl.style.color = colorClass;
    document.body.appendChild(tempEl);
    const resolvedColor = getComputedStyle(tempEl).color;
    document.body.removeChild(tempEl);

    // Get background color for highlight
    const bgColor =
      getComputedStyle(document.documentElement).getPropertyValue("--color-background").trim() ||
      "hsl(0 0% 12%)";

    // Measure text and size canvas
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    ctx2d.font = font;
    const metrics = ctx2d.measureText(children);
    const textWidth = Math.ceil(metrics.width);
    const ascent = metrics.actualBoundingBoxAscent;
    const descent = metrics.actualBoundingBoxDescent;
    const textHeight = Math.ceil(ascent + descent);

    // Handle HiDPI
    const dpr = window.devicePixelRatio || 1;
    canvas.width = textWidth * dpr;
    canvas.height = textHeight * dpr;
    canvas.style.width = `${textWidth}px`;
    canvas.style.height = `${textHeight}px`;
    canvas.style.verticalAlign = `${-descent}px`;

    const config = {
      text: children,
      font,
      color: resolvedColor,
      bgColor,
      duration,
      spread,
      dpr,
      textWidth,
      textHeight,
      baselineY: ascent,
    };

    // Worker path: transfer canvas and register
    if (api && !transferredRef.current) {
      try {
        const offscreen = canvas.transferControlToOffscreen();
        transferredRef.current = true;
        void api.register(Comlink.transfer(offscreen, [offscreen]), config).then((id) => {
          instanceIdRef.current = id;
        });
      } catch {
        // Transfer failed, fall back to main thread
        runMainThreadAnimation(canvas, config);
      }
    } else if (api && instanceIdRef.current !== null) {
      // Already registered, just update config
      void api.update(instanceIdRef.current, config);
    } else if (!api) {
      // No worker, run on main thread
      return runMainThreadAnimation(canvas, config);
    }

    return () => {
      if (api && instanceIdRef.current !== null) {
        void api.unregister(instanceIdRef.current);
        instanceIdRef.current = null;
      }
    };
  }, [children, colorClass, duration, spread]);

  return (
    <Component className={cn("inline", className)} data-chromatic="ignore">
      <canvas ref={canvasRef} className="inline" />
    </Component>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Thread Fallback
// ─────────────────────────────────────────────────────────────────────────────

interface ShimmerConfig {
  text: string;
  font: string;
  color: string;
  bgColor: string;
  duration: number;
  spread: number;
  dpr: number;
  textWidth: number;
  textHeight: number;
  baselineY: number;
}

function runMainThreadAnimation(canvas: HTMLCanvasElement, config: ShimmerConfig): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return function cleanup() {
      // No animation started - nothing to clean up
    };
  }

  const { text, font, color, bgColor, duration, spread, dpr, textWidth, textHeight, baselineY } =
    config;
  const durationMs = duration * 1000;
  const startTime = performance.now();
  let animationId: number;

  const animate = (now: number) => {
    const elapsed = now - startTime;
    const progress = 1 - (elapsed % durationMs) / durationMs;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.font = font;
    ctx.fillStyle = color;
    ctx.fillText(text, 0, baselineY);

    const dynamicSpread = (text?.length ?? 0) * spread;
    const gradientCenter = progress * textWidth * 2.5 - textWidth * 0.75;
    const gradient = ctx.createLinearGradient(
      gradientCenter - dynamicSpread,
      0,
      gradientCenter + dynamicSpread,
      0
    );
    gradient.addColorStop(0, "transparent");
    gradient.addColorStop(0.5, bgColor);
    gradient.addColorStop(1, "transparent");

    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, textWidth, textHeight);

    ctx.restore();
    animationId = requestAnimationFrame(animate);
  };

  animationId = requestAnimationFrame(animate);
  return () => cancelAnimationFrame(animationId);
}

export const Shimmer = memo(ShimmerComponent);
