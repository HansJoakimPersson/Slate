const { test, expect } = require("@playwright/test");

function ndjsonLines(objects, trailingNewline = true) {
  const body = objects.map((entry) => JSON.stringify(entry)).join("\n");
  return trailingNewline ? body + "\n" : body;
}

async function mockDefaultOllamaModels(page, models, status = 200) {
  await page.route("http://127.0.0.1:12434/api/tags", async (route) => {
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify({
        models: models.map((name) => ({ name })),
      }),
    });
  });
}

async function mockOpenAiModels(page, models, status = 200) {
  await page.route("http://127.0.0.1:12434/engines/v1/models", async (route) => {
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify({
        data: models.map((id) => ({ id })),
      }),
    });
  });
}

async function openSettings(page) {
  await page.locator("#settingsButton").click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
}

async function switchToOllama(page) {
  await openSettings(page);
  await page.locator("#providerInput").selectOption("ollama");
  await page.locator("#saveSettingsButton").click();
}

test("cancel in settings does not persist draft changes", async ({ page }) => {
  const ollamaModel = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  const openAiModel = "gpt-4o-mini";
  await mockDefaultOllamaModels(page, [ollamaModel]);
  await mockOpenAiModels(page, [openAiModel]);

  await page.goto("/");
  await openSettings(page);
  await page.locator("#providerInput").selectOption("openai");
  await page.locator("#apiBaseUrlInput").fill("http://example.invalid/v1");
  await page.locator("#cancelSettingsButton").click();

  await openSettings(page);
  await expect(page.locator("#providerInput")).toHaveValue("openai");
  await expect(page.locator("#apiBaseUrlInput")).toHaveValue("http://127.0.0.1:12434/engines/v1");
});

test("new chat clears transcript and returns to empty state", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockDefaultOllamaModels(page, [modelName]);
  await page.route("http://127.0.0.1:12434/api/chat", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: { content: "Hej fran test." },
      }),
    });
  });

  await page.goto("/");
  await switchToOllama(page);
  await page.locator("#composerEmpty").fill("hej");
  await page.locator("#sendButtonEmpty").click();
  await expect(page.locator(".message--assistant .message__content")).toContainText("Hej fran test.");

  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.locator("#emptyState")).toBeVisible();
  await expect(page.locator(".message--assistant")).toHaveCount(0);
});

test("enter sends while shift+enter inserts newline", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockDefaultOllamaModels(page, [modelName]);
  let requestCount = 0;

  await page.route("http://127.0.0.1:12434/api/chat", async (route) => {
    requestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: { content: "Okej." },
      }),
    });
  });

  await page.goto("/");
  await switchToOllama(page);
  const composer = page.locator("#composerEmpty");
  await composer.fill("rad 1");
  await composer.press("Shift+Enter");
  await composer.type("rad 2");
  await expect(composer).toHaveValue("rad 1\nrad 2");
  await expect.poll(() => requestCount).toBe(0);

  await composer.press("Enter");
  await expect.poll(() => requestCount).toBe(1);
});

test("OpenAI-compatible SSE responses are rendered", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockDefaultOllamaModels(page, [modelName]);
  await mockOpenAiModels(page, [modelName]);

  await page.route("http://127.0.0.1:12434/engines/v1/chat/completions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        'data: {"choices":[{"delta":{"content":"Hej"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" fran SSE"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""),
    });
  });

  await page.goto("/");
  await openSettings(page);
  await page.locator("#providerInput").selectOption("openai");
  await page.locator("#saveSettingsButton").click();
  await page.locator("#composerEmpty").fill("hej");
  await page.locator("#sendButtonEmpty").click();

  await expect(page.locator(".message--assistant .message__content")).toContainText("Hej fran SSE");
});

test("Ollama final buffered chunk without trailing newline is rendered", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockDefaultOllamaModels(page, [modelName]);

  await page.route("http://127.0.0.1:12434/api/chat", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: ndjsonLines([
        { message: { content: "Hej" }, done: false },
        { message: { content: " utan newline" }, done: false },
        { done: true },
      ], false),
    });
  });

  await page.goto("/");
  await switchToOllama(page);
  await page.locator("#composerEmpty").fill("hej");
  await page.locator("#sendButtonEmpty").click();
  await expect(page.locator(".message--assistant .message__content")).toContainText("Hej utan newline");
});

test("empty Ollama stream retries as non-stream and renders the fallback reply", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockDefaultOllamaModels(page, [modelName]);

  const seenBodies = [];
  await page.route("http://127.0.0.1:12434/api/chat", async (route) => {
    const body = route.request().postDataJSON();
    seenBodies.push(body);

    if (body.stream === true) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "",
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: { content: "Fallback-svaret renderades." },
      }),
    });
  });

  await page.goto("/");
  await switchToOllama(page);
  await expect(page.locator("#debugPanel")).toBeVisible();

  await page.locator("#composerEmpty").fill("hej");
  await page.locator("#sendButtonEmpty").click();

  await expect(page.locator(".message--assistant .message__content")).toContainText("Fallback-svaret renderades.");
  await expect.poll(() => seenBodies.length).toBe(2);
  expect(seenBodies[0].stream).toBe(true);
  expect(seenBodies[1].stream).toBe(false);
  await expect(page.locator("#debugLog")).toContainText("Chat Fallback");
});

test("provider 500 during model check opens fatal error modal", async ({ page }) => {
  const openAiModel = "gpt-4o-mini";
  await mockOpenAiModels(page, [openAiModel]);
  await page.route("http://127.0.0.1:12434/api/tags", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "text/plain",
      body: "provider exploded",
    });
  });

  await page.goto("/");
  await openSettings(page);
  await page.locator("#providerInput").selectOption("ollama");
  await page.locator("#testProviderButton").click();

  await expect(page.getByRole("alertdialog", { name: "Backend error" })).toBeVisible();
  await expect(page.locator("#fatalErrorText")).toContainText("provider exploded");
});

test("empty provider model list shows status error and keeps placeholder", async ({ page }) => {
  const openAiModel = "gpt-4o-mini";
  await mockOpenAiModels(page, [openAiModel]);
  await mockDefaultOllamaModels(page, []);
  await page.goto("/");
  await openSettings(page);
  await page.locator("#providerInput").selectOption("ollama");

  await expect(page.locator("#modelStatus")).toContainText("Model list could not be loaded");
  await expect(page.locator("#modelSelect")).toHaveValue("");
  await expect(page.locator("#topModelSelect")).toHaveValue("");
});

test("OpenAI-compatible requests omit Authorization without key and include it with key", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockDefaultOllamaModels(page, [modelName]);
  await mockOpenAiModels(page, [modelName]);

  const seenHeaders = [];
  await page.route("http://127.0.0.1:12434/engines/v1/chat/completions", async (route) => {
    seenHeaders.push(route.request().headers());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Hej." } }],
      }),
    });
  });

  await page.goto("/");
  await openSettings(page);
  await page.locator("#providerInput").selectOption("openai");
  await page.locator("#saveSettingsButton").click();

  await page.locator("#composerEmpty").fill("hej");
  await page.locator("#sendButtonEmpty").click();
  await expect.poll(() => seenHeaders.length).toBe(1);
  expect(seenHeaders[0].authorization).toBeUndefined();

  await openSettings(page);
  await page.locator("#apiKeyInput").fill("sk-test");
  await page.locator("#saveSettingsButton").click();
  await page.locator("#composer").fill("hej igen");
  await page.locator("#sendButton").click();
  await expect.poll(() => seenHeaders.length).toBe(2);
  expect(seenHeaders[1].authorization).toBe("Bearer sk-test");
});

test("OpenAI-compatible request includes stop sequences", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockDefaultOllamaModels(page, [modelName]);
  await mockOpenAiModels(page, [modelName]);

  let requestBody = null;
  await page.route("http://127.0.0.1:12434/engines/v1/chat/completions", async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Hej." } }],
      }),
    });
  });

  await page.goto("/");
  await openSettings(page);
  await page.locator("#providerInput").selectOption("openai");
  await page.locator("#saveSettingsButton").click();
  await page.locator("#composerEmpty").fill("hej");
  await page.locator("#sendButtonEmpty").click();

  await expect.poll(() => requestBody && requestBody.stop && requestBody.stop.length).toBe(4);
  expect(requestBody.stop).toEqual(["\nUser:", "\nAssistant:", "User:", "Human:"]);
});

test("malformed successful response body surfaces a UI error instead of crashing silently", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockDefaultOllamaModels(page, [modelName]);

  await page.route("http://127.0.0.1:12434/api/chat", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/plain",
      body: "not-json-at-all",
    });
  });

  await page.goto("/");
  await switchToOllama(page);
  await expect(page.locator("#debugPanel")).toBeVisible();

  await page.locator("#composerEmpty").fill("hej");
  await page.locator("#sendButtonEmpty").click();

  await expect(page.locator("#topbarError")).toContainText("could not be parsed");
  await expect(page.locator("#debugLog")).toContainText("Chat Failure");
});

test("debug sidebar toggle persists after saving and hides when turned off", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockDefaultOllamaModels(page, [modelName]);

  await page.goto("/");
  await expect(page.locator("#debugPanel")).toBeVisible();
  await openSettings(page);
  await page.locator("#debugToggle").click();
  await page.locator("#saveSettingsButton").click();
  await expect(page.locator("#debugPanel")).not.toBeVisible();

  await openSettings(page);
  await page.locator("#debugToggle").click();
  await page.locator("#saveSettingsButton").click();
  await expect(page.locator("#debugPanel")).toBeVisible();
});
