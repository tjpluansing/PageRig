import { describe, expect, it } from "vitest";
import { COMMANDS, MENUS, commandForKey, shortcutLabel } from "./commands";

const key = (k: string, mods: Partial<{ ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }> = {}) => ({
  key: k,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

describe("commandForKey", () => {
  it("matches Ctrl and Cmd alike", () => {
    expect(commandForKey(key("o", { ctrl: true }))).toBe("open");
    expect(commandForKey(key("o", { meta: true }))).toBe("open");
    expect(commandForKey(key("S", { ctrl: true }))).toBe("save");
  });

  it("tells undo from redo by Shift, and takes Ctrl+Y for redo", () => {
    expect(commandForKey(key("z", { ctrl: true }))).toBe("undo");
    expect(commandForKey(key("Z", { ctrl: true, shift: true }))).toBe("redo");
    expect(commandForKey(key("y", { ctrl: true }))).toBe("redo");
  });

  it("zooms in with = or +, out with -", () => {
    expect(commandForKey(key("=", { ctrl: true }))).toBe("zoom-in");
    expect(commandForKey(key("+", { ctrl: true, shift: true }))).toBe("zoom-in");
    expect(commandForKey(key("-", { ctrl: true }))).toBe("zoom-out");
    expect(commandForKey(key("0", { ctrl: true }))).toBe("fit-width");
  });

  it("ignores plain typing and unknown shortcuts", () => {
    expect(commandForKey(key("o"))).toBeNull();
    expect(commandForKey(key("a"))).toBeNull();
    expect(commandForKey(key("o", { ctrl: true, alt: true }))).toBeNull();
    expect(commandForKey(key("k", { ctrl: true }))).toBeNull();
  });

  it("opens shortcuts help with F1", () => {
    expect(commandForKey(key("F1"))).toBe("shortcuts");
  });
});

describe("shortcutLabel", () => {
  it("reads naturally on each platform", () => {
    expect(shortcutLabel("CmdOrCtrl+Shift+Z", false)).toBe("Ctrl+Shift+Z");
    expect(shortcutLabel("CmdOrCtrl+Shift+Z", true)).toBe("⇧⌘Z");
    expect(shortcutLabel("CmdOrCtrl+=", false)).toBe("Ctrl++");
    expect(shortcutLabel("F1", true)).toBe("F1");
  });
});

describe("menus", () => {
  it("only list known commands, each once per menu", () => {
    for (const menu of MENUS) {
      const ids = menu.items.filter((i) => i !== "-");
      for (const id of ids) expect(COMMANDS[id]).toBeDefined();
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("give no two commands the same shortcut", () => {
    const seen = new Map<string, string>();
    for (const [id, c] of Object.entries(COMMANDS)) {
      for (const s of [c.shortcut, ...(c.alsoKeys ?? [])]) {
        if (!s) continue;
        expect(seen.get(s), `${s} is used by ${seen.get(s)} and ${id}`).toBeUndefined();
        seen.set(s, id);
      }
    }
  });
});
