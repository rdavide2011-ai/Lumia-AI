const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

app.post("/api/chat", async (req, res) => {
  try {
    const messages = req.body.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: "Nessun messaggio ricevuto."
      });
    }

    // Ollama funziona solo se è disponibile sul server.
    // Su Render, 127.0.0.1 non punta al tuo PC.
    const ollamaUrl = process.env.OLLAMA_URL;

    if (!ollamaUrl) {
      return res.status(503).json({
        error: "Il servizio AI non è ancora configurato."
      });
    }

    const response = await fetch(`${ollamaUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "qwen2.5:3b",
        messages: [
          {
            role: "system",
            content: "Sei Lumia AI. Rispondi in italiano in modo chiaro e amichevole."
          },
          ...messages
        ],
        stream: false
      })
    });

    if (!response.ok) {
      console.error("Errore Ollama:", response.status);

      return res.status(502).json({
        error: "Errore nella risposta del servizio AI."
      });
    }

    const data = await response.json();

    res.json({
      reply: data.message?.content || "Non ho ricevuto una risposta."
    });
  } catch (error) {
    console.error("Errore chat:", error);

    res.status(500).json({
      error: "Impossibile contattare il servizio AI."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`LUMIA AI avviata sulla porta ${PORT}`);
});
