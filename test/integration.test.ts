// Integration tests: the real waddle sync loop against mock-duckling and
// mock-osxphotos. No Photos.app, no museum, no network — every process,
// file move, deletion, retry, rotation, and exit code is the real code
// path with scripted collaborators.

import { describe, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const MOCK_DUCKLING = join(ROOT, "test/mock-duckling.ts");
const MOCK_OSXPHOTOS = join(ROOT, "test/mock-osxphotos.ts");

interface Run {
    exitCode: number;
    stdout: string;
    stderr: string;
    staging: string;
    base: string;
    spawnLog: () => string[];
}

interface RunOpts {
    poolFiles?: string[];
    stagingFiles?: string[];
    args?: string[];
    env?: Record<string, string>;
}

const runSync = (opts: RunOpts = {}): Run => {
    const base = mkdtempSync(join(tmpdir(), "waddle-it-"));
    const staging = join(base, "staging");
    const pool = join(base, "pool");
    const state = join(base, "state");
    const spawnLog = join(base, "spawns.log");
    mkdirSync(staging, { recursive: true });
    mkdirSync(pool, { recursive: true });
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "session.json"), '{"mock":true}');
    for (const f of opts.poolFiles ?? [])
        writeFileSync(join(pool, f), `pool content of ${f}`);
    for (const f of opts.stagingFiles ?? [])
        writeFileSync(join(staging, f), `staged content of ${f}`);

    const proc = Bun.spawnSync(
        [
            "bun",
            "run",
            join(ROOT, "src/index.ts"),
            "sync",
            "--album",
            "Photos",
            "--staging",
            staging,
            "--min-free-gb",
            "0.001",
            ...(opts.args ?? []),
        ],
        {
            env: {
                ...process.env,
                DUCKLING_STATE_DIR: state,
                WADDLE_DUCKLING_PATH: MOCK_DUCKLING,
                WADDLE_OSXPHOTOS_PATH: MOCK_OSXPHOTOS,
                MOCK_EXPORT_POOL: pool,
                MOCK_SPAWN_LOG: spawnLog,
                ...(opts.env ?? {}),
            },
            stdout: "pipe",
            stderr: "pipe",
        },
    );
    return {
        exitCode: proc.exitCode,
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
        staging,
        base,
        spawnLog: () =>
            existsSync(spawnLog)
                ? readFileSync(spawnLog, "utf8").split("\n").filter(Boolean)
                : [],
    };
};

const staged = (r: Run): string[] =>
    readdirSync(r.staging).filter((n) => !n.startsWith("."));

describe("sync happy path", () => {
    test("uploads the whole pool in chunks, deletes on confirm, exits 0", () => {
        const r = runSync({
            poolFiles: ["a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg"],
            args: ["--chunk", "2"],
        });
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("5 uploaded");
        expect(r.stdout).toContain("0 failed");
        expect(staged(r)).toEqual([]);
        // Spawn ritual ran: ping, session restore, collection seed.
        const log = r.spawnLog();
        expect(log[0]).toBe("spawn");
        expect(log).toContain("auth.restore");
        expect(log).toContain("collections.list");
    });

    test("resumes by draining pre-existing leftovers with an empty pool", () => {
        const r = runSync({ stagingFiles: ["left1.jpg", "left2.jpg"] });
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("2 uploaded");
        expect(staged(r)).toEqual([]);
    });
});

describe("UploadResult classification", () => {
    test("uploaded/present/skipped each delete the source; counts split", () => {
        const r = runSync({
            poolFiles: ["a.jpg", "b.jpg", "c.jpg", "d.jpg"],
            args: ["--chunk", "4"],
            env: {
                MOCK_RESULTS: JSON.stringify({
                    "upload.put_file": [
                        { type: "uploaded", file: {} },
                        { type: "alreadyUploaded", file: {} },
                        { type: "addedSymlink", file: {} },
                        { type: "unsupported" },
                    ],
                }),
            },
        });
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("1 uploaded");
        expect(r.stdout).toContain("2 already present");
        expect(r.stdout).toContain("1 skipped");
        expect(staged(r)).toEqual([]);
    });

    test("failed results retain the file, retry once, then report + exit 1", () => {
        const r = runSync({
            poolFiles: ["stubborn.jpg"],
            env: {
                MOCK_RESULTS: JSON.stringify({
                    "upload.put_file": [{ type: "failed" }],
                }),
            },
        });
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toContain("1 failed");
        expect(r.stdout).toContain("1 file(s) left in staging");
        expect(staged(r)).toEqual(["stubborn.jpg"]);
        // Exactly two attempts (MAX_ATTEMPTS_PER_FILE).
        const attempts = r
            .spawnLog()
            .filter((l) => l === "upload.put_file").length;
        expect(attempts).toBe(2);
    });
});

describe("stall and failure handling", () => {
    test("two zero-progress chunks with report errors abort the loop", () => {
        const r = runSync({
            env: { MOCK_EXPORT_ZERO: "1", MOCK_EXPORT_ERRORS: "3" },
        });
        expect(r.stderr).toContain("strike 1/2");
        expect(r.stderr).toContain("two consecutive zero-progress chunks");
        expect(r.exitCode).toBe(0);
    });

    test("upload timeout rotates the worker and retains the file", () => {
        const r = runSync({
            poolFiles: ["slow.jpg"],
            env: {
                WADDLE_UPLOAD_TIMEOUT_MS: "300",
                MOCK_DELAY_MS: "1500",
                MOCK_DELAY_METHODS: "upload.put_file",
            },
        });
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain("timed out");
        expect(r.stderr).toContain("rotating duckling");
        expect(staged(r)).toEqual(["slow.jpg"]);
        const spawns = r.spawnLog().filter((l) => l === "spawn").length;
        expect(spawns).toBeGreaterThanOrEqual(2);
    });

    test("worker crash mid-upload rotates and the retry succeeds", () => {
        // Per-process request sequence: ping(1) restore(2) list(3)
        // list(4, ensureAlbum) put_file(5) — crash without replying to #5.
        // The respawned process only sees ping/restore/list + the retried
        // upload (request 4), so it survives and the upload lands.
        const r = runSync({
            poolFiles: ["victim.jpg"],
            env: { MOCK_CRASH_AFTER: "5" },
        });
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("1 uploaded");
        expect(r.stderr).toContain("rotating duckling");
        expect(staged(r)).toEqual([]);
        expect(
            r.spawnLog().filter((l) => l === "spawn").length,
        ).toBeGreaterThanOrEqual(2);
    });

    test("rejected session restore fails with a clean one-line error", () => {
        const r = runSync({
            poolFiles: ["a.jpg"],
            env: { MOCK_REJECT_RESTORE: "1" },
        });
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain("mock: session rejected");
        expect(r.stderr).not.toContain("    at "); // no stack trace
    });

    test("garbage on the wire is tolerated line-by-line", () => {
        const r = runSync({
            poolFiles: ["a.jpg", "b.jpg"],
            args: ["--chunk", "2"],
            env: { MOCK_GARBAGE: "1" },
        });
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("2 uploaded");
        expect(r.stderr).toContain("unparseable line from duckling");
    });
});

describe("rotation cadence", () => {
    test("rotates every N uploads", () => {
        const r = runSync({
            poolFiles: ["a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg", "f.jpg"],
            args: ["--chunk", "6", "--rotate-every", "2"],
        });
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("6 uploaded");
        // initial spawn + a rotation per 2 uploads (last one may be elided
        // if the loop ends first) → at least 3 spawns.
        expect(
            r.spawnLog().filter((l) => l === "spawn").length,
        ).toBeGreaterThanOrEqual(3);
    });
});

describe("plan-driven sync", () => {
    test("--uuid-file narrows the export and reaches osxphotos", () => {
        const base = mkdtempSync(join(tmpdir(), "waddle-uuid-"));
        const uuidFile = join(base, "uuids.txt");
        writeFileSync(uuidFile, "b.jpg\n");
        const osxLog = join(base, "osx.log");
        const r = runSync({
            poolFiles: ["a.jpg", "b.jpg", "c.jpg"],
            args: ["--uuid-file", uuidFile],
            env: { MOCK_OSXPHOTOS_LOG: osxLog },
        });
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("1 uploaded");
        expect(readFileSync(osxLog, "utf8")).toContain(
            `--uuid-from-file ${uuidFile}`,
        );
    });
});

describe("live pairs and sidecars in the drain", () => {
    test("pairs go through put_live_photo; .aae is deleted up front", () => {
        const r = runSync({
            poolFiles: [
                "IMG_1.HEIC",
                "IMG_1.mov",
                "IMG_1.aae",
                "solo.jpg",
            ],
            args: ["--chunk", "4"],
        });
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("2 uploaded (1 live photo pairs)");
        expect(r.stdout).toContain("1 skipped (1 .aae)");
        expect(staged(r)).toEqual([]);
        const log = r.spawnLog();
        expect(log).toContain("upload.put_live_photo");
        expect(log.filter((l) => l === "upload.put_file")).toHaveLength(1);
    });
});
