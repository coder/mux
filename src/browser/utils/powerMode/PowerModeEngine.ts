// Inspired by Joel Besada's "activate-power-mode" (MIT).
// Audio clips are sourced from that project (see assets/audio/activate-power-mode/LICENSE.txt).

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  ttlMs: number;
  lifeMs: number;
  color: string;
}

export class PowerModeEngine {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  private particles: Particle[] = [];
  private rafId: number | null = null;
  private lastFrameTimeMs: number | null = null;

  private shakeEl: HTMLElement | null = null;
  private shakeTimeoutId: number | null = null;
  private shakePrevTransform: string | null = null;
  private lastShakeTimeMs = 0;

  private typewriterPool: HTMLAudioElement[] = [];
  private gunPool: HTMLAudioElement[] = [];
  private typewriterIndex = 0;
  private gunIndex = 0;

  private resizeListenerActive = false;

  setCanvas(canvas: HTMLCanvasElement | null): void {
    if (this.canvas === canvas) return;

    this.canvas = canvas;
    this.ctx = canvas?.getContext("2d") ?? null;

    this.setResizeListenerActive(Boolean(canvas && this.ctx));

    if (!canvas || !this.ctx) {
      this.stop();
      return;
    }

    this.resizeCanvasToWindow();
  }

  setShakeElement(el: HTMLElement | null): void {
    if (this.shakeEl === el) return;

    this.clearShake();
    this.shakeEl = el;
  }

  setAudio(urls: { typewriterUrl: string; gunUrl: string } | null): void {
    if (!urls) {
      this.typewriterPool = [];
      this.gunPool = [];
      this.typewriterIndex = 0;
      this.gunIndex = 0;
      return;
    }

    // Keep pools small to avoid unnecessary overhead.
    this.typewriterPool = this.createAudioPool(urls.typewriterUrl, 6, 0.08);
    this.gunPool = this.createAudioPool(urls.gunUrl, 2, 0.04);
    this.typewriterIndex = 0;
    this.gunIndex = 0;
  }

  burst(x: number, y: number, intensity = 1): void {
    const normalizedIntensity = Math.max(1, Math.min(12, Math.floor(intensity)));

    this.maybeShake(normalizedIntensity);
    this.maybePlaySounds(normalizedIntensity);

    if (!this.ctx || !this.canvas) {
      return;
    }

    const count = 8 + normalizedIntensity * 6;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (70 + Math.random() * 140) * (0.6 + normalizedIntensity * 0.12);

      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed - (60 + Math.random() * 80);

      const ttlMs = 240 + Math.random() * 260;
      const hue = Math.floor(Math.random() * 360);

      this.particles.push({
        x,
        y,
        vx,
        vy,
        size: 2 + Math.random() * 2.5,
        ttlMs,
        lifeMs: ttlMs,
        color: `hsl(${hue}, 100%, 70%)`,
      });
    }

    this.startAnimationIfNeeded();
  }

  stop(): void {
    this.particles = [];
    this.stopAnimation();
    this.clearShake();
  }

  private startAnimationIfNeeded(): void {
    if (this.rafId !== null) return;

    this.lastFrameTimeMs = null;
    this.rafId = requestAnimationFrame(this.frame);
  }

  private stopAnimation(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
    this.lastFrameTimeMs = null;

    const ctx = this.ctx;
    if (ctx) {
      // Clear any remaining pixels.
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
  }

  private readonly frame = (nowMs: number) => {
    // Clear the scheduled ID immediately so stop() can safely cancel only pending frames.
    this.rafId = null;

    const ctx = this.ctx;
    if (!ctx || this.particles.length === 0) {
      this.stopAnimation();
      return;
    }

    const lastFrameTimeMs = (this.lastFrameTimeMs ??= nowMs);

    const dtMs = Math.min(34, Math.max(0, nowMs - lastFrameTimeMs));
    this.lastFrameTimeMs = nowMs;

    this.step(dtMs);
    this.render();

    if (this.particles.length > 0) {
      this.rafId = requestAnimationFrame(this.frame);
    }
  };

  private step(dtMs: number): void {
    const dt = dtMs / 1000;
    const gravity = 1100;

    // Update particles in-place, compacting the array.
    let write = 0;
    for (const p of this.particles) {
      p.vy += gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.985;
      p.vy *= 0.985;

      p.lifeMs -= dtMs;
      if (p.lifeMs > 0) {
        this.particles[write] = p;
        write++;
      }
    }
    this.particles.length = write;
  }

  private render(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const width = window.innerWidth;
    const height = window.innerHeight;

    ctx.clearRect(0, 0, width, height);

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (const p of this.particles) {
      const alpha = Math.max(0, Math.min(1, p.lifeMs / p.ttlMs));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }

    ctx.restore();
  }

  private maybeShake(intensity: number): void {
    const el = this.shakeEl;
    if (!el) return;

    const now = performance.now();
    if (now - this.lastShakeTimeMs < 100) {
      return;
    }

    // Shake doesn't need to happen every keystroke.
    const chance = Math.min(0.35, 0.06 * intensity);
    if (Math.random() > chance) {
      return;
    }

    this.lastShakeTimeMs = now;

    const magnitude = 1 + intensity * 0.7;
    const dx = (Math.random() * 2 - 1) * magnitude;
    const dy = (Math.random() * 2 - 1) * magnitude;
    const rot = (Math.random() * 2 - 1) * (magnitude * 0.15);

    if (this.shakeTimeoutId !== null) {
      window.clearTimeout(this.shakeTimeoutId);
      this.shakeTimeoutId = null;
    }

    this.shakePrevTransform ??= el.style.transform || "";

    el.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;

    this.shakeTimeoutId = window.setTimeout(() => {
      this.clearShake();
    }, 75);
  }

  private clearShake(): void {
    const el = this.shakeEl;
    if (!el) {
      this.shakePrevTransform = null;
      return;
    }

    if (this.shakeTimeoutId !== null) {
      window.clearTimeout(this.shakeTimeoutId);
      this.shakeTimeoutId = null;
    }

    if (this.shakePrevTransform === null) {
      return;
    }

    el.style.transform = this.shakePrevTransform;
    this.shakePrevTransform = null;
  }

  private maybePlaySounds(intensity: number): void {
    // Typing audio should feel subtle; avoid errors if autoplay is blocked.
    if (this.typewriterPool.length > 0) {
      const typeChance = Math.min(0.95, 0.55 + intensity * 0.06);
      if (Math.random() <= typeChance) {
        this.playFromPool(this.typewriterPool, "typewriter");
      }
    }

    if (this.gunPool.length > 0) {
      const gunChance = Math.min(0.12, 0.015 * intensity);
      if (Math.random() <= gunChance) {
        this.playFromPool(this.gunPool, "gun");
      }
    }
  }

  private playFromPool(pool: HTMLAudioElement[], kind: "typewriter" | "gun"): void {
    const nextIndex = kind === "typewriter" ? this.typewriterIndex++ : this.gunIndex++;
    const audio = pool[nextIndex % pool.length];

    try {
      audio.currentTime = 0;
      void audio.play().catch(() => {
        // Ignored: browsers may block audio until a gesture; typing usually counts.
      });
    } catch {
      // Ignored.
    }
  }

  private createAudioPool(url: string, size: number, volume: number): HTMLAudioElement[] {
    const pool: HTMLAudioElement[] = [];
    for (let i = 0; i < size; i++) {
      const audio = new Audio(url);
      audio.preload = "auto";
      audio.volume = volume;
      pool.push(audio);
    }
    return pool;
  }

  private setResizeListenerActive(active: boolean): void {
    if (this.resizeListenerActive === active) return;
    this.resizeListenerActive = active;

    if (active) {
      window.addEventListener("resize", this.handleResize, { passive: true });
      return;
    }

    window.removeEventListener("resize", this.handleResize);
  }

  private readonly handleResize = () => {
    this.resizeCanvasToWindow();
  };

  private resizeCanvasToWindow(): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(window.innerWidth * dpr));
    const height = Math.max(1, Math.floor(window.innerHeight * dpr));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    canvas.style.width = "100%";
    canvas.style.height = "100%";

    // Draw in CSS pixels.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}
