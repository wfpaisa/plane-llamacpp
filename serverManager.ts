/* serverManager.ts
 *
 * Long-running llama.cpp server process manager for the Plane Llamacpp GNOME
 * Shell extension. Handles starting/stopping `llama-server` commands tracked by
 * script index, port parsing and collision resolution, readiness detection by
 * scanning the server output, crash detection and error reporting. It has no UI
 * dependencies: it talks to the extension through injected callbacks.
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
import GLib from 'gi://GLib';

export type ServerState = 'stopped' | 'starting' | 'running';
export type GlobalState = 'idle' | 'starting' | 'running';

/** Default HTTP port used by `llama-server` when no port flag is given. */
const DEFAULT_PORT = 8080;

/** Max stderr lines kept per server for the error summary of a crash. */
const STDERR_TAIL_MAX = 20;

/** Grace period (seconds) between SIGTERM and the SIGKILL escalation. */
const KILL_GRACE_SECONDS = 5;

/**
 * Line printed by llama-server once the HTTP server is accepting connections.
 * Adjust this pattern if a future llama.cpp release changes the wording.
 */
const READY_PATTERN =
    /server is listening|listening on|HTTP server listening|starting the main loop/i;

/**
 * Extract the TCP port from a llama-server command line. Matches `--port N`,
 * `--port=N`, `-p N` and `-p=N`. The flag must be preceded by whitespace (or be
 * at the start) so that unrelated flags such as `--top-p 0.95` are not matched.
 */
export function parsePort(command: string): number {
    const m = command.match(/(?:^|\s)(?:--port|-p)(?:[=\s]+)(\d{1,5})\b/);
    return m ? parseInt(m[1], 10) : DEFAULT_PORT;
}

interface ServerInstance {
    proc: Gio.Subprocess;
    state: ServerState;
    port: number;
    name: string;
    cancellable: Gio.Cancellable;
    stderrTail: string[];
    killTimeout: number | null;
    stopping: boolean;
    ready: boolean;
    /** One-shot callback run after this instance fully exits (port hand-off). */
    onExit: (() => void) | null;
}

export interface ServerManagerCallbacks {
    onStateChange: (index: number, state: ServerState) => void;
    onNotify: (title: string, body: string, isError: boolean) => void;
}

export class ServerManager {
    private _servers = new Map<number, ServerInstance>();
    private _cb: ServerManagerCallbacks;
    private _disposed = false;

    constructor(callbacks: ServerManagerCallbacks) {
        this._cb = callbacks;
    }

    /** Current state of a given script (stopped if not tracked). */
    getState(index: number): ServerState {
        return this._servers.get(index)?.state ?? 'stopped';
    }

    /** Aggregated state across every tracked server. */
    getGlobalState(): GlobalState {
        let anyStarting = false;
        for (const inst of this._servers.values()) {
            if (inst.state === 'running') return 'running';
            if (inst.state === 'starting') anyStarting = true;
        }
        return anyStarting ? 'starting' : 'idle';
    }

    /**
     * Start a server for the given script. If another server already uses the
     * same port it is stopped first and this start is chained to its exit, to
     * avoid a race for the port. Servers on different ports run in parallel.
     */
    start(index: number, name: string, command: string): void {
        if (this._disposed) return;
        if (this._servers.has(index)) return;

        const port = parsePort(command);

        for (const [otherIndex, inst] of this._servers) {
            if (inst.port === port) {
                // Free the port first, then start this one when the other exits.
                inst.onExit = () => this._spawn(index, name, command, port);
                this.stop(otherIndex);
                return;
            }
        }

        this._spawn(index, name, command, port);
    }

    /** Stop a running/starting server (SIGTERM, then SIGKILL after a grace period). */
    stop(index: number): void {
        const inst = this._servers.get(index);
        if (!inst) return;
        inst.stopping = true;

        try {
            inst.proc.send_signal(15); // SIGTERM
        } catch (e) {
            console.log(`[Plane Llamacpp] Error sending SIGTERM to ${inst.name}: ${e}`);
        }

        if (inst.killTimeout === null) {
            inst.killTimeout = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                KILL_GRACE_SECONDS,
                () => {
                    inst.killTimeout = null;
                    try {
                        inst.proc.force_exit(); // SIGKILL
                    } catch (e) {
                        console.log(
                            `[Plane Llamacpp] Error killing ${inst.name}: ${e}`
                        );
                    }
                    return GLib.SOURCE_REMOVE;
                }
            );
        }
    }

    /** Toggle a server: start it if stopped, stop it otherwise. */
    toggle(index: number, name: string, command: string): void {
        if (this.getState(index) === 'stopped') this.start(index, name, command);
        else this.stop(index);
    }

    /** Tear everything down: SIGTERM all servers and drop all tracking. */
    destroy(): void {
        this._disposed = true;
        for (const inst of this._servers.values()) {
            if (inst.killTimeout !== null) {
                GLib.Source.remove(inst.killTimeout);
                inst.killTimeout = null;
            }
            try {
                inst.proc.send_signal(15);
            } catch {
                // The process may already be gone; nothing to do.
            }
            inst.cancellable.cancel();
        }
        this._servers.clear();
    }

    private _spawn(
        index: number,
        name: string,
        command: string,
        port: number
    ): void {
        if (this._disposed) return;

        const cancellable = new Gio.Cancellable();
        let proc: Gio.Subprocess;
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags:
                    Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_PIPE,
            });
            // `exec` replaces the shell so the tracked pid is llama-server itself,
            // which makes SIGTERM/SIGKILL reach the server directly.
            proc = launcher.spawnv(['bash', '-c', `exec ${command}`]);
        } catch (e) {
            this._cb.onNotify(`Error en ${name}`, `${e}`, true);
            this._cb.onStateChange(index, 'stopped');
            return;
        }

        const inst: ServerInstance = {
            proc,
            state: 'starting',
            port,
            name,
            cancellable,
            stderrTail: [],
            killTimeout: null,
            stopping: false,
            ready: false,
            onExit: null,
        };
        this._servers.set(index, inst);
        this._cb.onStateChange(index, 'starting');

        const stdout = proc.get_stdout_pipe();
        const stderr = proc.get_stderr_pipe();
        if (stdout) this._readLines(inst, index, stdout, false);
        if (stderr) this._readLines(inst, index, stderr, true);

        proc.wait_async(cancellable, (p, res) => {
            try {
                p!.wait_finish(res);
            } catch {
                // Cancelled (e.g. on destroy): fall through to cleanup.
            }
            if (inst.killTimeout !== null) {
                GLib.Source.remove(inst.killTimeout);
                inst.killTimeout = null;
            }
            cancellable.cancel(); // stop the output read loops
            this._servers.delete(index);

            if (this._disposed) return;

            const crashed =
                !inst.stopping &&
                ((p!.get_if_exited() && p!.get_exit_status() !== 0) ||
                    p!.get_if_signaled());

            if (crashed) {
                const tail = inst.stderrTail.join('\n').slice(-500);
                this._cb.onNotify(
                    `Error en ${name}`,
                    tail || 'El servidor terminó inesperadamente.',
                    true
                );
            } else if (inst.stopping) {
                this._cb.onNotify('Servidor detenido', name, false);
            }

            this._cb.onStateChange(index, 'stopped');

            if (inst.onExit) {
                const cb = inst.onExit;
                inst.onExit = null;
                cb();
            }
        });
    }

    /**
     * Stream a subprocess pipe line by line (non-blocking). Stderr lines feed the
     * error ring buffer; any line matching READY_PATTERN flips the server from
     * "starting" (yellow) to "running" (green). There is deliberately no timeout:
     * startup may take minutes (model download, GPU load), so "starting" persists
     * until the ready line appears or the process exits.
     */
    private _readLines(
        inst: ServerInstance,
        index: number,
        stream: Gio.InputStream,
        isStderr: boolean
    ): void {
        const dis = new Gio.DataInputStream({base_stream: stream});
        const pump = () => {
            dis.read_line_async(
                GLib.PRIORITY_LOW,
                inst.cancellable,
                (source, res) => {
                    let line: string | null;
                    try {
                        [line] = source!.read_line_finish_utf8(res);
                    } catch {
                        return; // cancelled or stream error
                    }
                    if (line === null) return; // EOF: pipe closed

                    if (isStderr) {
                        inst.stderrTail.push(line);
                        if (inst.stderrTail.length > STDERR_TAIL_MAX)
                            inst.stderrTail.shift();
                    }

                    if (!inst.ready && READY_PATTERN.test(line)) {
                        inst.ready = true;
                        inst.state = 'running';
                        this._cb.onStateChange(index, 'running');
                        this._cb.onNotify('Servidor iniciado', inst.name, false);
                    }

                    pump();
                }
            );
        };
        pump();
    }
}
