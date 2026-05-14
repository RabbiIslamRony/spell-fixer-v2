import http from "node:http";

const PORT = Number(process.env.PORT || 8787);

const server = http.createServer(async (request, response) => {
  setCors(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method !== "POST" || request.url !== "/grammar/check") {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  try {
    const payload = JSON.parse(await readBody(request));
    const text = String(payload.text || "").trim();

    if (!text) {
      sendJson(response, 400, { error: "Missing text" });
      return;
    }

    const result = await checkText(payload);
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Grammar API listening on http://127.0.0.1:${PORT}/grammar/check`);
});

async function checkText(payload) {
  if (process.env.AI_API_URL && process.env.AI_API_KEY && process.env.AI_MODEL) {
    return checkWithChatApi(payload);
  }

  return demoCheck(payload);
}

async function checkWithChatApi(payload) {
  const mode = String(payload.mode || "grammar");
  const response = await fetch(process.env.AI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.AI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.AI_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "Return only valid JSON with correctedText and suggestions. Do not add markdown."
        },
        {
          role: "user",
          content: JSON.stringify({
            task: mode,
            language: payload.language || "en",
            text: payload.text
          })
        }
      ]
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || response.statusText);
  }

  const content = data?.choices?.[0]?.message?.content || "";
  return parseModelJson(content);
}

function demoCheck(payload) {
  const original = String(payload.text || "");
  let correctedText = original
    .replace(/\bThis are\b/g, "This is")
    .replace(/\bthis are\b/g, "this is")
    .replace(/\bI has\b/g, "I have")
    .replace(/\bi has\b/g, "i have");

  if (payload.mode === "shorten") {
    correctedText = correctedText
      .replace(/\bin order to\b/gi, "to")
      .replace(/\bat this point in time\b/gi, "now");
  }

  return {
    correctedText,
    suggestions:
      correctedText === original
        ? []
        : [
            {
              title: "Demo correction",
              replacement: correctedText,
              explanation:
                "This demo server made a basic correction. Connect your own AI service for full grammar checking.",
              severity: "grammar"
            }
          ]
  };
}

function parseModelJson(content) {
  try {
    const parsed = JSON.parse(content);
    return {
      correctedText: String(parsed.correctedText || parsed.corrected_text || parsed.text || ""),
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : []
    };
  } catch {
    return {
      correctedText: content,
      suggestions: []
    };
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        request.destroy(new Error("Request body too large"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function sendJson(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(data, null, 2));
}
