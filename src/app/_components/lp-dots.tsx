"use client";

import { useEffect, useRef } from "react";

/**
 * Interactive dot field on a pitch-black stage. A grid of faint dots that the
 * cursor gently repels and brightens as it passes — nothing else. Canvas + rAF,
 * dpr capped, reduced-motion renders a still field. Dot colour comes from
 * --lp-dot-rgb so it themes (white on dark, ink on light).
 */
export function LpDots() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const canvas = node;
    const context = canvas.getContext("2d");
    if (!context) return;
    const ctx = context;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const GAP = 38;
    let w = 0;
    let h = 0;
    let dots: { x: number; y: number }[] = [];
    let rgb = "255,255,255";
    const mouse = { x: -9999, y: -9999 };

    function readColor() {
      const v = getComputedStyle(canvas).getPropertyValue("--lp-dot-rgb").trim();
      if (v) rgb = v;
    }
    function resize() {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dots = [];
      for (let y = GAP / 2; y < h; y += GAP) {
        for (let x = GAP / 2; x < w; x += GAP) dots.push({ x, y });
      }
    }
    readColor();
    resize();

    function drawStatic() {
      ctx.clearRect(0, 0, w, h);
      for (const d of dots) {
        ctx.beginPath();
        ctx.arc(d.x, d.y, 1.1, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb},0.16)`;
        ctx.fill();
      }
    }

    if (reduce) {
      drawStatic();
      const roStatic = new ResizeObserver(() => {
        resize();
        drawStatic();
      });
      roStatic.observe(canvas);
      return () => roStatic.disconnect();
    }

    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      mouse.x = e.clientX - r.left;
      mouse.y = e.clientY - r.top;
    };
    const onLeave = () => {
      mouse.x = -9999;
      mouse.y = -9999;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave, { passive: true });

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const themeObs = new MutationObserver(readColor);
    themeObs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    let raf = 0;
    const frame = () => {
      ctx.clearRect(0, 0, w, h);
      for (const d of dots) {
        let ox = 0;
        let oy = 0;
        let glow = 0;
        const dx = d.x - mouse.x;
        const dy = d.y - mouse.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 130) {
          const f = 1 - dist / 130;
          const a = Math.atan2(dy, dx);
          ox = Math.cos(a) * f * 15;
          oy = Math.sin(a) * f * 15;
          glow = f;
        }
        const size = 1.05 + glow * 1.8;
        const alpha = 0.14 + glow * 0.72;
        ctx.beginPath();
        ctx.arc(d.x + ox, d.y + oy, size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb},${alpha})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      themeObs.disconnect();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return <canvas ref={ref} className="lp-dots" aria-hidden="true" />;
}
