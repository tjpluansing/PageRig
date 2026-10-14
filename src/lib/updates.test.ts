import { describe, expect, it } from "vitest";
import { buildId } from "./updates";

describe("buildId", () => {
  it("finds the built script", () => {
    const html = `<head><script type="module" crossorigin src="/assets/index-Bk8VGrRI.js"></script>
      <link rel="stylesheet" crossorigin href="/assets/index-6lLRbetm.css"></head>`;
    expect(buildId(html)).toBe("/assets/index-Bk8VGrRI.js");
  });

  it("changes when the app is rebuilt", () => {
    const page = (hash: string) => `<script type="module" crossorigin src="/assets/index-${hash}.js"></script>`;
    expect(buildId(page("aaaa"))).not.toBe(buildId(page("bbbb")));
  });

  it("ignores the dev server's script", () => {
    expect(buildId(`<script type="module" src="/src/main.tsx"></script>`)).toBeNull();
  });
});
