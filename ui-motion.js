/**
 * Booot motion wiring for the app shell.
 *
 * Press and lift are pure CSS (components.css / styles.css). This module adds
 * the one JS-driven verb the app needs today: `confirm` (the shiver) when an
 * export lands. Delegated in the capture phase so it works for buttons that
 * other modules render and re-render, without touching their logic.
 */
import { confirm } from "./design/motion.js";

const CONFIRM_ON_CLICK = [
  "#downloadTripBtn",
  "#exportMarkdownBtn",
  ".trip-card-actions [data-action='export']",
].join(",");

document.addEventListener(
  "click",
  (e) => {
    const el = e.target.closest?.(CONFIRM_ON_CLICK);
    if (el) confirm(el);
  },
  true
);
