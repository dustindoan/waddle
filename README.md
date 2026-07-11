# waddle

Photos.app → [ente](https://ente.io) migration orchestrator. Drives
[osxphotos](https://github.com/RhetTbull/osxphotos) exports into a staging
folder and drains them through [duckling](https://github.com/dustindoan/duckling),
**deleting each file the moment ente confirms it** — so a 300 GB library
migrates through a bounded ~few-GB staging footprint, and a crash resumes
where it left off.

The successor to coralstack-migrator: same battle-tested producer design,
but the drain is duckling's synchronous first-party upload confirmation
instead of a watch folder + polling.

```
Photos.app --osxphotos--> staging --duckling--> ente museum
              (chunked)      (delete on confirm)
```

## Why this shape

- **No backpressure exists in Photos export paths.** Photos writes at disk
  speed and hard-errors on disk-full with no resume. Chunked exports
  (`--limit N`) with a drained-empty gate between chunks are the
  backpressure.
- **`--update --only-new`** makes osxphotos skip everything previously
  exported *even though we deleted it* — incremental sync and
  delete-on-confirm coexist. First run = full migration; later runs =
  catch-up. (Verify on your machine first: export 10, delete them, re-run,
  confirm the *next* 10 export.)
- **duckling is rotated every N uploads** (default 500), bounding the
  JS-level memory growth that long ente upload sessions exhibit.
- **Live Photos** pair by stem within a chunk (both halves export
  together), guarded by ente's own rules — each half < 20 MB, ambiguous
  stem groups refused — because bare basename matching mis-pairs ~14% of
  same-name still+video collisions in real libraries.

## Prereqs

- `duckling` on PATH (or `WADDLE_DUCKLING_PATH`) and a session:
  `duckling login` once
- `osxphotos` on PATH (`pipx install osxphotos`; needs ≥ the version with
  `--applescript-timeout`, present in 0.75.9)
- Photos-library + Automation permission prompts will attribute to the
  terminal you run from; approve them once

## Use

```sh
# 1. Pre-download dedup (read-only, no iCloud): which assets aren't in ente?
waddle plan                                  # → ~/.waddle/plan-uuids.txt

# 2. Migrate only those. Skipped assets are never exported, so their
#    iCloud originals are never downloaded.
waddle sync --album "Photos" --uuid-file ~/.waddle/plan-uuids.txt

waddle sync --album "Photos" --max-chunks 1 --chunk 20    # small test run
```

`plan` matches by normalized filename + capture date (±26 h, tunable via
`--epsilon-hours`); ambiguous assets (name matches, date doesn't) are
exported to be safe — a wrong skip strands a photo, a wrong export costs
one download that hash dedup absorbs. On an Optimize-Mac-Storage library
this is the difference between downloading ~4k originals and ~30k.

Options: `--library <path>`, `--staging <dir>` (default `~/.waddle/staging`),
`--chunk <n>` (default 100), `--min-free-gb <n>` (default 20),
`--rotate-every <n>`, `--applescript-timeout <s>`.

Failed files stay in staging (retried once, then reported); re-running
drains leftovers before exporting more. Set `DUCKLING_ENDPOINT` for a
self-hosted museum (or rely on `duckling login`'s environment).

## Known gaps (deliberate v1 cuts)

- Chunks are count-based, not size-tiered: a chunk of large videos can
  briefly overshoot the intended footprint. The migrator's size-tier design
  (20/small, 5/medium, 1/large) is the planned fix.
- No Photos.app wedge probe yet (interrupted AppleScript exports can leave
  Photos with phantom export tasks; quit and reopen Photos if exports hang).
- No `verify` command yet (manifest vs. ente completeness report — the
  trust gate before deleting originals from iCloud).
- TOTP/passkey accounts: blocked on duckling's `login` support.

## Build

```sh
bun install && bun run typecheck && bun run build   # → dist/waddle
```
