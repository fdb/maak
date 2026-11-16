import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";
import { boxText, preview, sessionCookie, setBox, signInPage } from "./browser";
import { APP, call, filesUrl, site } from "./lib";

// A 1x1 PNG, used as "a photo".
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const saved = (page: import("@playwright/test").Page) => expect(page.locator(".status")).toHaveText("Opgeslagen");

test("a new student gets from the front page to a visible change on their own page", async ({ page }) => {
  const started = Date.now();
  await signInPage(page, "new");
  await expect(preview(page).locator("h1")).toHaveText("Welkom op mijn website");
  await expect(boxText(page, 0)).toContainText("<h1>Welkom op mijn website</h1>");
  await expect(boxText(page, 1)).toContainText("font-family");
  // The JS box stays folded until it is used.
  await expect(page.locator(".box").nth(2)).toHaveClass(/folded/);

  await setBox(page, 0, '<!doctype html>\n<title>Hallo</title>\n<link rel="stylesheet" href="style.css">\n<h1>Mijn eerste pagina</h1>\n');
  await expect(preview(page).locator("h1")).toHaveText("Mijn eerste pagina");
  await saved(page);
  expect(Date.now() - started).toBeLessThan(120_000);
  await page.screenshot({ path: "test-results/editor.png" });
});

test("a CSS edit shows within 100 ms without a reload, an HTML edit within a second", async ({ page }) => {
  await signInPage(page, "speed");
  await expect(preview(page).locator("h1")).toBeVisible();
  const frame = page.frame({ url: /--/ })!;
  // A value on the page's window survives only if the page is not reloaded.
  await frame.evaluate(() => ((window as any).marker = 1));

  await page.locator(".box").nth(1).locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+A");
  const cssStart = Date.now();
  await page.keyboard.insertText("h1 { color: rgb(255, 0, 0); }");
  await frame.waitForFunction(() => getComputedStyle(document.querySelector("h1")!).color === "rgb(255, 0, 0)");
  const cssTime = Date.now() - cssStart;
  expect(cssTime).toBeLessThan(100);
  await saved(page);
  expect(await frame.evaluate(() => (window as any).marker)).toBe(1);
  // After the save the stylesheet file itself is in charge again.
  await frame.waitForFunction(() => !document.querySelector("style[data-maak]"));
  expect(await frame.evaluate(() => getComputedStyle(document.querySelector("h1")!).color)).toBe("rgb(255, 0, 0)");

  await page.locator(".box").nth(0).locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+A");
  const htmlStart = Date.now();
  await page.keyboard.insertText('<!doctype html><link rel="stylesheet" href="style.css"><h1>Snel</h1>');
  await expect(preview(page).locator("h1")).toHaveText("Snel");
  const htmlTime = Date.now() - htmlStart;
  expect(htmlTime).toBeLessThan(1000);
  console.log(`css ${cssTime} ms, html ${htmlTime} ms (local machine, no network)`);
});

test("console output and errors appear in the console strip with file and line", async ({ page }) => {
  await signInPage(page, "console");
  await expect(page.locator(".console")).toHaveCount(0);
  await page.getByRole("button", { name: "script.js openvouwen" }).click();
  await setBox(page, 2, 'console.log("hallo", 1 + 1);\n\nnietBestaand();\n');
  const strip = page.locator(".console");
  await expect(strip.locator("li").nth(0)).toContainText("hallo 2");
  await expect(strip.locator("li").nth(0)).toContainText("script.js:1");
  await expect(strip.locator("li").nth(1)).toContainText("nietBestaand is not defined");
  await expect(strip.locator("li").nth(1)).toContainText("script.js:3");
  await strip.getByRole("button", { name: "Wissen" }).click();
  await expect(page.locator(".console")).toHaveCount(0);
});

test('alert("hallo") shows a dialog', async ({ page }) => {
  await signInPage(page, "alert");
  const dialog = page.waitForEvent("dialog");
  await page.getByRole("button", { name: "script.js openvouwen" }).click();
  await setBox(page, 2, 'alert("hallo");');
  const shown = await dialog;
  expect(shown.message()).toBe("hallo");
  await shown.accept();
});

test("a photo can be uploaded, moved into images/ by rename and by drag, referenced and seen", async ({ page }) => {
  await signInPage(page, "photo");
  await page.locator('.tree input[type="file"]').setInputFiles([
    { name: "cat.png", mimeType: "image/png", buffer: PNG },
    { name: "Dog Photo.png", mimeType: "image/png", buffer: PNG },
    { name: "virus.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") },
  ]);
  const tree = page.locator(".tree");
  await expect(tree.getByRole("button", { name: "cat.png", exact: true })).toBeVisible();
  // A type outside the allow-list is refused with a clear message.
  await expect(page.locator(".notice")).toContainText("Dit bestandstype kan niet");
  await page.locator(".notice").getByRole("button", { name: "Sluiten" }).click();
  await expect(tree.getByText("virus.exe")).toHaveCount(0);
  // A name with spaces or capitals gets a quiet hint.
  await expect(tree.locator(".row", { hasText: "Dog Photo.png" }).locator(".hint")).toBeVisible();

  // Rename: typing images/cat.png moves the file and creates the folder.
  await tree.locator(".row", { hasText: "cat.png" }).hover();
  await page.getByRole("button", { name: "Acties voor cat.png" }).click();
  await page.getByRole("menuitem", { name: "Naam wijzigen" }).click();
  await page.getByLabel("Naam", { exact: true }).fill("images/cat.png");
  await page.keyboard.press("Enter");
  await expect(tree.getByText("images/", { exact: true })).toBeVisible();

  // Drag: dropping a file on the folder moves it.
  await tree.locator(".row", { hasText: "Dog Photo.png" }).dragTo(tree.locator(".row", { hasText: "images/" }));
  const { name } = { name: new URL(page.url()).pathname.slice(3) };
  const cookie = await sessionCookie(page.context());
  await expect
    .poll(async () => (await call(APP, "GET", filesUrl(name), { cookie })).json.files.map((f: any) => f.path))
    .toEqual(expect.arrayContaining(["images", "images/cat.png", "images/Dog Photo.png"]));

  // Clicking an image shows it in the preview at its own path.
  await tree.getByRole("button", { name: "cat.png", exact: true }).click();
  await expect(page.locator(".preview .path")).toHaveValue("/images/cat.png");

  await setBox(page, 0, '<!doctype html><img id="a" src="images/cat.png"><img id="b" src="images/Dog%20Photo.png"><img id="c" src="Images/cat.png">');
  const frame = preview(page);
  await expect(frame.locator("#a")).toHaveJSProperty("naturalWidth", 1);
  await expect(frame.locator("#b")).toHaveJSProperty("naturalWidth", 1);
  // Paths are case-sensitive, as on a real server.
  await expect(frame.locator("#c")).toHaveJSProperty("naturalWidth", 0);
});

test("the ZIP holds exactly the student's files, in one folder named after the project", async ({ page }) => {
  const { name } = await signInPage(page, "zip");
  await page.getByRole("button", { name: "Nieuwe map" }).click();
  await page.getByLabel("Naam", { exact: true }).fill("leeg");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tree").getByText("leeg/")).toBeVisible();
  await page.locator('.tree input[type="file"]').setInputFiles([{ name: "cat.png", mimeType: "image/png", buffer: PNG }]);
  await expect(page.locator(".tree").getByRole("button", { name: "cat.png", exact: true })).toBeVisible();
  await setBox(page, 1, "h1 { color: teal; }");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Meer" }).click();
  await page.getByRole("menuitem", { name: "ZIP downloaden" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`${name}.zip`);
  const entries = unzipSync(readFileSync(await file.path()));
  expect(Object.keys(entries).sort()).toEqual([`${name}/cat.png`, `${name}/index.html`, `${name}/leeg/`, `${name}/script.js`, `${name}/style.css`]);
  const text = (path: string) => Buffer.from(entries[`${name}/${path}`]).toString("utf8");
  // The text in the box is in the ZIP even when the save is still on its way.
  expect(text("style.css")).toBe("h1 { color: teal; }");
  expect(Buffer.from(entries[`${name}/cat.png`]).equals(PNG)).toBe(true);
  // No helper script, and relative links, so a double-click on index.html works.
  expect(text("index.html")).not.toContain("maak");
  expect(text("index.html")).toContain('href="style.css"');
  expect(text("index.html")).toContain('src="script.js"');
});

test("share on: the address loads in a private window. Share off: it answers 404", async ({ page, browser }) => {
  const { name } = await signInPage(page, "share");
  const visitor = await (await browser.newContext()).newPage();
  expect((await visitor.goto(`http://${site(name)}/`))!.status()).toBe(404);

  await page.getByRole("button", { name: "Delen" }).click();
  await page.getByRole("switch", { name: "Iedereen met de link kan kijken" }).check();
  await expect(page.locator(".share input[readonly]")).toHaveValue(`http://${site(name)}`);
  const open = await visitor.goto(`http://${site(name)}/`);
  expect(open!.status()).toBe(200);
  await expect(visitor.locator("h1")).toHaveText("Welkom op mijn website");
  // The shared site carries nothing of maak.io.
  expect(await visitor.content()).not.toContain("maak");

  await page.getByRole("switch", { name: "Iedereen met de link kan kijken" }).uncheck();
  await expect(page.locator(".share")).toContainText("Alleen jij ziet dit project.");
  expect((await visitor.goto(`http://${site(name)}/`))!.status()).toBe(404);
  await visitor.context().close();
});

test("the code view is read-only, and the copy link gives a second account an independent copy", async ({ page, browser }) => {
  const { name } = await signInPage(page, "starter");
  await setBox(page, 0, "<!doctype html><h1>Starter van de docent</h1>");
  await saved(page);
  await page.getByRole("button", { name: "Delen" }).click();
  await page.getByRole("switch", { name: "Iedereen met de link kan kijken" }).check();
  await expect(page.locator(".share input[readonly]")).toBeVisible();

  const context = await browser.newContext({ locale: "nl-BE" });
  const student = await context.newPage();
  // Signed out, the code view shows files, boxes and the site, and nothing can be changed.
  await student.goto(`/p/${name}`);
  await expect(boxText(student, 0)).toContainText("Starter van de docent");
  await expect(student.frameLocator(".preview iframe").locator("h1")).toHaveText("Starter van de docent");
  await expect(student.getByRole("button", { name: "Nieuw bestand" })).toHaveCount(0);
  await expect(student.getByRole("button", { name: "Delen" })).toHaveCount(0);
  await expect(boxText(student, 0)).toHaveAttribute("aria-readonly", "true");
  await boxText(student, 0).click();
  await student.keyboard.type("getypt door een bezoeker");
  await expect(boxText(student, 0)).not.toContainText("getypt door een bezoeker");

  await signInPage(student, "pupil");
  await student.goto(`/copy/${name}`);
  await student.waitForURL((url) => url.pathname.startsWith("/e/") && !url.pathname.endsWith(name));
  const copy = new URL(student.url()).pathname.slice(3);
  expect(copy).not.toBe(name);
  await expect(boxText(student, 0)).toContainText("Starter van de docent");
  await setBox(student, 0, "<!doctype html><h1>Mijn versie</h1>");
  await expect(student.locator(".status")).toHaveText("Opgeslagen");

  await page.reload();
  await expect(boxText(page, 0)).toContainText("Starter van de docent");
  await context.close();
});

test("network off mid-edit, typing continues, network on: nothing is lost", async ({ page, context }) => {
  const { name } = await signInPage(page, "offline");
  const cookie = await sessionCookie(context);
  await context.setOffline(true);
  await setBox(page, 0, "<!doctype html><h1>Getypt zonder netwerk</h1>");
  await expect(page.locator(".status")).toHaveText("Offline, wijzigingen blijven op deze computer");
  await page.keyboard.insertText("<p>en nog een regel</p>");
  expect((await call(APP, "GET", filesUrl(name, "index.html"), { cookie })).text).toContain("Welkom");

  await context.setOffline(false);
  await saved(page);
  const text = (await call(APP, "GET", filesUrl(name, "index.html"), { cookie })).text;
  expect(text).toBe("<!doctype html><h1>Getypt zonder netwerk</h1><p>en nog een regel</p>");
});

test("changes typed offline survive a closed tab", async ({ page, context }) => {
  const { name } = await signInPage(page, "kept");
  const cookie = await sessionCookie(context);
  // The server is unreachable for saves, while the editor itself can still load.
  await page.route("**/api/projects/*/files/**", (route) => (route.request().method() === "PUT" ? route.abort() : route.continue()));
  await setBox(page, 0, "<!doctype html><h1>Bewaard op deze computer</h1>");
  await expect(page.locator(".status")).toHaveText("Offline, wijzigingen blijven op deze computer");
  await page.unroute("**/api/projects/*/files/**");
  await page.reload();
  await expect(boxText(page, 0)).toContainText("Bewaard op deze computer");
  await saved(page);
  expect((await call(APP, "GET", filesUrl(name, "index.html"), { cookie })).text).toContain("Bewaard op deze computer");
});

test("a file changed somewhere else shows a bar with two choices, and nothing is merged", async ({ page, context }) => {
  const { name } = await signInPage(page, "conflict");
  const cookie = await sessionCookie(context);
  const elsewhere = () => call(APP, "PUT", filesUrl(name, "index.html"), { cookie, body: "<h1>Van de andere tab</h1>" });

  await elsewhere();
  await setBox(page, 0, "<h1>Van deze tab</h1>");
  const bar = page.locator(".box").nth(0).locator(".strip");
  await expect(bar).toContainText("Dit bestand is ergens anders gewijzigd.");
  await bar.getByRole("button", { name: "De mijne houden" }).click();
  await saved(page);
  expect((await call(APP, "GET", filesUrl(name, "index.html"), { cookie })).text).toBe("<h1>Van deze tab</h1>");

  await elsewhere();
  await setBox(page, 0, "<h1>Weer van deze tab</h1>");
  await bar.getByRole("button", { name: "Die versie laden" }).click();
  await expect(boxText(page, 0)).toContainText("Van de andere tab");
  await saved(page);
  expect((await call(APP, "GET", filesUrl(name, "index.html"), { cookie })).text).toBe("<h1>Van de andere tab</h1>");
});

test("with while (true) {} in script.js, a reload opens with the preview paused and the script can be fixed", async ({ page }) => {
  await signInPage(page, "loop");
  await page.getByRole("button", { name: "script.js openvouwen" }).click();
  await setBox(page, 2, "while (true) {}");
  await saved(page);

  await page.reload();
  await expect(page.locator(".paused")).toContainText("Het voorbeeld reageerde de vorige keer niet meer.");
  await expect(page.locator(".preview iframe")).toHaveCount(0);
  // The JS box is open now, because the file is in use.
  await setBox(page, 2, 'document.querySelector("h1").textContent = "Gerepareerd";');
  await saved(page);
  await page.getByRole("button", { name: "Voorbeeld starten" }).click();
  await expect(preview(page).locator("h1")).toHaveText("Gerepareerd");
  await page.reload();
  await expect(page.locator(".paused")).toHaveCount(0);
  await expect(preview(page).locator("h1")).toHaveText("Gerepareerd");
});

test("a preview that hangs can be restarted without leaving the editor", async ({ page }) => {
  // While a frame's process hangs, Playwright's own keyboard and mouse calls stall, so this test
  // edits and clicks from inside the page. Whether a real keyboard is held up in the same way is
  // not something this test can show.
  const type = (box: number, text: string) =>
    page.locator(".box").nth(box).locator(".cm-content").evaluate((el, value) => {
      (el as HTMLElement).focus();
      document.execCommand("selectAll");
      document.execCommand("insertText", false, value);
    }, text);

  await signInPage(page, "stuck");
  await page.getByRole("button", { name: "script.js openvouwen" }).click();
  await setBox(page, 2, "while (true) {}");
  const bar = page.locator(".preview .strip.warn");
  await expect(bar).toContainText("Het voorbeeld reageert niet.", { timeout: 10_000 });
  // The editor's own page keeps running and saving while the preview hangs.
  await type(2, 'document.querySelector("h1").textContent = "Weer in orde";');
  await saved(page);
  // On macOS the hung process stays stuck for this host name: the reload after the save hangs
  // again, the bar comes back, and its button moves the preview to a fresh twin. On Linux Chromium
  // (CI) that reload can recover by itself and the bar does not come back. So the test presses the
  // button whenever it is there, from inside the page so it never waits on a button that is gone.
  await expect
    .poll(
      async () => {
        await page.evaluate(() =>
          [...document.querySelectorAll<HTMLButtonElement>(".preview .strip.warn button")]
            .find((b) => b.textContent?.includes("Voorbeeld opnieuw starten"))
            ?.click(),
        );
        return preview(page).locator("h1").textContent({ timeout: 1000 }).catch(() => null);
      },
      { timeout: 20_000 },
    )
    .toBe("Weer in orde");
  await expect(bar).toHaveCount(0);
  // A later edit still reaches the restarted preview.
  await type(0, "<!doctype html><h1>Na de herstart</h1>");
  await expect(preview(page).locator("h1")).toHaveText("Na de herstart");
});

test("index.html is emptied and the tab closed. Later, History restores the earlier version", async ({ page }) => {
  await signInPage(page, "history");
  await setBox(page, 0, "");
  await saved(page);
  await expect(preview(page).locator("h1")).toHaveCount(0);
  await page.goto("/");
  await page.getByRole("link", { name: /^[a-z]+-[a-z]+/ }).first().click();
  await expect(boxText(page, 0)).not.toContainText("Welkom");

  await page.getByRole("button", { name: "Meer" }).click();
  await page.getByRole("menuitem", { name: "Geschiedenis" }).click();
  const moments = page.locator(".history .row-name");
  await expect(moments.first()).toBeVisible();
  // Picking a moment shows that version in the preview before anything changes.
  await moments.last().click();
  await expect(preview(page).locator("h1")).toHaveText("Welkom op mijn website");
  await expect(boxText(page, 0)).not.toContainText("Welkom");
  await page.getByRole("button", { name: "Deze versie terugzetten" }).click();
  await expect(boxText(page, 0)).toContainText("<h1>Welkom op mijn website</h1>");
  await expect(preview(page).locator("h1")).toHaveText("Welkom op mijn website");
});

test("renaming the project changes the address, and the preview keeps working", async ({ page }) => {
  const { name } = await signInPage(page, "rename");
  const fresh = `mijn-site-${Math.random().toString(36).slice(2, 8)}`;
  await page.getByRole("button", { name: `Naam wijzigen: ${name}` }).click();
  await expect(page.locator(".name-form")).toContainText("Oude links stoppen met werken.");
  await page.getByLabel("Naam van het project").fill("Niet Goed");
  await page.keyboard.press("Enter");
  await expect(page.locator(".notice")).toContainText("kleine letters");
  await page.locator(".notice").getByRole("button", { name: "Sluiten" }).click();
  await page.getByLabel("Naam van het project").fill(fresh);
  await page.keyboard.press("Enter");
  await page.waitForURL(`**/e/${fresh}`);
  await expect(preview(page).locator("h1")).toHaveText("Welkom op mijn website");
  await setBox(page, 0, "<!doctype html><h1>Na de naamswijziging</h1>");
  await expect(preview(page).locator("h1")).toHaveText("Na de naamswijziging");
});

test("the editor works by keyboard: new file, Cmd+S, menus", async ({ page }) => {
  await signInPage(page, "keys");
  await page.getByRole("button", { name: "Nieuw bestand" }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.type("over.html");
  await page.keyboard.press("Enter");
  // A second HTML file turns the file name of the box into a dropdown.
  const chooser = page.getByRole("combobox", { name: "Bestand in dit vak" });
  await expect(chooser).toHaveValue("over.html");
  await page.keyboard.insertText("<h1>Over mij</h1>");
  await saved(page);
  await chooser.selectOption("index.html");
  await expect(boxText(page, 0)).toContainText("Welkom");

  // Cmd/Ctrl+S flashes the status and does nothing else.
  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.locator(".status .flash")).toBeVisible();

  // The More menu opens with Enter, moves with the arrows, and closes with Escape.
  await page.getByRole("button", { name: "Meer" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Geschiedenis" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "ZIP downloaden" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Kopie maken" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Meer" })).toBeFocused();

  // Delete a file from its row menu, by keyboard.
  await page.getByRole("button", { name: "Acties voor over.html" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Naam wijzigen" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("menuitem", { name: "Verwijderen" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".tree").getByText("over.html")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Bestand in dit vak" })).toHaveCount(0);
});

test("the project list: new, rename, duplicate, trash, and the interface in English", async ({ page }) => {
  const { name, email } = await signInPage(page, "list");
  await page.goto("/");
  await expect(page.getByRole("link", { name })).toBeVisible();
  await page.getByRole("button", { name: "Nieuw project" }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/e/") && !url.pathname.endsWith(name));
  await page.getByRole("link", { name: "maak, terug naar je projecten" }).click();
  await expect(page.locator(".projects li")).toHaveCount(2);

  await page.getByRole("button", { name: `Acties voor ${name}` }).click();
  await page.getByRole("menuitem", { name: "Dupliceren" }).click();
  await expect(page.locator(".projects li")).toHaveCount(3);

  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: `Acties voor ${name}` }).click();
  await page.getByRole("menuitem", { name: "Verwijderen" }).click();
  await expect(page.locator(".projects li")).toHaveCount(2);
  await page.getByRole("link", { name: "Prullenbak" }).click();
  await expect(page.locator(".projects li")).toHaveCount(1);
  await expect(page.locator(".projects li")).toContainText(name);
  await page.getByRole("button", { name: "Terugzetten" }).click();
  await expect(page.locator(".projects li")).toHaveCount(0);
  await page.getByRole("link", { name: "Terug naar je projecten" }).click();
  await expect(page.locator(".projects li")).toHaveCount(3);

  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "English" }).click();
  await expect(page.getByRole("button", { name: "New project" })).toBeVisible();
  await page.getByRole("link", { name }).click();
  await expect(page.getByRole("button", { name: "Share" })).toBeVisible();
  await expect(page.locator(".status")).toHaveText("Saved");
  await expect(page.getByRole("button", { name: "New file" })).toBeVisible();
  expect(email).toContain("@school.test");
});

test("on a narrow window the three areas become three tabs", async ({ page }) => {
  await signInPage(page, "narrow");
  await page.setViewportSize({ width: 420, height: 800 });
  await expect(page.getByRole("tab", { name: "Code" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".pane-code")).toBeVisible();
  await expect(page.locator(".pane-preview")).toBeHidden();
  await page.getByRole("tab", { name: "Voorbeeld" }).click();
  await expect(page.locator(".pane-preview")).toBeVisible();
  await expect(preview(page).locator("h1")).toBeVisible();
  await page.getByRole("tab", { name: "Bestanden" }).click();
  await expect(page.getByRole("button", { name: "index.html", exact: true })).toBeVisible();
  // No sideways scrolling at this width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("a person outside the allow-list reads that maak.io is invite-only", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("Schrijf je eerste website en zie ze meteen op haar eigen adres.");
  await page.getByRole("link", { name: "Aanmelden" }).click();
  await page.getByLabel("Email").fill("iemand@elders.test");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".error")).toContainText("maak.io werkt voorlopig alleen op uitnodiging.");
  await page.goto("/e/groene-vos");
  await expect(page.getByRole("link", { name: "Aanmelden" })).toBeVisible();
});

test("the editor loads nothing from another party", async ({ page }) => {
  const hosts = new Set<string>();
  page.on("request", (request) => hosts.add(new URL(request.url()).host));
  const { name } = await signInPage(page, "third");
  await expect(preview(page).locator("h1")).toBeVisible();
  const allowed = [...hosts].filter((host) => host !== "localhost:8787" && host !== "localhost:8788" && !host.startsWith(`${name}--`));
  expect(allowed).toEqual([]);
});

test("the admin handles the allow-list, invitations and reports, and blocks a site; a visitor can send a report", async ({ page, browser }) => {
  const { name } = await signInPage(page, "reported");
  await page.getByRole("button", { name: "Delen" }).click();
  await page.getByRole("switch", { name: "Iedereen met de link kan kijken" }).check();
  await expect(page.locator(".share input[readonly]")).toBeVisible();
  await page.screenshot({ path: "test-results/share.png" });

  // The 404 page of a site links to the report page.
  const visitor = await (await browser.newContext({ locale: "nl-BE" })).newPage();
  await visitor.goto(`http://${site(name)}/bestaat-niet.html`);
  await visitor.getByRole("link", { name: /Meld een probleem/ }).click();
  await visitor.getByLabel("Adres of naam van de site").fill(`http://${site(name)}/`);
  await visitor.getByLabel("Wat is er mis?").fill("Dit lijkt op een inlogpagina van een bank.");
  await visitor.getByRole("button", { name: "Melding versturen" }).click();
  await expect(visitor.getByRole("status")).toHaveText("Dank je. De melding is ontvangen.");
  // The text pages exist in both languages and say that the legal texts are drafts.
  await visitor.goto("/privacy");
  await expect(visitor.locator("article")).toContainText("Geen wachtwoord, geen foto, geen profiel.");
  await expect(visitor.locator("article .error")).toHaveText("Ontwerp, nog niet nagelezen.");
  await visitor.goto("/admin");
  await expect(visitor.getByRole("link", { name: "Aanmelden" })).toBeVisible();

  await visitor.getByRole("link", { name: "Aanmelden" }).click();
  await visitor.getByLabel("Email").fill("admin@school.test");
  await visitor.getByRole("button", { name: "Sign in" }).click();
  await visitor.waitForURL("**/admin");
  const report = visitor.locator("li", { hasText: "inlogpagina van een bank" });
  await expect(report).toContainText("inlogpagina van een bank");
  await visitor.screenshot({ path: "test-results/admin.png", fullPage: true });
  await report.getByRole("button", { name: "Bekijken" }).click();
  await expect(visitor.locator(".admin-project")).toContainText("Eigenaar: reported-");
  await visitor.getByLabel("Reden, die de eigenaar te zien krijgt").fill("Vraagt om bankgegevens.");
  await visitor.getByRole("button", { name: "Blokkeren" }).click();
  await expect(visitor.locator(".admin-project .blocked")).toHaveText("Geblokkeerd: Vraagt om bankgegevens.");
  await expect(report).toContainText("afgehandeld");
  await expect(visitor.locator("li", { hasText: `blokkeerde ${name}` })).toContainText("Vraagt om bankgegevens.");
  expect((await call(site(name), "GET", "/")).status).toBe(404);
  await visitor.screenshot({ path: "test-results/admin-blocked.png", fullPage: true });

  // The owner sees the reason where the switch was, and in the project list.
  await page.reload();
  await page.getByRole("button", { name: "Delen" }).click();
  await expect(page.locator(".share .blocked")).toContainText("Reden: Vraagt om bankgegevens.");
  await expect(page.locator(".share").getByRole("switch")).toHaveCount(0);
  await page.goto("/");
  await expect(page.locator("li", { hasText: name }).locator(".blocked")).toContainText("Vraagt om bankgegevens.");
  await page.screenshot({ path: "test-results/list-blocked.png" });

  await visitor.getByRole("button", { name: "Uitnodiging maken" }).click();
  await expect(visitor.locator("code").first()).toContainText("/?invite=");
  await visitor.getByLabel("Domein of adres").fill("workshop-b.test");
  await visitor.getByRole("button", { name: "Toevoegen" }).click();
  await expect(visitor.locator("li", { hasText: "workshop-b.test" })).toBeVisible();
  await visitor.goto("/");
  await visitor.screenshot({ path: "test-results/list.png" });
  await visitor.context().close();
});

test("screens for a look: console, conflict bar, narrow", async ({ page, context }) => {
  const { name } = await signInPage(page, "look");
  await page.locator('.tree input[type="file"]').setInputFiles([{ name: "Foto Van Mij.png", mimeType: "image/png", buffer: PNG }]);
  await page.getByRole("button", { name: "script.js openvouwen" }).click();
  await setBox(page, 1, "body {\n  font-family: Georgia, serif;\n  color: #1d2b53;\n}\n\nh1 {\n  border-bottom: 4px solid tomato; /* een lijn */\n}\n");
  await setBox(page, 2, 'const naam = "wereld";\nconsole.log("hallo", naam);\nconsole.warn("let op");\nfout();');
  await expect(page.locator(".console li")).toHaveCount(3);
  await call(APP, "PUT", filesUrl(name, "index.html"), { cookie: await sessionCookie(context), body: "<h1>elders</h1>" });
  await setBox(page, 0, "<h1>hier</h1>");
  await expect(page.locator(".box .strip")).toBeVisible();
  await page.screenshot({ path: "test-results/console.png" });
  await page.getByRole("switch", { name: "Donkere modus" }).click();
  await page.mouse.move(600, 400);
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/console-dark.png" });
  await page.getByRole("switch", { name: "Donkere modus" }).click();
  await page.setViewportSize({ width: 420, height: 760 });
  await page.waitForTimeout(500);
  expect(await page.locator(".bar").count()).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  await page.screenshot({ path: "test-results/narrow.png" });
});

test("the dark mode switch changes the theme and is remembered", async ({ page }) => {
  await signInPage(page, "dark");
  const toggle = page.getByRole("switch", { name: "Donkere modus" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(dark).not.toBe(light);
  // The code editor follows, and the student's own page does not.
  const code = await page.locator(".cm-editor").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(code).toBe(dark);
  await expect(preview(page).locator("h1")).toBeVisible();
  expect(await page.frame({ url: /--/ })!.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).not.toBe("dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // The switch works from the keyboard.
  await page.getByRole("switch", { name: "Donkere modus" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

/** A PNG of one colour, built by hand so the test needs no image library. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height, 120);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

test("large images are resized in the browser before the upload, all in the same way", async ({ page, context }) => {
  const { name } = await signInPage(page, "resize");
  const cookie = await sessionCookie(context);
  const sizeOf = async (path: string) => {
    const bytes = (await call(APP, "GET", filesUrl(name, path), { cookie })).bytes;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  };
  const input = page.locator('.tree input[type="file"]');
  const batch = [
    { name: "strand.png", mimeType: "image/png", buffer: png(3000, 2000) },
    { name: "portret.png", mimeType: "image/png", buffer: png(1500, 2400) },
    { name: "klein.png", mimeType: "image/png", buffer: png(300, 200) },
  ];

  // A small image alone uploads at once, with no question.
  await input.setInputFiles([batch[2]]);
  await expect(page.locator(".tree").getByRole("button", { name: "klein.png", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await input.setInputFiles(batch);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("2 afbeeldingen zijn te groot");
  await expect(dialog).toContainText("strand.png, is 3000 × 2000 pixels");
  // Each choice says what it is for and how many pixels it is.
  await expect(dialog.getByRole("radio", { name: /Schermvullend/ })).toBeVisible();
  await expect(dialog.locator("label", { hasText: "Miniatuur" })).toContainText("400 px");
  await expect(dialog.getByRole("radio", { name: /Paginabreed/ })).toBeChecked();
  // Nothing reaches the server while the question is open.
  expect((await call(APP, "GET", filesUrl(name, "strand.png"), { cookie })).status).toBe(404);
  await page.screenshot({ path: "test-results/resize.png" });

  await dialog.getByRole("radio", { name: /Halve pagina/ }).check();
  await dialog.getByRole("button", { name: "Uploaden" }).click();
  await expect(page.locator(".tree").getByRole("button", { name: "strand.png", exact: true })).toBeVisible();
  await expect(page.locator(".tree").getByRole("button", { name: "portret.png", exact: true })).toBeVisible();
  // The longest side is 800 pixels, for a wide and for a tall image. The small one is untouched.
  expect(await sizeOf("strand.png")).toEqual({ width: 800, height: 533 });
  expect(await sizeOf("portret.png")).toEqual({ width: 500, height: 800 });
  expect(await sizeOf("klein.png")).toEqual({ width: 300, height: 200 });

  // Keeping the original and cancelling both work.
  await input.setInputFiles([{ ...batch[0], name: "groot.png" }]);
  await page.getByRole("dialog").getByRole("radio", { name: /Origineel houden/ }).check();
  await page.getByRole("dialog").getByRole("button", { name: "Uploaden" }).click();
  await expect(page.locator(".tree").getByRole("button", { name: "groot.png", exact: true })).toBeVisible();
  expect(await sizeOf("groot.png")).toEqual({ width: 3000, height: 2000 });

  await input.setInputFiles([{ ...batch[0], name: "toch-niet.png" }]);
  await page.getByRole("dialog").getByRole("button", { name: "Annuleren" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await call(APP, "GET", filesUrl(name, "toch-niet.png"), { cookie })).status).toBe(404);
});

test("on a phone the bar has two lines: maak, status and theme; then the address, Share and More", async ({ page }) => {
  const { name } = await signInPage(page, "bar");
  // The longest name a project can have, so the address cannot push Share and More to a third line.
  const long = `${"zilveren-vlinder-".repeat(2)}${String(Date.now()).slice(-6)}`;
  const renamed = await page.evaluate(
    async ([from, to]) =>
      (await fetch(`/api/projects/${from}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: to }) })).status,
    [name, long],
  );
  expect(renamed).toBe(200);
  await page.goto(`/e/${long}`);
  await expect(page.locator(".status")).toHaveText("Opgeslagen");
  await page.setViewportSize({ width: 390, height: 800 });
  const bar = page.locator("header.bar");
  const box = async (locator: import("@playwright/test").Locator) => (await locator.boundingBox())!;
  const middle = (b: { y: number; height: number }) => b.y + b.height / 2;
  const home = await box(bar.locator(".home"));
  const status = await box(bar.locator(".status"));
  const theme = await box(bar.getByRole("switch"));
  const address = await box(bar.locator(".address"));
  const share = await box(bar.getByRole("button", { name: "Delen" }));
  const more = await box(bar.getByRole("button", { name: "Meer" }));
  // One line each: the middles agree within a few pixels.
  for (const b of [status, theme]) expect(Math.abs(middle(b) - middle(home))).toBeLessThan(6);
  for (const b of [share, more]) expect(Math.abs(middle(b) - middle(address))).toBeLessThan(6);
  expect(middle(address)).toBeGreaterThan(middle(home) + 20);
  // Left and right.
  expect(home.x).toBeLessThan(status.x);
  expect(status.x).toBeLessThan(theme.x);
  expect(theme.x + theme.width).toBeGreaterThan(390 - 40);
  expect(more.x + more.width).toBeGreaterThan(390 - 40);
  expect(address.x).toBeLessThan(40);
  // Download ZIP lives in the More menu.
  await expect(bar.getByRole("button", { name: "ZIP downloaden" })).toHaveCount(0);
  await bar.getByRole("button", { name: "Meer" }).click();
  await expect(page.getByRole("menuitem", { name: "ZIP downloaden" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "test-results/phone-bar.png", clip: { x: 0, y: 0, width: 390, height: 160 } });
});

test("on a phone the Share panel and the More menu stay on the screen", async ({ page }) => {
  await signInPage(page, "phone");
  await page.setViewportSize({ width: 390, height: 800 });
  const inside = async (locator: import("@playwright/test").Locator) => {
    const box = (await locator.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  };
  await page.getByRole("button", { name: "Delen" }).click();
  await page.getByRole("switch", { name: "Iedereen met de link kan kijken" }).check();
  await expect(page.locator(".share input[readonly]")).toBeVisible();
  await inside(page.locator(".popover"));
  await inside(page.locator(".share input[readonly]"));
  await page.screenshot({ path: "test-results/phone-share.png" });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Meer" }).click();
  await inside(page.getByRole("menu"));
});

test("on a touch device code and inputs are 16 px, so iPhone Safari does not zoom on a tap", async ({ browser }) => {
  const context = await browser.newContext({ locale: "nl-BE", hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } });
  const page = await context.newPage();
  await signInPage(page, "touch");
  const sizeOf = (selector: string) => page.locator(selector).first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(await sizeOf(".cm-content")).toBeGreaterThanOrEqual(16);
  await page.getByRole("tab", { name: "Voorbeeld" }).tap();
  expect(await sizeOf(".preview-bar .path")).toBeGreaterThanOrEqual(16);
  await page.getByRole("button", { name: "Delen" }).tap();
  await page.getByRole("switch", { name: "Iedereen met de link kan kijken" }).check();
  expect(await sizeOf(".share input[readonly]")).toBeGreaterThanOrEqual(16);
  // The page itself still allows zooming by hand.
  expect(await page.locator('meta[name="viewport"]').getAttribute("content")).not.toMatch(/user-scalable|maximum-scale/);
  await context.close();
});

test("a file can be duplicated under a new name, to start about.html from index.html", async ({ page, context }) => {
  const { name } = await signInPage(page, "duplicate");
  const cookie = await sessionCookie(context);
  // Text that is still on its way to the server is part of the copy.
  await setBox(page, 0, "<!doctype html><h1>Startpagina</h1>");
  await page.locator(".tree .row", { hasText: "index.html" }).hover();
  await page.getByRole("button", { name: "Acties voor index.html" }).click();
  await page.getByRole("menuitem", { name: "Dupliceren" }).click();
  const field = page.getByLabel("Naam", { exact: true });
  // The field proposes a free name and selects the part before the extension.
  await expect(field).toHaveValue("index-kopie.html");
  expect(await field.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart!, el.selectionEnd!))).toBe("index-kopie");
  await page.keyboard.type("about");
  await page.keyboard.press("Enter");

  await expect(page.locator(".tree").getByRole("button", { name: "about.html", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Bestand in dit vak" })).toHaveValue("about.html");
  await expect(boxText(page, 0)).toContainText("Startpagina");
  await saved(page);
  expect((await call(APP, "GET", filesUrl(name, "about.html"), { cookie })).text).toBe("<!doctype html><h1>Startpagina</h1>");
  // The copy is its own file: changing it leaves index.html alone.
  await setBox(page, 0, "<!doctype html><h1>Over mij</h1>");
  await saved(page);
  expect((await call(APP, "GET", filesUrl(name, "index.html"), { cookie })).text).toBe("<!doctype html><h1>Startpagina</h1>");

  // A name that exists is refused, and a second copy gets the next free name.
  await page.locator('.tree input[type="file"]').setInputFiles([{ name: "cat.png", mimeType: "image/png", buffer: PNG }]);
  await page.locator(".tree .row", { hasText: "cat.png" }).hover();
  await page.getByRole("button", { name: "Acties voor cat.png" }).click();
  await page.getByRole("menuitem", { name: "Dupliceren" }).click();
  await expect(page.getByLabel("Naam", { exact: true })).toHaveValue("cat-kopie.png");
  await page.getByLabel("Naam", { exact: true }).fill("about.html");
  await page.keyboard.press("Enter");
  await expect(page.locator(".notice")).toContainText("Er bestaat al iets met deze naam.");
  await page.locator(".notice").getByRole("button", { name: "Sluiten" }).click();
  await page.getByLabel("Naam", { exact: true }).fill("images/cat-2.png");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await call(APP, "GET", filesUrl(name, "images/cat-2.png"), { cookie })).bytes.equals(PNG)).toBe(true);
});

test("a menu closes on a press anywhere outside it, the preview included", async ({ page, browser }) => {
  await signInPage(page, "dismiss");
  await expect(preview(page).locator("h1")).toBeVisible();
  const frame = (await page.locator(".preview iframe").boundingBox())!;
  const openShare = async (on: import("@playwright/test").Page) => {
    await on.getByRole("button", { name: "Delen" }).click();
    await expect(on.locator(".popover")).toBeVisible();
  };

  await openShare(page);
  await page.mouse.click(frame.x + frame.width / 2, frame.y + frame.height - 60);
  await expect(page.locator(".popover")).toHaveCount(0);

  await openShare(page);
  await boxText(page, 1).click();
  await expect(page.locator(".popover")).toHaveCount(0);

  await page.getByRole("button", { name: "Meer" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.mouse.click(frame.x + frame.width / 2, frame.y + frame.height - 60);
  await expect(page.getByRole("menu")).toHaveCount(0);
  // With no menu open the preview takes clicks again.
  await setBox(page, 0, '<!doctype html><button onclick="this.textContent = \'geklikt\'">knop</button>');
  await preview(page).getByRole("button", { name: "knop" }).click();
  await expect(preview(page).getByRole("button")).toHaveText("geklikt");

  // The same by touch, on a phone.
  const context = await browser.newContext({ locale: "nl-BE", hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } });
  const phone = await context.newPage();
  await signInPage(phone, "tap");
  await phone.getByRole("button", { name: "Delen" }).tap();
  await expect(phone.locator(".popover")).toBeVisible();
  await phone.touchscreen.tap(195, 600);
  await expect(phone.locator(".popover")).toHaveCount(0);
  await phone.getByRole("tab", { name: "Voorbeeld" }).tap();
  await phone.getByRole("button", { name: "Meer" }).tap();
  await expect(phone.getByRole("menu")).toBeVisible();
  // Chromium sends a touch on a frame by hit-test data that trails the page by a moment.
  // A tap in the same instant the menu opens still lands in the preview; a person is slower.
  await phone.waitForTimeout(300);
  await phone.touchscreen.tap(195, 600);
  await expect(phone.getByRole("menu")).toHaveCount(0);
  await context.close();
});

test("dragging in the file tree highlights a real target once and never flashes the panel", async ({ page, context }) => {
  const { name } = await signInPage(page, "drag");
  const cookie = await sessionCookie(context);
  await page.getByRole("button", { name: "Nieuwe map" }).click();
  await page.getByLabel("Naam", { exact: true }).fill("images");
  await page.keyboard.press("Enter");
  const tree = page.locator(".tree");
  const folder = tree.locator(".row", { hasText: "images/" });
  await expect(folder).toBeVisible();
  // The folder icon is not clipped by its row.
  const icon = (await folder.locator("svg").first().boundingBox())!;
  const label = (await folder.locator(".row-name").boundingBox())!;
  expect(icon.x).toBeGreaterThanOrEqual(label.x);

  // Count every change of the highlight classes while a file is dragged across the rows.
  await page.evaluate(() => {
    (window as any).changes = 0;
    new MutationObserver((list) => ((window as any).changes += list.length)).observe(document.querySelector(".tree")!, {
      attributes: true,
      attributeFilter: ["class"],
      subtree: true,
    });
  });
  const center = async (text: string) => {
    const box = (await tree.locator(".row", { hasText: text }).boundingBox())!;
    return { x: box.x + 60, y: box.y + box.height / 2 };
  };
  const start = await center("style.css");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // Over its own level, back and forth across other files: no highlight at all.
  for (const text of ["script.js", "index.html", "script.js", "index.html"]) {
    const at = await center(text);
    await page.mouse.move(at.x, at.y, { steps: 6 });
  }
  await expect(tree.locator(".row.over")).toHaveCount(0);
  await expect(page.locator(".tree.over")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).changes)).toBe(0);
  // Over the folder: one highlight, set once however much the pointer moves inside the row.
  const target = await center("images/");
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await page.mouse.move(target.x + 40, target.y + 3, { steps: 6 });
  await expect(folder).toHaveClass(/over/);
  expect(await page.evaluate(() => (window as any).changes)).toBe(1);
  await page.mouse.up();
  await expect.poll(async () => (await call(APP, "GET", filesUrl(name, "images/style.css"), { cookie })).status).toBe(200);
  await expect(tree.locator(".row.over")).toHaveCount(0);
});

test("a right-click on a file or folder opens the same menu as its three dots", async ({ page, browser }) => {
  const { name } = await signInPage(page, "context");
  const tree = page.locator(".tree");
  await tree.locator(".row", { hasText: "style.css" }).click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText(["Naam wijzigen", "Dupliceren", "Pad kopiëren", "Verwijderen"]);
  await expect(page.getByRole("button", { name: "Acties voor style.css" })).toHaveAttribute("aria-expanded", "true");
  // A second right-click on the same row leaves the menu open; one elsewhere moves it.
  await tree.locator(".row", { hasText: "style.css" }).click({ button: "right" });
  await expect(menu).toHaveCount(1);
  await tree.locator(".row", { hasText: "script.js" }).click({ button: "right" });
  await expect(page.getByRole("button", { name: "Acties voor script.js" })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("menu")).toHaveCount(1);
  await page.getByRole("menuitem", { name: "Verwijderen" }).click();
  await expect(tree.getByText("script.js")).toHaveCount(0);

  // A folder has no Duplicate.
  await page.getByRole("button", { name: "Nieuwe map" }).click();
  await page.getByLabel("Naam", { exact: true }).fill("images");
  await page.keyboard.press("Enter");
  await tree.locator(".row", { hasText: "images/" }).click({ button: "right" });
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveText(["Naam wijzigen", "Pad kopiëren", "Verwijderen"]);
  await page.keyboard.press("Escape");

  // In the read-only code view there is no menu, so the browser's own right-click stays.
  await page.getByRole("button", { name: "Delen" }).click();
  await page.getByRole("switch", { name: "Iedereen met de link kan kijken" }).check();
  await expect(page.locator(".share input[readonly]")).toBeVisible();
  const visitor = await (await browser.newContext({ locale: "nl-BE" })).newPage();
  await visitor.goto(`/p/${name}`);
  await visitor.locator(".tree .row", { hasText: "style.css" }).click({ button: "right" });
  await expect(visitor.getByRole("menu")).toHaveCount(0);
  await visitor.context().close();
});

test("an image dropped on the HTML code becomes an img tag at that spot", async ({ page, context }) => {
  const { name } = await signInPage(page, "imgdrop");
  const cookie = await sessionCookie(context);
  await page.locator('.tree input[type="file"]').setInputFiles([{ name: "Mijn Kat.png", mimeType: "image/png", buffer: PNG }]);
  const tree = page.locator(".tree");
  await tree.locator(".row", { hasText: "Mijn Kat.png" }).hover();
  await page.getByRole("button", { name: "Acties voor Mijn Kat.png" }).click();
  await page.getByRole("menuitem", { name: "Naam wijzigen" }).click();
  await page.getByLabel("Naam", { exact: true }).fill("images/Mijn Kat.png");
  await page.keyboard.press("Enter");
  await expect(tree.getByText("images/", { exact: true })).toBeVisible();
  await setBox(page, 0, "<!doctype html>\n<h1>Mijn kat</h1>\n\n<p>einde</p>\n");
  await saved(page);

  // From the file list, onto the empty third line.
  const source = (await tree.locator(".row", { hasText: "Mijn Kat.png" }).boundingBox())!;
  const line = (await page.locator(".box").nth(0).locator(".cm-line").nth(2).boundingBox())!;
  await page.mouse.move(source.x + 60, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(line.x + 30, line.y + line.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".box").nth(0).locator(".cm-line").nth(2)).toHaveText('<img src="images/Mijn%20Kat.png" alt="">');
  // The file stays where it was, and the cursor waits inside alt="".
  await expect(tree.getByRole("button", { name: "Mijn Kat.png", exact: true })).toBeVisible();
  await page.keyboard.type("Mijn kat op de bank");
  await saved(page);
  expect((await call(APP, "GET", filesUrl(name, "index.html"), { cookie })).text).toBe(
    '<!doctype html>\n<h1>Mijn kat</h1>\n<img src="images/Mijn%20Kat.png" alt="Mijn kat op de bank">\n<p>einde</p>\n',
  );
  const shown = preview(page).getByRole("img", { name: "Mijn kat op de bank" });
  await expect(shown).toHaveJSProperty("naturalWidth", 1);

  // A file that is not an image inserts nothing, and is not moved either.
  const css = (await tree.locator(".row", { hasText: "style.css" }).boundingBox())!;
  await page.mouse.move(css.x + 60, css.y + css.height / 2);
  await page.mouse.down();
  await page.mouse.move(line.x + 30, line.y + line.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".box").nth(0).locator(".cm-line")).toHaveCount(5);

  // From the computer: the image is uploaded next to the HTML file, then the tag appears.
  const last = (await page.locator(".box").nth(0).locator(".cm-line").nth(4).boundingBox())!;
  await page.evaluate(
    ({ bytes, x, y }) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], "hond.png", { type: "image/png" }));
      const target = document.querySelector(".box .cm-content")!;
      target.dispatchEvent(new DragEvent("drop", { dataTransfer: data, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    },
    { bytes: PNG.toString("base64"), x: last.x + 30, y: last.y + last.height / 2 },
  );
  await expect(page.locator(".box").nth(0).locator(".cm-line").nth(4)).toHaveText('<img src="hond.png" alt="">');
  await expect(tree.getByRole("button", { name: "hond.png", exact: true })).toBeVisible();
  expect((await call(APP, "GET", filesUrl(name, "hond.png"), { cookie })).bytes.equals(PNG)).toBe(true);

  // In a page inside a folder, the path climbs out of that folder.
  await page.getByRole("button", { name: "Nieuw bestand" }).click();
  await page.getByLabel("Naam", { exact: true }).fill("paginas/over.html");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("combobox", { name: "Bestand in dit vak" })).toHaveValue("paginas/over.html");
  const empty = (await page.locator(".box").nth(0).locator(".cm-line").first().boundingBox())!;
  const again = (await tree.locator(".row", { hasText: "Mijn Kat.png" }).boundingBox())!;
  await page.mouse.move(again.x + 60, again.y + again.height / 2);
  await page.mouse.down();
  await page.mouse.move(empty.x + 30, empty.y + empty.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".box").nth(0).locator(".cm-line").first()).toHaveText('<img src="../images/Mijn%20Kat.png" alt="">');
});

test("clicking an HTML file in the file list shows that page in the preview", async ({ page }) => {
  await signInPage(page, "pages");
  await page.getByRole("button", { name: "Nieuw bestand" }).click();
  await page.getByLabel("Naam", { exact: true }).fill("about.html");
  await page.keyboard.press("Enter");
  const address = page.locator(".preview .path");
  // A new page shows at once, empty, and fills as it is written.
  await expect(address).toHaveValue("/about.html");
  await expect(page.getByRole("combobox", { name: "Bestand in dit vak" })).toHaveValue("about.html");
  await expect(boxText(page, 0)).toBeFocused();
  await page.keyboard.insertText("<!doctype html><h1>Over mij</h1>");
  await expect(preview(page).locator("h1")).toHaveText("Over mij");

  const tree = page.locator(".tree");
  await tree.getByRole("button", { name: "index.html", exact: true }).click();
  await expect(address).toHaveValue("/index.html");
  await expect(preview(page).locator("h1")).toHaveText("Welkom op mijn website");
  await expect(boxText(page, 0)).toContainText("Welkom op mijn website");

  await tree.getByRole("button", { name: "about.html", exact: true }).click();
  await expect(address).toHaveValue("/about.html");
  await expect(preview(page).locator("h1")).toHaveText("Over mij");
  // The dropdown of the box does the same.
  await page.getByRole("combobox", { name: "Bestand in dit vak" }).selectOption("index.html");
  await expect(address).toHaveValue("/index.html");
  // A stylesheet opens in its box and leaves the preview where it is.
  await tree.getByRole("button", { name: "style.css", exact: true }).click();
  await expect(address).toHaveValue("/index.html");
  // An edit to the page on screen reloads that page, not another one.
  await tree.getByRole("button", { name: "about.html", exact: true }).click();
  await expect(boxText(page, 0)).toContainText("Over mij");
  await setBox(page, 0, "<!doctype html><h1>Over mij, versie twee</h1>");
  await expect(preview(page).locator("h1")).toHaveText("Over mij, versie twee");
  await expect(address).toHaveValue("/about.html");
});

test("Tab expands Emmet abbreviations in HTML, and only where that is meant", async ({ page }) => {
  await signInPage(page, "emmet");
  const html = page.locator(".box").nth(0);
  const lines = () => html.locator(".cm-content").evaluate((el) => [...el.querySelectorAll(".cm-line")].map((l) => l.textContent));
  await setBox(page, 0, "");

  // img: the whole element, with the cursor in src and Tab stepping on to alt.
  await page.keyboard.type("img");
  await page.keyboard.press("Tab");
  expect(await lines()).toEqual(['<img src="" alt="">']);
  await page.keyboard.type("cat.png");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Mijn kat");
  expect(await lines()).toEqual(['<img src="cat.png" alt="Mijn kat">']);

  // A nested abbreviation with a multiplier.
  await setBox(page, 0, "");
  await page.keyboard.type("ul>li*4>a>img");
  await page.keyboard.press("Tab");
  const list = (await lines()).map((l) => l!.trim());
  expect(list[0]).toBe("<ul>");
  expect(list.filter((l) => l === '<li><a href=""><img src="" alt=""></a></li>')).toHaveLength(4);
  expect(list[list.length - 1]).toBe("</ul>");
  // The cursor starts in the first href.
  await page.keyboard.type("een.html");
  expect((await lines())[1]!.trim()).toBe('<li><a href="een.html"><img src="" alt=""></a></li>');

  // Classes and ids work as in CSS.
  await setBox(page, 0, "");
  await page.keyboard.type("nav.menu>a#home");
  await page.keyboard.press("Tab");
  expect((await lines()).join("")).toContain('<nav class="menu"><a href="" id="home"></a></nav>');

  // An ordinary word is not turned into a tag: Tab indents.
  await setBox(page, 0, "");
  await page.keyboard.type("tekst");
  await page.keyboard.press("Tab");
  expect((await lines())[0]!.trim()).toBe("tekst");
  // Inside a tag nothing expands either: "b" here is a class name, not an element.
  await setBox(page, 0, '<p class="a b');
  await page.keyboard.press("Tab");
  expect((await lines()).join("")).not.toContain("<b>");

  // In CSS and JS, Tab keeps its plain meaning.
  await setBox(page, 1, "");
  await page.keyboard.type("img");
  await page.keyboard.press("Tab");
  expect((await page.locator(".box").nth(1).locator(".cm-line").first().textContent())!.trim()).toBe("img");
});

test("the account menu ends with sign out, and download and delete are on the account page", async ({ page }) => {
  const { email } = await signInPage(page, "account");
  await page.goto("/");
  await page.getByRole("button", { name: "Account" }).click();
  const items = page.getByRole("menuitem");
  await expect(items.last()).toHaveText("Afmelden");
  await expect(page.getByRole("menuitem", { name: "Account verwijderen" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Al mijn projecten downloaden" })).toHaveCount(0);

  await page.getByRole("menuitem", { name: "Account", exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.locator("h1")).toHaveText("Account");
  await expect(page.locator("main")).toContainText(email);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Al mijn projecten downloaden" }).click();
  expect((await download).suggestedFilename()).toBe("maak.zip");

  await page.getByRole("textbox").fill(email);
  await page.getByRole("button", { name: "Mijn account verwijderen" }).click();
  await expect(page.getByRole("link", { name: "Aanmelden" })).toBeVisible();
});

test("each project in the list shows its page as a small picture that runs no script", async ({ page }) => {
  const { name } = await signInPage(page, "thumbs");
  await setBox(page, 0, "<h1>Klein beeld</h1><script>document.title = 'ran'; document.body.append('SCRIPT')</script>");
  await expect(page.locator(".status")).toHaveText("Opgeslagen");
  await page.goto("/");
  const frame = page.locator(".projects li iframe");
  await expect(frame).toHaveCount(1);
  expect(await frame.getAttribute("src")).toMatch(new RegExp(`^http://${name}--[0-9a-f]+\\.`));
  expect(await frame.getAttribute("sandbox")).toBe("");
  const inside = page.frameLocator(".projects li iframe");
  await expect(inside.locator("h1")).toHaveText("Klein beeld");
  await expect(inside.locator("body")).not.toContainText("SCRIPT");
  // The picture is a way into the project, like the name.
  await page.locator(".projects li .thumb").click();
  await expect(page).toHaveURL(new RegExp(`/e/${name}$`));
});
