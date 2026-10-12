import { describe, expect, it } from "vitest";
import { captureName, normaliseUrl } from "./capture";

describe("web page addresses", () => {
  it("adds https:// when it's left off", () => {
    expect(normaliseUrl(" example.com/a ")).toBe("https://example.com/a");
    expect(normaliseUrl("http://example.com")).toBe("http://example.com");
    expect(normaliseUrl("")).toBe("");
  });

  it("names the file after the page", () => {
    expect(captureName("https://www.example.com/")).toBe("example.com.pdf");
    expect(captureName("https://example.com/news/big-story.html?x=1")).toBe("example.com-big-story.pdf");
    expect(captureName("nonsense")).toBe("web-page.pdf");
  });
});
