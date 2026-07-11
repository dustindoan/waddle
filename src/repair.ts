// repair.ts — fix ente files whose capture date never survived migration.
//
// Formats that can't carry EXIF (gif, bmp, EXIF-less jpg) get their ente
// creationTime from file mtime at upload. Before waddle passed
// --touch-file, staged mtimes were the EXPORT moment — so those files are
// permanently stamped with the migration date. This verb finds them
// (creationTime suspiciously recent), looks up the true capture date in
// the Photos library, and repairs via duckling's files.set_creation_time
// (ente's editedTime channel).
//
// Matching is deliberately strict: the repair WRITES dates, so an
// ambiguous name (several same-named assets with different dates) is
// skipped and reported, never guessed.

import { DucklingClient } from "./duckling-client.ts";
import { normalizeName, photosInventory } from "./plan.ts";

const out = (s: string): void => void process.stdout.write(s + "\n");
const err = (s: string): void => void process.stderr.write(s + "\n");

export interface RepairOptions {
    album: string;
    /** Files with creationTime at/after this are repair candidates. */
    sinceMs: number;
    dryRun: boolean;
    library?: string;
    osxphotosBin: string;
    ducklingBin: string;
}

interface FileSummary {
    id: number;
    name: string;
    creationTime?: number;
}

export const runRepairDates = async (opts: RepairOptions): Promise<void> => {
    err("waddle: reading Photos inventory (local database only) …");
    const assets = await photosInventory(opts.osxphotosBin, opts.library);
    // name → set of distinct capture dates. Repair needs ONE unambiguous
    // answer per name; multiple dates for a name = skip.
    const datesByName = new Map<string, Set<number>>();
    for (const a of assets) {
        const key = normalizeName(a.name);
        const set = datesByName.get(key);
        if (set) set.add(a.dateMs);
        else datesByName.set(key, new Set([a.dateMs]));
    }

    const client = new DucklingClient(opts.ducklingBin);
    await client.start();
    const collectionID = await client.ensureAlbum(opts.album);
    const listed = (await client.call(
        "collections.list_files",
        { id: collectionID },
        600_000,
    )) as { files: FileSummary[] };

    const suspects = listed.files.filter(
        (f) =>
            typeof f.creationTime === "number" &&
            f.creationTime / 1000 >= opts.sinceMs,
    );
    err(
        `waddle: ${suspects.length} of ${listed.files.length} file(s) dated after the cutoff`,
    );

    let repaired = 0;
    let ambiguous = 0;
    let unmatched = 0;
    for (const f of suspects) {
        const dates = datesByName.get(normalizeName(f.name));
        if (!dates || dates.size === 0) {
            unmatched++;
            err(`waddle:   ? ${f.name} — no Photos asset with this name`);
            continue;
        }
        if (dates.size > 1) {
            ambiguous++;
            err(
                `waddle:   ~ ${f.name} — ${dates.size} same-named assets with different dates, skipped`,
            );
            continue;
        }
        const dateMs = [...dates][0]!;
        const stamp = new Date(dateMs).toISOString().slice(0, 10);
        if (opts.dryRun) {
            out(`would repair: ${f.name} → ${stamp}`);
            repaired++;
            continue;
        }
        try {
            await client.call(
                "files.set_creation_time",
                {
                    fileID: f.id,
                    collectionID,
                    creationTime: Math.round(dateMs * 1000),
                },
                120_000,
            );
            repaired++;
            out(`repaired: ${f.name} → ${stamp}`);
        } catch (e) {
            unmatched++;
            const msg = e instanceof Error ? e.message : String(e);
            err(`waddle:   ✗ ${f.name}: ${msg}`);
        }
    }
    await client.stop();

    out(
        `${opts.dryRun ? "dry run: " : ""}${repaired} repaired, ` +
            `${ambiguous} ambiguous (skipped), ${unmatched} unmatched/failed`,
    );
    if (ambiguous > 0 || unmatched > 0) process.exitCode = 1;
};
