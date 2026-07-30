/* prefs.ts
 *
 * Preferences window for the Plane Llamacpp extension: the command editor page
 * plus a configuration page (backup/restore, menu settings, about). Ported to
 * TypeScript from the Custom Command Menu extension
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

import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import commandsUI, {extractModelName} from './commandsUI.js';

const numberOfCommands = 99;
const fileName = 'commands.ini';
const filePath = GLib.build_filenamev([GLib.get_home_dir(), fileName]);

/** Tuple stored in each `commandN` GSettings key: (name, command, icon, visible). */
type CommandTuple = [string, string, string, boolean];

export default class PlaneLlamacppPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        window.set_default_size(700, 850);
        const settings = this.getSettings();

        const page = new commandsUI({
            title: _('Commands'),
            icon_name: 'utilities-terminal-symbolic',
            Settings: settings,
        } as unknown as Partial<Adw.PreferencesPage.ConstructorProps>);
        window.add(page);

        const page2 = new Adw.PreferencesPage({
            title: _('Configuration'),
            icon_name: 'applications-system-symbolic',
        });
        window.add(page2);

        const backupGroup1 = new Adw.PreferencesGroup({
            title: _('Backup and Restore'),
        });

        // Export
        const exportRow = new Adw.ActionRow({
            title: _('Export Command List'),
            subtitle: _(
                "Click to export %s configuration file to user's home directory"
            ).format(fileName),
            activatable: true,
        });
        exportRow.add_prefix(
            new Gtk.Image({icon_name: 'x-office-document-symbolic'})
        );

        exportRow.connect('activated', () => {
            const keyFile = new GLib.KeyFile();
            const commandOrderArray = settings
                .get_value('command-order')
                .deep_unpack() as number[];
            let commandNumber = 0;

            for (let i = 1; i <= numberOfCommands; i++) {
                const [name, command, icon, visible] = settings
                    .get_value(`command${commandOrderArray[i - 1]}`)
                    .deep_unpack() as CommandTuple;
                // Only export commands that are not blank
                if (name !== '' || command !== '' || icon !== '') {
                    commandNumber++;
                    keyFile.set_string(
                        `Command ${commandNumber}`,
                        'Name',
                        name
                    );
                    keyFile.set_string(
                        `Command ${commandNumber}`,
                        'Command',
                        command
                    );
                    keyFile.set_string(
                        `Command ${commandNumber}`,
                        'Icon',
                        icon
                    );
                    keyFile.set_boolean(
                        `Command ${commandNumber}`,
                        'Visible',
                        visible
                    );
                }
            }

            // Try saving the config file
            try {
                keyFile.save_to_file(filePath);
                console.log(
                    '[Plane Llamacpp] Commands exported to %s'.format(filePath)
                );

                const toast = Adw.Toast.new(
                    _('Commands exported to: %s').format(filePath)
                );
                toast.set_timeout(3);
                toast.set_button_label(_('Open'));

                toast.connect('button-clicked', () => {
                    const appInfo = Gio.AppInfo.get_default_for_type(
                        'text/plain',
                        false
                    );
                    if (appInfo) {
                        appInfo.launch_uris([`file://${filePath}`], null);
                    } else {
                        const noAppDialog = new Gtk.MessageDialog({
                            transient_for: window,
                            modal: true,
                            text: _('Application Not Found'),
                            secondary_text: _(
                                'No default application found to open .ini files.\n\n' +
                                    'The commands.ini configuration file can be opened and modified in any text editor. ' +
                                    'To open the file, it may first be required to manually associate the .ini file ' +
                                    'with the default text editor by doing the following:\n\n' +
                                    '1. Open the home directory and locate the commands.ini file\n' +
                                    '2. Right-click on the file and select "Open with..."\n' +
                                    '3. Choose a default text editor, and select the option "Always use for this file type"'
                            ),
                            buttons: Gtk.ButtonsType.CLOSE,
                        });
                        noAppDialog.connect('response', () =>
                            noAppDialog.destroy()
                        );
                        noAppDialog.show();
                    }
                });
                window.add_toast(toast);
            } catch (e) {
                console.log(
                    '[Plane Llamacpp] Failed to export commands\n%s'.format(
                        `${e}`
                    )
                );
                const toast = Adw.Toast.new(_(`Export Error`));
                toast.set_timeout(3);
                toast.set_button_label(_('Details'));
                toast.connect('button-clicked', () => {
                    const errorDialog = new Adw.MessageDialog({
                        transient_for: window,
                        modal: true,
                        heading: _('Export Error'),
                        body: _('Failed to export command list\n\n%s').format(
                            `${e}`
                        ),
                    });
                    errorDialog.add_response('ok', _('OK'));
                    errorDialog.connect('response', () =>
                        errorDialog.destroy()
                    );
                    errorDialog.show();
                });
                window.add_toast(toast);
            }
        });

        // Import
        const importRow = new Adw.ActionRow({
            title: _('Import Command List'),
            subtitle: _(
                "Click to import %s configuration file from user's home directory"
            ).format(fileName),
            activatable: true,
        });
        importRow.add_prefix(
            new Gtk.Image({icon_name: 'x-office-document-symbolic'})
        );

        importRow.connect('activated', () => {
            const importPath = GLib.build_filenamev([
                GLib.get_home_dir(),
                fileName,
            ]);
            const keyFile = new GLib.KeyFile();

            // Check if the file exists
            if (!GLib.file_test(importPath, GLib.FileTest.EXISTS)) {
                const toast = Adw.Toast.new(_(`File not found`));
                toast.set_timeout(3);
                toast.set_button_label(_('Details'));
                toast.connect('button-clicked', () => {
                    const errorDialog = new Adw.MessageDialog({
                        transient_for: window,
                        modal: true,
                        heading: _('File Not Found'),
                        body: _(
                            "The %s configuration file could not be found in the user's home directory. Verify the following file exists:\n\n%s"
                        ).format(fileName, importPath),
                    });
                    errorDialog.add_response('ok', _('OK'));
                    errorDialog.connect('response', () =>
                        errorDialog.destroy()
                    );
                    errorDialog.show();
                });
                window.add_toast(toast);
                return; // Exit the function if file does not exist
            }

            // Try importing the config file
            try {
                keyFile.load_from_file(importPath, GLib.KeyFileFlags.NONE);
                let commandCount = 0;
                for (let i = 1; i <= numberOfCommands; i++) {
                    if (keyFile.has_group(`Command ${i}`)) {
                        const name = keyFile.get_string(`Command ${i}`, 'Name');
                        const command = keyFile.get_string(
                            `Command ${i}`,
                            'Command'
                        );
                        let icon = '';
                        try {
                            icon = keyFile.get_string(`Command ${i}`, 'Icon');
                        } catch {
                            /* optional */
                        }
                        let visible = true;
                        try {
                            visible = keyFile.get_boolean(
                                `Command ${i}`,
                                'Visible'
                            );
                        } catch {
                            /* optional */
                        }
                        settings.set_value(
                            `command${i}`,
                            new GLib.Variant('(sssb)', [
                                name,
                                command,
                                icon,
                                visible,
                            ])
                        );
                        commandCount++;
                    } else {
                        settings.set_value(
                            `command${i}`,
                            new GLib.Variant('(sssb)', ['', '', '', true])
                        );
                    }
                }
                settings.set_value(
                    'command-order',
                    new GLib.Variant(
                        'ai',
                        Array.from({length: numberOfCommands}, (_v, i) => i + 1)
                    )
                );
                page.refreshCommandList();
                page._refreshMenuTitles();
                console.log(
                    '[Plane Llamacpp] Commands imported from %s'.format(
                        importPath
                    )
                );
                const toast = Adw.Toast.new(
                    commandCount === 1
                        ? _('Successfully imported 1 entry')
                        : _('Successfully imported %d entries').format(
                              commandCount
                          )
                );
                toast.set_timeout(3);
                window.add_toast(toast);
            } catch (e) {
                console.log(
                    '[Plane Llamacpp] Failed to import commands\n%s'.format(
                        `${e}`
                    )
                );
                const toast = Adw.Toast.new(_(`Import Error`));
                toast.set_timeout(3);
                toast.set_button_label(_('Details'));
                toast.connect('button-clicked', () => {
                    const errorDialog = new Adw.MessageDialog({
                        transient_for: window,
                        modal: true,
                        heading: _('Import Error'),
                        body: _('Failed to import command list\n\n%s').format(
                            `${e}`
                        ),
                    });
                    errorDialog.add_response('ok', _('OK'));
                    errorDialog.connect('response', () =>
                        errorDialog.destroy()
                    );
                    errorDialog.show();
                });
                window.add_toast(toast);
            }
        });

        // Import from Plane Llama Bench
        const defaultBenchPath = GLib.build_filenamev([
            GLib.get_home_dir(),
            '.config',
            'plane-llama-bench',
            'history.json',
        ]);
        // Seed the stored path with the default so it is visible and editable.
        if (settings.get_string('bench-history-path').trim() === '') {
            settings.set_string('bench-history-path', defaultBenchPath);
        }

        const benchPathRow = new Adw.EntryRow({
            title: _('Plane Llama Bench History Path'),
        });
        settings.bind(
            'bench-history-path',
            benchPathRow,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );

        const benchFavoritesRow = new Adw.SwitchRow({
            title: _('Import Favorites Only'),
            subtitle: _(
                'Only import entries marked as favorite in Plane Llama Bench'
            ),
        });
        settings.bind(
            'bench-favorites-only',
            benchFavoritesRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        const benchImportRow = new Adw.ActionRow({
            title: _('Import from Plane Llama Bench'),
            subtitle: _(
                'Add the launch scripts stored in history.json as commands'
            ),
            activatable: true,
        });
        benchImportRow.add_prefix(
            new Gtk.Image({
                gicon: new Gio.FileIcon({
                    file: Gio.File.new_for_path(
                        GLib.build_filenamev([
                            this.path,
                            'data',
                            'icons',
                            'document-send-symbolic.svg',
                        ])
                    ),
                }),
            })
        );

        /** Show an error toast with a details dialog. */
        const showBenchError = (heading: string, body: string) => {
            const toast = Adw.Toast.new(heading);
            toast.set_timeout(3);
            toast.set_button_label(_('Details'));
            toast.connect('button-clicked', () => {
                const errorDialog = new Adw.MessageDialog({
                    transient_for: window,
                    modal: true,
                    heading,
                    body,
                });
                errorDialog.add_response('ok', _('OK'));
                errorDialog.connect('response', () => errorDialog.destroy());
                errorDialog.show();
            });
            window.add_toast(toast);
        };

        /** Derive a readable command name from a bench config's model flags,
         * following the same `-hf`/`-m` naming pattern used when extracting
         * a name from a command script in the command editor. */
        const deriveBenchName = (
            config: {model?: unknown; argv?: unknown},
            script: string
        ): string => {
            const fromScript = extractModelName(script);
            if (fromScript) return fromScript;

            let model =
                typeof config.model === 'string' ? config.model.trim() : '';
            if (model === '' && Array.isArray(config.argv)) {
                const flags = ['-m', '--model', '--mode', '-hf', '--hf-repo'];
                const argv = config.argv as unknown[];
                for (let i = 0; i < argv.length - 1; i++) {
                    if (
                        typeof argv[i] === 'string' &&
                        flags.includes(argv[i] as string) &&
                        typeof argv[i + 1] === 'string'
                    ) {
                        model = (argv[i + 1] as string).trim();
                        break;
                    }
                }
            }
            if (model === '') return _('Imported command');
            // Basename works for both file paths and HuggingFace repos.
            const base = model.split('/').pop() ?? model;
            return base.replace(/\.gguf$/i, '');
        };

        benchImportRow.connect('activated', () => {
            const benchPath =
                settings.get_string('bench-history-path').trim() ||
                defaultBenchPath;
            const favoritesOnly = settings.get_boolean('bench-favorites-only');

            if (!GLib.file_test(benchPath, GLib.FileTest.EXISTS)) {
                showBenchError(
                    _('File Not Found'),
                    _(
                        'The Plane Llama Bench history file could not be found. Verify the following file exists:\n\n%s'
                    ).format(benchPath)
                );
                return;
            }

            let data: unknown;
            try {
                const [ok, contents] = GLib.file_get_contents(benchPath);
                if (!ok) throw new Error('Could not read file contents');
                const text = new TextDecoder().decode(contents);
                data = JSON.parse(text);
            } catch (e) {
                console.log(
                    '[Plane Llamacpp] Failed to read bench history\n%s'.format(
                        `${e}`
                    )
                );
                showBenchError(
                    _('Import Error'),
                    _('Failed to read Plane Llama Bench history\n\n%s').format(
                        `${e}`
                    )
                );
                return;
            }

            if (!Array.isArray(data)) {
                showBenchError(
                    _('Import Error'),
                    _('The Plane Llama Bench history file is not a valid list.')
                );
                return;
            }

            // Collect unique scripts (deduped) from the history entries.
            const seen = new Set<string>();
            const candidates: {name: string; script: string}[] = [];
            for (const entry of data as Array<Record<string, unknown>>) {
                if (!entry || typeof entry !== 'object') continue;
                if (favoritesOnly && entry.favorite !== true) continue;
                const config = entry.config as
                    | {script?: unknown; model?: unknown; argv?: unknown}
                    | undefined;
                if (!config || typeof config !== 'object') continue;
                const script =
                    typeof config.script === 'string'
                        ? config.script.trim()
                        : '';
                if (script === '' || seen.has(script)) continue;
                seen.add(script);
                candidates.push({
                    name: deriveBenchName(config, script),
                    script,
                });
            }

            if (candidates.length === 0) {
                window.add_toast(
                    Adw.Toast.new(
                        favoritesOnly
                            ? _('No favorite entries found to import')
                            : _('No entries found to import')
                    )
                );
                return;
            }

            // Skip scripts already present as a command.
            const existingScripts = new Set<string>();
            for (let i = 1; i <= numberOfCommands; i++) {
                const [, command] = settings
                    .get_value(`command${i}`)
                    .deep_unpack() as CommandTuple;
                if (command.trim() !== '') existingScripts.add(command.trim());
            }
            const toAdd = candidates.filter(
                c => !existingScripts.has(c.script)
            );

            // Place new entries into the first empty slots, keeping menu order.
            const orderArray = settings
                .get_value('command-order')
                .deep_unpack() as number[];
            let added = 0;
            let idx = 0;
            for (const slot of orderArray) {
                if (idx >= toAdd.length) break;
                if (slot < 1 || slot > numberOfCommands) continue;
                const [name, command, icon] = settings
                    .get_value(`command${slot}`)
                    .deep_unpack() as CommandTuple;
                if (name !== '' || command !== '' || icon !== '') continue;
                const item = toAdd[idx++];
                settings.set_value(
                    `command${slot}`,
                    new GLib.Variant('(sssb)', [
                        item.name,
                        item.script,
                        'utilities-terminal-symbolic',
                        true,
                    ])
                );
                added++;
            }

            page.refreshCommandList();
            page._refreshMenuTitles();

            const skippedExisting = candidates.length - toAdd.length;
            const noRoom = toAdd.length - added;
            let message =
                added === 1
                    ? _('Imported 1 command from Plane Llama Bench')
                    : _('Imported %d commands from Plane Llama Bench').format(
                          added
                      );
            if (skippedExisting > 0)
                message +=
                    ' ' + _('(%d already existed)').format(skippedExisting);
            if (noRoom > 0)
                message +=
                    ' ' + _('(%d skipped, no free slots)').format(noRoom);
            const toast = Adw.Toast.new(message);
            toast.set_timeout(4);
            window.add_toast(toast);
            console.log(
                '[Plane Llamacpp] Imported %d commands from %s'.format(
                    added,
                    benchPath
                )
            );
        });

        // Setup Information
        const configGroup1 = new Adw.PreferencesGroup({
            title: _('Setup Information'),
        });

        const configRow1 = new Adw.ActionRow({
            title: _('Commands'),
            subtitle: _(
                'Enter the display names and associated commands for the drop-down menu.\n' +
                    'Drag and drop to reorder, and use the checkbox to show/hide commands.\n' +
                    '\n' +
                    'Separators\n' +
                    '•  Enter --- or ~~~ in the name field to insert a separator line.\n' +
                    '•  Add text after --- or ~~~ to create a labeled separator.'
            ),
            activatable: false,
        });

        // About
        const aboutGroup1 = new Adw.PreferencesGroup({
            title: _('About'),
        });

        const aboutRow1 = new Adw.ActionRow({
            title: _('Homepage'),
            subtitle: _(
                'GitHub page for additional information and bug reporting'
            ),
            activatable: true,
        });
        aboutRow1.connect('activated', () => {
            Gio.app_info_launch_default_for_uri(
                'https://github.com/wfpaisa/plane-llamacpp',
                null
            );
        });
        aboutRow1.add_prefix(new Gtk.Image({icon_name: 'go-home-symbolic'}));
        aboutRow1.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));

        // Settings
        const settingsGroup1 = new Adw.PreferencesGroup({
            title: _('Settings'),
        });

        const menuPositionSpinRow = new Adw.SpinRow({
            title: _('Menu Position'),
            subtitle: _('Adjust position of the menu in the top bar'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 20,
                step_increment: 1,
            }),
            value: settings.get_int('menuposition-setting'),
        });

        settings.bind(
            'menuposition-setting',
            menuPositionSpinRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );

        const resetRow = new Adw.ActionRow({
            title: _('Reset to Defaults'),
            subtitle: _(
                'Click to restore all commands and settings to their default values'
            ),
            activatable: true,
        });
        resetRow.connect('activated', () => {
            const dialog = new Adw.MessageDialog({
                transient_for: window,
                heading: _('Confirm Reset'),
                body: _(
                    'All commands and extension settings will be reset to their default values. This action cannot be undone.'
                ),
                default_response: 'cancel',
                close_response: 'cancel',
            });

            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('reset', _('Reset'));
            dialog.set_response_appearance(
                'reset',
                Adw.ResponseAppearance.DESTRUCTIVE
            );

            dialog.connect('response', (dlg, response) => {
                if (response === 'reset') {
                    try {
                        for (const key of settings.list_keys()) {
                            settings.reset(key);
                        }
                        page.refreshCommandList();
                        menuPositionSpinRow.value = settings.get_int(
                            'menuposition-setting'
                        );
                        window.add_toast(
                            Adw.Toast.new(_('All settings reset to defaults'))
                        );
                    } catch {
                        window.add_toast(
                            Adw.Toast.new(_('Failed to reset settings'))
                        );
                    }
                }
                dlg.destroy();
            });
            dialog.show();
        });

        // Layout
        page2.add(configGroup1);
        configGroup1.add(configRow1);

        page2.add(backupGroup1);
        backupGroup1.add(exportRow);
        backupGroup1.add(importRow);
        backupGroup1.add(benchPathRow);
        backupGroup1.add(benchFavoritesRow);
        backupGroup1.add(benchImportRow);

        page2.add(settingsGroup1);
        settingsGroup1.add(menuPositionSpinRow);
        settingsGroup1.add(resetRow);

        page2.add(aboutGroup1);
        aboutGroup1.add(aboutRow1);

        this.addMaximizeButton(window);

        return Promise.resolve();
    }

    addMaximizeButton(window: Adw.PreferencesWindow) {
        const icon = new Gtk.Image({
            icon_name: 'window-maximize-symbolic',
            pixel_size: 16,
        });
        const button = new Gtk.Button({
            valign: Gtk.Align.CENTER,
            child: icon,
        });
        button.add_css_class('circular');
        button.set_size_request(24, 24);

        const cssProvider = new Gtk.CssProvider();
        cssProvider.load_from_data(
            `
        button.circular {
            padding: 0;
            min-width: 24px;
            min-height: 24px;
            max-width: 24px;
            max-height: 24px;
        }
        `,
            -1
        );
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default()!,
            cssProvider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );

        button.connect('clicked', () => {
            if (window.is_maximized()) window.unmaximize();
            else window.maximize();
        });

        window.connect('notify::maximized', () => {
            icon.set_from_icon_name(
                window.is_maximized()
                    ? 'window-restore-symbolic'
                    : 'window-maximize-symbolic'
            );
        });

        const content = window.get_content();
        const header = content
            ? (this.findWidgetByType(
                  content,
                  Adw.HeaderBar
              ) as Adw.HeaderBar | null)
            : null;
        if (header) {
            header.pack_end(button);
            button.show();
        } else {
            console.log('[Plane Llamacpp] Error adding maximize button');
        }

        return button;
    }

    findWidgetByType(
        parent: Gtk.Widget,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: any
    ): Gtk.Widget | null {
        let child = parent.get_first_child();
        while (child) {
            if (child instanceof type) return child;
            const found = this.findWidgetByType(child, type);
            if (found) return found;
            child = child.get_next_sibling();
        }
        return null;
    }
}
