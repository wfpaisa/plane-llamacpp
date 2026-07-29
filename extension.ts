/* extension.ts
 *
 * Panel menu of the Plane Llamacpp GNOME Shell extension: builds a configurable
 * drop-down of user commands (with separators, submenus and dynamic labels) in
 * the top bar. Ported to TypeScript from the Custom Command Menu extension
 * (https://github.com/StorageB/custom-command-menu).
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
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';

const numberOfCommands = 99;

/** Tuple stored in each `commandN` GSettings key: (name, command, icon, visible). */
type CommandTuple = [string, string, string, boolean];

const CommandMenu = GObject.registerClass(
    class CommandMenu extends PanelMenu.Button {
        _pendingCancellables!: Gio.Cancellable[];
        _label!: St.Label | St.Icon;

        _init() {
            super._init(0.5, _('Commands'));
            this._pendingCancellables = [];
        }

        /** Build the panel label and the drop-down menu from GSettings. */
        build(settings: Gio.Settings) {
            let labelText;

            if (settings.get_int('menuoptions-setting') === 2) {
                labelText = settings.get_string('menuicon-setting');
                this._label = new St.Icon({
                    icon_name: labelText.trim(),
                    style_class: 'system-status-icon',
                });
                this.add_child(this._label);
            } else if (settings.get_int('menuoptions-setting') === 1) {
                labelText = settings.get_string('menutitle-setting');
                this._label = new St.Label({
                    text: labelText,
                    y_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                this.add_child(this._label);
            } else {
                labelText = _('Commands');
                this._label = new St.Label({
                    text: labelText,
                    y_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                this.add_child(this._label);
            }

            const menu = this.menu as PopupMenu.PopupMenu;
            const getCmd = (n: number) =>
                settings.get_value(`command${n}`).deep_unpack() as CommandTuple;

            const commandOrder = settings
                .get_value('command-order')
                .deep_unpack() as number[];
            let menuTitle = '';
            let currentSubMenu: PopupMenu.PopupMenuBase | null = null;

            // 0 - no sub menu; 1 - sub menu detected on next line; 2 - submenu creation in progress
            let subMenuStatus = 0;

            for (const j of commandOrder) {
                if (j < 1 || j > numberOfCommands) continue;
                if (!getCmd(j)[3]) continue;

                const [entryRowA, entryRowB, entryRowC] = getCmd(j);

                if (entryRowA === '' && entryRowB === '' && entryRowC === '')
                    continue;

                const currentIndex = commandOrder.indexOf(j);
                let foundNext = false;

                for (let m = currentIndex + 1; m < commandOrder.length; m++) {
                    const nextId = commandOrder[m];

                    if (nextId < 1 || nextId > numberOfCommands) continue;
                    if (!getCmd(nextId)[3]) continue;

                    const [nextEntryRowA, nextEntryRowB, nextEntryRowC] =
                        getCmd(nextId);

                    if (
                        nextEntryRowA === '' &&
                        nextEntryRowB === '' &&
                        nextEntryRowC === ''
                    )
                        continue;

                    const nextRow = getCmd(nextId)[0].trim();

                    if (nextRow.startsWith('*')) {
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
                    if (entryRowA.trim().startsWith('*')) {
                        menuTitle = '';
                    } else {
                        menuTitle = entryRowA.trim();
                        currentSubMenu = null;
                        continue;
                    }
                }

                const separators = ['~~~', '---', '───'];
                // menu entry for separator
                if (separators.some(prefix => entryRowA.trim() === prefix)) {
                    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                    continue;
                }

                // menu entry for labeled separator
                if (
                    separators.some(
                        prefix =>
                            entryRowA.trimStart().startsWith(prefix) &&
                            entryRowA.trimStart().length > prefix.length
                    )
                ) {
                    const matchingSeparator = separators.find(prefix =>
                        entryRowA.trimStart().startsWith(prefix)
                    )!;
                    const sectionLabel = new PopupMenu.PopupBaseMenuItem({
                        reactive: false,
                        style_class: 'section-label-menu-item',
                    });

                    const sepLabelText = entryRowA
                        .trimStart()
                        .slice(matchingSeparator.length)
                        .trim();
                    const label = new St.Label({
                        text: sepLabelText,
                        style_class: 'popup-subtitle-menu-item',
                        x_expand: true,
                        x_align: Clutter.ActorAlign.START,
                        y_align: Clutter.ActorAlign.CENTER,
                    });

                    label.set_style(
                        'font-size: 0.8em; padding: 0em; margin: 0em; line-height: 1em;'
                    );
                    this._resolveLabelAsync(label, sepLabelText);
                    sectionLabel.actor.set_style(
                        'padding-top: 0px; padding-bottom: 0px; min-height: 0;'
                    );
                    sectionLabel.actor.add_child(label);

                    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                    if (matchingSeparator !== '───')
                        menu.addMenuItem(sectionLabel);

                    continue;
                }

                const subMenuName = entryRowA.trim();
                // submenu entry
                if (subMenuName.startsWith('*')) {
                    if (!currentSubMenu) {
                        const sub = new PopupMenu.PopupSubMenuMenuItem(
                            menuTitle
                        );
                        menu.addMenuItem(sub);
                        currentSubMenu = sub.menu;
                    }

                    const itemLabel = subMenuName.replace(/^\*\s*/, '');
                    this._addMenuItem(
                        itemLabel,
                        entryRowB,
                        entryRowC.trim(),
                        currentSubMenu
                    );

                    continue;
                } else {
                    currentSubMenu = null;
                }

                // menu entry for command
                if (entryRowA.trim() !== '') {
                    this._addMenuItem(entryRowA, entryRowB, entryRowC.trim());
                }
            }
        }

        destroy() {
            for (const c of this._pendingCancellables) c.cancel();
            this._pendingCancellables = [];
            super.destroy();
        }

        _resolveLabelAsync(labelWidget: St.Label, text: string) {
            const pattern = /\$\(([^)]+)\)/g;
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const fullMatch = match[0];
                const cmd = match[1];
                const cancellable = new Gio.Cancellable();
                this._pendingCancellables.push(cancellable);
                let timeoutId = GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT,
                    2,
                    () => {
                        if (timeoutId > 0) {
                            cancellable.cancel();
                            timeoutId = 0;
                        }
                        return GLib.SOURCE_REMOVE;
                    }
                );
                try {
                    const proc = Gio.Subprocess.new(
                        ['bash', '-c', cmd],
                        Gio.SubprocessFlags.STDOUT_PIPE |
                            Gio.SubprocessFlags.STDERR_SILENCE
                    );
                    proc.communicate_utf8_async(
                        null,
                        cancellable,
                        (proc, res) => {
                            if (timeoutId > 0) {
                                GLib.Source.remove(timeoutId);
                                timeoutId = 0;
                            }
                            try {
                                const [, stdout] =
                                    proc!.communicate_utf8_finish(res);
                                if (stdout) {
                                    const current = labelWidget.get_text();
                                    labelWidget.set_text(
                                        current.replace(
                                            fullMatch,
                                            stdout.trim()
                                        )
                                    );
                                }
                            } catch (e) {
                                console.log(
                                    `[Plane Llamacpp] Error resolving dynamic label: ${cmd}: ${e}`
                                );
                            }
                        }
                    );
                } catch (e) {
                    if (timeoutId > 0) {
                        GLib.Source.remove(timeoutId);
                        timeoutId = 0;
                    }
                    console.log(
                        `[Plane Llamacpp] Error spawning command: ${cmd}: ${e}`
                    );
                }
            }
        }

        _addMenuItem(
            label: string,
            command: string,
            icon: string,
            targetMenu: PopupMenu.PopupMenuBase = this.menu as PopupMenu.PopupMenu
        ) {
            const newItem = new PopupMenu.PopupMenuItem('');
            if (icon) {
                const commandIcon = new St.Icon({
                    icon_name: icon,
                    style_class: 'popup-menu-icon',
                });
                newItem.add_child(commandIcon);
            }
            const commandLabel = new St.Label({text: label});
            newItem.add_child(commandLabel);
            this._resolveLabelAsync(commandLabel, label);

            newItem.connect('activate', () => {
                if (command.trim().toLowerCase() === '##showapplications') {
                    Main.overview.show(OverviewControls.ControlsState.APP_GRID);
                    return;
                }

                // Run associated command when a menu item is clicked
                console.log(
                    _('[Plane Llamacpp] Attempting to execute command:\n%s').replace(
                        '%s',
                        command
                    )
                );
                const [success] = GLib.spawn_async(
                    null,
                    ['/usr/bin/env', 'bash', '-c', command],
                    null,
                    GLib.SpawnFlags.SEARCH_PATH,
                    null
                );
                if (!success) {
                    console.log(
                        _('[Plane Llamacpp] Error running command:\n%s').replace(
                            '%s',
                            command
                        )
                    );
                }
            });
            targetMenu.addMenuItem(newItem);
        }

        updateLabel(text: string) {
            if (this._label instanceof St.Label) {
                this._label.text = text;
            } else if (this._label instanceof St.Icon) {
                this._label.icon_name = text.trim();
            }
        }
    }
);

export default class PlaneLlamacppExtension extends Extension {
    _settings?: Gio.Settings;
    _indicator?: InstanceType<typeof CommandMenu>;
    _settingsSignals: number[] = [];
    _commandRefreshTimeout: number | null = null;

    enable() {
        this._settings = this.getSettings();
        this._settingsSignals = [];

        this._placeIndicator();

        // Debounced rebuild whenever any command entry changes.
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

        // Watch for changes to menu display settings.
        this._settingsSignals.push(
            this._settings.connect('changed::menuoptions-setting', () =>
                this._refreshIndicator()
            )
        );
        this._settingsSignals.push(
            this._settings.connect('changed::menutitle-setting', () => {
                const newLabelText =
                    this._settings!.get_string('menutitle-setting');
                this._indicator?.updateLabel(newLabelText);
            })
        );
        this._settingsSignals.push(
            this._settings.connect('changed::menuicon-setting', () =>
                this._refreshIndicator()
            )
        );
        this._settingsSignals.push(
            this._settings.connect('changed::command-order', () =>
                this._refreshIndicator()
            )
        );
        this._settingsSignals.push(
            this._settings.connect('changed::menulocation-setting', () =>
                this._refreshIndicator()
            )
        );
        this._settingsSignals.push(
            this._settings.connect('changed::menuposition-setting', () =>
                this._refreshIndicator()
            )
        );
    }

    disable() {
        if (this._settingsSignals.length) {
            for (const id of this._settingsSignals)
                this._settings?.disconnect(id);
            this._settingsSignals = [];
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = undefined;
        }

        if (this._commandRefreshTimeout !== null) {
            GLib.Source.remove(this._commandRefreshTimeout);
            this._commandRefreshTimeout = null;
        }

        this._settings = undefined;
    }

    _placeIndicator() {
        const settings = this._settings!;
        this._indicator = new CommandMenu();
        this._indicator.build(settings);

        const location =
            settings.get_int('menulocation-setting') === 2 ? 'right' : 'left';
        const pos = settings.get_int('menuposition-setting');
        if (settings.get_int('menulocation-setting') === 0) {
            Main.panel.addToStatusArea(
                'command-menu',
                this._indicator,
                Main.sessionMode.panel.left.length,
                'left'
            );
        } else {
            Main.panel.addToStatusArea(
                'command-menu',
                this._indicator,
                pos,
                location
            );
        }
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
        if (this._settings!.get_int('menuoptions-setting') === 2)
            this._indicator!.updateLabel(
                this._settings!.get_string('menuicon-setting')
            );
    }
}
