const { test, expect } = require("@playwright/test");

const OLLAMA_URL = "http://127.0.0.1:12434/";
const OPENAI_URL = "http://127.0.0.1:12434/engines/v1";
const MODEL_ID = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";

async function openSettings(page) {
  await page.locator("#settingsButton").click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
}

async function switchToOllama(page) {
  await openSettings(page);
  await page.locator("#providerInput").selectOption("ollama");
  await page.locator("#saveSettingsButton").click();
}

async function enableDebug(page) {
  await openSettings(page);
  const debugToggle = page.locator("#debugToggle");
  const pressed = await debugToggle.getAttribute("aria-pressed");
  if (pressed !== "true") {
    await debugToggle.click();
  }
  await page.locator("#saveSettingsButton").click();
  await expect(page.locator("#debugPanel")).toBeVisible();
}

async function setStreaming(page, enabled) {
  await openSettings(page);
  const toggle = page.locator("#streamingToggle");
  const pressed = await toggle.getAttribute("aria-pressed");
  const shouldBe = enabled ? "true" : "false";
  if (pressed !== shouldBe) {
    await toggle.click();
  }
  await page.locator("#saveSettingsButton").click();
}

async function sendAndWaitForAssistant(page, prompt) {
  const emptyComposer = page.locator("#composerEmpty");
  const conversationComposer = page.locator("#composer");

  if (await emptyComposer.isVisible()) {
    await emptyComposer.fill(prompt);
    await page.locator("#sendButtonEmpty").click();
  } else {
    await conversationComposer.fill(prompt);
    await page.locator("#sendButton").click();
  }

  const assistant = page.locator(".message--assistant .message__content").last();
  await expect(assistant).not.toHaveText("", { timeout: 60_000 });
  return assistant;
}

test.describe("live backend smoke tests", () => {
  test.describe.configure({ mode: "serial" });

  test("startup loads models from the real default backend", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/");

    await expect(page.locator("#topModelSelect")).toHaveValue(MODEL_ID, { timeout: 15_000 });
    await expect(page.locator("#emptyModelSelect")).toHaveValue(MODEL_ID, { timeout: 15_000 });
  });

  test("can chat against the real backend in ollama mode", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/");
    await switchToOllama(page);
    await enableDebug(page);
    await setStreaming(page, false);

    await expect(page.locator("#topModelSelect")).toHaveValue(MODEL_ID, { timeout: 15_000 });
    const assistant = await sendAndWaitForAssistant(page, "Reply with a short greeting in Swedish.");
    await expect(assistant).toContainText(/hej|hall/i);
    const transcriptHtml = await page.locator("#messages").innerHTML();
    expect(transcriptHtml).toContain("message--assistant");
    expect(transcriptHtml).toContain("message--user");
    await expect(page.locator("#debugLog")).toContainText("Chat Request");
    await expect(page.locator("#debugLog")).toContainText(`${OLLAMA_URL}api/chat`);
  });

  test("can chat against the real backend in ollama mode with streaming enabled", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/");
    await switchToOllama(page);
    await enableDebug(page);

    await expect(page.locator("#topModelSelect")).toHaveValue(MODEL_ID, { timeout: 15_000 });
    const assistant = await sendAndWaitForAssistant(page, "Reply with a short Swedish greeting.");
    await expect(assistant).not.toHaveText("", { timeout: 60_000 });

    const transcriptHtml = await page.locator("#messages").innerHTML();
    expect(transcriptHtml).toContain("message--assistant");
    expect(transcriptHtml).toContain("message--user");
    await expect(page.locator("#debugLog")).toContainText("Chat Request");
  });

  test("can chat against the real backend in openai-compatible mode", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/");
    await enableDebug(page);

    await openSettings(page);
    await page.locator("#providerInput").selectOption("openai");
    await expect(page.locator("#apiBaseUrlInput")).toHaveValue(OPENAI_URL);
    await expect(page.locator("#modelSelect")).toHaveValue(MODEL_ID, { timeout: 15_000 });
    const streamingToggle = page.locator("#streamingToggle");
    const pressed = await streamingToggle.getAttribute("aria-pressed");
    if (pressed !== "false") {
      await streamingToggle.click();
    }
    await page.locator("#saveSettingsButton").click();

    const assistant = await sendAndWaitForAssistant(page, "Reply with exactly one short Swedish greeting.");
    await expect(assistant).not.toHaveText("", { timeout: 60_000 });
    const transcriptHtml = await page.locator("#messages").innerHTML();
    expect(transcriptHtml).toContain("message--assistant");
    expect(transcriptHtml).toContain("message--user");
    await expect(page.locator("#debugLog")).toContainText(`${OPENAI_URL}/chat/completions`);
  });
});
