"use client";

import { useEffect } from "react";

/**
 * Console easter egg: clears the console, then prints a detailed ASCII Helm —
 * an eight-spoke ship's wheel with a ⎈ hub, above the HELM wordmark.
 */
const WHEEL = String.raw`
             o   o   o
              \  |  /
               \ | /
                \|/
    o ─────────( ⎈ )───────── o
                /|\
               / | \
              /  |  \
             o   o   o
`;

const WORDMARK = [
  "",
  "  ██╗  ██╗███████╗██╗     ███╗   ███╗",
  "  ██║  ██║██╔════╝██║     ████╗ ████║",
  "  ███████║█████╗  ██║     ██╔████╔██║",
  "  ██╔══██║██╔══╝  ██║     ██║╚██╔╝██║",
  "  ██║  ██║███████╗███████╗██║ ╚═╝ ██║",
  "  ╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝     ╚═╝",
].join("\n");

export function ConsoleEgg() {
  useEffect(() => {
    const w = window as Window & { __helmEgg?: boolean };
    if (w.__helmEgg) return;
    w.__helmEgg = true;

    console.clear();
    console.log("%c" + WHEEL, "color:#38bdf8");
    console.log("%c" + WORDMARK, "color:#38bdf8;font-weight:bold");
    console.log(
      "%c  keyboard-first command center  ·  helm.houndcode.com",
      "color:#8a8a80",
    );
  }, []);

  return null;
}
