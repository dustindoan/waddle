// osxphotos.ts — invoke osxphotos for one bounded export chunk.
//
// The incremental-export contract (verified against osxphotos 0.75.9 docs;
// see the 20-photo test in the README before trusting it with a library):
//
//   --update --only-new   export only photos never exported before, per the
//                         export db — files we deleted after upload are NOT
//                         re-exported. This is what makes delete-on-confirm
//                         and osxphotos coexist.
//   --limit N             at most N new photos this invocation. Chunking is
//                         the backpressure: the next chunk waits until the
//                         drain empties staging.
//   --download-missing    iCloud-only originals get fetched via Photos.app
//                         (the reason --applescript-timeout exists).
//   --report <json>       per-photo outcome; we use it to distinguish "done"
//                         from "everything errored" when nothing lands.
//
// Progress detection is filesystem-first: the set-difference of staging
// before/after the run is the truth about what got staged. The report is
// best-effort corroboration (its schema has shifted across osxphotos
// versions), never the primary signal.

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const err = (s: string): void => void process.stderr.write(s + "\n");

/** Locate osxphotos: explicit env, then PATH (pipx installs there). */
export const resolveOsxphotos = async (): Promise<string> => {
    const fromEnv = process.env.WADDLE_OSXPHOTOS_PATH;
    if (fromEnv) {
        if (!existsSync(fromEnv))
            throw new Error(`WADDLE_OSXPHOTOS_PATH does not exist: ${fromEnv}`);
        return fromEnv;
    }
    const which = Bun.spawn({
        cmd: ["/usr/bin/which", "osxphotos"],
        stdout: "pipe",
        stderr: "ignore",
    });
    const out = (await new Response(which.stdout).text()).trim();
    await which.exited;
    if (out && existsSync(out)) return out;
    throw new Error(
        "osxphotos not found. `pipx install osxphotos` or set WADDLE_OSXPHOTOS_PATH.",
    );
};

/** Regular files in staging, ignoring dotfiles (export db, .DS_Store). */
export const stagedFiles = (staging: string): string[] => {
    if (!existsSync(staging)) return [];
    return readdirSync(staging, { withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith("."))
        .map((e) => join(staging, e.name))
        .sort();
};

export interface ChunkOptions {
    bin: string;
    staging: string;
    limit: number;
    applescriptTimeoutSecs: number;
    library?: string;
    reportPath: string;
    /** Restrict the export to these asset UUIDs (a `waddle plan` output).
     * Combines with --update/--only-new: the export db still tracks
     * progress within the UUID set across chunks. */
    uuidFile?: string;
}

export interface ChunkResult {
    /** Absolute paths that appeared in staging during this invocation. */
    newFiles: string[];
    /** Per-photo errors the report admitted to (best-effort). */
    reportErrors: number;
    exitCode: number;
}

export const exportChunk = async (
    opts: ChunkOptions,
): Promise<ChunkResult> => {
    const before = new Set(stagedFiles(opts.staging));
    rmSync(opts.reportPath, { force: true });

    const args = [
        "export",
        opts.staging,
        "--update",
        "--only-new",
        "--limit",
        String(opts.limit),
        "--download-missing",
        "--applescript-timeout",
        String(opts.applescriptTimeoutSecs),
        "--report",
        opts.reportPath,
        "--verbose",
    ];
    if (opts.library) args.push("--library", opts.library);
    if (opts.uuidFile) args.push("--uuid-from-file", opts.uuidFile);

    err(`waddle: osxphotos export (limit ${opts.limit}) …`);
    const proc = Bun.spawn({
        cmd: [opts.bin, ...args],
        stdout: "pipe",
        stderr: "pipe",
    });
    // osxphotos narrates on stdout; keep our stdout clean, tag it onto stderr.
    const pump = async (
        stream: ReadableStream<Uint8Array>,
    ): Promise<void> => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) {
            const text = decoder.decode(chunk);
            for (const line of text.split("\n")) {
                if (line.trim()) err(`[osxphotos] ${line}`);
            }
        }
    };
    await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
    const exitCode = await proc.exited;

    const newFiles = stagedFiles(opts.staging).filter((f) => !before.has(f));
    const reportErrors = countReportErrors(opts.reportPath);
    rmSync(opts.reportPath, { force: true });
    return { newFiles, reportErrors, exitCode };
};

/** Tolerant report scan: count entries carrying a non-empty error field.
 * Any parse trouble degrades to 0 — the filesystem diff is the real signal. */
const countReportErrors = (reportPath: string): number => {
    try {
        const parsed = JSON.parse(readFileSync(reportPath, "utf8")) as unknown;
        if (!Array.isArray(parsed)) return 0;
        let n = 0;
        for (const entry of parsed) {
            if (
                entry &&
                typeof entry === "object" &&
                "error" in entry &&
                (entry as { error?: unknown }).error
            )
                n++;
        }
        return n;
    } catch {
        return 0;
    }
};
