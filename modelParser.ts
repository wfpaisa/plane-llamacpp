/* modelParser.ts
 *
 * Pure helpers (no Gi/GTK imports) that split a llama.cpp model identifier into
 * display pieces — org, base name, parameter size, quantization, feature tags
 * and an MTP flag — so the panel menu can render them as coloured chips.
 *
 * Ported from the Plane Llama Bench frontend (`core/utils/format.ts`,
 * `parseModel`/`modelBase`) so the extension shows the exact same badges as the
 * history table there.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/** A model id split into its display pieces (badges). */
export interface ParsedModel {
    /** Family/base name, e.g. `Qwen3.5` (no size, quant, tags nor GGUF). */
    base: string;
    /** Parameter-size marker, e.g. `9B` or `35B-A3B` for a MoE, or null. */
    size: string | null;
    /** Quantization, e.g. `Q6_K` or `UD-Q4_K_S`, or null. */
    quant: string | null;
    /** True when the slug carries an `MTP` marker (speculative/MTP draft). */
    mtp: boolean;
    /** Recognised finetune/format tags, e.g. `IT`, `QAT`, `GGUF`. */
    tags: string[];
    /** Organisation before the first `/`, e.g. `DavidAU`, or null. */
    org: string | null;
}

/** Parameter-size token: `9B`, `35B`, `35B-A3B` (MoE) or bare `A3B`/`MoE`. */
const SIZE_RE = /^(\d+B(?:-A\d+B)?|MoE|A\d+B)$/i;
/** Quantization token, e.g. `Q6_K`, `IQ4_XS`, `UD-Q4_K_S`, `F16`, `BF16`. */
const QUANT_RE =
    /^(UD-)?(I?Q\d[_A-Z0-9]*|IQ\d[_A-Z0-9]*|F16|F32|BF16|FP16|FP8|TQ\d[_A-Z0-9]*)$/i;

/** Slug suffixes recognised as tags (not quant, not noise). */
const KNOWN_TAGS = new Set([
    'it',
    'sft',
    'dpo',
    'orpo',
    'kto',
    'qat',
    'awq',
    'gguf',
    'lora',
    'rlhf',
    'rm',
    'chat',
    'instruct',
    'pretrain',
    'finetune',
    'ft',
    'flash',
]);

/**
 * Normalise a model id to its comparable base (no `org/`, no `:quant` suffix).
 * e.g. `unsloth/Qwen3.6-35B-A3B-UD-Q4_K_S` → `Qwen3.6-35B-A3B-UD-Q4_K_S`.
 */
export function modelBase(m: string | null | undefined): string | null {
    if (!m) return null;
    return m.split(':')[0].split('/').pop() || m;
}

/**
 * Split a model id into `{ org, base, size, quant, mtp, tags }`.
 *   `DavidAU/Qwen3.5-9B-...-MTP-GGUF:Q6_K`
 *     → { org:"DavidAU", base:"Qwen3.5", size:"9B", quant:"Q6_K", mtp:true, tags:["GGUF"] }
 * Returns null for an empty/absent id.
 */
export function parseModel(m: string | null | undefined): ParsedModel | null {
    if (!m) return null;
    const full = modelBase(m) ?? m;
    const hasMtp = /MTP/i.test(full);
    // Org: first segment before '/'.
    const org = m.includes('/') ? m.split('/')[0] : null;
    // Quant suffix after ':' (e.g. `Qwen...:Q6_K`).
    let quant: string | null = null;
    let body = full;
    if (m.includes(':')) {
        quant = m.split(':').slice(1).join(':');
        body = m.split(':')[0].split('/').pop() || full;
    }
    const parts = body.split(/-/).filter(Boolean);
    let size: string | null = null;
    let sizeStart = -1;
    let sizeEnd = -1;
    // Locate the size token, grouping a trailing MoE active-params `A3B`.
    for (let i = 0; i < parts.length; i++) {
        if (SIZE_RE.test(parts[i])) {
            sizeStart = i;
            if (i + 1 < parts.length && /^A\d+B$/i.test(parts[i + 1])) {
                size = `${parts[i]}-${parts[i + 1]}`;
                sizeEnd = i + 1;
            } else {
                size = parts[i];
                sizeEnd = i;
            }
            break;
        }
    }
    // Where the base name ends.
    let baseEnd: number;
    if (sizeStart >= 0) {
        baseEnd = sizeStart;
    } else {
        // No size: base spans until the first recognised tag/quant.
        let firstNonBase = parts.length;
        for (let i = 1; i < parts.length; i++) {
            if (KNOWN_TAGS.has(parts[i].toLowerCase()) || QUANT_RE.test(parts[i])) {
                firstNonBase = i;
                break;
            }
        }
        baseEnd = firstNonBase;
    }
    const base = parts.slice(0, baseEnd).join('-') || body;
    // Quant by suffix if it did not come via ':'.
    if (!quant) {
        for (let i = sizeEnd + 1; i < parts.length; i++) {
            if (QUANT_RE.test(parts[i])) {
                quant = parts.slice(i).join('-');
                break;
            }
        }
    }
    // Recognised tags between size and quant.
    const tags: string[] = [];
    const tagStart = sizeEnd >= 0 ? sizeEnd + 1 : baseEnd;
    for (let i = tagStart; i < parts.length; i++) {
        if (KNOWN_TAGS.has(parts[i].toLowerCase())) {
            tags.push(parts[i].toUpperCase());
        }
    }
    return {base, size, quant, mtp: hasMtp, tags, org};
}

/**
 * Pull the raw model identifier out of a llama-server invocation: the argument
 * to `-hf`/`--hf-repo` (kept whole, incl. `org/` and `:quant`), or the file
 * name of `-m`/`--model` with a trailing `.gguf` stripped. Returns null when
 * the command references no model (a plain script, a separator, …).
 */
export function extractModelId(command: string): string | null {
    const tokens = command
        .replace(/\\\s*\n/g, ' ')
        .split(/\s+/)
        .filter(Boolean);

    const hfIndex = tokens.findIndex(t => t === '-hf' || t === '--hf-repo');
    if (hfIndex !== -1 && tokens[hfIndex + 1]) return tokens[hfIndex + 1];

    const mIndex = tokens.findIndex(t => t === '-m' || t === '--model');
    if (mIndex !== -1 && tokens[mIndex + 1]) {
        const base = tokens[mIndex + 1].split('/').pop() ?? '';
        return base.replace(/\.gguf$/i, '') || null;
    }

    return null;
}
