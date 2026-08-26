import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { controlCenterWorkspace } from "./index.ts";

const root = document.querySelector<HTMLDivElement>("#root");

if (!root) {
  throw new Error("CONTROL_CENTER_ROOT_MISSING");
}

createRoot(root).render(
  <StrictMode>
    <main>
      <h1>Himawari Agent</h1>
      <p data-workspace={controlCenterWorkspace.applicationKind}>Control Center</p>
    </main>
  </StrictMode>,
);
