// waddle — Photos.app → ente migration orchestrator.
//
// The loop (docs in coralstack-ente-helper/docs/plan-controlled-pull-migration.md;
// producer lessons inherited from coralstack-migrator's watermark.rs):
//
//   repeat until osxphotos exports nothing new:
//     1. free-disk gate
//     2. drain any leftovers in staging (crash recovery — a killed run
//        leaves only un-uploaded files behind)
//     3. osxphotos exports a bounded chunk into staging
//     4. drain: pair Live Photos, upload each item through duckling,
//        DELETE the staged file on confirmed upload or ente dedup
//
// Delete-on-confirm bounds the disk by construction: staging never holds
// more than ~one chunk. duckling is rotated every N uploads to bound the
// JS-level memory growth that motivated this whole toolchain.
//
// Output discipline: results/summary on stdout; progress, osxphotos and
// duckling chatter on stderr.

import {
    existsSync,
    mkdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
    DucklingClient,
    ducklingSessionPath,
    resolveDuckling,
} from "./duckling-client.ts";
import { exportChunk, resolveOsxphotos, stagedFiles } from "./osxphotos.ts";
import { clusterLivePhotos, type StagedFile } from "./pairing.ts";
import {
    buildEnteIndex,
    DEFAULT_EPSILON_HOURS,
    matchAssets,
    photosInventory,
} from "./plan.ts";

const VERSION = "0.1.0";

const out = (s: string): void => void process.stdout.write(s + "\n");
const err = (s: string): void => void process.stderr.write(s + "\n");

/** Per-upload ceiling before we declare the worker wedged and rotate.
 * Sized for a multi-GB video over a ~18 Mbps uplink, with margin. */
const UPLOAD_TIMEOUT_MS = 45 * 60 * 1000;

/** Give up on a staged file after this many failed upload attempts; it
 * stays in staging and is reported at the end. */
const MAX_ATTEMPTS_PER_FILE = 2;

interface Options {
    album: string;
    library?: string;
    staging: string;
    chunk: number;
    minFreeGb: number;
    maxChunks: number;
    rotateEvery: number;
    applescriptTimeoutSecs: number;
    uuidFile?: string;
}

interface Totals {
    uploaded: number;
    livePairs: number;
    present: number;
    failed: number;
    skippedAae: number;
    skippedUnsupported: number;
    chunks: number;
}

const usage = (): void => {
    err("waddle — Photos.app → ente migration orchestrator");
    err("");
    err("Usage:");
    err("  waddle plan [--out <file>] [--epsilon-hours <n>] [--library <path>]");
    err("      pre-download dedup: find assets NOT already in ente (by name +");
    err("      capture date) and write their UUIDs — no iCloud downloads");
    err("  waddle sync --album <name> [--uuid-file <plan-output>] [options]");
    err("");
    err("Options:");
    err("  --album <name>          target ente album (created if missing; required)");
    err("  --library <path>        Photos library (default: system library)");
    err("  --staging <dir>         staging folder (default ~/.waddle/staging)");
    err("  --chunk <n>             photos per osxphotos invocation (default 100)");
    err("  --min-free-gb <n>       refuse to export below this free disk (default 20)");
    err("  --max-chunks <n>        stop after N chunks (default: run to completion)");
    err("  --rotate-every <n>      restart duckling after N uploads (default 500)");
    err("  --applescript-timeout <s>  per-photo iCloud-download timeout (default 600)");
    err("");
    err("Prereqs: `duckling login` once (session is reused); osxphotos on PATH.");
    err("Env: WADDLE_DUCKLING_PATH, WADDLE_OSXPHOTOS_PATH, DUCKLING_ENDPOINT.");
};

const parseArgs = (argv: string[]): Options => {
    const opts: Options = {
        album: "",
        staging: join(homedir(), ".waddle", "staging"),
        chunk: 100,
        minFreeGb: 20,
        maxChunks: Number.MAX_SAFE_INTEGER,
        rotateEvery: 500,
        applescriptTimeoutSecs: 600,
    };
    const takeValue = (flag: string, v: string | undefined): string => {
        if (v === undefined) {
            err(`waddle: ${flag} needs a value`);
            process.exit(2);
        }
        return v;
    };
    const takeNumber = (flag: string, v: string | undefined): number => {
        const n = Number(takeValue(flag, v));
        if (!Number.isFinite(n) || n <= 0) {
            err(`waddle: ${flag} must be a positive number`);
            process.exit(2);
        }
        return n;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        switch (a) {
            case "--album":
                opts.album = takeValue(a, argv[++i]);
                break;
            case "--library":
                opts.library = takeValue(a, argv[++i]);
                break;
            case "--staging":
                opts.staging = takeValue(a, argv[++i]);
                break;
            case "--chunk":
                opts.chunk = takeNumber(a, argv[++i]);
                break;
            case "--min-free-gb":
                opts.minFreeGb = takeNumber(a, argv[++i]);
                break;
            case "--max-chunks":
                opts.maxChunks = takeNumber(a, argv[++i]);
                break;
            case "--rotate-every":
                opts.rotateEvery = takeNumber(a, argv[++i]);
                break;
            case "--applescript-timeout":
                opts.applescriptTimeoutSecs = takeNumber(a, argv[++i]);
                break;
            case "--uuid-file":
                opts.uuidFile = takeValue(a, argv[++i]);
                break;
            default:
                err(`waddle: unknown option ${a}`);
                process.exit(2);
        }
    }
    if (!opts.album) {
        err("waddle: --album <name> is required");
        process.exit(2);
    }
    return opts;
};

/** Free space on the volume holding `dir`, in GB, via df. */
const freeDiskGb = async (dir: string): Promise<number> => {
    const proc = Bun.spawn({
        cmd: ["/bin/df", "-k", dir],
        stdout: "pipe",
        stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const line = text.trim().split("\n")[1];
    const availKb = Number(line?.split(/\s+/)[3]);
    if (!Number.isFinite(availKb))
        throw new Error(`could not parse df output for ${dir}`);
    return availKb / 1024 / 1024;
};

interface PlanOptions {
    library?: string;
    out: string;
    epsilonHours: number;
}

const parsePlanArgs = (argv: string[]): PlanOptions => {
    const opts: PlanOptions = {
        out: join(homedir(), ".waddle", "plan-uuids.txt"),
        epsilonHours: DEFAULT_EPSILON_HOURS,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        switch (a) {
            case "--library":
                opts.library = argv[++i] ?? "";
                break;
            case "--out":
                opts.out = argv[++i] ?? "";
                break;
            case "--epsilon-hours": {
                const n = Number(argv[++i]);
                if (!Number.isFinite(n) || n <= 0) {
                    err("waddle: --epsilon-hours must be a positive number");
                    process.exit(2);
                }
                opts.epsilonHours = n;
                break;
            }
            default:
                err(`waddle: plan: unknown option ${a}`);
                process.exit(2);
        }
    }
    if (!opts.out) {
        err("waddle: --out needs a value");
        process.exit(2);
    }
    return opts;
};

/** Pre-download dedup: intersect the Photos inventory (local SQLite, no
 * iCloud) with the ente inventory (via duckling) and write the UUIDs of
 * assets worth exporting. Read-only on both sides. */
const runPlan = async (opts: PlanOptions): Promise<void> => {
    if (!existsSync(ducklingSessionPath())) {
        err(`waddle: no duckling session at ${ducklingSessionPath()}`);
        err("waddle: run `duckling login` first");
        process.exit(1);
    }
    const [ducklingBin, osxphotosBin] = await Promise.all([
        resolveDuckling(),
        resolveOsxphotos(),
    ]);

    err("waddle: reading Photos inventory (local database only) …");
    const assets = await photosInventory(osxphotosBin, opts.library);
    err(`waddle: ${assets.length} assets in Photos`);

    err("waddle: reading ente inventory …");
    const client = new DucklingClient(ducklingBin);
    const collections = await client.start();
    const enteFiles: { name: string; creationTime?: number }[] = [];
    for (const c of collections) {
        const res = (await client.call(
            "collections.list_files",
            { id: c.id },
            600_000,
        )) as { files: { name: string; creationTime?: number }[] };
        err(`waddle:   ${c.name}: ${res.files.length} file(s)`);
        enteFiles.push(...res.files);
    }
    await client.stop();

    const result = matchAssets(
        assets,
        buildEnteIndex(enteFiles),
        opts.epsilonHours,
    );

    mkdirSync(join(opts.out, ".."), { recursive: true });
    writeFileSync(opts.out, result.toMigrate.join("\n") + "\n");

    out(
        `${assets.length} assets in Photos · ${enteFiles.length} file entries in ente`,
    );
    out(
        `${result.matched} already in ente (skipped) · ${result.unmatched} not in ente · ` +
            `${result.ambiguous} ambiguous (name matched, date didn't — exporting to be safe)`,
    );
    out(`${result.toMigrate.length} to migrate → ${opts.out}`);
    out("");
    out(`next: waddle sync --album <name> --uuid-file ${opts.out}`);
};

const runSync = async (opts: Options): Promise<void> => {
    if (!existsSync(ducklingSessionPath())) {
        err(`waddle: no duckling session at ${ducklingSessionPath()}`);
        err("waddle: run `duckling login` first");
        process.exit(1);
    }
    const [ducklingBin, osxphotosBin] = await Promise.all([
        resolveDuckling(),
        resolveOsxphotos(),
    ]);
    mkdirSync(opts.staging, { recursive: true });
    err(`waddle: duckling ${ducklingBin}`);
    err(`waddle: osxphotos ${osxphotosBin}`);
    err(`waddle: staging ${opts.staging}`);

    const client = new DucklingClient(ducklingBin);
    await client.start();
    const collectionID = await client.ensureAlbum(opts.album);
    err(`waddle: album "${opts.album}" → collection ${collectionID}`);

    const totals: Totals = {
        uploaded: 0,
        livePairs: 0,
        present: 0,
        failed: 0,
        skippedAae: 0,
        skippedUnsupported: 0,
        chunks: 0,
    };
    const attempts = new Map<string, number>();
    let zeroProgressStreak = 0;

    const maybeRotate = async (): Promise<void> => {
        if (client.uploadsSinceSpawn < opts.rotateEvery) return;
        err(
            `waddle: rotating duckling after ${client.uploadsSinceSpawn} uploads`,
        );
        await client.rotate();
    };

    /** Upload one batch of staged paths; delete each on confirmation. */
    const drain = async (paths: string[]): Promise<void> => {
        const staged: StagedFile[] = [];
        for (const path of paths) {
            if (basename(path).startsWith(".")) continue;
            if (path.toLowerCase().endsWith(".aae")) {
                // Photos edit sidecars: ente has no type for them and the
                // museum refuses them (learned the hard way in the FP era).
                rmSync(path, { force: true });
                totals.skippedAae++;
                continue;
            }
            if ((attempts.get(path) ?? 0) >= MAX_ATTEMPTS_PER_FILE) continue;
            staged.push({ path, size: statSync(path).size });
        }
        if (staged.length === 0) return;

        const { pairs, singles } = clusterLivePhotos(staged);
        err(
            `waddle: draining ${staged.length} file(s) — ${pairs.length} live pair(s), ${singles.length} single(s)`,
        );

        // ente's UploadResult union (gallery/services/upload/index.ts), by
        // what the source file's fate should be:
        //   delete + count uploaded:  uploaded, uploadedWithStaticThumbnail
        //   delete + count present:   alreadyUploaded (same collection),
        //                             addedSymlink (content matched in a
        //                             DIFFERENT collection — ente links it
        //                             into ours instead of re-uploading;
        //                             common when re-migrating a library
        //                             that partially reached ente before)
        //   delete + count skipped:   unsupported, zeroSize, tooLarge,
        //                             largerThanAvailableStorage — retrying
        //                             can never change the answer, and the
        //                             staged file is only an export copy
        //   keep + retry:             failed, blocked
        const PERMANENT_SKIPS = new Set([
            "unsupported",
            "zeroSize",
            "tooLarge",
            "largerThanAvailableStorage",
        ]);
        const finish = (result: unknown, files: StagedFile[]): void => {
            const type =
                result && typeof result === "object" && "type" in result
                    ? String((result as { type: unknown }).type)
                    : "unknown";
            const names = files.map((f) => basename(f.path)).join(" + ");
            if (type === "uploaded" || type === "uploadedWithStaticThumbnail") {
                for (const f of files) rmSync(f.path, { force: true });
                totals.uploaded++;
            } else if (type === "alreadyUploaded" || type === "addedSymlink") {
                for (const f of files) rmSync(f.path, { force: true });
                totals.present++;
            } else if (PERMANENT_SKIPS.has(type)) {
                for (const f of files) rmSync(f.path, { force: true });
                totals.skippedUnsupported++;
                err(`waddle: – ${names} (${type}, skipped)`);
            } else {
                for (const f of files)
                    attempts.set(f.path, (attempts.get(f.path) ?? 0) + 1);
                totals.failed++;
                err(`waddle: ✗ ${names} (${type})`);
            }
        };
        const failedCall = async (
            e: unknown,
            files: StagedFile[],
        ): Promise<void> => {
            const msg = e instanceof Error ? e.message : String(e);
            for (const f of files)
                attempts.set(f.path, (attempts.get(f.path) ?? 0) + 1);
            totals.failed++;
            err(
                `waddle: ✗ ${files.map((f) => basename(f.path)).join(" + ")}: ${msg}`,
            );
            if (msg.includes("timed out")) {
                err("waddle: upload timed out — rotating duckling");
                await client.rotate();
            }
        };

        for (const pair of pairs) {
            try {
                const result = await client.call(
                    "upload.put_live_photo",
                    {
                        stillPath: pair.still.path,
                        motionPath: pair.motion.path,
                        collectionID,
                    },
                    UPLOAD_TIMEOUT_MS,
                );
                client.uploadsSinceSpawn++;
                finish(result, [pair.still, pair.motion]);
                if (
                    result &&
                    typeof result === "object" &&
                    "type" in result &&
                    String((result as { type: unknown }).type).startsWith(
                        "upload",
                    )
                )
                    totals.livePairs++;
            } catch (e) {
                await failedCall(e, [pair.still, pair.motion]);
            }
            await maybeRotate();
        }
        for (const single of singles) {
            try {
                const result = await client.call(
                    "upload.put_file",
                    { path: single.path, collectionID },
                    UPLOAD_TIMEOUT_MS,
                );
                client.uploadsSinceSpawn++;
                finish(result, [single]);
            } catch (e) {
                await failedCall(e, [single]);
            }
            await maybeRotate();
        }
    };

    const reportPath = join(opts.staging, "..", ".waddle-report.json");
    for (let chunk = 1; chunk <= opts.maxChunks; chunk++) {
        // Drain before gating: draining only FREES disk (upload → delete),
        // so it must run even under disk pressure — it's the way out of it.
        const leftovers = stagedFiles(opts.staging);
        if (leftovers.length > 0) {
            err(`waddle: ${leftovers.length} leftover file(s) in staging`);
            await drain(leftovers);
        }

        // The gate protects the export only: a chunk is the one thing that
        // grows disk usage, and Photos hard-errors on disk-full.
        const free = await freeDiskGb(opts.staging);
        if (free < opts.minFreeGb) {
            err(
                `waddle: only ${free.toFixed(1)} GB free (< ${opts.minFreeGb} GB floor) — stopping. ` +
                    "Free some space and re-run; the export picks up where it left off.",
            );
            break;
        }

        const result = await exportChunk({
            bin: osxphotosBin,
            staging: opts.staging,
            limit: opts.chunk,
            applescriptTimeoutSecs: opts.applescriptTimeoutSecs,
            library: opts.library,
            reportPath,
            uuidFile: opts.uuidFile,
        });
        totals.chunks++;

        if (result.newFiles.length === 0) {
            if (result.exitCode !== 0) {
                err(
                    `waddle: osxphotos exited ${result.exitCode} and staged nothing — stopping`,
                );
                break;
            }
            if (result.reportErrors === 0) {
                err("waddle: nothing new to export — caught up");
                break;
            }
            zeroProgressStreak++;
            err(
                `waddle: ${result.reportErrors} export error(s), nothing staged ` +
                    `(strike ${zeroProgressStreak}/2)`,
            );
            if (zeroProgressStreak >= 2) {
                err(
                    "waddle: two consecutive zero-progress chunks — stopping to avoid a retry loop",
                );
                break;
            }
            continue;
        }
        zeroProgressStreak = 0;
        await drain(result.newFiles);

        err(
            `waddle: chunk ${chunk} done — totals: ${totals.uploaded} uploaded ` +
                `(${totals.livePairs} live pairs), ${totals.present} already present, ${totals.failed} failed`,
        );
    }

    await client.stop();

    const remaining = stagedFiles(opts.staging);
    out(
        `waddle: ${totals.uploaded} uploaded (${totals.livePairs} live photo pairs), ` +
            `${totals.present} already present, ${totals.failed} failed, ` +
            `${totals.skippedUnsupported + totals.skippedAae} skipped (${totals.skippedAae} .aae), ${totals.chunks} chunk(s)`,
    );
    if (remaining.length > 0) {
        out(
            `waddle: ${remaining.length} file(s) left in staging: ${opts.staging}`,
        );
        process.exit(1);
    }
};

const main = async (): Promise<void> => {
    const args = process.argv.slice(2);
    if (args.includes("--version")) {
        out(VERSION);
        return;
    }
    if (args.length === 0 || args.includes("--help")) {
        usage();
        process.exit(args.length === 0 ? 2 : 0);
    }
    if (args[0] === "plan") {
        await runPlan(parsePlanArgs(args.slice(1)));
        return;
    }
    if (args[0] !== "sync") {
        err(`waddle: unknown command "${args[0]}" — see waddle --help`);
        process.exit(2);
    }
    await runSync(parseArgs(args.slice(1)));
};

main().catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    err(`waddle: ${msg}`);
    process.exit(1);
});
