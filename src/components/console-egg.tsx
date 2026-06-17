"use client";

import { useEffect } from "react";

/**
 * Console easter egg: clears the console, then prints the HELM wordmark in
 * ASCII for anyone who opens DevTools.
 */
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
    console.log("%c" + WORDMARK, "color:#38bdf8;font-weight:bold");
    console.log(
      "%c  keyboard-first command center  ·  helm.houndcode.com",
      "color:#8a8a80",
    );
  }, []);

  return null;
}
