// Simple line icons drawn for PageRig. They take the text colour, so they work in light and dark mode.
import type { ReactNode } from "react";

const PATHS = {
  open: <path d="M3 6.5V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-6L8.5 5H4a1 1 0 0 0-1 1.5Z" />,
  save: (
    <>
      <path d="M4 3h9.5L17 6.5V16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M6.5 3v4h6V3M6 17v-5h8v5" />
    </>
  ),
  print: (
    <>
      <path d="M6 7V3h8v4M6 14H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-2" />
      <path d="M6 11h8v6H6z" />
    </>
  ),
  undo: <path d="M7 5 3.5 8.5 7 12M4 8.5h8a4 4 0 0 1 0 8H9" />,
  redo: <path d="M13 5l3.5 3.5L13 12M16 8.5H8a4 4 0 0 0 0 8h3" />,
  search: (
    <>
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="m12.5 12.5 4.5 4.5" />
    </>
  ),
  cursor: <path d="M5 3v13l3.5-3.5 2.5 5 2-1-2.5-5H15L5 3Z" />,
  text: <path d="M4 5V3.5h12V5M10 3.5V17M7.5 17h5" />,
  editText: (
    <>
      <path d="M3 5V3.5h9V5M7.5 3.5v10M5.5 13.5h4" />
      <path d="m12 16.5 5-5-1.5-1.5-5 5-.5 2 2-.5Z" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="14" height="12" rx="1" />
      <circle cx="7.5" cy="8" r="1.3" />
      <path d="m3.5 15 4.5-4.5 3 3 2-2 3.5 3.5" />
    </>
  ),
  ocr: (
    <>
      <path d="M3 7V4a1 1 0 0 1 1-1h3M13 3h3a1 1 0 0 1 1 1v3M17 13v3a1 1 0 0 1-1 1h-3M7 17H4a1 1 0 0 1-1-1v-3" />
      <path d="M7 13.5 10 6l3 7.5M8.2 11h3.6" />
    </>
  ),
  redact: (
    <>
      <rect x="3" y="7" width="14" height="5" rx="0.5" fill="currentColor" />
      <path d="M3 4h9M3 15h11" />
    </>
  ),
  sign: <path d="M3 15c2-5 4-9 5.5-9S7 14 9 14s2.5-3 4-3 1 3 2.5 3M3 17.5h14" />,
  initials: (
    <>
      <path d="M5 5v8M3.5 5h3M3.5 13h3M10 13V5l5 8V5" />
      <path d="M3 16.5h14" />
    </>
  ),
  check: <path d="m4 10.5 4 4L16 6" />,
  stamp: (
    <>
      <path d="M8 3h4v4.5l2 3H6l2-3V3ZM4 10.5h12V14H4zM5 17h10" />
    </>
  ),
  form: (
    <>
      <rect x="3" y="3" width="14" height="14" rx="1" />
      <path d="M6 7h8M6 10.5h3.5M11.5 10h2.5v2.5h-2.5zM6 14h8" />
    </>
  ),
  certificate: (
    <>
      <path d="M4 3h12v9H4z" />
      <path d="M7 6.5h6M7 9h3" />
      <circle cx="13" cy="13.5" r="2.2" />
      <path d="m11.8 15.3-.8 2.7 2-1 2 1-.8-2.7" />
    </>
  ),
  pages: (
    <>
      <rect x="6" y="3" width="10" height="12" rx="1" />
      <path d="M4 6v10a1 1 0 0 0 1 1h8" />
    </>
  ),
  rotateLeft: <path d="M4 4v4h4M4.5 8A6 6 0 1 1 5 13.5" />,
  rotateRight: <path d="M16 4v4h-4M15.5 8a6 6 0 1 0-.5 5.5" />,
  crop: <path d="M6 2v12h12M2 6h12v12" />,
  trash: <path d="M4 5.5h12M8 5.5V3.5h4v2M5.5 5.5l.8 11a1 1 0 0 0 1 .9h5.4a1 1 0 0 0 1-.9l.8-11M8.5 8.5v6M11.5 8.5v6" />,
  addPage: (
    <>
      <path d="M11 3H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8l-5-5Z" />
      <path d="M10 9.5v5M7.5 12h5" />
    </>
  ),
  merge: <path d="M4 3v4a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v4M16 3v4a3 3 0 0 1-3 3M13 14.5l3 2.5 3-2.5" />,
  split: <path d="M10 3v5M10 8 5 13v4M10 8l5 5v4M3 15l2 2 2-2M13 15l2 2 2-2" />,
  extract: (
    <>
      <rect x="3" y="3" width="9" height="12" rx="1" />
      <path d="M10 11h7M14 8l3 3-3 3" />
    </>
  ),
  export: (
    <>
      <path d="M11 3H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8" />
      <path d="M11 3v5h5M11 3l5 5M8 13l4-4M9 9h3v3" />
    </>
  ),
  web: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M3 10h14M10 3c2.2 2 3 4.5 3 7s-.8 5-3 7c-2.2-2-3-4.5-3-7s.8-5 3-7Z" />
    </>
  ),
  protect: (
    <>
      <path d="M10 2.5 4 5v4.5c0 3.8 2.6 6.6 6 8 3.4-1.4 6-4.2 6-8V5l-6-2.5Z" />
      <rect x="7.5" y="9" width="5" height="4" rx="0.5" />
      <path d="M8.5 9V7.8a1.5 1.5 0 0 1 3 0V9" />
    </>
  ),
  send: <path d="M3 10 17 3l-4 14-3.5-5.5L3 10ZM9.5 11.5 17 3" />,
  inbox: <path d="M3 11h4l1 2h4l1-2h4M3 11l2.5-7h9L17 11v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5Z" />,
  settings: (
    <>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
    </>
  ),
  thumbs: (
    <>
      <rect x="3" y="3" width="6" height="6" rx="0.5" />
      <rect x="11" y="3" width="6" height="6" rx="0.5" />
      <rect x="3" y="11" width="6" height="6" rx="0.5" />
      <rect x="11" y="11" width="6" height="6" rx="0.5" />
    </>
  ),
  tools: (
    <>
      <rect x="3" y="3" width="5.5" height="5.5" rx="1" />
      <rect x="11.5" y="3" width="5.5" height="5.5" rx="1" />
      <rect x="3" y="11.5" width="5.5" height="5.5" rx="1" />
      <path d="M14.25 11.5v5.5M11.5 14.25H17" />
    </>
  ),
  zoomIn: (
    <>
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="m12.5 12.5 4.5 4.5M6.5 8.5h4M8.5 6.5v4" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="m12.5 12.5 4.5 4.5M6.5 8.5h4" />
    </>
  ),
  fit: <path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4M6 10h8M8 8l-2 2 2 2M12 8l2 2-2 2" />,
  up: <path d="m5 12.5 5-5 5 5" />,
  down: <path d="m5 7.5 5 5 5-5" />,
  close: <path d="m5 5 10 10M15 5 5 15" />,
  help: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M8 8a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.5M10 14v.01" />
    </>
  ),
  badge: (
    <>
      <circle cx="10" cy="8" r="4.5" />
      <path d="m7.5 12-1.5 5.5 4-2 4 2-1.5-5.5M8 8l1.5 1.5L12.5 6.5" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
