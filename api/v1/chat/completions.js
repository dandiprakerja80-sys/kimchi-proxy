const { URL } = require("url");
const { parseKeys, selectKey, throttleKey, isKeyThrottled } = require("../../lib/key-rotation.js");
const { proxyToKimchi, proxyToKimchiStreaming, writeResponse } = require("../../lib/proxy.js");
const { logRequest, getStats, addLog } = require("../../lib/stats.js");
const { validateProxyApiKey } = require("../../lib/auth.js");
const { isCfEnabled, isSupportedModel, proxyToCloudflare, proxyToCloudflareStreaming } = require("../../lib/cloudflare.js");

const KIMCHI_UPSTREAM = "https://llm.kimchi.dev/openai/v1/chat/completions";
const AUTO_CONTINUE_MAX = 5;
const AUTO_CONTINUE_TIMEOUT_MS = 120000;
const DEFAULT_MAX_TOKENS = 16384;
const CF_MAX_TOKENS = 16384;
const CF_STOP_CONTINUE_MAX = 2;

const SKIP_HEADERS = new Set(["transfer-encoding", "connection", "content-length"]);

function extractOutputText(sseEvents) {
  let text = "";
  for (const line of sseEvents) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6);
    if (data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content) {
        text += parsed.choices[0].delta.content;
      }
    } catch {}
  }
  return text;
}

function extractOutputReasoning(sseEvents) {
  let text = "";
  for (const line of sseEvents) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6);
    if (data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.reasoning_content) {
        text += parsed.choices[0].delta.reasoning_content;
      }
    } catch {}
  }
  return text;
}

function isStreamComplete(allLines) {
  for (let i = allLines.length - 1; i >= 0; i--) {
    const line = allLines[i];
    if (line === "data: [DONE]") return true;
    if (line.startsWith("data: ")) {
      try {
        const parsed = JSON.parse(line.slice(6));
        if (parsed.choices && parsed.choices[0] && parsed.choices[0].finish_reason) return true;
      } catch {}
      return false;
    }
  }
  return false;
}

function buildContinueBody(originalBody, partialOutput) {
  const messages = [...(originalBody.messages || [])];
  if (partialOutput) {
    messages.push({ role: "assistant", content: partialOutput });
  }
  return { ...originalBody, messages };
}

function extractMessageContent(parsed) {
  try {
    return parsed.choices[0].message.content || "";
  } catch {
    return "";
  }
}

function extractMessageReasoning(parsed) {
  try {
    return parsed.choices[0].message.reasoning_content || "";
  } catch {
    return "";
  }
}

function extractFinishReason(parsed) {
  try {
    return parsed.choices[0].finish_reason ?? null;
  } catch {
    return null;
  }
}

function extractRequestToolInfo(body) {
  const tools = body?.tools;
  const hasTools = Array.isArray(tools) && tools.length > 0;
  const toolNames = hasTools
    ? tools.map((t) => t?.function?.name || t?.name || "unknown").join(",")
    : "";
  const toolChoice = body?.tool_choice;
  const hasToolChoice = toolChoice !== undefined && toolChoice !== null;
  const toolChoiceType = typeof toolChoice === "string"
    ? toolChoice
    : toolChoice?.type || "none";
  return {
    hasTools,
    toolCount: hasTools ? tools.length : 0,
    toolNames,
    hasToolChoice,
    toolChoiceType,
  };
}

function extractResponseToolInfo(parsed) {
  const toolCalls = parsed?.choices?.[0]?.message?.tool_calls;
  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
  const toolCallNames = hasToolCalls
    ? toolCalls.map((tc) => tc?.function?.name || "unknown").join(",")
    : "";
  return {
    hasToolCalls,
    toolCallCount: hasToolCalls ? toolCalls.length : 0,
    toolCallNames,
  };
}

function mergeResponses(base, continuation) {
  try {
    const baseContent = extractMessageContent(base);
    const contContent = extractMessageContent(continuation);
    base.choices[0].message.content = baseContent + contContent;

    const baseReasoning = extractMessageReasoning(base);
    const contReasoning = extractMessageReasoning(continuation);
    if (baseReasoning || contReasoning) {
      base.choices[0].message.reasoning_content = baseReasoning + contReasoning;
    }

    if (continuation.choices && continuation.choices[0]) {
      base.choices[0].finish_reason = continuation.choices[0].finish_reason;
      if (continuation.choices[0].index !== undefined) {
        base.choices[0].index = continuation.choices[0].index;
      }
    }

    if (base.usage && continuation.usage) {
      base.usage.completion_tokens = (base.usage.completion_tokens || 0) + (continuation.usage.completion_tokens || 0);
      base.usage.prompt_tokens = (base.usage.prompt_tokens || 0) + (continuation.usage.prompt_tokens || 0);
      base.usage.total_tokens = (base.usage.total_tokens || 0) + (continuation.usage.total_tokens || 0);
    }
  } catch (err) {
    console.error("[mergeResponses] error:", err.message);
  }
  return base;
}

function shouldUseCloudflare(model) {
  return isCfEnabled() && isSupportedModel(model);
}

function applyCfMaxTokens(body) {
  const cloned = { ...body };
  cloned.max_tokens = CF_MAX_TOKENS;
  return cloned;
}

async function tryCloudflareThenKimchi({ body, getNextKey, requestHeaders, signal, maxRetries }) {
  if (shouldUseCloudflare(body.model)) {
    try {
      const result = await proxyToCloudflare({
        requestBody: applyCfMaxTokens(body),
        requestHeaders,
        signal,
      });
      if (result.status >= 200 && result.status < 300) {
        return { ...result, provider: "cf" };
      }
      const msg = `[cf] non-success status ${result.status}, falling back to kimchi`;
      console.log(msg);
      await addLog({ level: "error", message: `${body.model} (cf) fallback: ${msg}`, timestamp: Date.now() });
    } catch (err) {
      const msg = `[cf] error, falling back to kimchi: ${err.message}`;
      console.log(msg);
      await addLog({ level: "error", message: `${body.model} (cf) fallback: ${msg}`, timestamp: Date.now() });
    }
  }
  const result = await proxyToKimchi({
    upstreamUrl: KIMCHI_UPSTREAM,
    getNextKey,
    requestBody: body,
    requestHeaders,
    maxRetries,
    signal,
  });
  return { ...result, provider: "kimchi" };
}

async function tryCloudflareThenKimchiStreaming({ body, getNextKey, requestHeaders, signal }) {
  if (shouldUseCloudflare(body.model)) {
    try {
      const result = await proxyToCloudflareStreaming({
        requestBody: applyCfMaxTokens(body),
        requestHeaders,
        signal,
      });
      if (result.status >= 200 && result.status < 300) {
        return { ...result, provider: "cf" };
      }
      const msg = `[cf] non-success status ${result.status}, falling back to kimchi`;
      console.log(msg);
      await addLog({ level: "error", message: `${body.model} (cf) fallback: ${msg}`, timestamp: Date.now() });
    } catch (err) {
      const msg = `[cf] error, falling back to kimchi: ${err.message}`;
      console.log(msg);
      await addLog({ level: "error", message: `${body.model} (cf) fallback: ${msg}`, timestamp: Date.now() });
    }
  }
  const result = await proxyToKimchiStreaming({
    upstreamUrl: KIMCHI_UPSTREAM,
    getNextKey,
    requestBody: body,
    requestHeaders,
    signal,
  });
  return { ...result, provider: "kimchi" };
}

function streamWithAutoContinue(clientRes, initialResult, body, keys, getNextKey, startTime) {
  return new Promise((resolve, reject) => {
    const stream = initialResult.stream;
    let done = false;
    let buffer = "";
    const allLines = [];
    let lastDataTime = Date.now();
    let finishReason = initialResult.finishReason || null;
    let outputTokens = 0;
    let prematureStopAttempts = 0;
    let pendingContinue = false;

    const keepalive = setInterval(() => {
      if (!done && Date.now() - lastDataTime > 10000) {
        try { clientRes.write(": keepalive\n\n"); } catch {}
        lastDataTime = Date.now();
      }
    }, 5000);

    function parseChunk(data) {
      if (data === "[DONE]") return { done: true };
      try {
        return { parsed: JSON.parse(data) };
      } catch {
        return {};
      }
    }

    function extractStreamFinishReason(lines) {
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.choices?.[0]?.finish_reason) {
            return parsed.choices[0].finish_reason;
          }
        } catch {}
      }
      return null;
    }

    function isPrematureStop(lines) {
      const reason = extractStreamFinishReason(lines);
      if (reason === "tool_calls") return false; // valid tool call, not premature
      if (reason !== "stop") return false;
      const output = extractOutputText(lines);
      const reasoning = extractOutputReasoning(lines);
      // Premature if no content but reasoning exists, or content still short despite reasoning
      if (!output && reasoning.length > 0) return true;
      if (output.length < 500 && reasoning.length > 0) return true;
      return false;
    }

    function finish(finalReason) {
      clearInterval(keepalive);
      done = true;
      if (!clientRes.writableEnded) {
        try { clientRes.end(); } catch {}
      }
      resolve({
        finishReason: finalReason || finishReason || extractStreamFinishReason(allLines) || "unknown",
        outputTokens,
      });
    }

    function sendFinalStop(reason) {
      try {
        clientRes.write(`data: {"id":"id-${Date.now()}","object":"chat.completion.chunk","created":${Math.floor(Date.now()/1000)},"model":"${body.model}","choices":[{"index":0,"delta":{},"finish_reason":"${reason}"}]}\n\n`);
        clientRes.write("data: [DONE]\n\n");
      } catch {}
    }

    function handleCompleteLines(lines) {
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          const { done: isDone, parsed } = parseChunk(data);
          if (isDone) {
            if (pendingContinue) {
              // Don't forward [DONE] yet, continue will handle it
              return true;
            }
            finish("stop");
            return true;
          }
          if (parsed) {
            const choice = parsed.choices?.[0];
            const delta = choice?.delta || {};
            const content = delta.content || "";
            const reasoning = delta.reasoning_content || "";
            outputTokens += Math.ceil((content.length + reasoning.length) / 4);
            const fr = choice?.finish_reason;
            if (fr) {
              allLines.push(`data: ${data}`);
              const premature = isPrematureStop(allLines);
              const msg = `[cf-chunk] finish:${fr} content:${content.length} reasoning:${reasoning.length} totalOut:${outputTokens} premature:${premature}`;
              console.log(msg);
              addLog({ level: "info", message: msg, timestamp: Date.now() }).catch(() => {});
              if (premature) {
                pendingContinue = true;
                return true;
              }
            } else if (content.length > 0 || reasoning.length > 0) {
              allLines.push(`data: ${data}`);
              const msg = `[cf-chunk] content:${content.length} reasoning:${reasoning.length} totalOut:${outputTokens}`;
              console.log(msg);
              addLog({ level: "info", message: msg, timestamp: Date.now() }).catch(() => {});
            } else {
              allLines.push(`data: ${data}`);
            }
          }
          if (!pendingContinue) {
            try { clientRes.write(`data: ${data}\n\n`); } catch {}
          }
        }
      }
      return false;
    }

    function handleStreamEnd() {
      if (buffer.trim()) {
        const rawLine = buffer.trim();
        if (buffer.startsWith("data: ")) {
          const data = buffer.slice(6);
          const { done: isDone, parsed } = parseChunk(data);
          if (isDone) {
            if (pendingContinue) return true;
            finish("stop");
            return true;
          }
          if (parsed) {
            const choice = parsed.choices?.[0];
            const fr = choice?.finish_reason;
            if (fr) {
              allLines.push(rawLine);
              const premature = isPrematureStop(allLines);
              if (premature) {
                pendingContinue = true;
                return true;
              }
            } else {
              allLines.push(rawLine);
            }
          }
          if (!pendingContinue) {
            try { clientRes.write(`data: ${data}\n\n`); } catch {}
          }
        }
      }
      return false;
    }

    function tryAutoContinue() {
      const partialOutput = extractOutputText(allLines);
      const partialReasoning = extractOutputReasoning(allLines);
      console.log(`[auto-continue] stream incomplete/incomplete-stop, output:${partialOutput.length} reasoning:${partialReasoning.length}`);
      autoContinue(body, keys, getNextKey, clientRes, partialOutput, startTime, 1)
        .then((result) => {
          if (result && typeof result === "object") {
            finishReason = result.finishReason || finishReason;
            outputTokens += result.outputTokens || 0;
          } else {
            finishReason = result || finishReason;
          }
          const finalReason = finishReason || "stop";
          sendFinalStop(finalReason);
          finish(finalReason);
        })
        .catch(() => {
          sendFinalStop("stop");
          finish("stop");
        });
    }

    stream.on("data", (chunk) => {
      lastDataTime = Date.now();
      const text = chunk.toString("utf-8");
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      if (handleCompleteLines(lines)) return;
    });

    stream.on("end", () => {
      if (handleStreamEnd()) return;

      if (pendingContinue) {
        tryAutoContinue();
        return;
      }

      if (isStreamComplete(allLines)) {
        const output = extractOutputText(allLines);
        const reasoning = extractOutputReasoning(allLines);
        const premature = isPrematureStop(allLines);
        const finalReason = extractStreamFinishReason(allLines) || finishReason || "unknown";
        const finishMsg = `[cf-stream-finish] reason:${finalReason} content:${output.length} reasoning:${reasoning.length} outTokens:${outputTokens} premature:${premature}`;
        console.log(finishMsg);
        addLog({ level: "info", message: finishMsg, timestamp: Date.now() }).catch(() => {});
        if (premature && prematureStopAttempts < CF_STOP_CONTINUE_MAX) {
          prematureStopAttempts++;
          const continueMsg = `[cf-stop-continue] premature stop detected, attempt ${prematureStopAttempts}/${CF_STOP_CONTINUE_MAX}`;
          console.log(continueMsg);
          addLog({ level: "info", message: continueMsg, timestamp: Date.now() }).catch(() => {});
          tryAutoContinue();
          return;
        }
        finish();
        return;
      }

      tryAutoContinue();
    });

    stream.on("error", () => {
      clearInterval(keepalive);
      if (pendingContinue) {
        tryAutoContinue();
        return;
      }
      if (isStreamComplete(allLines)) {
        finish();
        return;
      }
      tryAutoContinue();
    });

    stream.on("close", () => {
      if (!done) {
        clearInterval(keepalive);
        if (pendingContinue) {
          tryAutoContinue();
          return;
        }
        if (isStreamComplete(allLines)) {
          const output = extractOutputText(allLines);
          const reasoning = extractOutputReasoning(allLines);
          const premature = isPrematureStop(allLines);
          const finalReason = extractStreamFinishReason(allLines) || finishReason || "unknown";
          const closeMsg = `[cf-stream-close] reason:${finalReason} content:${output.length} reasoning:${reasoning.length} outTokens:${outputTokens} premature:${premature}`;
          console.log(closeMsg);
          addLog({ level: "info", message: closeMsg, timestamp: Date.now() }).catch(() => {});
          if (premature && prematureStopAttempts < CF_STOP_CONTINUE_MAX) {
            prematureStopAttempts++;
            const continueMsg = `[cf-stop-continue] premature stop detected, attempt ${prematureStopAttempts}/${CF_STOP_CONTINUE_MAX}`;
            console.log(continueMsg);
            addLog({ level: "info", message: continueMsg, timestamp: Date.now() }).catch(() => {});
            tryAutoContinue();
            return;
          }
          finish();
          return;
        }
        tryAutoContinue();
      }
    });
  });
}

async function autoContinue(body, keys, getNextKey, clientRes, partialOutput, startTime, attempt) {
  if (attempt > AUTO_CONTINUE_MAX) {
    console.log(`[auto-continue] max attempts reached`);
    return { finishReason: "length", outputTokens: 0 };
  }
  if (Date.now() - startTime > AUTO_CONTINUE_TIMEOUT_MS) {
    console.log(`[auto-continue] timeout approaching, aborting`);
    return { finishReason: "timeout", outputTokens: 0 };
  }

  console.log(`[auto-continue] attempt ${attempt}, resuming from ${partialOutput.length} chars`);

  const continueBody = buildContinueBody(body, partialOutput);

  try {
    const result = await tryCloudflareThenKimchiStreaming({
      body: continueBody,
      getNextKey,
      requestHeaders: { "X-Request-Start": String(Date.now()) },
      signal: AbortSignal.timeout(AUTO_CONTINUE_TIMEOUT_MS),
    });

    if (result.status !== 200) {
      console.log(`[auto-continue] upstream returned ${result.status}`);
      return { finishReason: "error", outputTokens: 0 };
    }

    let buffer = "";
    const allLines = [];
    let lastDataTime = Date.now();
    let outputTokens = 0;

    const keepalive = setInterval(() => {
      if (Date.now() - lastDataTime > 10000) {
        try { clientRes.write(": keepalive\n\n"); } catch {}
        lastDataTime = Date.now();
      }
    }, 5000);

    function extractFinishReason(lines) {
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.choices?.[0]?.finish_reason) {
            return parsed.choices[0].finish_reason;
          }
        } catch {}
      }
      return null;
    }

    await new Promise((res, rej) => {
      let finished = false;
      const finish = () => { if (!finished) { finished = true; clearInterval(keepalive); res(); } };

      result.stream.on("data", (chunk) => {
        lastDataTime = Date.now();
        const text = chunk.toString("utf-8");
        buffer += text;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            allLines.push(`data: ${data}`);
            if (data === "[DONE]") { finish(); return; }
            try {
              const parsed = JSON.parse(data);
              const choice = parsed.choices?.[0];
              const delta = choice?.delta || {};
              const content = delta.content || "";
              const reasoning = delta.reasoning_content || "";
              outputTokens += Math.ceil((content.length + reasoning.length) / 4);
              const fr = choice?.finish_reason;
              if (fr) {
                console.log(`[cf-chunk-ac] finish:${fr} content:${content.length} reasoning:${reasoning.length} totalOut:${outputTokens}`);
              } else if (content.length > 0 || reasoning.length > 0) {
                console.log(`[cf-chunk-ac] content:${content.length} reasoning:${reasoning.length} totalOut:${outputTokens}`);
              }
            } catch {}
            try { clientRes.write(`data: ${data}\n\n`); } catch {}
          }
        }
      });

      result.stream.on("end", () => {
        if (buffer.trim()) {
          allLines.push(buffer.trim());
          if (buffer.startsWith("data: ")) {
            const data = buffer.slice(6);
            if (data !== "[DONE]") try { clientRes.write(`data: ${data}\n\n`); } catch {}
          }
        }
        finish();
      });

      result.stream.on("error", finish);
      result.stream.on("close", finish);
    });

    if (!isStreamComplete(allLines)) {
      const newPartial = extractOutputText(allLines);
      const continuation = await autoContinue(body, keys, getNextKey, clientRes, partialOutput + newPartial, startTime, attempt + 1);
      return { finishReason: continuation.finishReason, outputTokens: outputTokens + (continuation.outputTokens || 0) };
    }

    return { finishReason: extractFinishReason(allLines) || "stop", outputTokens };
  } catch (err) {
    console.error(`[auto-continue] error:`, err.message);
    return { finishReason: "error", outputTokens: 0 };
  }
}

async function completeNonStreaming({ body, getNextKey, startTime, keyTotal }) {
  const maxRetries = Math.min(keyTotal || 55, 55);
  const cfBody = { ...body, stream: false };
  const reqToolInfo = extractRequestToolInfo(body);
  const useCf = shouldUseCloudflare(body.model);

  console.log(`[provider-decision] model:${body.model} useCf:${useCf} cfEnabled:${isCfEnabled()} supported:${isSupportedModel(body.model)} hasTools:${reqToolInfo.hasTools} toolCount:${reqToolInfo.toolCount} toolChoice:${reqToolInfo.toolChoiceType}`);

  let result = await tryCloudflareThenKimchi({
    body: cfBody,
    getNextKey,
    requestHeaders: { "X-Request-Start": String(Date.now()) },
    maxRetries,
    signal: AbortSignal.timeout(AUTO_CONTINUE_TIMEOUT_MS),
  });

  console.log(`[upstream-result] provider:${result.provider || "unknown"} status:${result.status} cfIndex:${result.cfIndex ?? "-"} finishReason:${result.finishReason || "-"}`);

  let finalBody = null;
  let finishReason = result.finishReason || "unknown";
  let autoContinueAttempts = 0;
  let continued = false;
  let inputTokens = 0;
  let outputTokens = 0;

  if (result.status === 200) {
    try {
      finalBody = JSON.parse(result.body);
    } catch {
      finalBody = null;
    }

    if (finalBody) {
      const respToolInfo = extractResponseToolInfo(finalBody);
      console.log(`[cf-first-response] finish:${finalBody.choices?.[0]?.finish_reason} hasToolCalls:${respToolInfo.hasToolCalls} toolCallCount:${respToolInfo.toolCallCount}`);

      for (let attempt = 1; attempt <= AUTO_CONTINUE_MAX; attempt++) {
        const innerFinishReason = finalBody.choices?.[0]?.finish_reason;
        const content = extractMessageContent(finalBody);
        const reasoning = extractMessageReasoning(finalBody);

        const shouldContinue = innerFinishReason === "length" || (!content && reasoning) || (innerFinishReason === "stop" && content.length < 500 && reasoning.length > 0);
        const continueReason = innerFinishReason === "length" ? "length" : !content && reasoning ? "reasoning-only" : innerFinishReason === "stop" && content.length < 500 && reasoning.length > 0 ? "short-stop-with-reasoning" : "none";
        console.log(`[auto-continue-check] attempt:${attempt} finish:${innerFinishReason} content:${content.length} reasoning:${reasoning.length} shouldContinue:${shouldContinue} reason:${continueReason}`);

        if (!shouldContinue) {
          break;
        }
        if (Date.now() - startTime > AUTO_CONTINUE_TIMEOUT_MS) {
          console.log(`[auto-continue] non-streaming timeout approaching`);
          break;
        }

        continued = true;
        autoContinueAttempts++;
        console.log(`[auto-continue] non-streaming attempt ${attempt}, content: ${content.length} chars, reasoning: ${reasoning.length} chars`);

        const continueResult = await tryCloudflareThenKimchi({
          body: buildContinueBody(body, content),
          getNextKey,
          requestHeaders: { "X-Request-Start": String(Date.now()) },
          maxRetries,
          signal: AbortSignal.timeout(AUTO_CONTINUE_TIMEOUT_MS),
        });

        if (continueResult.status !== 200) {
          console.log(`[auto-continue] upstream returned ${continueResult.status}, stopping`);
          break;
        }

        let continueBodyParsed;
        try {
          continueBodyParsed = JSON.parse(continueResult.body);
        } catch {
          console.log(`[auto-continue] failed to parse continuation body, stopping`);
          break;
        }

        finalBody = mergeResponses(finalBody, continueBodyParsed);

        const nextFinishReason = finalBody.choices?.[0]?.finish_reason;
        const nextContent = extractMessageContent(finalBody);
        const nextReasoning = extractMessageReasoning(finalBody);
        const shouldContinueNext = nextFinishReason === "length" || (!nextContent && nextReasoning) || (nextFinishReason === "stop" && nextContent.length < 500 && nextReasoning.length > 0);
        const nextContinueReason = nextFinishReason === "length" ? "length" : !nextContent && nextReasoning ? "reasoning-only" : nextFinishReason === "stop" && nextContent.length < 500 && nextReasoning.length > 0 ? "short-stop-with-reasoning" : "none";
        console.log(`[auto-continue-check-next] finish:${nextFinishReason} content:${nextContent.length} reasoning:${nextReasoning.length} shouldContinue:${shouldContinueNext} reason:${nextContinueReason}`);
        if (!shouldContinueNext) {
          break;
        }
      }

      result.body = JSON.stringify(finalBody);
    }
  }

  try {
    const parsed = JSON.parse(result.body);
    if (parsed.usage) {
      inputTokens = parsed.usage.prompt_tokens || 0;
      outputTokens = parsed.usage.completion_tokens || 0;
    }
  } catch {}

  if (finalBody) {
    finishReason = extractFinishReason(finalBody) || finishReason;
    const content = extractMessageContent(finalBody);
    const reasoning = extractMessageReasoning(finalBody);
    const premature = finishReason === "stop" && content.length < 500 && reasoning.length > 0;
    const finalRespToolInfo = extractResponseToolInfo(finalBody);
    const finalMsg = `[cf-final] finish:${finishReason} content:${content.length} reasoning:${reasoning.length} outTokens:${outputTokens} continued:${autoContinueAttempts} premature:${premature} hasTools:${reqToolInfo.hasTools} toolCount:${reqToolInfo.toolCount} toolChoice:${reqToolInfo.toolChoiceType} hasToolCalls:${finalRespToolInfo.hasToolCalls} toolCallCount:${finalRespToolInfo.toolCallCount} toolCallNames:[${finalRespToolInfo.toolCallNames}]`;
    console.log(finalMsg);
    await addLog({ level: "info", message: finalMsg, timestamp: Date.now() }).catch(() => {});
  }

  return { result, finalBody, finishReason, inputTokens, outputTokens, continued, autoContinueAttempts };
}

function streamJsonAsSse(res, parsed, model) {
  return new Promise((resolve, reject) => {
    const choice = parsed.choices?.[0];
    if (!choice) {
      try { res.write("data: [DONE]\n\n"); res.end(); } catch {}
      resolve();
      return;
    }
    const id = parsed.id || `id-${Date.now()}`;
    const created = parsed.created || Math.floor(Date.now() / 1000);
    const message = choice.message || {};
    const reasoning = message.reasoning_content || "";
    const content = message.content || "";
    const toolCalls = message.tool_calls || null;
    const finishReason = choice.finish_reason || "stop";
    const base = { id, object: "chat.completion.chunk", created, model };

    let index = 0;
    function sendChunk(delta, finish = null) {
      const chunk = { ...base, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }] };
      try { res.write(`data: ${JSON.stringify(chunk)}\n\n`); } catch {}
    }

    // reasoning chunks
    for (let i = 0; i < reasoning.length; i += 10) {
      const piece = reasoning.slice(i, i + 10);
      sendChunk({ reasoning_content: piece });
      index++;
    }
    // content chunks
    for (let i = 0; i < content.length; i += 20) {
      const piece = content.slice(i, i + 20);
      sendChunk({ content: piece });
      index++;
    }

    if (toolCalls && toolCalls.length > 0) {
      sendChunk({ tool_calls: toolCalls });
    }

    sendChunk({}, finishReason);
    try { res.write("data: [DONE]\n\n"); res.end(); } catch {}
    resolve();
  });
}

module.exports = async function handler(req, res) {
  if (!validateProxyApiKey(req, res)) {
    return;
  }

  if (req.method === "GET" && req.url && req.url.includes("action=stats")) {
    const url = new URL(req.url, "http://localhost");
    const range = url.searchParams.get("range") || "today";
    const stats = await getStats(range);
    return res.status(200).json(stats);
  }

  const keysRaw = process.env.KIMCHI_API_KEYS;
  const keys = parseKeys(keysRaw);
  let startTime = 0;
  let lastKeyIndex = 0;
  let model = "unknown";

  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (keys.length === 0) {
      return res.status(500).json({ error: "No API keys configured. Set KIMCHI_API_KEYS env var." });
    }

    const keyIndexHeader = req.headers["x-kimchi-key-index"];
    let preferredIndex = undefined;
    if (keyIndexHeader && typeof keyIndexHeader === "string") {
      preferredIndex = parseInt(keyIndexHeader, 10);
    }

    let keySelection;
    try {
      keySelection = selectKey({ keys }, preferredIndex);
    } catch (e) {
      return res.status(500).json({ error: "Failed to select API key" });
    }

    let rotateIndex = keySelection.index;

    const getNextKey = () => {
      let skipAttempts = 0;
      while (isKeyThrottled(keys[rotateIndex]) && skipAttempts < keys.length) {
        rotateIndex = (rotateIndex + 1) % keys.length;
        skipAttempts++;
      }
      const key = keys[rotateIndex];
      const idx = rotateIndex;
      rotateIndex = (rotateIndex + 1) % keys.length;
      lastKeyIndex = idx;
      return { key, index: idx };
    };

    const body = req.body;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "Invalid request body" });
    }

    if (body.max_tokens === undefined || body.max_tokens === null) {
      body.max_tokens = DEFAULT_MAX_TOKENS;
    }

    model = body.model || "unknown";
    startTime = Date.now();
    const isStreaming = body.stream === true;
    const reqToolInfo = extractRequestToolInfo(body);
    console.log(`[incoming-request] model:${model} stream:${isStreaming} useCf:${shouldUseCloudflare(model)} hasTools:${reqToolInfo.hasTools} toolCount:${reqToolInfo.toolCount} toolNames:[${reqToolInfo.toolNames}] toolChoice:${reqToolInfo.toolChoiceType}`);

    if (isStreaming) {
      if (shouldUseCloudflare(body.model)) {
        const nonStreamBody = { ...body, stream: false };
        const completion = await completeNonStreaming({ body: nonStreamBody, getNextKey, startTime, keyTotal: keys.length });
        const elapsed = Date.now() - startTime;

        res.setHeader("X-Proxy-Key-Index", String(lastKeyIndex));
        res.setHeader("X-Proxy-Key-Total", String(keys.length));
        res.setHeader("X-Proxy-Attempts", String(completion.result.attempts));
        res.setHeader("X-Proxy-Provider", completion.result.provider || "kimchi");
        res.setHeader("X-Proxy-Finish-Reason", String(completion.finishReason));
        res.setHeader("X-Proxy-Continued", String(completion.continued));
        if (completion.continued) {
          res.setHeader("X-Proxy-Continue-Attempts", String(completion.autoContinueAttempts));
        }

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.status(200);

        let parsed = null;
        try { parsed = JSON.parse(completion.result.body); } catch {}
        await streamJsonAsSse(res, parsed || completion.finalBody || { id: `id-${Date.now()}`, choices: [] }, body.model);

        await logRequest({
          model,
          status: completion.result.status,
          elapsed,
          keyIndex: lastKeyIndex,
          provider: completion.result.provider || "kimchi",
          inputTokens: completion.inputTokens || (body.messages ? body.messages.reduce((s, m) => s + (m.content || "").length / 4, 0) : 0),
          outputTokens: completion.outputTokens || 0,
          finishReason: completion.finishReason,
          method: "POST",
        });
      } else {
        const result = await tryCloudflareThenKimchiStreaming({
          body,
          getNextKey,
          requestHeaders: { "X-Request-Start": String(Date.now()) },
          signal: AbortSignal.timeout(AUTO_CONTINUE_TIMEOUT_MS),
        });

        res.setHeader("X-Proxy-Key-Index", String(lastKeyIndex));
        res.setHeader("X-Proxy-Key-Total", String(keys.length));
        res.setHeader("X-Proxy-Attempts", String(result.attempts));
        res.setHeader("X-Proxy-Provider", result.provider || "kimchi");

        const streamStartTime = startTime;
        const streamResult = await streamWithAutoContinue(res, result, body, keys, getNextKey, streamStartTime);
        const elapsed = Date.now() - streamStartTime;

        await logRequest({
          model,
          status: result.status,
          elapsed,
          keyIndex: lastKeyIndex,
          provider: result.provider || "kimchi",
          inputTokens: body.messages ? body.messages.reduce((s, m) => s + (m.content || "").length / 4, 0) : 0,
          outputTokens: streamResult.outputTokens || 0,
          finishReason: streamResult.finishReason || result.finishReason || "unknown",
          method: "POST",
        });
      }
    } else {
      const completion = await completeNonStreaming({ body, getNextKey, startTime, keyTotal: keys.length });
      const elapsed = Date.now() - startTime;

      res.setHeader("X-Proxy-Key-Index", String(lastKeyIndex));
      res.setHeader("X-Proxy-Key-Total", String(keys.length));
      res.setHeader("X-Proxy-Attempts", String(completion.result.attempts));
      res.setHeader("X-Proxy-Elapsed-Ms", String(elapsed));
      res.setHeader("X-Proxy-Provider", completion.result.provider || "kimchi");
      res.setHeader("X-Proxy-Finish-Reason", String(completion.finishReason));
      res.setHeader("X-Proxy-Continued", String(completion.continued));
      if (completion.continued) {
        res.setHeader("X-Proxy-Continue-Attempts", String(completion.autoContinueAttempts));
      }

      await logRequest({
        model,
        status: completion.result.status,
        elapsed,
        keyIndex: lastKeyIndex,
        provider: completion.result.provider || "kimchi",
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        finishReason: completion.finishReason,
        method: "POST",
      });

      writeResponse(res, completion.result);
    }
  } catch (error) {
    console.error("[completions proxy] error:", error);
    const elapsed = startTime ? Date.now() - startTime : 0;
    const err = error instanceof Error ? error : new Error(String(error));

    await logRequest({
      model,
      status: 502,
      elapsed,
      keyIndex: lastKeyIndex,
      inputTokens: 0,
      outputTokens: 0,
      method: "POST",
      error: err.message,
      details: err.stack,
    });

    return res.status(502).json({
      ok: false,
      error: "Failed to reach Kimchi API",
      keyIndex: lastKeyIndex,
      keyTotal: keys.length,
      attempts: 0,
      elapsedMs: elapsed,
      details: err.message,
    });
  }
};
