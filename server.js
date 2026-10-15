
const express = require("express");
const crypto = require("node:crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.use(express.json({ limit: "8mb" }));
app.use(express.static(__dirname));

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
const CF_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${MODEL}`;

async function callCloudflare(messages, options = {}) {
  const response = await fetch(CF_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messages,
      max_tokens: options.max_tokens || 1024,
      temperature: options.temperature ?? 0.7,
      stream: options.stream ?? false
    }),
    signal: AbortSignal.timeout(options.timeout || 90000)
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    console.error("Errore Cloudflare:", response.status, details);
    throw new Error("Cloudflare AI non è riuscito a generare la risposta.");
  }

  return response;
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    aiConfigured: Boolean(CF_ACCOUNT_ID && CF_API_TOKEN)
  });
});

app.post("/api/title", async (req, res) => {
  try {
    if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
      return res.status(503).json({ error: "Cloudflare Workers AI non è configurato." });
    }

    const messages = req.body?.messages;
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: "Nessun messaggio ricevuto." });
    }

    const conversation = messages
      .filter(m => m && ["user", "assistant"].includes(m.role) &&
        typeof m.content === "string" && m.content.trim())
      .slice(-12)
      .map(m => ({ role: m.role, content: m.content.slice(0, 2500) }));

    const response = await callCloudflare([
      {
        role: "system",
        content: "Crea un titolo breve in italiano, specifico e naturale, di 2-7 parole. " +
          "Restituisci solo il titolo, senza virgolette o spiegazioni."
      },
      {
        role: "user",
        content: "Crea un titolo per questa conversazione:\n\n" +
          conversation.map(m => `${m.role === "user" ? "Utente" : "Lumia AI"}: ${m.content}`).join("\n")
      }
    ], { max_tokens: 40, temperature: 0.2, timeout: 30000 });

    const data = await response.json();
    const title = data?.result?.response;

    if (typeof title !== "string" || !title.trim()) {
      return res.status(502).json({ error: "Non è stato possibile generare il titolo." });
    }

    res.json({
      title: title.trim().replace(/^["'“”]+|["'“”]+$/g, "").replace(/\s+/g, " ").slice(0, 80)
    });
  } catch (error) {
    console.error("Errore generazione titolo:", error);
    res.status(502).json({ error: "Impossibile generare il titolo della conversazione." });
  }
});

/* Chat AI con streaming testuale. */
app.post("/api/chat", async (req, res) => {
  try {
    if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
      return res.status(503).json({ error: "Cloudflare Workers AI non è configurato." });
    }

    const messages = req.body?.messages;
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: "Nessun messaggio ricevuto." });
    }

    const validMessages = messages
      .filter(m => m && ["user", "assistant"].includes(m.role) &&
        typeof m.content === "string" && m.content.trim())
      .slice(-30)
      .map(m => ({ role: m.role, content: m.content.slice(0, 12000) }));

    const preferences = req.body?.preferences && typeof req.body.preferences === "object" ? req.body.preferences : {};
    const toneMap = {
      friendly: "Usa un tono amichevole, naturale e rispettoso.",
      professional: "Usa un tono professionale, preciso e ordinato.",
      direct: "Vai dritto al punto e privilegia risposte sintetiche.",
      creative: "Usa un tono creativo ed espressivo, restando chiaro e utile."
    };
    const lengthMap = {
      short: "Mantieni le risposte brevi e concentrate sui punti essenziali.",
      balanced: "Regola la lunghezza in base alla domanda, con un buon equilibrio tra chiarezza e dettaglio.",
      detailed: "Fornisci risposte dettagliate, con spiegazioni ed esempi quando utili."
    };
    const tone = toneMap[preferences.responseTone] || toneMap.friendly;
    const length = lengthMap[preferences.responseLength] || lengthMap.balanced;
    const customInstructions = typeof preferences.customInstructions === "string"
      ? preferences.customInstructions.trim().slice(0, 1200)
      : "";
    const personalMemory = typeof preferences.personalMemory === "string"
      ? preferences.personalMemory.trim().slice(0, 2000)
      : "";
    const systemContent = [
      "Sei Lumia AI, un assistente intelligente. Rispondi in italiano in modo chiaro, utile e rispettoso.",
      tone,
      length,
      customInstructions ? "Istruzioni personalizzate dell'utente (seguile se compatibili con sicurezza e accuratezza): " + customInstructions : "",
      personalMemory ? "Memoria personale fornita dall'utente, da usare come contesto quando pertinente: " + personalMemory : ""
    ].filter(Boolean).join("\n\n");
    const response = await callCloudflare([
      { role: "system", content: systemContent },
      ...validMessages
    ], { max_tokens: 1024, temperature: preferences.responseTone === "creative" ? 0.85 : 0.7, stream: true, timeout: 90000 });

    if (!response.body) {
      return res.status(502).json({ error: "Il servizio AI non ha restituito una risposta." });
    }

    res.status(200);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          try {
            const item = JSON.parse(payload);
            if (item.response) res.write(item.response);
            if (item.error) console.error("Errore Cloudflare stream:", item.error);
          } catch (error) {
            console.error("Evento AI non valido:", error.message);
          }
        }
      }

      buffer += decoder.decode();
      const lastLine = buffer.trim();
      if (lastLine.startsWith("data:")) {
        const payload = lastLine.slice(5).trim();
        if (payload && payload !== "[DONE]") {
          try {
            const item = JSON.parse(payload);
            if (item.response) res.write(item.response);
          } catch (error) {
            console.error("Ultimo evento AI non valido:", error.message);
          }
        }
      }
      res.end();
    } catch (error) {
      console.error("Errore durante lo streaming:", error);
      if (!res.headersSent) res.status(502).json({ error: "Errore durante la generazione della risposta." });
      else res.end();
    }
  } catch (error) {
    console.error("Errore chat:", error);
    if (!res.headersSent) res.status(502).json({ error: "Impossibile contattare il servizio AI." });
    else res.end();
  }
});

/* Trasferimenti temporanei tra dispositivi: memoria volatile del server. */
const transfers = new Map();
const attempts = new Map();
const TRANSFER_TTL = 10 * 60 * 1000;
const MAX_TRANSFER_BYTES = 8 * 1024 * 1024;

function cleanupTransfers() {
  const now = Date.now();
  for (const [token, item] of transfers) {
    if (item.expiresAt <= now || item.used) transfers.delete(token);
  }
  for (const [ip, item] of attempts) {
    if (now - item.startedAt > 60 * 60 * 1000) attempts.delete(ip);
  }
}
setInterval(cleanupTransfers, 30 * 1000).unref();

function validateConversations(value) {
  if (!Array.isArray(value) || value.length > 250) return false;

  let messageCount = 0;
  for (const conversation of value) {
    if (!conversation || typeof conversation !== "object" ||
        typeof conversation.title !== "string" ||
        !Array.isArray(conversation.messages) ||
        conversation.messages.length > 1000) return false;

    messageCount += conversation.messages.length;
    if (messageCount > 5000) return false;

    for (const message of conversation.messages) {
      if (!message || !["user", "assistant"].includes(message.role) ||
          typeof message.content !== "string" ||
          message.content.length > 100000) return false;
    }
  }
  return true;
}

app.post("/api/device-transfer/create", (req, res) => {
  cleanupTransfers();

  const conversations = req.body?.conversations;
  if (!validateConversations(conversations)) {
    return res.status(400).json({
      error: "La cronologia non è valida o supera i limiti consentiti."
    });
  }

  const size = Buffer.byteLength(JSON.stringify(conversations), "utf8");
  if (size > MAX_TRANSFER_BYTES) {
    return res.status(413).json({
      error: "La cronologia è troppo grande per un singolo trasferimento."
    });
  }

  const token = crypto.randomBytes(32).toString("hex");
  let code;

  do {
    code = String(crypto.randomInt(0, 100000000)).padStart(8, "0");
  } while ([...transfers.values()].some(item => item.code === code));

  const now = Date.now();
  transfers.set(token, {
    code,
    conversations,
    createdAt: now,
    expiresAt: now + TRANSFER_TTL,
    used: false
  });

  res.setHeader("Cache-Control", "no-store");
  res.json({
    token,
    code,
    expiresAt: now + TRANSFER_TTL,
    expiresInSeconds: TRANSFER_TTL / 1000
  });
});

app.post("/api/device-transfer/redeem", (req, res) => {
  cleanupTransfers();

  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let attempt = attempts.get(ip);

  if (!attempt || now - attempt.startedAt > 60 * 60 * 1000) {
    attempt = { startedAt: now, count: 0 };
    attempts.set(ip, attempt);
  }

  if (attempt.count >= 20) {
    return res.status(429).json({ error: "Troppi tentativi. Riprova più tardi." });
  }
  attempt.count++;

  const token = typeof req.body?.token === "string" ? req.body.token : "";
  const code = typeof req.body?.code === "string"
    ? req.body.code.replace(/\D/g, "")
    : "";

  let selectedToken = token && /^[a-f0-9]{64}$/i.test(token) ? token : "";
  let transfer = selectedToken ? transfers.get(selectedToken) : null;

  if (!transfer && code.length === 8) {
    for (const [candidateToken, item] of transfers) {
      if (item.code === code) {
        selectedToken = candidateToken;
        transfer = item;
        break;
      }
    }
  }

  if (!transfer || transfer.used || transfer.expiresAt <= now) {
    return res.status(404).json({
      error: "Codice o QR non valido, già utilizzato oppure scaduto."
    });
  }

  /*
   * Il codice/QR è monouso: viene consumato prima di inviare le chat.
   * In caso di interruzione, il mittente può generare un nuovo trasferimento.
   */
  transfer.used = true;
  transfers.delete(selectedToken);

  res.setHeader("Cache-Control", "no-store");
  res.json({
    conversations: transfer.conversations,
    importedAt: now
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Lumia AI avviata sulla porta ${PORT}`);
  console.log(`Cloudflare AI configurato: ${Boolean(CF_ACCOUNT_ID && CF_API_TOKEN)}`);
  console.log("Trasferimento temporaneo dispositivi attivo.");
});
