"use client";

import { useEffect, useRef } from "react";
import { motion } from "motion/react";

import { formatMessageDate, parseEmailAddress } from "@/lib/display";
import { buildEmailBodyDom } from "@/lib/email-dom";
import { loadVeilElement, VEIL_RUNTIME } from "@/lib/veil";

/**
 * Tearable triage view: the open email is rasterised onto a physics cloth
 * (slot="veil-face"), so it tears with the fabric. Its controls are REAL
 * buttons drawn into the cloth — clicking one ON the fabric (the engine
 * raycasts the pointer to the hidden control) runs its handler and the cloth
 * texture re-renders to show the change (e.g. Star → Starred). Tearing the
 * cloth past the threshold trashes the message; the panel opens the next.
 */
export type TearEmail = {
  id: string;
  from: string;
  subject: string;
  body: string;
  html: string;
  snippet: string;
  date: string | null;
};

type Props = {
  email: TearEmail;
  starred: boolean;
  onTear: () => void;
  onReply: () => void;
  onArchive: () => void;
  onStar: (next: boolean) => void;
};

function senderName(raw: string): string {
  const first = (raw || "").split(",")[0] ?? raw;
  const { name, email } = parseEmailAddress(first);
  return name || email || "Unknown sender";
}

function styled(tag: string, css: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  el.style.cssText = css;
  if (text != null) el.textContent = text; // textContent — never innerHTML
  return el;
}

// Solid-colour palette the cloth's face renderer can draw (no gradients).
const CARD = "#1b222c";
const INK = "#eef2f7";
const MUTED = "#9aa6b6";
const BTN = "#3d4858";
const ACCENT = "#2a7da3";
const STAR_ON = "#c8923f";
const DANGER = "#d2583c";

function actionBtn(label: string, bg: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.style.cssText = `font:700 24px system-ui,sans-serif;color:#fff;background:${bg};border:0;border-radius:11px;padding:18px 34px;cursor:pointer`;
  return b;
}

export function TearableReader({
  email,
  starred,
  onTear,
  onReply,
  onArchive,
  onStar,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const tornRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let el: (HTMLElement & { destroy?: () => void }) | null = null;
    tornRef.current = false;
    let isStarred = starred;

    loadVeilElement()
      .then(() => {
        if (disposed || !hostRef.current) return;
        el = document.createElement("veil-cloth");
        el.className = "tear-host";
        el.setAttribute("src", VEIL_RUNTIME);
        el.setAttribute("color", "#222a33, #14181d");
        el.setAttribute("interaction", "tear");
        el.setAttribute("reveal-threshold", "0.3");
        el.setAttribute("breeze", "4");

        const face = styled(
          "div",
          `width:1024px;height:640px;box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif;background:${CARD};color:${INK};padding:40px 48px;display:flex;flex-direction:column;gap:16px;overflow:hidden`,
        );
        face.setAttribute("slot", "veil-face");

        // Top bar: sender + live action controls (clickable on the cloth).
        const bar = styled(
          "div",
          "display:flex;align-items:center;gap:12px;flex:none",
        );
        const who = styled("div", "display:flex;flex-direction:column;margin-right:auto");
        who.appendChild(
          styled("div", "font-size:24px;font-weight:700", senderName(email.from)),
        );
        who.appendChild(
          styled(
            "div",
            `font-size:16px;color:${MUTED}`,
            email.date ? formatMessageDate(email.date) : "",
          ),
        );
        bar.appendChild(who);

        // Star — the live "press on cloth → the cloth value updates" control.
        const star = actionBtn(isStarred ? "Starred" : "Star", isStarred ? STAR_ON : BTN);
        const paintStar = () => {
          star.textContent = isStarred ? "Starred" : "Star";
          star.style.background = isStarred ? STAR_ON : BTN;
          star.style.color = isStarred ? "#1a120a" : "#fff";
        };
        paintStar();
        star.addEventListener("click", (e) => {
          e.stopPropagation();
          isStarred = !isStarred;
          paintStar();
          onStar(isStarred);
        });
        bar.appendChild(star);

        const reply = actionBtn("Reply", ACCENT);
        reply.addEventListener("click", (e) => {
          e.stopPropagation();
          onReply();
        });
        bar.appendChild(reply);

        const archive = actionBtn("Archive", BTN);
        archive.addEventListener("click", (e) => {
          e.stopPropagation();
          onArchive();
        });
        bar.appendChild(archive);
        face.appendChild(bar);

        face.appendChild(
          styled(
            "div",
            "font-size:28px;font-weight:800;line-height:1.2;flex:none",
            email.subject || "(no subject)",
          ),
        );

        // The whole email body — every link a real <a>, clickable on the cloth.
        const body = buildEmailBodyDom(email.html, email.body || email.snippet);
        body.style.flex = "1";
        body.style.overflow = "hidden";
        face.appendChild(body);

        face.appendChild(
          styled(
            "div",
            `flex:none;align-self:flex-start;background:${DANGER};color:#1a0f0c;font-weight:700;border-radius:8px;padding:10px 18px;font-size:17px`,
            "Tear to trash",
          ),
        );
        el.appendChild(face);

        el.addEventListener("veil-revealed", () => {
          if (tornRef.current) return;
          tornRef.current = true;
          onTear();
        });

        hostRef.current.appendChild(el);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      try {
        el?.destroy?.();
      } catch {
        /* already gone */
      }
      el?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email.id]);

  return (
    <motion.div
      className="tear-reader"
      ref={hostRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: 0.25 } }}
    />
  );
}
