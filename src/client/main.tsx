import { createRoot } from "react-dom/client";
import App from "./App";
import "@fontsource/jetbrains-mono/400.css";
import "./styles.css";
import { consumeSetupToken } from "./local-installation";
const setupToken = consumeSetupToken();
createRoot(document.getElementById("root")!).render(
  <App setupToken={setupToken} />,
);
