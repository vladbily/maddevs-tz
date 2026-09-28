import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

/** Show the application shell while the event screens are being added. */
function App() {
  return <main><h1>Место</h1><p>Хорошие события начинаются со встречи.</p></main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
