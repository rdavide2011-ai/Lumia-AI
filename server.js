const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    aiConfigured: Boolean(CF_ACCOUNT_ID && CF_API_TOKEN)
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
      return res.status(503).json({
        error: "Cloudflare Workers AI non è configurato."
      });
    }

    const messages = req.body?.messages;

    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({
        error: "Nessun messaggio ricevuto."
      });
    }

    const validMessages = messages
      .filter(message =>
        message &&
        ["user", "assistant"].includes(message.role) &&
        typeof message.content === "string" &&
        message.content.trim()
      )
      .slice(-30)
      .map(message => ({
        role: message.role,
        content: message.content.slice(0, 12000)
      }));

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${MODEL}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CF_API_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messages: [
            {
              role: "system",
              content:
                "Sei Lumia AI, un assistente intelligente e amichevole. " +
                "Rispondi in italiano in modo chiaro, naturale e utile."
            },
            ...validMessages
          ],
          max_tokens: 1024,
          temperature: 0.7,
          stream: true
        }),
        signal: AbortSignal.timeout(90000)
      }
    );

    if (!response.ok || !response.body) {
      const details = await response.text().catch(() => "");
      console.error("Errore Cloudflare:", response.status, details);

      return res.status(502).json({
        error: "Cloudflare AI non è riuscito a generare la risposta."
      });
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

        const events = buffer.split("\n");
        buffer = events.pop() || "";

        for (const line of events) {
          const trimmed = line.trim();

          if (!trimmed.startsWith("data:")) continue;

          const payload = trimmed.slice(5).trim();

          if (!payload || payload === "[DONE]") continue;

          try {
            const item = JSON.parse(payload);

            if (item.response) {
              res.write(item.response);
            }

            if (item.error) {
              console.error("Errore nel flusso Cloudflare:", item.error);
            }
          } catch (error) {
            console.error("Evento AI non valido:", error.message);
          }
        }
      }

      const lastLine = buffer.trim();

      if (lastLine.startsWith("data:")) {
        const payload = lastLine.slice(5).trim();

        if (payload && payload !== "[DONE]") {
          try {
            const item = JSON.parse(payload);
            if (item.response) res.write(item.response);
          } catch {}
        }
      }

      res.end();
    } catch (error) {
      console.error("Errore durante lo streaming:", error);

      if (!res.headersSent) {
        res.status(502).json({
          error: "Errore durante la generazione della risposta."
        });
      } else {
        res.end();
      }
    }
  } catch (error) {
    console.error("Errore chat:", error);

    if (!res.headersSent) {
      res.status(500).json({
        error: "Impossibile contattare il servizio AI."
      });
    } else {
      res.end();
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Lumia AI avviata sulla porta ${PORT}`);
  console.log(
    `Cloudflare AI configurato: ${Boolean(CF_ACCOUNT_ID && CF_API_TOKEN)}`
  );
});
