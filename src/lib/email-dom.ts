/**
 * Converts an email's HTML into a SAFE, self-styled DOM subtree the veil
 * cloth can rasterise and raycast. The cloth's face renderer only draws text,
 * links, solid boxes and same-origin images — and a tainting cross-origin
 * image would break the whole texture — so this:
 *   - rebuilds the tree from an allowlist (no scripts, styles, handlers, or
 *     javascript:/data: links survive — built with textContent + checked hrefs,
 *     so no raw HTML is ever injected);
 *   - drops images for a labelled placeholder (avoids canvas taint);
 *   - applies inline styles per tag so the renderer has computed styles to read.
 * Every surviving link stays a real <a> — clickable on the cloth.
 */

const BLOCK = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE",
  "UL", "OL", "LI", "BLOCKQUOTE", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH",
  "H1", "H2", "H3", "H4", "H5", "H6", "CENTER", "FIGURE", "FIGCAPTION",
]);
const INLINE = new Set([
  "SPAN", "A", "B", "STRONG", "I", "EM", "U", "SMALL", "FONT", "LABEL", "MARK",
]);
const DROP = new Set([
  "SCRIPT", "STYLE", "LINK", "META", "IFRAME", "OBJECT", "EMBED", "FORM",
  "INPUT", "BUTTON", "SELECT", "TEXTAREA", "SVG", "NOSCRIPT", "HEAD", "TITLE",
]);

const HEADING_SIZE: Record<string, string> = {
  H1: "30px", H2: "26px", H3: "23px", H4: "21px", H5: "20px", H6: "19px",
};

function styleFor(tag: string, el: HTMLElement): void {
  if (tag in HEADING_SIZE) {
    el.style.cssText = `font-size:${HEADING_SIZE[tag]};font-weight:800;line-height:1.2;margin:14px 0 8px;color:#f2f5f9`;
  } else if (tag === "A") {
    el.style.cssText = "color:#7fc3e6;font-weight:600";
  } else if (tag === "LI") {
    el.style.cssText = "margin:4px 0 4px 18px;list-style:disc";
  } else if (tag === "BLOCKQUOTE") {
    el.style.cssText = "margin:10px 0;padding-left:14px;border-left:3px solid #3a4660;color:#aab6c6";
  } else if (BLOCK.has(tag)) {
    el.style.cssText = "margin:6px 0;line-height:1.5";
  } else if (tag === "B" || tag === "STRONG") {
    el.style.cssText = "font-weight:700";
  } else if (tag === "I" || tag === "EM") {
    el.style.cssText = "font-style:italic";
  }
}

function rebuild(src: Node, dst: HTMLElement, links: number): number {
  for (const child of Array.from(src.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? "";
      if (text.trim()) dst.appendChild(document.createTextNode(text));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = (child as Element).tagName;

    if (DROP.has(tag)) continue;
    if (tag === "BR") {
      dst.appendChild(document.createElement("br"));
      continue;
    }
    if (tag === "HR") {
      const hr = document.createElement("div");
      hr.style.cssText = "height:1px;background:#37414f;margin:12px 0";
      dst.appendChild(hr);
      continue;
    }
    if (tag === "IMG") {
      // Images can't be drawn (cross-origin taint), so show a placeholder.
      const ph = document.createElement("div");
      ph.style.cssText = "display:inline-block;background:#2a323d;color:#8a96a6;border-radius:6px;padding:8px 14px;margin:4px 0;font-size:15px";
      const alt = (child as Element).getAttribute("alt")?.trim() ?? "";
      ph.textContent = alt.length > 0 ? alt : "[image]";
      dst.appendChild(ph);
      continue;
    }

    if (!BLOCK.has(tag) && !INLINE.has(tag)) {
      // Unknown tag: keep its children, drop the wrapper.
      links = rebuild(child, dst, links);
      continue;
    }

    const el = document.createElement(
      tag === "FONT" || tag === "CENTER" ? "div" : tag.toLowerCase(),
    );
    styleFor(tag, el);
    if (tag === "A") {
      const href = (child as Element).getAttribute("href") ?? "";
      if (/^(https?:|mailto:)/i.test(href) && links < 60) {
        el.setAttribute("href", href);
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
        links += 1;
      }
    }
    links = rebuild(child, el, links);
    dst.appendChild(el);
  }
  return links;
}

/** Build the safe, styled body DOM for the cloth face from an email. */
export function buildEmailBodyDom(html: string, text: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "font-family:system-ui,-apple-system,sans-serif;font-size:18px;line-height:1.5;color:#dde4ec";
  if (html.trim()) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    rebuild(doc.body, wrap, 0);
  } else {
    wrap.textContent = text;
  }
  return wrap;
}
