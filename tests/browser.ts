// Helpers for the browser tests.

import { type BrowserContext, type Page, expect } from "@playwright/test";
import { setUp } from "./lib";

/** Signs in through the local provider's form. A first sign-in lands in a new project. */
export async function signInPage(page: Page, tag: string): Promise<{ email: string; name: string }> {
  await setUp();
  const email = `${tag}-${Math.random().toString(36).slice(2, 8)}@school.test`;
  await page.goto("/");
  await page.getByRole("link", { name: /Aanmelden|Sign in/ }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/e\/[a-z0-9-]+$/);
  await expect(page.locator(".status")).toHaveText("Opgeslagen");
  return { email, name: new URL(page.url()).pathname.slice(3) };
}

export async function sessionCookie(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies("http://localhost:8787")).find((c) => c.name === "__Host-session");
  return `__Host-session=${cookie!.value}`;
}

/** Replaces the whole text of a box, the way a paste would. */
export async function setBox(page: Page, box: number, text: string): Promise<void> {
  // focus() and not click(): Playwright's mouse click waits on every frame of the page,
  // and one test types while the preview frame hangs.
  await page.locator(".box").nth(box).locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+A");
  if (text) await page.keyboard.insertText(text);
  else await page.keyboard.press("Delete");
}

export const boxText = (page: Page, box: number) => page.locator(".box").nth(box).locator(".cm-content");
export const preview = (page: Page) => page.frameLocator(".preview iframe");
