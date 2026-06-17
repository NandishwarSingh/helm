"use client";

import { useEffect } from "react";

/**
 * Console easter egg. Anyone who opens DevTools gets a one-time Helm compass and
 * a tiny `window.helm` playground — keyboard-first to the very end.
 */
export function ConsoleEgg() {
  useEffect(() => {
    const w = window as Window & { __helmEgg?: boolean; helm?: unknown };
    if (w.__helmEgg) return;
    w.__helmEgg = true;

    const sky = "color:#38bdf8;font-weight:bold";
    const dim = "color:#8a8a80";

    console.log(
      [
        "%c",
        "     \\  |  /",
        "   ──  ⎈  ──      H E L M",
        "     /  |  \\      keyboard-first command center",
        "",
      ].join("\n"),
      sky,
    );
    console.log(
      "%c⎈ You've taken the helm.%c  This inbox runs on keystrokes, not clicks —\n  built solo, keyboard-first, for the hackathon.",
      sky,
      dim,
    );
    console.log(
      "%c  › try  %chelm.shortcuts()%c  ·  %chelm.fly()%c  ·  %chelm.about()",
      dim,
      sky,
      dim,
      sky,
      dim,
      sky,
    );

    w.helm = {
      shortcuts() {
        console.table({
          "J / K": "fly through mail",
          R: "reply",
          E: "archive",
          "G then …": "jump to a folder",
          "⌘ K": "command anything",
          "⌘ ↵": "send",
        });
        return "no mouse required.";
      },
      fly() {
        console.log("%c  J · K · J · K · E · R · ⌘↵ … inbox zero. ⚡", sky);
        return "⛵";
      },
      about() {
        console.log(
          "%cHelm%c — keyboard-first Gmail + Calendar.\n" +
            "  Next.js · Postgres · Corsair · an isolated-vm agent. Solo build.\n" +
            "  https://helm.houndcode.com",
          sky,
          dim,
        );
        return "⎈";
      },
    };
  }, []);

  return null;
}
