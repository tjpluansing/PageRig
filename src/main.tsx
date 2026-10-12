import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { SignPage } from "./components/SignPage";
import "./styles.css";

// Signers arrive from their email at ?sign=<token>; everyone else gets the editor.
const signToken = new URLSearchParams(window.location.search).get("sign");

createRoot(document.getElementById("root")!).render(<StrictMode>{signToken ? <SignPage token={signToken} /> : <App />}</StrictMode>);
