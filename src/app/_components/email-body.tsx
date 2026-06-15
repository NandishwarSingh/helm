"use client";

import { useRef, useState } from "react";

import { LinkifiedText } from "@/lib/display";

/**
 * Renders an email body. HTML emails are shown in a sandboxed, auto-sized
 * iframe (no scripts run) on a white sheet so they read correctly in both
 * light and dark themes; plain-text emails fall back to linkified text.
 */
function sanitize(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

function wrap(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
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
