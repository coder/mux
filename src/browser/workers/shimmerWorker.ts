/**
 * Web Worker for shimmer animation
 *
 * Runs the animation loop entirely off the main thread using OffscreenCanvas.
 * Each shimmer instance registers its canvas and config, and the worker
 * manages all animations in a single rAF loop.
 */

import * as Comlink from "comlink";

interface ShimmerInstance {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
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
  startTime: number;
}

const instances = new Map<number, ShimmerInstance>();
let nextId = 0;
let animationRunning = false;

function animate() {
  if (instances.size === 0) {
    animationRunning = false;
    return;
  }

  const now = performance.now();

  for (const instance of instances.values()) {
    const {
      canvas,
      ctx,
      text,
      font,
      color,
      bgColor,
      duration,
      spread,
      dpr,
      textWidth,
      textHeight,
      baselineY,
      startTime,
    } = instance;

    const durationMs = duration * 1000;
    const elapsed = now - startTime;
    // Progress from 1 to 0 (right to left, matching original)
    const progress = 1 - (elapsed % durationMs) / durationMs;

    // Clear
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Scale for HiDPI
    ctx.save();
    ctx.scale(dpr, dpr);

    // Draw base text
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.fillText(text, 0, baselineY);

    // Create gradient for highlight at current position
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

    // Draw highlight on top using composite
    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, textWidth, textHeight);

    ctx.restore();
  }

  requestAnimationFrame(animate);
}

function ensureAnimationRunning() {
  if (!animationRunning) {
    animationRunning = true;
    requestAnimationFrame(animate);
  }
}

const api = {
  /**
   * Register a new shimmer instance
   * @returns Instance ID for later removal
   */
  register(
    canvas: OffscreenCanvas,
    config: {
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
  ): number {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to get 2d context from OffscreenCanvas");
    }

    const id = nextId++;
    instances.set(id, {
      canvas,
      ctx,
      ...config,
      startTime: performance.now(),
    });

    ensureAnimationRunning();
    return id;
  },

  /**
   * Update an existing shimmer instance (e.g., text changed)
   */
  update(
    id: number,
    config: {
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
  ): void {
    const instance = instances.get(id);
    if (!instance) return;

    // Resize canvas if dimensions changed
    if (
      config.textWidth * config.dpr !== instance.canvas.width ||
      config.textHeight * config.dpr !== instance.canvas.height
    ) {
      instance.canvas.width = config.textWidth * config.dpr;
      instance.canvas.height = config.textHeight * config.dpr;
    }

    // Update config (keep startTime for smooth animation)
    Object.assign(instance, config);
  },

  /**
   * Unregister a shimmer instance
   */
  unregister(id: number): void {
    instances.delete(id);
    // Animation loop will stop itself when no instances remain
  },
};

export type ShimmerWorkerAPI = typeof api;

Comlink.expose(api);
