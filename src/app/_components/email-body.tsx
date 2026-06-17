"use client";

import DOMPurify from "dompurify";
import { useRef, useState } from "react";

import { LinkifiedText } from "@/lib/display";

/**
 * Renders an email body. HTML emails are shown in a sandboxed, auto-sized
 * iframe on a white sheet so they read correctly in both light and dark themes;
 * plain-text emails fall back to linkified text. Defence in depth: the markup is
 * run through DOMPurify (a real allowlist parser, not a regex), the iframe omits
 * `allow-scripts` so nothing executes, and the framed document carries a strict
 * Content-Security-Policy. `allow-same-origin` is kept only so the parent can
 * read the body height for auto-sizing — harmless without `allow-scripts`.
 */
function sanitize(html: string): string {
  // Guarded for SSR — the email body only renders after the user opens a
  // message, so the server pass is a no-op and DOMPurify runs in the browser.
  if (typeof window === "undefined") return "";
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}

function wrap(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:; media-src https: data:">
<base target="_blank">
<style>
  html,body{margin:0;padding:0;background:#fff;color:#17170f;
    font-family:-apple-system,system-ui,"Segoe UI",sans-serif;font-size:14px;line-height:1.55;
    word-break:break-word;overflow-wrap:anywhere;}
  body{padding:4px 2px;}
  img{max-width:100%;height:auto;}
  a{color:#0369a1;}
  table{max-width:100%;}
</style></head><body>${sanitize(html)}</body></html>`;
}

export function EmailBody({ html, text }: { html?: string; text?: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(0);

  if (html?.trim()) {
    return (
      <iframe
        ref={ref}
        title="Message"
        className="email-frame"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={wrap(html)}
        style={{ height: height ? `${height}px` : "62vh" }}
        onLoad={() => {
          const doc = ref.current?.contentDocument;
          if (doc?.body) setHeight(doc.body.scrollHeight + 24);
        }}
      />
    );
  }

  return (
    <div className="read-body">
      <LinkifiedText text={text?.trim() ? text : "(empty)"} />
    </div>
  );
}
