/* commandsUI.ts
 *
 * Adwaita preferences page that edits the command list: one expander row per
 * command with name/command entries, a visibility checkbox, per-row
 * insert/duplicate/delete actions and drag-and-drop reordering. Ported to
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

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const numberOfCommands = 99;

/** Tuple stored in each `commandN` GSettings key: (name, command, icon, visible). */
type CommandTuple = [string, string, string, boolean];

/** Expander row carrying the per-command widgets and metadata we attach to it. */
type CommandRow = Adw.ExpanderRow & {
    _rowNumber: number;
    _entryRowName: Adw.EntryRow;
    _commandBuffer: Gtk.TextBuffer;
    _checkButton: Gtk.Button;
};

/** Read the full text of a multi-line command buffer. */
function getBufferText(buffer: Gtk.TextBuffer): string {
    return buffer.get_text(
        buffer.get_start_iter(),
        buffer.get_end_iter(),
        false
    );
}

let draggedRow: CommandRow | null = null;

export default class commandsUI extends Adw.PreferencesPage {
    static {
        GObject.registerClass(
            {
                GTypeName: 'PlaneLlamacppCommandsUI',
            },
            this
        );
    }

    _settings!: Gio.Settings;
    _expanderRows!: CommandRow[];
    _commandBoxList!: Gtk.ListBox;
    _scroller!: Gtk.ScrolledWindow;
    _overlay!: Adw.ToastOverlay;
    _addCommandButton!: Gtk.ListBoxRow;

    _init(params: {Settings?: Gio.Settings} & Record<string, unknown> = {}) {
        this._settings = params.Settings!;
        this._expanderRows = [];
        const args = {...params};
        delete args.Settings;
        super._init(args as Partial<Adw.PreferencesPage.ConstructorProps>);

        const style = new Gtk.CssProvider();
        const cssData = `button > label { font-weight: normal; }`;
        style.load_from_data(cssData, cssData.length);
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default()!,
            style,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );

        this._commandBoxList = new Gtk.ListBox();
        this._commandBoxList.add_css_class('boxed-list');

        this._scroller = new Gtk.ScrolledWindow();
        this._scroller.set_policy(
            Gtk.PolicyType.NEVER,
            Gtk.PolicyType.AUTOMATIC
        );
        this._scroller.set_propagate_natural_height(true);
        this._scroller.set_child(this._commandBoxList);

        const clamp = new Adw.Clamp({child: this._scroller});

        this._overlay = new Adw.ToastOverlay();
        this._overlay.set_child(clamp);

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        box.append(this._overlay);

        const group = new Adw.PreferencesGroup();
        group.add(box);
        this.add(group);

        this._initDragMenu();
    }

    _addRow(dragBox: Gtk.ListBox, rowNumber: number, index: number) {
        const row = new Adw.ExpanderRow({
            title: '',
            selectable: false,
            expanded: false,
        }) as CommandRow;
        row._rowNumber = rowNumber;
        this._expanderRows.push(row);

        const entryRowName = new Adw.EntryRow({title: _('Name:')});

        // Multi-line command editor: llama-server scripts span several lines with
        // `\` continuations, which a single-line Adw.EntryRow cannot hold.
        const commandView = new Gtk.TextView({
            monospace: true,
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            accepts_tab: false,
            top_margin: 6,
            bottom_margin: 6,
            left_margin: 6,
            right_margin: 6,
        });
        const commandBuffer = commandView.get_buffer();
        const commandScroller = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            min_content_height: 96,
        });
        commandScroller.set_child(commandView);
        const commandFrame = new Gtk.Frame({child: commandScroller});
        const commandLabel = new Gtk.Label({
            label: _('Command:'),
            xalign: 0,
            css_classes: ['dim-label', 'caption'],
        });
        const commandBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 12,
            margin_end: 12,
        });
        commandBox.append(commandLabel);
        commandBox.append(commandFrame);

        row.add_row(entryRowName);
        row.add_row(commandBox);

        row._entryRowName = entryRowName;
        row._commandBuffer = commandBuffer;

        const [name, command] = this._settings
            .get_value(`command${rowNumber}`)
            .deep_unpack() as CommandTuple;
        entryRowName.text = name;
        commandBuffer.set_text(command, -1);

        row.title = entryRowName.text.replace(/&/g, '&amp;');

        // (menuButton)
        const gMenu = new Gio.Menu();
        gMenu.append(_('Insert new'), 'row.insert');
        gMenu.append(_('Duplicate'), 'row.duplicate');
        gMenu.append(_('Delete'), 'row.delete');

        const menuButton = new Gtk.MenuButton({
            icon_name: 'view-more-symbolic',
            valign: Gtk.Align.CENTER,
            has_frame: false,
            menu_model: gMenu,
        });
        const actionGroup = new Gio.SimpleActionGroup();

        // (insert)
        const insertAction = new Gio.SimpleAction({name: 'insert'});
        insertAction.connect('activate', () => {
            let inserted = false;
            for (const child of this._getListBoxRows(this._commandBoxList)) {
                if (child instanceof Adw.ExpanderRow && !child.visible) {
                    const crow = child as CommandRow;
                    this._settings.set_value(
                        `command${crow._rowNumber}`,
                        new GLib.Variant('(sssb)', ['', '', '', true])
                    );
                    crow._entryRowName.text = '';
                    crow._commandBuffer.set_text('', -1);
                    crow.title = '';

                    (crow._checkButton.get_child() as Gtk.Image).set_from_icon_name(
                        'checkbox-checked-symbolic'
                    );
                    crow.remove_css_class('dim-label');

                    this._commandBoxList.remove(crow);
                    const updatedRows = this._getListBoxRows(
                        this._commandBoxList
                    );
                    const insertIndex = updatedRows.indexOf(row) + 1;
                    this._commandBoxList.insert(crow, insertIndex);

                    crow.visible = true;
                    crow.expanded = true;
                    this._emitReorder();

                    inserted = true;
                    break;
                }
            }
            if (!inserted)
                this._overlay.add_toast(
                    new Adw.Toast({title: _('Maximum row limit reached')})
                );
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._refreshMenuTitles();
                return GLib.SOURCE_REMOVE;
            });
        });
        actionGroup.add_action(insertAction);

        // (duplicate)
        const duplicateAction = new Gio.SimpleAction({name: 'duplicate'});
        duplicateAction.connect('activate', () => {
            let inserted = false;
            for (const child of this._getListBoxRows(this._commandBoxList)) {
                if (child instanceof Adw.ExpanderRow && !child.visible) {
                    const crow = child as CommandRow;
                    const [dName, dCommand] = this._settings
                        .get_value(`command${row._rowNumber}`)
                        .deep_unpack() as CommandTuple;
                    const newName = `${dName} ${_('(copy)')}`;

                    this._settings.set_value(
                        `command${crow._rowNumber}`,
                        new GLib.Variant('(sssb)', [newName, dCommand, '', true])
                    );

                    crow._entryRowName.text = newName;
                    crow._commandBuffer.set_text(dCommand, -1);
                    crow.title = newName.replace(/&/g, '&amp;');

                    (crow._checkButton.get_child() as Gtk.Image).set_from_icon_name(
                        'checkbox-checked-symbolic'
                    );
                    crow.remove_css_class('dim-label');

                    this._commandBoxList.remove(crow);
                    const updatedRows = this._getListBoxRows(
                        this._commandBoxList
                    );
                    const insertIndex = updatedRows.indexOf(row) + 1;
                    this._commandBoxList.insert(crow, insertIndex);

                    crow.visible = true;
                    crow.expanded = true;
                    this._emitReorder();

                    inserted = true;
                    break;
                }
            }
            if (!inserted)
                this._overlay.add_toast(
                    new Adw.Toast({title: _('Maximum row limit reached')})
                );
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._refreshMenuTitles();
                return GLib.SOURCE_REMOVE;
            });
        });
        actionGroup.add_action(duplicateAction);

        // (delete)
        const deleteAction = new Gio.SimpleAction({name: 'delete'});
        deleteAction.connect('activate', () => {
            const adjustment = this._scroller.get_vadjustment();
            const scrollValue = adjustment.get_value();
            draggedRow = null;

            row._entryRowName.text = '';
            row._commandBuffer.set_text('', -1);
            row.title = '';

            row.visible = false;
            this._settings.set_value(
                `command${rowNumber}`,
                new GLib.Variant('(sssb)', ['', '', '', true])
            );

            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                adjustment.set_value(scrollValue);
                return GLib.SOURCE_REMOVE;
            });

            const clock = this._scroller.get_frame_clock?.();
            if (clock) {
                const handlerId = clock.connect('after-paint', () => {
                    adjustment.set_value(scrollValue);
                    clock.disconnect(handlerId);
                });
            }
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._refreshMenuTitles();
                return GLib.SOURCE_REMOVE;
            });
        });
        actionGroup.add_action(deleteAction);

        row.add_suffix(menuButton);
        row.insert_action_group('row', actionGroup);

        // (checkbox)
        const checkButtonIcon = (
            this._settings.get_value(`command${rowNumber}`).deep_unpack() as CommandTuple
        )[3]
            ? 'checkbox-checked-symbolic'
            : 'checkbox-symbolic';
        const checkButton = new Gtk.Button({
            child: new Gtk.Image({icon_name: checkButtonIcon, pixel_size: 14}),
            has_frame: false,
            valign: Gtk.Align.CENTER,
        });
        row._checkButton = checkButton;

        if (checkButtonIcon === 'checkbox-checked-symbolic')
            row.remove_css_class('dim-label');
        else row.add_css_class('dim-label');

        checkButton.connect('clicked', () => {
            const image = checkButton.get_child() as Gtk.Image;
            const newIcon =
                image.icon_name === 'checkbox-checked-symbolic'
                    ? 'checkbox-symbolic'
                    : 'checkbox-checked-symbolic';
            image.set_from_icon_name(newIcon);

            const [cName, cCommand] = this._settings
                .get_value(`command${rowNumber}`)
                .deep_unpack() as CommandTuple;

            this._settings.set_value(
                `command${rowNumber}`,
                new GLib.Variant('(sssb)', [
                    cName,
                    cCommand,
                    '',
                    newIcon === 'checkbox-checked-symbolic',
                ])
            );

            if (newIcon === 'checkbox-checked-symbolic')
                row.remove_css_class('dim-label');
            else row.add_css_class('dim-label');

            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._refreshMenuTitles();
                return GLib.SOURCE_REMOVE;
            });
        });
        row.add_suffix(checkButton);

        entryRowName.connect('notify::text', () => {
            row.title = entryRowName.text.replace(/&/g, '&amp;');
            const [, , , visible] = this._settings
                .get_value(`command${rowNumber}`)
                .deep_unpack() as CommandTuple;
            this._settings.set_value(
                `command${rowNumber}`,
                new GLib.Variant('(sssb)', [
                    entryRowName.text,
                    getBufferText(commandBuffer),
                    '',
                    visible,
                ])
            );

            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._refreshMenuTitles();
                return GLib.SOURCE_REMOVE;
            });
        });

        commandBuffer.connect('changed', () => {
            const [name2, , , visible] = this._settings
                .get_value(`command${rowNumber}`)
                .deep_unpack() as CommandTuple;
            this._settings.set_value(
                `command${rowNumber}`,
                new GLib.Variant('(sssb)', [
                    name2,
                    getBufferText(commandBuffer),
                    '',
                    visible,
                ])
            );
        });

        row.add_prefix(
            new Gtk.Image({
                icon_name: 'list-drag-handle-symbolic',
                css_classes: ['dim-label'],
            })
        );

        // (drag)
        let dragX = 0;
        let dragY = 0;
        const dropController = new Gtk.DropControllerMotion();
        const dragSource = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});

        row.add_controller(dragSource);
        row.add_controller(dropController);

        dragSource.connect('prepare', (_source, x, y) => {
            dragX = x;
            dragY = y;
            const value = new GObject.Value();
            value.init(Gtk.ListBoxRow.$gtype);
            value.set_object(row);
            return Gdk.ContentProvider.new_for_value(value);
        });

        dragSource.connect('drag-begin', (_source, drag) => {
            draggedRow = row;
            const dragWidget = new Gtk.ListBox();
            dragWidget.set_size_request(row.get_width(), row.get_height());
            dragWidget.add_css_class('boxed-list');

            const dragRow = new Adw.ExpanderRow({
                title: row.title,
                selectable: false,
            });
            dragRow.add_prefix(
                new Gtk.Image({
                    icon_name: 'list-drag-handle-symbolic',
                    css_classes: ['dim-label'],
                })
            );

            dragWidget.append(dragRow);
            dragWidget.drag_highlight_row(dragRow);

            const icon = Gtk.DragIcon.get_for_drag(drag);
            (icon as Gtk.DragIcon).child = dragWidget;
            drag.set_hotspot(dragX, dragY);
        });

        dropController.connect('enter', () => dragBox.drag_highlight_row(row));
        dropController.connect('leave', () => dragBox.drag_unhighlight_row());
        dragBox.insert(row, index);

        if (
            entryRowName.text === '' &&
            getBufferText(commandBuffer) === ''
        ) {
            row.visible = false;
        }
    }

    _initDragMenu() {
        this._expanderRows.length = 0;
        const commandBoxTarget = Gtk.DropTarget.new(
            Gtk.ListBoxRow.$gtype,
            Gdk.DragAction.MOVE
        );
        this._commandBoxList.add_controller(commandBoxTarget);
        this._commandBoxList.set_vexpand(false);

        let savedOrder: number[] = [];
        try {
            savedOrder = this._settings
                .get_value('command-order')
                .deep_unpack() as number[];
        } catch (e) {
            console.log(
                '[Plane Llamacpp] Failed to read command-order from settings:',
                e
            );
        }

        if (!Array.isArray(savedOrder) || savedOrder.length !== numberOfCommands) {
            console.log('[Plane Llamacpp] Invalid savedOrder array');
            savedOrder = Array.from({length: numberOfCommands}, (_v, i) => i + 1);
        }

        for (let i = 0; i < savedOrder.length; i++) {
            const rowNumber = savedOrder[i];
            this._addRow(this._commandBoxList, rowNumber, -1);
        }

        // (add command)
        this._addCommandButton = new Gtk.ListBoxRow({
            selectable: false,
            activatable: true,
        });

        const buttonBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            margin_top: 8,
            margin_bottom: 8,
        });

        const icon = new Gtk.Image({
            icon_name: 'list-add-symbolic',
            pixel_size: 16,
        });
        buttonBox.append(icon);

        this._addCommandButton.set_child(buttonBox);

        const clickGesture = new Gtk.GestureClick();
        clickGesture.connect('released', () => {
            let inserted = false;
            for (const child of this._getListBoxRows(this._commandBoxList)) {
                if (child instanceof Adw.ExpanderRow && !child.visible) {
                    const crow = child as CommandRow;
                    this._settings.set_value(
                        `command${crow._rowNumber}`,
                        new GLib.Variant('(sssb)', ['', '', '', true])
                    );

                    (crow._checkButton.get_child() as Gtk.Image).set_from_icon_name(
                        'checkbox-checked-symbolic'
                    );
                    crow.remove_css_class('dim-label');

                    this._commandBoxList.remove(crow);
                    const index = this._getListBoxRows(
                        this._commandBoxList
                    ).indexOf(this._addCommandButton);
                    this._commandBoxList.insert(crow, index);

                    let order = this._settings
                        .get_value('command-order')
                        .deep_unpack() as number[];
                    order = order.filter(n => n !== crow._rowNumber);
                    order.push(crow._rowNumber);
                    this._settings.set_value(
                        'command-order',
                        new GLib.Variant('ai', order)
                    );

                    crow.visible = true;
                    crow.expanded = true;

                    inserted = true;
                    break;
                }
            }
            if (!inserted)
                this._overlay.add_toast(
                    new Adw.Toast({title: _('Maximum row limit reached')})
                );
        });

        this._addCommandButton.add_controller(clickGesture);

        const ignoreDrop = new Gtk.DropControllerMotion();
        ignoreDrop.connect('enter', () =>
            this._commandBoxList.drag_unhighlight_row()
        );
        ignoreDrop.connect('leave', () =>
            this._commandBoxList.drag_unhighlight_row()
        );
        this._addCommandButton.add_controller(ignoreDrop);

        this._commandBoxList.append(this._addCommandButton);

        commandBoxTarget.connect('drop', (target, value, x, y) =>
            this._onTargetDropped(target, value, x, y, this._commandBoxList)
        );

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._refreshMenuTitles();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onTargetDropped(
        _drop: Gtk.DropTarget,
        value: unknown,
        _x: number,
        y: number,
        listbox: Gtk.ListBox
    ) {
        const targetRow = listbox.get_row_at_y(y);
        if (!value || !targetRow || !draggedRow) return false;

        this._commandBoxList.drag_unhighlight_row();

        if (targetRow === draggedRow || targetRow === this._addCommandButton)
            return false;

        const children = this._getListBoxRows(this._commandBoxList);
        const fromIndex = children.indexOf(draggedRow);
        const toIndex = children.indexOf(targetRow);
        if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex)
            return false;

        const adjustment = this._scroller.get_vadjustment();
        const scrollValue = adjustment.get_value();

        this._commandBoxList.remove(draggedRow);
        const adjustedIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
        this._commandBoxList.insert(draggedRow, adjustedIndex);

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            adjustment.set_value(scrollValue);
            return GLib.SOURCE_REMOVE;
        });

        const clock = this._scroller.get_frame_clock?.();
        if (clock) {
            const handlerId = clock.connect('after-paint', () => {
                adjustment.set_value(scrollValue);
                clock.disconnect(handlerId);
            });
        }

        this._emitReorder();

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._refreshMenuTitles();
            return GLib.SOURCE_REMOVE;
        });

        draggedRow = null;
        return true;
    }

    _emitReorder() {
        const order: number[] = [];
        for (const child of this._getListBoxRows(this._commandBoxList)) {
            const crow = child as CommandRow;
            if (child !== this._addCommandButton && crow._rowNumber)
                order.push(crow._rowNumber);
        }
        this._settings.set_value('command-order', new GLib.Variant('ai', order));
    }

    _getListBoxRows(listBox: Gtk.ListBox): Gtk.Widget[] {
        const rows: Gtk.Widget[] = [];
        let row = listBox.get_first_child();
        while (row) {
            rows.push(row);
            row = row.get_next_sibling();
        }
        return rows;
    }

    refreshCommandList() {
        this._expanderRows.length = 0;
        // Remove all current rows except the "Add Command" button
        const rowsToRemove = this._getListBoxRows(this._commandBoxList).filter(
            child => child instanceof Adw.ExpanderRow
        );
        for (const row of rowsToRemove) {
            this._commandBoxList.remove(row);
        }

        // Rebuild rows based on current settings
        let savedOrder: number[];
        try {
            savedOrder = this._settings
                .get_value('command-order')
                .deep_unpack() as number[];
        } catch (e) {
            console.log('Failed to read command-order from settings:', e);
            savedOrder = Array.from({length: numberOfCommands}, (_v, i) => i + 1);
        }

        for (let i = 0; i < savedOrder.length; i++) {
            const rowNumber = savedOrder[i];
            this._addRow(this._commandBoxList, rowNumber, -1);
        }

        // Make sure "Add Command" button stays at the end
        this._commandBoxList.remove(this._addCommandButton);
        this._commandBoxList.append(this._addCommandButton);
    }

    _showToast(message: string) {
        const toast = new Adw.Toast({title: message});
        this._overlay.add_toast(toast);
    }

    _refreshMenuTitles() {
        const order = this._settings
            .get_value('command-order')
            .deep_unpack() as number[];

        for (const n of order) {
            if (n < 1 || n > numberOfCommands) continue;

            const row = this._getListBoxRows(this._commandBoxList).find(
                r => (r as CommandRow)._rowNumber === n
            ) as CommandRow | undefined;
            if (!row) continue;

            if (row._entryRowName) row._entryRowName.title = _('Name:');
            row.title = row._entryRowName.text.replace(/&/g, '&amp;');
        }
    }

    collapseAll() {
        for (const row of this._expanderRows) row.expanded = false;
    }
}
