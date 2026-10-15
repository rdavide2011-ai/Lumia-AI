const express = require("express");

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(__dirname));

app.post("/api/chat", async (req, res) => {
  try {
    const messages = req.body.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Nessun messaggio ricevuto." });
    }

    const response = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      return res.status(502).json({ error: "Errore nella risposta di Ollama." });
    }

    const data = await response.json();
    res.json({ reply: data.message.content });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Impossibile contattare Ollama." });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log("LUMIA AI avviata!");
  console.log("Apri http://127.0.0.1:3000");
});