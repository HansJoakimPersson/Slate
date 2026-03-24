const { test, expect } = require("@playwright/test");

function ndjsonLines(objects) {
  return objects.map((entry) => JSON.stringify(entry)).join("\n");
}

async function mockDefaultOllamaModels(page, models) {
  await page.route("http://127.0.0.1:12434/api/tags", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        models: models.map((name) => ({ name })),
      }),
    });
  });
}

async function mockOpenAiModels(page, models) {
  await page.route("http://127.0.0.1:12434/engines/v1/models", async (route) => {
    await route.fulfill({
      status: 200,
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

test("loads default provider models on startup and populates model dropdowns", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockOpenAiModels(page, [modelName]);

  await page.goto("/");

  const topModel = page.locator("#topModelSelect");
  const emptyModel = page.locator("#emptyModelSelect");

  await expect(topModel).toHaveValue(modelName);
  await expect(emptyModel).toHaveValue(modelName);
  await expect(topModel.locator("option")).toHaveText(["gpt-oss-20b-mxfp4-q8:latest"]);

  await openSettings(page);
  await expect(page.locator("#modelSelect")).toHaveValue(modelName);
});

test("shows reasonable default generation settings and uses them for the default provider", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockDefaultOllamaModels(page, [modelName]);
  await mockOpenAiModels(page, [modelName]);

  let seenRequestBody = null;
  await page.route("http://127.0.0.1:12434/engines/v1/chat/completions", async (route) => {
    seenRequestBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Hej." } }],
        usage: { prompt_tokens: 24, completion_tokens: 1, total_tokens: 25 },
      }),
    });
  });

  await page.goto("/");
  await openSettings(page);
  await expect(page.locator("#providerInput")).toHaveValue("openai");
  await expect(page.locator("#maxTokensInput")).toHaveValue("300");
  await expect(page.locator("#temperatureInput")).toHaveValue("0.4");
  await expect(page.locator("#topPInput")).toHaveValue("1");
  await page.locator("#saveSettingsButton").click();

  await page.locator("#composerEmpty").fill("hej");
  await page.locator("#sendButtonEmpty").click();

  await expect.poll(() => seenRequestBody).not.toBeNull();
  expect(seenRequestBody.max_tokens).toBe(300);
  expect(seenRequestBody.temperature).toBe(0.4);
  expect(seenRequestBody.top_p).toBe(1);
  expect(seenRequestBody.stop).toEqual(["\nUser:", "\nAssistant:", "User:", "Human:"]);
  expect(seenRequestBody.messages[0]).toEqual({
    role: "system",
    content: "You are a helpful assistant. Answer concisely and stop after your answer.",
  });
});

test("preserves provider-specific API URLs when switching providers in settings", async ({ page }) => {
  const ollamaModel = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  const openAiModel = "gpt-4o-mini";

  await mockDefaultOllamaModels(page, [ollamaModel]);
  await mockOpenAiModels(page, [openAiModel]);

  await page.goto("/");
  await openSettings(page);

  await page.locator("#apiBaseUrlInput").fill("http://127.0.0.1:12434/engines/v1/");
  await page.locator("#providerInput").selectOption("ollama");
  await expect(page.locator("#apiBaseUrlInput")).toHaveValue("http://127.0.0.1:12434/");

  await page.locator("#apiBaseUrlInput").fill("http://127.0.0.1:12434/");

  await page.locator("#providerInput").selectOption("openai");
  await expect(page.locator("#apiBaseUrlInput")).toHaveValue("http://127.0.0.1:12434/engines/v1/");
});

test("renders assistant response for OpenAI-compatible JSON completion even with stream enabled", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockDefaultOllamaModels(page, [modelName]);
  await mockOpenAiModels(page, [modelName]);

  await page.route("http://127.0.0.1:12434/engines/v1/chat/completions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1774272683,
        model: modelName,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hej! Hur kan jag hjalpa dig idag?",
            },
            finish_reason: "stop",
          },
        ],
      }),
    });
  });

  await page.goto("/");
  await openSettings(page);
  await page.locator("#providerInput").selectOption("openai");
  await page.locator("#saveSettingsButton").click();

  await page.locator("#composerEmpty").fill("hej");
  await page.locator("#sendButtonEmpty").click();

  await expect(page.locator(".message--assistant .message__content")).toContainText("Hej! Hur kan jag hjalpa dig idag?");
  await expect(page.locator("#messages")).toContainText("hej");
  await expect(page.locator("#messages")).toContainText("Hej! Hur kan jag hjalpa dig idag?");
});

test("enforces DMR OpenAI request guardrails and rejects suspicious prompt token counts", async ({ page }) => {
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
        usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
      }),
    });
  });

  await page.goto("/");
  await openSettings(page);
  await page.locator("#providerInput").selectOption("openai");
  await page.locator("#systemPromptInput").fill("");
  await page.locator("#maxTokensInput").fill("50");
  await page.locator("#temperatureInput").fill("");
  await page.locator("#stopSequencesInput").fill("");
  await page.locator("#saveSettingsButton").click();

  await page.locator("#composerEmpty").fill("hej");
  await page.locator("#sendButtonEmpty").click();

  await expect.poll(() => requestBody).not.toBeNull();
  expect(requestBody.messages[0]).toEqual({
    role: "system",
    content: "You are a helpful assistant. Answer concisely and stop after your answer.",
  });
  expect(requestBody.max_tokens).toBe(300);
  expect(requestBody.temperature).toBe(0.4);
  expect(requestBody.stop).toEqual(["\nUser:", "\nAssistant:", "User:", "Human:"]);
  await expect(page.locator("#topbarError")).toContainText("system prompt was not applied correctly");
});

test("cleans obvious scratchpad and repeated restarts from assistant output", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockDefaultOllamaModels(page, [modelName]);
  await mockOpenAiModels(page, [modelName]);

  await page.route("http://127.0.0.1:12434/engines/v1/chat/completions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: [
                "Certainly! It seems like you want to provide a concise and clear response regarding the individual's questions about the email. I'll keep the response short and to the point.",
                "Sure, here's a professional email you can use to address your team:",
                "**Subject:** Weekly Team Update",
                "Dear Team,\n\nHere is the update for this week.",
                "Sure, here's a professional email you can use to address your team:",
                "**Subject:** Weekly Team Update",
              ].join("\n\n"),
            },
            finish_reason: "stop",
          },
        ],
      }),
    });
  });

  await page.goto("/");
  await openSettings(page);
  await page.locator("#providerInput").selectOption("openai");
  await page.locator("#saveSettingsButton").click();
  await expect(page.locator("#debugPanel")).toBeVisible();

  await page.locator("#composerEmpty").fill("Help me write a professional email to my team");
  await page.locator("#sendButtonEmpty").click();

  const assistant = page.locator(".message--assistant .message__content");
  await expect(assistant).toContainText("Sure, here's a professional email you can use to address your team:");
  await expect(assistant).toContainText("Weekly Team Update");
  await expect(assistant).not.toContainText("It seems like you want to provide a concise and clear response");
  await expect(assistant).toHaveText(/Sure, here's a professional email you can use to address your team:/);
  await expect(page.locator("#debugLog")).toContainText("Chat Cleanup");
});

test("renders assistant response for Anthropic-compatible JSON completion", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockDefaultOllamaModels(page, [modelName]);
  await mockOpenAiModels(page, [modelName]);

  await page.route("http://127.0.0.1:12434/v1/messages", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hej fran Anthropic-formatet.",
          },
        ],
      }),
    });
  });

  await page.goto("/");
  await openSettings(page);
  await page.locator("#providerInput").selectOption("anthropic");
  await expect(page.locator("#apiBaseUrlInput")).toHaveValue("http://127.0.0.1:12434");
  await page.locator("#saveSettingsButton").click();

  await page.locator("#composerEmpty").fill("hej");
  await page.locator("#sendButtonEmpty").click();

  await expect(page.locator(".message--assistant .message__content")).toContainText("Hej fran Anthropic-formatet.");
  await expect(page.locator("#messages")).toContainText("hej");
  await expect(page.locator("#messages")).toContainText("Hej fran Anthropic-formatet.");
});

test("falls back to the legacy Anthropic endpoint when /v1/messages returns 404", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockDefaultOllamaModels(page, [modelName]);
  await mockOpenAiModels(page, [modelName]);

  let primarySeen = 0;
  let fallbackSeen = 0;

  await page.route("http://127.0.0.1:12434/v1/messages", async (route) => {
    primarySeen += 1;
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Not Found" }),
    });
  });

  await page.route("http://127.0.0.1:12434/anthropic/v1/messages", async (route) => {
    fallbackSeen += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "msg_test_legacy",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hej fran fallback-endpointen.",
          },
        ],
      }),
    });
  });

  await page.goto("/");
  await openSettings(page);
  await page.locator("#providerInput").selectOption("anthropic");
  await page.locator("#saveSettingsButton").click();

  await page.locator("#composerEmpty").fill("hej");
  await page.locator("#sendButtonEmpty").click();

  await expect(page.locator(".message--assistant .message__content")).toContainText("Hej fran fallback-endpointen.");
  expect(primarySeen).toBe(1);
  expect(fallbackSeen).toBe(1);
});

test("renders assistant response for Ollama NDJSON stream", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockDefaultOllamaModels(page, [modelName]);

  await page.route("http://127.0.0.1:12434/api/chat", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: ndjsonLines([
        { message: { content: "Hej!" }, done: false },
        { message: { content: " Hur kan jag hjalpa dig?" }, done: false },
        { done: true },
      ]),
    });
  });

  await page.goto("/");
  await switchToOllama(page);
  await page.locator("#composerEmpty").fill("hej");
  await page.locator("#sendButtonEmpty").click();

  await expect(page.locator(".message--assistant .message__content")).toContainText("Hej! Hur kan jag hjalpa dig?");
  await expect(page.locator("#messages")).toContainText("hej");
  await expect(page.locator("#messages")).toContainText("Hej! Hur kan jag hjalpa dig?");
});

test("assistant output is written into transcript HTML, not just state", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockDefaultOllamaModels(page, [modelName]);

  await page.route("http://127.0.0.1:12434/api/chat", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: {
          content: "Detta ar svaret som ska synas i HTML.",
        },
      }),
    });
  });

  await page.goto("/");
  await switchToOllama(page);
  await page.locator("#composerEmpty").fill("Visa HTML");
  await page.locator("#sendButtonEmpty").click();
  await expect(page.locator(".message--assistant .message__content")).toContainText("Detta ar svaret som ska synas i HTML.");

  const transcriptHtml = await page.locator("#messages").innerHTML();
  expect(transcriptHtml).toContain("message--assistant");
  expect(transcriptHtml).toContain("Detta ar svaret som ska synas i HTML.");
  expect(transcriptHtml).toContain("Visa HTML");
});

test("debug sidebar logs chat request and response", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockDefaultOllamaModels(page, [modelName]);

  await page.route("http://127.0.0.1:12434/api/chat", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: ndjsonLines([
        { message: { content: "Hej!" }, done: false },
        { done: true },
      ]),
    });
  });

  await page.goto("/");
  await switchToOllama(page);
  await expect(page.locator("#debugPanel")).toBeVisible();

  await page.locator("#composerEmpty").fill("hej");
  await page.locator("#sendButtonEmpty").click();

  await expect(page.locator("#debugLog")).toContainText("Chat Request");
  await expect(page.locator("#debugLog")).toContainText("http://127.0.0.1:12434/api/chat");
});

test("shows fatal error modal for severe backend failures", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockDefaultOllamaModels(page, [modelName]);

  await page.route("http://127.0.0.1:12434/api/chat", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "text/plain",
      body: "unable to load runner: runner terminated unexpectedly",
    });
  });

  await page.goto("/");
  await switchToOllama(page);
  await page.locator("#composerEmpty").fill("hej");
  await page.locator("#sendButtonEmpty").click();

  await expect(page.getByRole("alertdialog", { name: "Backend error" })).toBeVisible();
  await expect(page.locator("#fatalErrorText")).toContainText("unable to load runner");
});

test("model selection on the first page changes the active model used in requests", async ({ page }) => {
  const firstModel = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  const secondModel = "huggingface.co/ai-sweden-models/gpt-sw3-20b-instruct-4bit-gptq:latest";
  await mockDefaultOllamaModels(page, [firstModel, secondModel]);

  let seenRequestBody = null;
  await page.route("http://127.0.0.1:12434/api/chat", async (route) => {
    seenRequestBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: ndjsonLines([
        { message: { content: "Hej!" }, done: false },
        { done: true },
      ]),
    });
  });

  await page.goto("/");
  await switchToOllama(page);
  await page.locator("#emptyModelSelect").selectOption(secondModel);
  await page.locator("#composerEmpty").fill("hej");
  await page.locator("#sendButtonEmpty").click();

  await expect.poll(() => seenRequestBody && seenRequestBody.model).toBe(secondModel);
  await expect(page.locator("#topModelSelect")).toHaveValue(secondModel);
});

test("parses non-stream JSON text response in ollama mode without crashing", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockDefaultOllamaModels(page, [modelName]);

  await page.route("http://127.0.0.1:12434/api/chat", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: {
          content: "Hej fran fallback-json.",
        },
      }),
    });
  });

  await page.goto("/");
  await switchToOllama(page);
  await expect(page.locator("#debugPanel")).toBeVisible();

  await page.locator("#composerEmpty").fill("hej");
  await page.locator("#sendButtonEmpty").click();

  await expect(page.locator(".message--assistant .message__content")).toContainText("Hej fran fallback-json.");
  await expect(page.locator("#debugLog")).toContainText("Chat Raw Response");
});

test("sends provider-specific advanced parameters in the request body", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockDefaultOllamaModels(page, [modelName]);
  await mockOpenAiModels(page, [modelName]);

  const requests = {
    openai: null,
    anthropic: null,
    ollama: null,
  };

  await page.route("http://127.0.0.1:12434/engines/v1/chat/completions", async (route) => {
    requests.openai = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [{ message: { role: "assistant", content: "OpenAI reply." } }],
      }),
    });
  });

  await page.route("http://127.0.0.1:12434/v1/messages", async (route) => {
    requests.anthropic = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "Anthropic reply." }],
      }),
    });
  });

  await page.route("http://127.0.0.1:12434/api/chat", async (route) => {
    requests.ollama = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: { content: "Ollama reply." },
      }),
    });
  });

  await page.goto("/");

  await openSettings(page);
  await page.locator("#providerInput").selectOption("openai");
  await page.locator("#maxTokensInput").fill("512");
  await page.locator("#temperatureInput").fill("0.7");
  await page.locator("#topPInput").fill("0.8");
  await page.locator("#presencePenaltyInput").fill("0.3");
  await page.locator("#frequencyPenaltyInput").fill("0.4");
  await page.locator("#stopSequencesInput").fill("STOP\nDONE");
  await page.locator("#systemPromptInput").fill("You are concise.");
  await page.locator("#saveSettingsButton").click();
  await page.locator("#composerEmpty").fill("hello");
  await page.locator("#sendButtonEmpty").click();
  await expect.poll(() => requests.openai).not.toBeNull();
  expect(requests.openai.max_tokens).toBe(500);
  expect(requests.openai.temperature).toBe(0.7);
  expect(requests.openai.top_p).toBe(0.8);
  expect(requests.openai.presence_penalty).toBe(0.3);
  expect(requests.openai.frequency_penalty).toBe(0.4);
  expect(requests.openai.stop).toEqual(["\nUser:", "\nAssistant:", "User:", "Human:", "STOP", "DONE"]);
  expect(requests.openai.messages[0]).toEqual({ role: "system", content: "You are concise." });

  await openSettings(page);
  await page.locator("#providerInput").selectOption("anthropic");
  await page.locator("#maxTokensInput").fill("256");
  await page.locator("#temperatureInput").fill("0.6");
  await page.locator("#topPInput").fill("0.9");
  await page.locator("#topKInput").fill("24");
  await page.locator("#stopSequencesInput").fill("Human:");
  await page.locator("#saveSettingsButton").click();
  await page.locator("#composer").fill("hello again");
  await page.locator("#sendButton").click();
  await expect.poll(() => requests.anthropic).not.toBeNull();
  expect(requests.anthropic.max_tokens).toBe(256);
  expect(requests.anthropic.temperature).toBe(0.6);
  expect(requests.anthropic.top_p).toBe(0.9);
  expect(requests.anthropic.top_k).toBe(24);
  expect(requests.anthropic.stop_sequences).toEqual(["Human:"]);
  expect(requests.anthropic.system).toBe("You are concise.");
  expect(requests.anthropic.messages[0]).toEqual({ role: "user", content: "hello" });

  await openSettings(page);
  await page.locator("#providerInput").selectOption("ollama");
  await page.locator("#maxTokensInput").fill("128");
  await page.locator("#temperatureInput").fill("0.2");
  await page.locator("#topPInput").fill("0.75");
  await page.locator("#topKInput").fill("16");
  await page.locator("#saveSettingsButton").click();
  await page.locator("#composer").fill("third");
  await page.locator("#sendButton").click();
  await expect.poll(() => requests.ollama).not.toBeNull();
  expect(requests.ollama.options.num_predict).toBe(128);
  expect(requests.ollama.options.temperature).toBe(0.2);
  expect(requests.ollama.options.top_p).toBe(0.75);
  expect(requests.ollama.options.top_k).toBe(16);
});

test("debug sidebar can be cleared after logging entries", async ({ page }) => {
  const modelName = "huggingface.co/mlx-community/gpt-oss-20b-mxfp4-q8:latest";
  await mockDefaultOllamaModels(page, [modelName]);

  await page.route("http://127.0.0.1:12434/api/chat", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/x-ndjson",
      body: ndjsonLines([
        { message: { content: "Hej!" }, done: false },
        { done: true },
      ]),
    });
  });

  await page.goto("/");
  await expect(page.locator("#debugPanel")).toBeVisible();

  await page.locator("#composerEmpty").fill("hej");
  await page.locator("#sendButtonEmpty").click();
  await expect(page.locator("#debugLog")).toContainText("Chat Request");

  await page.locator("#clearDebugButton").click();
  await expect(page.locator("#debugLog")).toContainText("No logs yet");
});
