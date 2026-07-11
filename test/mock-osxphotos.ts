#!/usr/bin/env bun
// mock-osxphotos — stands in for `osxphotos export` in waddle's
// integration tests. Emulates the two behaviors waddle depends on:
// bounded chunks (--limit) and incremental --update --only-new semantics
// (files already exported are never exported again, even if deleted).
//
// Env:
//   MOCK_EXPORT_POOL    dir of fixture files acting as "the Photos library"
//   MOCK_EXPORT_ERRORS  add this many error entries to the --report
//   MOCK_EXPORT_ZERO    stage nothing (report errors still honored)
//   MOCK_OSXPHOTOS_LOG  append full argv per invocation (flag assertions)
//
// State: .mock-export-db in the staging dir lists already-exported names,
// mirroring osxphotos' export db living next to the exports.

import {
    appendFileSync,
    copyFileSync,
    existsSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (process.env.MOCK_OSXPHOTOS_LOG)
    appendFileSync(process.env.MOCK_OSXPHOTOS_LOG, argv.join(" ") + "\n");

if (argv[0] !== "export") {
    console.error("mock-osxphotos: only `export` is implemented");
    process.exit(2);
}
const staging = argv[1]!;
const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
};
const limit = Number(flag("--limit") ?? 25);
const reportPath = flag("--report");
const uuidFile = flag("--uuid-from-file");

const pool = process.env.MOCK_EXPORT_POOL;
if (!pool) {
    console.error("mock-osxphotos: MOCK_EXPORT_POOL not set");
    process.exit(2);
}

const dbPath = join(staging, ".mock-export-db");
const exported = new Set(
    existsSync(dbPath)
        ? readFileSync(dbPath, "utf8").split("\n").filter(Boolean)
        : [],
);

// The candidate pool, optionally narrowed by --uuid-from-file (fixture
// "uuids" are just the file names).
let candidates = readdirSync(pool)
    .filter((n) => !n.startsWith("."))
    .sort();
if (uuidFile) {
    const wanted = new Set(
        readFileSync(uuidFile, "utf8").split("\n").filter(Boolean),
    );
    candidates = candidates.filter((n) => wanted.has(n));
}

const fresh = candidates.filter((n) => !exported.has(n));
const chunk = process.env.MOCK_EXPORT_ZERO ? [] : fresh.slice(0, limit);

for (const name of chunk) {
    copyFileSync(join(pool, name), join(staging, name));
    exported.add(name);
}
writeFileSync(dbPath, [...exported].join("\n") + "\n");

if (reportPath) {
    const entries: Record<string, unknown>[] = chunk.map((n) => ({
        filename: n,
        exported: true,
        error: "",
    }));
    const errorCount = Number(process.env.MOCK_EXPORT_ERRORS ?? 0);
    for (let i = 0; i < errorCount; i++) {
        entries.push({
            filename: `error-${i}.jpg`,
            exported: false,
            error: "mock export failure",
        });
    }
    writeFileSync(reportPath, JSON.stringify(entries));
}
console.error(
    `mock-osxphotos: staged ${chunk.length} of ${fresh.length} fresh (limit ${limit})`,
);
