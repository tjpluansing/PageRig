// The desktop app's menu bar, built from the same menus as the web app's.
import type { CheckMenuItem, MenuItem } from "@tauri-apps/api/menu";
import { COMMANDS, MENUS, TOGGLES, isMac, type CommandId, type MenuEntry } from "./commands";

export interface NativeMenuState {
  enabled: (id: CommandId) => boolean;
  checked: (id: CommandId) => boolean;
}

export interface NativeMenu {
  /** Grey out and tick items to match the app. Only changes are sent. */
  sync: (state: NativeMenuState) => void;
}

/**
 * Install the menu bar. On a Mac the app menu holds About and Quit, and the Edit
 * menu carries the system's Cut, Copy and Paste so they work in text boxes.
 */
export async function installNativeMenu(onCommand: (id: CommandId) => void): Promise<NativeMenu> {
  const { Menu, Submenu, MenuItem, CheckMenuItem, PredefinedMenuItem } = await import("@tauri-apps/api/menu");
  const items = new Map<CommandId, (MenuItem | CheckMenuItem)[]>();
  const shown = new Map<MenuItem | CheckMenuItem, string>();

  const item = async (id: CommandId) => {
    const cmd = COMMANDS[id];
    const opts = { id, text: cmd.label, accelerator: cmd.shortcut, enabled: false, action: () => onCommand(id) };
    const made = TOGGLES.has(id) ? await CheckMenuItem.new({ ...opts, checked: false }) : await MenuItem.new(opts);
    items.set(id, [...(items.get(id) ?? []), made]);
    return made;
  };
  const separator = () => PredefinedMenuItem.new({ item: "Separator" });

  const build = async (entries: MenuEntry[]) => Promise.all(entries.map((e) => (e === "-" ? separator() : item(e))));

  const submenus = [];
  if (isMac) {
    submenus.push(
      await Submenu.new({
        text: "PageRig",
        items: [
          await item("about"),
          await item("check-updates"),
          await separator(),
          await PredefinedMenuItem.new({ item: "Services" }),
          await separator(),
          await PredefinedMenuItem.new({ item: "Hide" }),
          await PredefinedMenuItem.new({ item: "HideOthers" }),
          await PredefinedMenuItem.new({ item: "ShowAll" }),
          await separator(),
          await PredefinedMenuItem.new({ item: "Quit" }),
        ],
      }),
    );
  }
  for (const menu of MENUS) {
    let entries = menu.items;
    if (isMac) entries = entries.filter((e) => e !== "quit" && e !== "about" && e !== "check-updates");
    const built = await build(entries.filter((e, i, all) => !(e === "-" && (i === all.length - 1 || all[i + 1] === "-"))));
    if (isMac && menu.label === "Edit") {
      // After Undo, Redo and the separator.
      built.splice(3, 0, ...(await Promise.all([PredefinedMenuItem.new({ item: "Cut" }), PredefinedMenuItem.new({ item: "Copy" }), PredefinedMenuItem.new({ item: "Paste" }), separator()])));
    }
    submenus.push(await Submenu.new({ text: menu.label, items: built }));
  }
  if (isMac) {
    const help = submenus.pop()!;
    submenus.push(
      await Submenu.new({
        text: "Window",
        items: [await PredefinedMenuItem.new({ item: "Minimize" }), await PredefinedMenuItem.new({ item: "Maximize" }), await PredefinedMenuItem.new({ item: "Fullscreen" })],
      }),
      help,
    );
  }

  const menu = await Menu.new({ items: submenus });
  await menu.setAsAppMenu();

  return {
    sync(state) {
      for (const [id, list] of items) {
        const enabled = state.enabled(id);
        const checked = TOGGLES.has(id) && state.checked(id);
        const key = `${enabled}${checked}`;
        for (const made of list) {
          if (shown.get(made) === key) continue;
          shown.set(made, key);
          made.setEnabled(enabled).catch(() => {});
          if (TOGGLES.has(id)) (made as CheckMenuItem).setChecked(checked).catch(() => {});
        }
      }
    },
  };
}
