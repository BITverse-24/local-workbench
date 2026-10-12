import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export default function ResponsivePanel({ side, docked, open, onClose, children }: {
  side: "left" | "right"; docked: boolean; open: boolean; onClose: () => void; children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    if (docked || !open) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current!;
    const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"], a[href]'))
      .filter(element => element.getClientRects().length > 0);
    (focusable()[0] ?? panel).focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key === "Tab") {
        const items = focusable();
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (!items.length) { event.preventDefault(); panel.focus(); }
        else if (event.shiftKey && index <= 0) { event.preventDefault(); items[items.length - 1].focus(); }
        else if (!event.shiftKey && (index < 0 || index === items.length - 1)) { event.preventDefault(); items[0].focus(); }
      }
    };
    const contain = (event: FocusEvent) => { if (!panel.contains(event.target as Node)) (focusable()[0] ?? panel).focus(); };
    document.addEventListener("keydown", keys); document.addEventListener("focusin", contain);
    return () => { document.removeEventListener("keydown", keys); document.removeEventListener("focusin", contain); previous?.focus(); };
  }, [docked, open]);
  if (docked) return <div className={`docked-panel docked-${side}`} hidden={!open}>{children}</div>;
  if (!open) return null;
  return createPortal(<div className="panel-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panelRef} role="dialog" aria-modal="true" aria-label={side === "left" ? "Explorer" : "Settings"}
      tabIndex={-1} className={`panel-drawer panel-drawer-${side}`}>{children}</div>
  </div>, document.body);
}
