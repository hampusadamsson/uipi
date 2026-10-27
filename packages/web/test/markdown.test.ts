// Markdown rendering contract for chat messages.
//
// The input is *model output*, so the security-relevant rules are pinned here
// next to the formatting ones: raw HTML must never become live DOM, and link /
// image destinations must be scheme-vetted. Everything else is "does the shape
// of a message survive the trip through marked".
import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/lib/markdown.js";

describe("markdown formatting", () => {
  it("renders paragraphs, emphasis, lists and headings", () => {
    const html = renderMarkdown("# Title\n\nsome **bold** and _ital_\n\n- a\n- b");
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>ital</em>");
    expect(html).toContain("<li>a</li>");
  });

  it("keeps a single newline a line break (chat input semantics)", () => {
    // previously rendered with `whitespace-pre-wrap`, so `a\nb` was two lines
    expect(renderMarkdown("a\nb")).toContain("<br>");
  });

  it("renders GFM tables and task lists", () => {
    expect(renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |")).toContain("<table>");
    expect(renderMarkdown("- [x] done")).toContain('type="checkbox"');
  });

  it("renders inline code and fenced blocks", () => {
    expect(renderMarkdown("use `x` here")).toContain("<code>x</code>");
    const html = renderMarkdown("```ts\nconst a = 1;\n```");
    expect(html).toContain('<code class="hljs"');
    expect(html).toContain('class="language-ts"');
  });

  it("highlights a fenced block it knows the language of", () => {
    const html = renderMarkdown("```js\nconst a = 1;\n```");
    // hljs wraps keywords in spans; plain escaping would not
    expect(html).toContain("hljs-keyword");
  });

  it("does not throw on an unknown language, and still fences the code", () => {
    const html = renderMarkdown("```notalang\nfoo()\n```");
    expect(html).toContain("<pre><code");
    expect(html).toContain("foo()");
  });

  it("escapes special characters inside code", () => {
    expect(renderMarkdown("```\n<script>x</script>\n```")).toContain(
      "&lt;script&gt;x&lt;/script&gt;",
    );
  });
});

describe("markdown safety (input is model output)", () => {
  it("escapes raw HTML instead of passing it through", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes raw HTML block elements like <img onerror>", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("drops a javascript: link target but keeps its text", () => {
    const html = renderMarkdown("[click me](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a ");
    expect(html).toContain("click me");
  });

  it("drops a javascript: image source", () => {
    const html = renderMarkdown("![alt](javascript:alert(1))");
    expect(html).not.toContain("<img");
    expect(html).toContain("alt");
  });

  it("ignores control characters used to smuggle a scheme", () => {
    const html = renderMarkdown("[x](java\tscript:alert(1))");
    expect(html).not.toContain("<a ");
  });

  it("ignores HTML-entity-encoded scheme separators", () => {
    // marked passes `&#58;` through undecoded, so a naive scheme check sees no colon
    const html = renderMarkdown("[x](javascript&#58;alert(1))");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("&amp;#58;");
  });

  it("drops backslash-escaped protocol-relative URLs", () => {
    // browsers normalise "/\\evil.example" to a protocol-relative URL
    expect(renderMarkdown("[x](/\\evil.example)")).not.toContain("<a ");
  });

  it("drops data: URLs", () => {
    const html = renderMarkdown("[x](data:text/html;base64,PHNjcmlwdD4=)");
    expect(html).not.toContain("data:");
  });

  it("keeps http(s) and mailto links, opening them in a new tab", () => {
    const html = renderMarkdown("[a](https://example.com) [b](mailto:x@example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="mailto:x@example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("keeps relative links (they cannot escape the app in a new tab)", () => {
    expect(renderMarkdown("[a](./docs/x.md)")).toContain('href="./docs/x.md"');
  });

  it("pins no referrer on images so transcript images can't leak the URL", () => {
    expect(renderMarkdown("![x](https://example.com/i.png)")).toContain(
      'referrerpolicy="no-referrer"',
    );
  });

  it("escapes quoted attributes in link titles", () => {
    const html = renderMarkdown('[a](https://example.com "x\\" onmouseover=\\"y")');
    expect(html).not.toContain('onmouseover="y"');
  });
});

describe("markdown cache", () => {
  it("returns the same html for the same input, and renders distinct inputs distinctly", () => {
    expect(renderMarkdown("**same**")).toBe(renderMarkdown("**same**"));
    expect(renderMarkdown("**a**")).not.toBe(renderMarkdown("**b**"));
  });
});
