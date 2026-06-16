/** Shared loader for the vendored Veil cloth web component. */
export const VEIL_SCRIPT = "/veil/veil-cloth.js";
export const VEIL_RUNTIME = "/veil/runtime/";

let scriptPromise: Promise<void> | null = null;

/**
 * Loads and registers <veil-cloth> once. The element is a plain ES module that
 * pulls its own WASM at runtime, so it is injected as a script the bundler
 * never touches.
 */
export function loadVeilElement(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.customElements?.get("veil-cloth")) return Promise.resolve();
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = VEIL_SCRIPT;
    script.onload = () =>
      window.customElements.whenDefined("veil-cloth").then(() => resolve());
    script.onerror = () => reject(new Error("veil engine failed to load"));
    document.head.appendChild(script);
  });
  return scriptPromise;
}
