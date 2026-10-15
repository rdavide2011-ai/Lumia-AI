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

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: "Nessun messaggio ricevuto."
      });
    }

    const validMessages = messages
      .filter(
        message =>
          message &&
          ["user", "assistant"].includes(message.role) &&
          typeof message.content === "string" &&
          message.content.trim().length > 0
      )
      .slice(-30)
      .map(message => ({
        role: message.role,
        content: message.content.slice(0, 12000)
      }));

    if (validMessages.length === 0) {
      return res.status(400).json({
        error: "Non ci sono messaggi validi da inviare."
      });
    }

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
                "Sei Lumia AI, un assistente intelligente, amichevole e utile. " +
                "Rispondi in italiano, salvo richiesta diversa. " +
                "Spiega gli argomenti in modo chiaro e adatta la risposta " +
                "alla domanda dell'utente. Se non conosci una risposta, " +
                "dillo con sincerità."
            },
            ...validMessages
          ],
          max_tokens: 1024,
          temperature: 0.7
        }),
        signal: AbortSignal.timeout(90000)
      }
    );

    const data = await response.json().catch(() => null);

    if (!response.ok || data?.success === false) {
      console.error(
        "Errore Cloudflare Workers AI:",
        response.status,
        JSON.stringify(data?.errors || data)
      );

      return res.status(502).json({
        error:
          "Cloudflare AI non è riuscito a generare la risposta. Riprova tra poco."
      });
    }

    const reply =
      data?.result?.response ??
      data?.result?.message?.content ??
      data?.result?.choices?.[0]?.message?.content;

    if (typeof reply !== "string" || !reply.trim()) {
      console.error("Risposta Cloudflare non riconosciuta:", data);

      return res.status(502).json({
        error: "Il modello AI non ha restituito una risposta valida."
      });
    }

    return res.json({ reply: reply.trim() });
  } catch (error) {
    console.error("Errore durante la chat:", error);

    return res.status(500).json({
      error:
        error.name === "TimeoutError"
          ? "Il modello AI sta impiegando troppo tempo. Riprova."
          : "Impossibile contattare il servizio AI."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Lumia AI avviata sulla porta ${PORT}`);
  console.log(
    `Cloudflare AI configurato: ${Boolean(CF_ACCOUNT_ID && CF_API_TOKEN)}`
  );
});
