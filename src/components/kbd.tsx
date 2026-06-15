/** A keyboard-hint chip. Pass one key per child, e.g. <Kbd>C</Kbd>. */
export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
