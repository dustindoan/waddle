import { describe, expect, test } from "bun:test";
import {
    buildEnteIndex,
    matchAssets,
    normalizeName,
    type PhotosAsset,
} from "./plan.ts";

const HOUR = 3600 * 1000;
const asset = (uuid: string, name: string, dateMs: number): PhotosAsset => ({
    uuid,
    name,
    dateMs,
});

describe("normalizeName", () => {
    test("lowercases", () => {
        expect(normalizeName("IMG_2872.HEIC")).toBe("img_2872.heic");
    });
    test("strips collision suffixes before the extension", () => {
        expect(normalizeName("PIC_0039 (11).JPG")).toBe("pic_0039.jpg");
    });
    test("does not strip parenthesized text elsewhere", () => {
        expect(normalizeName("party (edited) copy.jpg")).toBe(
            "party (edited) copy.jpg",
        );
    });
});

describe("matchAssets", () => {
    test("matches name + date within epsilon", () => {
        const index = buildEnteIndex([
            { name: "IMG_1.HEIC", creationTime: 1000 * HOUR * 1000 },
        ]);
        const r = matchAssets([asset("u1", "img_1.heic", 1000 * HOUR)], index);
        expect(r.matched).toBe(1);
        expect(r.toMigrate).toHaveLength(0);
    });

    test("name hit outside epsilon is ambiguous and exported", () => {
        const index = buildEnteIndex([
            { name: "IMG_1.HEIC", creationTime: 0 },
        ]);
        const r = matchAssets(
            [asset("u1", "IMG_1.HEIC", 100 * 24 * HOUR)],
            index,
        );
        expect(r.ambiguous).toBe(1);
        expect(r.toMigrate).toEqual(["u1"]);
    });

    test("no name hit is unmatched and exported", () => {
        const r = matchAssets(
            [asset("u1", "new.jpg", 0)],
            buildEnteIndex([]),
        );
        expect(r.unmatched).toBe(1);
        expect(r.toMigrate).toEqual(["u1"]);
    });

    test("each ente file satisfies at most one asset", () => {
        const index = buildEnteIndex([
            { name: "PIC_0039 (3).JPG", creationTime: 0 },
        ]);
        const r = matchAssets(
            [
                asset("u1", "PIC_0039.JPG", 1 * HOUR),
                asset("u2", "PIC_0039.JPG", 2 * HOUR),
            ],
            index,
        );
        expect(r.matched).toBe(1);
        expect(r.toMigrate).toEqual(["u2"]);
    });

    test("collision-suffixed ente names match bare Photos names by date", () => {
        const index = buildEnteIndex([
            { name: "PIC_0039 (1).JPG", creationTime: 0 },
            { name: "PIC_0039 (2).JPG", creationTime: 500 * 24 * HOUR * 1000 },
        ]);
        const r = matchAssets(
            [
                asset("u1", "PIC_0039.JPG", 0),
                asset("u2", "PIC_0039.JPG", 500 * 24 * HOUR),
            ],
            index,
        );
        expect(r.matched).toBe(2);
    });
});
