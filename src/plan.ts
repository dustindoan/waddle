// plan.ts — pre-download dedup: decide which Photos assets are already in
// ente WITHOUT materializing any bytes from iCloud.
//
// Why this exists: on an Optimize-Mac-Storage library, nearly every
// original lives only in iCloud (30,431 of 32,789 on the reference
// library). Without a plan, a full sync downloads each one just so ente
// can answer "already have it" (the first live test drained 19/19 as
// dedups). The plan intersects two inventories that are both available
// locally — the Photos SQLite (via osxphotos, no iCloud touch) and the
// ente library (via duckling) — and emits the UUIDs worth exporting.
//
// Match rule: exact normalized filename + capture date within an epsilon
// (default ±26 h, following coralstack-migrator's proven ±1 day fuzzy
// match; EXIF-vs-timezone drift makes exact-time comparison a trap).
// Each ente file can satisfy at most one asset (nearest-date greedy), so
// twelve distinct `PIC_0039.JPG`s can't all hide behind one upload.
//
// The asymmetry is deliberate: a false NON-match costs one redundant
// download that ente's hash dedup then absorbs; a false match silently
// strands a photo outside ente. When unsure, export it.

import { basename } from "node:path";

const err = (s: string): void => void process.stderr.write(s + "\n");

export interface PhotosAsset {
    uuid: string;
    name: string;
    dateMs: number;
}

export interface EnteCandidate {
    dateMs: number;
    consumed: boolean;
}

/** Default match epsilon: ±26 h (a day plus DST slop). */
export const DEFAULT_EPSILON_HOURS = 26;

/**
 * Filename → index key. Lowercased, and Finder/Photos collision suffixes
 * stripped (`PIC_0039 (11).JPG` → `pic_0039.jpg`): the FP-era migration
 * uploaded collision-suffixed names, while the Photos originals carry the
 * bare name. The date guard still applies, so this widens candidates, not
 * matches.
 */
export const normalizeName = (name: string): string =>
    basename(name)
        .toLowerCase()
        .replace(/ \(\d+\)(?=\.[^.]+$)/, "");

/** Photos-side inventory via `osxphotos query --print` (tab-delimited;
 * filenames cannot contain tabs). Reads only the local Photos database. */
export const photosInventory = async (
    bin: string,
    library?: string,
): Promise<PhotosAsset[]> => {
    const template =
        "{uuid}\t{photo.original_filename}\t{created.strftime,%Y-%m-%dT%H:%M:%S%z}";
    const args = ["query", "--print", template];
    if (library) args.push("--library", library);
    const proc = Bun.spawn({
        cmd: [bin, ...args],
        stdout: "pipe",
        stderr: "pipe",
    });
    const [text, errText] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        throw new Error(
            `osxphotos query exited ${exitCode}: ${errText.trim().split("\n").slice(-3).join(" | ")}`,
        );
    }
    const assets: PhotosAsset[] = [];
    let badDates = 0;
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        const [uuid, name, date] = parts;
        // osxphotos prints its default query output (bare UUIDs, one per
        // asset) after the rendered templates; anything that isn't a
        // 3-field template line is that listing — skip silently.
        if (parts.length !== 3 || !uuid || !name || !date) continue;
        const dateMs = Date.parse(date);
        if (Number.isNaN(dateMs)) {
            badDates++;
            continue;
        }
        assets.push({ uuid, name, dateMs });
    }
    if (badDates > 0)
        err(
            `waddle: plan: ${badDates} asset(s) with unparseable dates skipped`,
        );
    if (assets.length === 0)
        throw new Error(
            "plan: osxphotos returned no parseable inventory lines",
        );
    return assets;
};

export interface MatchResult {
    matched: number;
    /** Name hit, but no candidate inside the date epsilon. Exported anyway. */
    ambiguous: number;
    /** No name hit at all. */
    unmatched: number;
    /** UUIDs to export: unmatched + ambiguous. */
    toMigrate: string[];
}

/**
 * Greedy nearest-date matching. `enteIndex` maps normalized name → date
 * candidates; each candidate satisfies at most one asset.
 */
export const matchAssets = (
    assets: PhotosAsset[],
    enteIndex: Map<string, EnteCandidate[]>,
    epsilonHours: number = DEFAULT_EPSILON_HOURS,
): MatchResult => {
    const epsilonMs = epsilonHours * 3600 * 1000;
    const result: MatchResult = {
        matched: 0,
        ambiguous: 0,
        unmatched: 0,
        toMigrate: [],
    };
    for (const asset of assets) {
        const candidates = enteIndex.get(normalizeName(asset.name));
        if (!candidates || candidates.length === 0) {
            result.unmatched++;
            result.toMigrate.push(asset.uuid);
            continue;
        }
        let best: EnteCandidate | undefined;
        let bestDiff = Number.POSITIVE_INFINITY;
        for (const c of candidates) {
            if (c.consumed) continue;
            const diff = Math.abs(c.dateMs - asset.dateMs);
            if (diff < bestDiff) {
                bestDiff = diff;
                best = c;
            }
        }
        if (best && bestDiff <= epsilonMs) {
            best.consumed = true;
            result.matched++;
        } else {
            result.ambiguous++;
            result.toMigrate.push(asset.uuid);
        }
    }
    return result;
};

/** Build the name→candidates index from duckling list_files summaries.
 * `creationTime` arrives in epoch microseconds (ente's metadata unit). */
export const buildEnteIndex = (
    files: { name: string; creationTime?: number }[],
): Map<string, EnteCandidate[]> => {
    const index = new Map<string, EnteCandidate[]>();
    for (const f of files) {
        const key = normalizeName(f.name);
        const dateMs =
            typeof f.creationTime === "number" ? f.creationTime / 1000 : 0;
        const list = index.get(key);
        const candidate = { dateMs, consumed: false };
        if (list) list.push(candidate);
        else index.set(key, [candidate]);
    }
    return index;
};
