import { useLayoutEffect, useState } from "react";

export function useAgentPortalContainer(panelOpen = true) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    // The panel is absent while its children render for the first time.
    // Resolve it after the DOM commit so menus stay in its stacking context.
    setContainer(panelOpen ? document.getElementById("agent-panel") : null);
  }, [panelOpen]);
  return container;
}
