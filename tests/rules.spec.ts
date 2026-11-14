import { expect, test } from "@playwright/test";
import { boxOf, contentType, generateName, nameError, pathError, pathHint } from "../src/shared/rules";
import { injectHelper } from "../src/worker/helper";

test("project names are DNS labels without a double hyphen", () => {
  expect(nameError("groene-vos")).toBeNull();
  expect(nameError("ab")).toBe("length");
  expect(nameError("a".repeat(41))).toBe("length");
  expect(nameError("-vos")).toBe("chars");
  expect(nameError("vos-")).toBe("chars");
  expect(nameError("Groene-Vos")).toBe("chars");
  expect(nameError("groene--vos")).toBe("chars");
  expect(nameError("admin")).toBe("reserved");
});

test("generated names pass the name rules", () => {
  for (let i = 0; i < 200; i++) expect(nameError(generateName())).toBeNull();
});

test("paths refuse traversal, backslashes, hidden files and control characters", () => {
  expect(pathError("images/cat.jpg")).toBeNull();
  expect(pathError("My Photo.JPG")).toBeNull();
  expect(pathError("../secret.txt")).toBe("dots");
  expect(pathError("a/..b/c.txt")).toBe("dots");
  expect(pathError("a\\b.txt")).toBe("backslash");
  expect(pathError(".env")).toBe("leading-dot");
  expect(pathError("a/.git/config")).toBe("leading-dot");
  expect(pathError("a//b.txt")).toBe("slash");
  expect(pathError("/a.txt")).toBe("slash");
  expect(pathError("a\u0000.txt")).toBe("control");
  expect(pathError("")).toBe("empty");
});

test("spaces and capitals get a hint, plain names do not", () => {
  expect(pathHint("My Photo.JPG")).toBe(true);
  expect(pathHint("images/cat.jpg")).toBe(false);
});

test("each text kind opens in its own box", () => {
  expect(boxOf("index.html")).toBe(0);
  expect(boxOf("logo.svg")).toBe(0);
  expect(boxOf("notes.md")).toBe(0);
  expect(boxOf("css/style.css")).toBe(1);
  expect(boxOf("script.js")).toBe(2);
  expect(boxOf("data.json")).toBe(2);
  expect(boxOf("cat.jpg")).toBeNull();
});

test("the content type comes from the extension", () => {
  expect(contentType("a.html")).toContain("text/html");
  expect(contentType("a.JPG")).toBe("image/jpeg");
  expect(contentType("a.exe")).toBeNull();
  expect(contentType("Makefile")).toBeNull();
});

test("the helper goes after the doctype and adds no line", () => {
  const html = "<!doctype html>\n<html>\n<body></body>\n</html>\n";
  const out = injectHelper(html, "http://localhost:8787");
  expect(out.startsWith("<!doctype html><script>")).toBe(true);
  expect(out.split("\n").length).toBe(html.split("\n").length);
  expect(out.endsWith("</script>\n<html>\n<body></body>\n</html>\n")).toBe(true);
  expect(injectHelper("<p>hi", "http://localhost:8787").startsWith("<script>")).toBe(true);
});
