#!/usr/bin/env bun
// mock-duckling — a scriptable stand-in for the duckling stdio JSON-RPC
// server, so waddle's drain/rotation/timeout logic tests run headless.
//
// Behaviors are driven by environment variables (inherited from the test
// through waddle):
//
//   MOCK_RESULTS       JSON: method → array of results, consumed in order
//                      (last one repeats). E.g.
//                      {"upload.put_file":[{"type":"failed"},{"type":"uploaded"}]}
//   MOCK_DELAY_MS      per-call delay before responding (timeout tests)
//   MOCK_DELAY_METHODS comma-separated methods the delay applies to
//                      (default: all)
//   MOCK_CRASH_AFTER   exit(1) without responding once this many requests
//                      have been received (mid-call crash)
//   MOCK_GARBAGE       emit a non-JSON line before every response
//   MOCK_REJECT_RESTORE respond to auth.restore with an error
//   MOCK_SPAWN_LOG     append "spawn" on start and "<method>" per request
//                      to this file (rotation/order assertions)
//
// Defaults answer the happy path for every method waddle uses.

import { appendFileSync } from "node:fs";

const results: Record<string, unknown[]> = process.env.MOCK_RESULTS
    ? (JSON.parse(process.env.MOCK_RESULTS) as Record<string, unknown[]>)
    : {};
const consumed: Record<string, number> = {};
const delayMs = Number(process.env.MOCK_DELAY_MS ?? 0);
const delayMethods = process.env.MOCK_DELAY_METHODS?.split(",");
const crashAfter = Number(process.env.MOCK_CRASH_AFTER ?? 0);
const spawnLog = process.env.MOCK_SPAWN_LOG;

if (spawnLog) appendFileSync(spawnLog, "spawn\n");

const defaultResult = (method: string, params: unknown): unknown => {
    switch (method) {
        case "ping":
            return "pong";
        case "auth.restore":
            return { ok: true, id: 1 };
        case "collections.list":
            return {
                collections: [{ id: 1, name: "Photos", type: "album" }],
            };
        case "collections.create":
            return {
                id: 2,
                name: (params as { name?: string })?.name ?? "created",
                type: "album",
            };
        case "collections.list_files":
            return { files: [], total: 0 };
        case "upload.put_file":
        case "upload.put_live_photo":
            return { type: "uploaded", file: { id: 42 } };
        default:
            return { ok: true };
    }
};

const nextResult = (method: string, params: unknown): unknown => {
    const scripted = results[method];
    if (!scripted || scripted.length === 0)
        return defaultResult(method, params);
    const i = Math.min(consumed[method] ?? 0, scripted.length - 1);
    consumed[method] = (consumed[method] ?? 0) + 1;
    return scripted[i];
};

let requestCount = 0;
const decoder = new TextDecoder();
let buffer = "";

// @ts-expect-error Bun exposes async iteration on process.stdin
for await (const chunk of process.stdin) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const req = JSON.parse(line) as {
            id: number;
            method: string;
            params?: unknown;
        };
        requestCount++;
        if (spawnLog) appendFileSync(spawnLog, req.method + "\n");

        if (crashAfter > 0 && requestCount >= crashAfter) {
            process.exit(1);
        }
        const applyDelay =
            delayMs > 0 &&
            (!delayMethods || delayMethods.includes(req.method));
        if (applyDelay) await Bun.sleep(delayMs);

        if (process.env.MOCK_GARBAGE)
            process.stdout.write("not json at all {{{\n");

        if (req.method === "auth.restore" && process.env.MOCK_REJECT_RESTORE) {
            process.stdout.write(
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: req.id,
                    error: { code: -32001, message: "mock: session rejected" },
                }) + "\n",
            );
            continue;
        }
        process.stdout.write(
            JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: nextResult(req.method, req.params),
            }) + "\n",
        );
    }
}
