import { describe, expect, test } from "bun:test";
import { clusterLivePhotos, type StagedFile } from "./pairing.ts";

const f = (path: string, mb = 3): StagedFile => ({
    path,
    size: mb * 1024 * 1024,
});

describe("clusterLivePhotos", () => {
    test("pairs a small still+motion sharing a stem", () => {
        const { pairs, singles } = clusterLivePhotos([
            f("/s/IMG_2872.HEIC"),
            f("/s/IMG_2872.mov"),
        ]);
        expect(pairs).toHaveLength(1);
        expect(singles).toHaveLength(0);
        expect(pairs[0]!.still.path).toBe("/s/IMG_2872.HEIC");
        expect(pairs[0]!.motion.path).toBe("/s/IMG_2872.mov");
    });

    test("stem matching is case-insensitive", () => {
        const { pairs } = clusterLivePhotos([
            f("/s/img_0001.heic"),
            f("/s/IMG_0001.MOV"),
        ]);
        expect(pairs).toHaveLength(1);
    });

    test("refuses when either half exceeds ente's 20 MB live-photo cap", () => {
        const { pairs, singles } = clusterLivePhotos([
            f("/s/IMG_1.HEIC", 3),
            f("/s/IMG_1.mov", 25),
        ]);
        expect(pairs).toHaveLength(0);
        expect(singles).toHaveLength(2);
    });

    test("refuses ambiguous stem groups instead of guessing", () => {
        const { pairs, singles } = clusterLivePhotos([
            f("/s/IMG_1.HEIC"),
            f("/s/IMG_1.jpg"),
            f("/s/IMG_1.mov"),
        ]);
        expect(pairs).toHaveLength(0);
        expect(singles).toHaveLength(3);
    });

    test("unrelated files pass through as singles", () => {
        const { pairs, singles } = clusterLivePhotos([
            f("/s/IMG_1.jpg"),
            f("/s/IMG_2.mov"),
            f("/s/notes.pdf"),
        ]);
        expect(pairs).toHaveLength(0);
        expect(singles).toHaveLength(3);
    });

    test("a standalone video with no still stays single", () => {
        const { pairs, singles } = clusterLivePhotos([f("/s/clip.mp4", 10)]);
        expect(pairs).toHaveLength(0);
        expect(singles).toHaveLength(1);
    });
});
