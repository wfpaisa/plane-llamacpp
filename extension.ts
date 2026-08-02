/* extension.ts
 *
 * Panel indicator of the Plane Llamacpp GNOME Shell extension: shows the
 * llama.cpp icon in the top bar (its background turns yellow while a server is
 * starting and green while at least one is running) and a drop-down listing the
 * configured server scripts. Each entry starts/stops its `llama-server` command
 * and shows a per-script status icon. Start/stop/error notifications are posted
 * to the message tray. Process handling lives in serverManager.ts.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {
    Extension,
    gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ServerManager, ServerState} from './serverManager.js';
import {extractModelId, parseModel, ParsedModel} from './modelParser.js';

const numberOfCommands = 99;

/** Tuple stored in each `commandN` GSettings key: (name, command, icon, visible). */
type CommandTuple = [string, string, string, boolean];

/** Theme icon name used for the per-script status icon while starting. */
const STARTING_ICON_NAME = 'content-loading-symbolic';

/** CSS class carrying the color for each server state. */
const STATE_CLASS: Record<ServerState, string> = {
    stopped: 'llamacpp-status-stopped',
    starting: 'llamacpp-status-starting',
    running: 'llamacpp-status-running',
};

/** Panel icons shown for the aggregated state (see `setPanelState`). */
interface PanelIcons {
    /** Normal llama.cpp glyph, shown at rest and while any server is running. */
    normal: Gio.Icon;
    /** "Loading" glyph shown while a server is starting up. */
    starting: Gio.Icon;
}

/**
 * Per-script status icons, named after the action a click would perform
 * rather than the current state: a stopped script shows "play" (click to
 * start it), a running one shows "stop" (click to stop it).
 */
interface MenuIcons {
    stopped: Gio.Icon;
    running: Gio.Icon;
    /** Icon for the "Stop all llama-server processes" menu entry. */
    killAll: Gio.Icon;
    /** Icon for the bottom "Settings" menu entry. */
    settings: Gio.Icon;
}

/** Duration (ms) of one full 360° turn of the loading spinner. */
const SPIN_PERIOD_MS = 1000;
/** Interval (ms) between spin steps; ~33 fps is smooth enough for a panel glyph. */
const SPIN_TICK_MS = 30;

/** Options the extension passes to the indicator when (re)building the menu. */
interface BuildOptions {
    getState: (index: number) => ServerState;
    onActivate: (index: number, name: string, command: string) => void;
    onKillAll: () => void;
    onOpenPrefs: () => void;
}

const LlamacppIndicator = GObject.registerClass(
    {GTypeName: 'PlaneLlamacppIndicator'},
    class LlamacppIndicator extends PanelMenu.Button {
        _icon!: St.Icon;
        _icons!: PanelIcons;
        _menuIcons!: MenuIcons;
        /** GLib source id of the running spin loop, or null when not spinning. */
        _spinTimeout: number | null = null;
        /** Per-script menu widgets keyed by command index. */
        _items!: Map<number, {icon: St.Icon}>;

        _init() {
            super._init(0.5, _('Plane Llamacpp'));
            this._items = new Map();
            // Ensure the spin timeout never outlives the actor.
            this.connect('destroy', () => this._stopSpin());
        }

        /** Create the panel icon (custom SVG) as a direct child of the button. */
        setup(icons: PanelIcons, menuIcons: MenuIcons) {
            this._icons = icons;
            this._menuIcons = menuIcons;
            this._icon = new St.Icon({
                gicon: icons.normal,
                style_class: 'system-status-icon',
                icon_size: 16,
            });
            this.add_child(this._icon);
        }

        /** Apply the right glyph for `state` to a per-script status icon. */
        _applyItemIcon(icon: St.Icon, state: ServerState) {
            if (state === 'starting') icon.icon_name = STARTING_ICON_NAME;
            else icon.gicon = this._menuIcons[state];
        }

        /**
         * Build the drop-down: one entry per visible, named script, plus the
         * separator (`---`/`~~~`/`───`) and submenu (`*`) markers ported from
         * the Custom Command Menu extension. A name that is exactly a separator
         * prefix inserts a divider; a prefix followed by text inserts a labeled
         * divider; a name starting with `*` places the entry inside a submenu
         * whose title comes from the (non-`*`) row above the group.
         */
        build(settings: Gio.Settings, opts: BuildOptions) {
            this._items.clear();
            const menu = this.menu as PopupMenu.PopupMenu;

            const getCmd = (n: number) =>
                settings.get_value(`command${n}`).deep_unpack() as CommandTuple;
            const order = settings
                .get_value('command-order')
                .deep_unpack() as number[];

            const separators = ['~~~', '---', '───'];
            const isBlank = (t: CommandTuple) => t[0] === '' && t[1] === '';

            let menuTitle = '';
            let currentSubMenu: PopupMenu.PopupSubMenu | null = null;
            // 0 = no submenu; 1 = submenu detected on next line; 2 = submenu in progress.
            let subMenuStatus = 0;

            for (const j of order) {
                if (j < 1 || j > numberOfCommands) continue;
                const tuple = getCmd(j);
                const [name, command, , visible] = tuple;
                if (!visible) continue;
                if (isBlank(tuple)) continue;

                // Look ahead to the next visible, non-blank entry to decide
                // whether a submenu group is starting here.
                const currentIndex = order.indexOf(j);
                let foundNext = false;
                for (let m = currentIndex + 1; m < order.length; m++) {
                    const nextId = order[m];
                    if (nextId < 1 || nextId > numberOfCommands) continue;
                    const nextTuple = getCmd(nextId);
                    if (!nextTuple[3]) continue;
                    if (isBlank(nextTuple)) continue;

                    if (nextTuple[0].trim().startsWith('*')) {
                        if (subMenuStatus === 0) subMenuStatus = 1;
                        else if (subMenuStatus === 1) subMenuStatus = 2;
                    } else {
                        subMenuStatus = 0;
                    }
                    foundNext = true;
                    break;
                }
                if (!foundNext) subMenuStatus = 0;

                if (subMenuStatus === 1) {
                    if (name.trim().startsWith('*')) {
                        menuTitle = '';
                    } else {
                        // This row is the title for the submenu that follows.
                        menuTitle = name.trim();
                        currentSubMenu = null;
                        continue;
                    }
                }

                // Plain separator: the whole name is a separator prefix.
                if (separators.some(p => name.trim() === p)) {
                    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                    continue;
                }

                // Labeled separator: a prefix followed by text.
                const trimmedStart = name.trimStart();
                const matchingSeparator = separators.find(
                    p =>
                        trimmedStart.startsWith(p) &&
                        trimmedStart.length > p.length
                );
                if (matchingSeparator) {
                    const labelText = trimmedStart
                        .slice(matchingSeparator.length)
                        .trim();
                    menu.addMenuItem(
                        matchingSeparator === '───'
                            ? new PopupMenu.PopupSeparatorMenuItem()
                            : new PopupMenu.PopupSeparatorMenuItem(labelText)
                    );
                    continue;
                }

                // Submenu entry: place it inside the current submenu group.
                const trimmedName = name.trim();
                if (trimmedName.startsWith('*')) {
                    if (!currentSubMenu) {
                        const sub = new PopupMenu.PopupSubMenuMenuItem(
                            menuTitle
                        );
                        menu.addMenuItem(sub);
                        currentSubMenu = sub.menu;
                    }
                    const itemLabel = trimmedName.replace(/^\*\s*/, '');
                    this._addServerItem(
                        j,
                        itemLabel,
                        command.trim(),
                        opts,
                        currentSubMenu
                    );
                    continue;
                } else {
                    currentSubMenu = null;
                }

                if (trimmedName !== '') {
                    this._addServerItem(j, trimmedName, command.trim(), opts);
                }
            }

            if (this._items.size === 0) {
                const empty = new PopupMenu.PopupMenuItem(
                    _('No scripts configured')
                );
                empty.setSensitive(false);
                menu.addMenuItem(empty);
            }

            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const killAllItem = new PopupMenu.PopupImageMenuItem(
                _('Stop all llama-server processes'),
                this._menuIcons.killAll
            );
            killAllItem.connect('activate', () => opts.onKillAll());
            menu.addMenuItem(killAllItem);

            const prefsItem = new PopupMenu.PopupImageMenuItem(
                _('Settings'),
                this._menuIcons.settings
            );
            prefsItem.connect('activate', () => opts.onOpenPrefs());
            menu.addMenuItem(prefsItem);
        }

        /**
         * A server row: name on the left, play/stop status icon flush against
         * the right edge (same pattern GNOME Shell uses to put a switch at the
         * end of a PopupSwitchMenuItem row) so the icon lines up across every
         * row regardless of how long each script's name is.
         */
        _addServerItem(
            index: number,
            name: string,
            command: string,
            opts: BuildOptions,
            targetMenu: PopupMenu.PopupMenuBase = this
                .menu as PopupMenu.PopupMenu
        ) {
            const state = opts.getState(index);
            const item = new PopupMenu.PopupMenuItem(name);

            // If the command references a model (`-hf`/`-m`), render org + base
            // name + coloured badges (size/tags/quant/MTP) exactly like the
            // Plane Llama Bench history table; otherwise keep the plain name.
            const modelId = extractModelId(command);
            const parsed = modelId ? parseModel(modelId) : null;
            if (parsed && parsed.base) {
                item.label.visible = false;
                item.add_child(this._buildModelBox(parsed));
            } else {
                item.label.x_expand = true;
            }

            const icon = new St.Icon({
                style_class: `popup-menu-icon ${STATE_CLASS[state]}`,
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.END,
            });
            this._applyItemIcon(icon, state);
            item.add_child(icon);

            item.connect('activate', () =>
                opts.onActivate(index, name, command)
            );

            this._items.set(index, {icon});
            targetMenu.addMenuItem(item);
        }

        /**
         * Build the `org/` + base-name + badge row for a parsed model id. The
         * box carries `x_expand` so the play/stop icon still sits flush right.
         */
        _buildModelBox(parsed: ParsedModel): St.BoxLayout {
            const box = new St.BoxLayout({
                style_class: 'llamacpp-model-box',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            if (parsed.org) {
                box.add_child(
                    new St.Label({
                        text: `${parsed.org}/`,
                        style_class: 'llamacpp-model-org',
                        y_align: Clutter.ActorAlign.CENTER,
                    })
                );
            }
            box.add_child(
                new St.Label({
                    text: parsed.base,
                    style_class: 'llamacpp-model-name',
                    y_align: Clutter.ActorAlign.CENTER,
                })
            );
            if (parsed.size) box.add_child(this._makeTag(parsed.size, 'info'));
            for (const tag of parsed.tags)
                box.add_child(this._makeTag(tag, 'secondary'));
            if (parsed.quant)
                box.add_child(this._makeTag(parsed.quant, 'default'));
            if (parsed.mtp) box.add_child(this._makeTag('MTP', 'warn'));
            return box;
        }

        /** One coloured badge (St.Label) mirroring a PrimeNG `p-tag` severity. */
        _makeTag(
            text: string,
            severity: 'info' | 'secondary' | 'default' | 'warn'
        ): St.Label {
            return new St.Label({
                text,
                style_class: `llamacpp-tag llamacpp-tag-${severity}`,
                y_align: Clutter.ActorAlign.CENTER,
            });
        }

        /** Update a script's status icon in place (color + glyph). */
        setItemState(index: number, state: ServerState) {
            const item = this._items.get(index);
            if (!item) return;
            this._applyItemIcon(item.icon, state);
            for (const cls of Object.values(STATE_CLASS))
                item.icon.remove_style_class_name(cls);
            item.icon.add_style_class_name(STATE_CLASS[state]);
        }

        /**
         * Paint the whole panel button background from the aggregated state,
         * swap in the "loading" glyph while starting, and spin that glyph only
         * while starting; "running" settles into a solid green so a server that
         * stays up indefinitely doesn't spin forever.
         */
        setPanelState(globalState: 'idle' | 'starting' | 'running') {
            this.remove_style_class_name('llamacpp-running');
            this.remove_style_class_name('llamacpp-starting');

            if (globalState === 'running') {
                this.add_style_class_name('llamacpp-running');
            } else if (globalState === 'starting') {
                this.add_style_class_name('llamacpp-starting');
            }

            if (globalState === 'starting') {
                this._icon.gicon = this._icons.starting;
                this._startSpin();
            } else {
                this._stopSpin();
                this._icon.gicon = this._icons.normal;
            }
        }

        /**
         * Start rotating the loading glyph (no-op if already spinning). The
         * spin is driven by a plain GLib timeout that steps the rotation angle
         * itself: unlike `ease()`, this never depends on a Clutter transition
         * name resolving, so it can't throw inside `setPanelState` (a throw
         * there once aborted the server's readiness detection, leaving the
         * panel stuck amber).
         */
        _startSpin() {
            if (this._spinTimeout !== null) return;
            // Rotate about the icon's own centre, not its top-left corner.
            this._icon.set_pivot_point(0.5, 0.5);
            const stepDeg = 360 * (SPIN_TICK_MS / SPIN_PERIOD_MS);
            this._spinTimeout = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                SPIN_TICK_MS,
                () => {
                    this._icon.rotationAngleZ =
                        (this._icon.rotationAngleZ + stepDeg) % 360;
                    return GLib.SOURCE_CONTINUE;
                }
            );
        }

        /** Stop the spin and snap the glyph back to its upright angle. */
        _stopSpin() {
            if (this._spinTimeout !== null) {
                GLib.Source.remove(this._spinTimeout);
                this._spinTimeout = null;
            }
            this._icon.rotationAngleZ = 0;
        }
    }
);

export default class PlaneLlamacppExtension extends Extension {
    _settings?: Gio.Settings;
    _indicator?: InstanceType<typeof LlamacppIndicator>;
    _manager?: ServerManager;
    _gicon?: Gio.Icon;
    _icons?: PanelIcons;
    _menuIcons?: MenuIcons;
    _notifSource: MessageTray.Source | null = null;
    _settingsSignals: number[] = [];
    _commandRefreshTimeout: number | null = null;
    _sessionModeSignal: number | null = null;

    enable() {
        this._settings = this.getSettings();
        this._settingsSignals = [];

        // Use the `-symbolic` variant so St recolors it to the panel foreground
        // (visible in both light and dark themes); the state color lives in the
        // St.Bin background behind it.
        const iconFile = (name: string) =>
            new Gio.FileIcon({
                file: Gio.File.new_for_path(
                    GLib.build_filenamev([this.path, 'data', 'icons', name])
                ),
            });
        this._gicon = iconFile('llamacpp-symbolic.svg');
        this._icons = {
            normal: this._gicon,
            starting: iconFile('spinner-symbolic.svg'),
        };
        this._menuIcons = {
            stopped: iconFile('play-large-symbolic.svg'),
            running: iconFile('stop-large-symbolic.svg'),
            killAll: iconFile('kill-symbolic.svg'),
            settings: iconFile('settings-symbolic.svg'),
        };

        this._manager = new ServerManager({
            onStateChange: (index, state) => {
                // Never let a drawing error propagate back into the manager:
                // this callback runs mid-`_spawn`, before the server's stdout
                // readers are wired, so a throw here would abort readiness
                // detection and strand the panel on "starting" (amber).
                try {
                    this._indicator?.setItemState(index, state);
                    this._indicator?.setPanelState(
                        this._manager!.getGlobalState()
                    );
                } catch (e) {
                    console.log(`[Plane Llamacpp] indicator update failed: ${e}`);
                }
            },
            onNotify: (title, body, isError) =>
                this._notify(title, body, isError),
        });

        this._placeIndicator();

        // Debounced menu rebuild whenever any script entry changes.
        for (let k = 1; k <= numberOfCommands; k++) {
            this._settingsSignals.push(
                this._settings.connect(`changed::command${k}`, () => {
                    if (this._commandRefreshTimeout !== null) return;
                    this._commandRefreshTimeout = GLib.timeout_add(
                        GLib.PRIORITY_DEFAULT,
                        300,
                        () => {
                            this._commandRefreshTimeout = null;
                            this._refreshIndicator();
                            return GLib.SOURCE_REMOVE;
                        }
                    );
                })
            );
        }

        // Order and placement changes rebuild the indicator too.
        for (const key of ['command-order', 'menuposition-setting']) {
            this._settingsSignals.push(
                this._settings.connect(`changed::${key}`, () =>
                    this._refreshIndicator()
                )
            );
        }

        // The extension keeps running behind the lock screen (see
        // `session-modes` in metadata.json) so that locking the screen never
        // stops the tracked `llama-server` processes. The panel icon itself
        // must still stay hidden while locked, so toggle its visibility with
        // the session mode instead of tearing anything down.
        this._sessionModeSignal = Main.sessionMode.connect('updated', () =>
            this._updateIndicatorVisibility()
        );
    }

    disable() {
        for (const id of this._settingsSignals) this._settings?.disconnect(id);
        this._settingsSignals = [];

        if (this._sessionModeSignal !== null) {
            Main.sessionMode.disconnect(this._sessionModeSignal);
            this._sessionModeSignal = null;
        }

        if (this._commandRefreshTimeout !== null) {
            GLib.Source.remove(this._commandRefreshTimeout);
            this._commandRefreshTimeout = null;
        }

        this._manager?.destroy();
        this._manager = undefined;

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = undefined;
        }

        if (this._notifSource) {
            this._notifSource.destroy(
                MessageTray.NotificationDestroyedReason.SOURCE_CLOSED
            );
            this._notifSource = null;
        }

        this._gicon = undefined;
        this._icons = undefined;
        this._menuIcons = undefined;
        this._settings = undefined;
    }

    _placeIndicator() {
        const settings = this._settings!;
        this._indicator = new LlamacppIndicator();
        this._indicator.setup(this._icons!, this._menuIcons!);
        this._indicator.build(settings, {
            getState: index => this._manager!.getState(index),
            onActivate: (index, name, command) =>
                this._manager!.toggle(index, name, command),
            onKillAll: () => this._manager!.killAllExternal(),
            onOpenPrefs: () => this.openPreferences(),
        });

        const pos = settings.get_int('menuposition-setting');
        Main.panel.addToStatusArea(this.uuid, this._indicator, pos, 'right');

        this._indicator.setPanelState(this._manager!.getGlobalState());
        this._updateIndicatorVisibility();
    }

    /**
     * Hide the panel icon while the screen is locked ('unlock-dialog' session
     * mode) and show it again once unlocked. This only toggles visibility;
     * `_manager` keeps running untouched, so locking the screen never stops
     * the tracked servers.
     */
    _updateIndicatorVisibility() {
        if (!this._indicator) return;
        this._indicator.visible = Main.sessionMode.currentMode !== 'unlock-dialog';
    }

    _refreshIndicator() {
        if (this._commandRefreshTimeout !== null) {
            GLib.Source.remove(this._commandRefreshTimeout);
            this._commandRefreshTimeout = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = undefined;
        }
        this._placeIndicator();
    }

    _ensureSource(): MessageTray.Source {
        if (this._notifSource) return this._notifSource;
        this._notifSource = new MessageTray.Source({
            title: _('Plane Llamacpp'),
            iconName: 'application-x-executable-symbolic',
        });
        this._notifSource.connect('destroy', () => (this._notifSource = null));
        Main.messageTray.add(this._notifSource);
        return this._notifSource;
    }

    _notify(title: string, body: string, isError: boolean) {
        const source = this._ensureSource();
        const notification = new MessageTray.Notification({
            source,
            title,
            body,
            gicon: this._gicon,
            isTransient: !isError,
            urgency: isError
                ? MessageTray.Urgency.HIGH
                : MessageTray.Urgency.NORMAL,
        });
        source.addNotification(notification);
    }
}
