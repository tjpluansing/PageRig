import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { COMMANDS, TOGGLES, shortcutLabel, type CommandId, type MenuEntry, type MenuSpec } from "../lib/commands";

export interface CommandState {
  enabled: (id: CommandId) => boolean;
  checked: (id: CommandId) => boolean;
}

interface ListProps {
  items: MenuEntry[];
  state: CommandState;
  onCommand: (id: CommandId) => void;
  onClose: () => void;
  /** Left and right arrows move to the neighbouring menu. */
  onSideways?: (dir: 1 | -1) => void;
  label: string;
  className?: string;
  style?: React.CSSProperties;
}

/** A drop-down list of commands, used by the menu bar and right-click menus. */
export function MenuList({ items, state, onCommand, onClose, onSideways, label, className = "", style }: ListProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Separators at the start or end, or doubled up, are left out.
  const shown = items.filter((item, i) => item !== "-" || (i > 0 && i < items.length - 1 && items[i - 1] !== "-"));

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      buttons[(at + step + buttons.length) % buttons.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      buttons[e.key === "Home" ? 0 : buttons.length - 1]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && onSideways) {
      e.preventDefault();
      onSideways(e.key === "ArrowRight" ? 1 : -1);
    } else if (e.key === "Tab") {
      onClose();
    }
  };

  return (
    <div ref={ref} className={`menu command-menu ${className}`} role="menu" aria-label={label} onKeyDown={onKeyDown} style={style}>
      {shown.map((item, i) => {
        if (item === "-") return <div key={`sep${i}`} className="menu-sep" role="separator" />;
        const cmd = COMMANDS[item];
        const toggle = TOGGLES.has(item);
        const keys = cmd.shortcut ? shortcutLabel(cmd.shortcut) : cmd.hint;
        return (
          <button
            key={item}
            role={toggle ? "menuitemcheckbox" : "menuitem"}
            aria-checked={toggle ? state.checked(item) : undefined}
            disabled={!state.enabled(item)}
            onClick={() => {
              onClose();
              onCommand(item);
            }}
          >
            <span className="menu-check" aria-hidden="true">
              {toggle && state.checked(item) ? "✓" : ""}
            </span>
            <span className="menu-label">{cmd.label}</span>
            {keys && <kbd>{keys}</kbd>}
          </button>
        );
      })}
    </div>
  );
}

interface BarProps {
  menus: MenuSpec[];
  state: CommandState;
  onCommand: (id: CommandId) => void;
}

/** File, Edit, View… menus across the top of the window, for the web app (the desktop app uses native menus). */
export function MenuBar({ menus, state, onCommand }: BarProps) {
  const [open, setOpen] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return;
    const away = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);

  const close = (refocus: boolean) => {
    if (refocus && open !== null) barRef.current?.querySelectorAll<HTMLButtonElement>(".menubar-item")[open]?.focus();
    setOpen(null);
  };

  return (
    <div className="menubar" role="menubar" ref={barRef}>
      {menus.map((menu, i) => (
        <div key={menu.label} className="menu-wrap">
          <button
            className={`menubar-item${open === i ? " open" : ""}`}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === i}
            onClick={() => setOpen(open === i ? null : i)}
            onMouseEnter={() => open !== null && open !== i && setOpen(i)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setOpen(i);
              } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                const items = barRef.current?.querySelectorAll<HTMLButtonElement>(".menubar-item");
                items?.[(i + (e.key === "ArrowRight" ? 1 : -1) + menus.length) % menus.length]?.focus();
              }
            }}
          >
            {menu.label}
          </button>
          {open === i && (
            <MenuList
              key={i}
              label={menu.label}
              items={menu.items}
              state={state}
              onCommand={onCommand}
              onClose={() => close(true)}
              onSideways={(dir) => setOpen((i + dir + menus.length) % menus.length)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** A right-click menu at the pointer. */
export function ContextMenu({ x, y, items, state, onCommand, onClose }: { x: number; y: number } & Omit<ListProps, "label" | "onSideways">) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    // Keep the menu inside the window.
    const el = ref.current?.firstElementChild as HTMLElement | null;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
    }
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener("mousedown", away);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [x, y, onClose]);

  return (
    <div ref={ref} onContextMenu={(e) => e.preventDefault()}>
      <MenuList label="Page" className="context-menu" style={{ position: "fixed", ...pos }} items={items} state={state} onCommand={onCommand} onClose={onClose} />
    </div>
  );
}
