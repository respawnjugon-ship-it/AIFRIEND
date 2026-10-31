// Función serverless de Netlify: recibe la conversación y llama a Claude.
// La clave de API vive SOLO aquí (variable de entorno), nunca en la web.

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };
  const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

  if (event.httpMethod !== "POST") return reply(405, { error: "Método no permitido" });

  // Si hay GEMINI_API_KEY se usa Gemini (tiene capa gratuita); si no, Claude.
  const geminiKey = process.env.GEMINI_API_KEY;
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  if (!geminiKey && !claudeKey) {
    return reply(500, { error: "Falta GEMINI_API_KEY (gratis) o ANTHROPIC_API_KEY en las variables de Netlify." });
  }

  // Código de acceso opcional para que nadie más gaste tu saldo.
  const accessCode = process.env.ACCESS_CODE;
  if (accessCode && (event.headers["x-access-code"] || "") !== accessCode) {
    return reply(401, { error: "Código de acceso incorrecto. Escríbelo en Ajustes." });
  }

  let input;
  try {
    input = JSON.parse(event.body || "{}");
  } catch {
    return reply(400, { error: "Petición no válida." });
  }

  // Limpia el historial: últimos 20 mensajes, solo texto, empezando por el usuario.
  let messages = (Array.isArray(input.messages) ? input.messages : [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
    .slice(-20);
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length) return reply(400, { error: "No hay mensaje que responder." });

  const name = String(input.name || "Pixel").slice(0, 30);
  const extra = String(input.extra || "").slice(0, 500);
  const lang = String(input.lang || "es-ES").slice(0, 10);

  const system = [
    `Te llamas ${name}. Eres un compañero de escritorio con voz que acompaña a la persona mientras trabaja o estudia.`,
    `Tus respuestas se leen en voz alta: habla como en una conversación, con frases cortas y naturales, normalmente de una a tres frases.`,
    `No uses markdown, listas, asteriscos, emojis ni enlaces. Escribe los números y símbolos como se dirían en voz alta.`,
    `Responde en el idioma que usa la persona (por defecto, el del código ${lang}).`,
    `Sé cálido, curioso y con un punto de humor. Si te piden algo largo, da primero lo esencial y ofrece seguir.`,
    `Si el audio se transcribió mal y no tiene sentido, pide con amabilidad que lo repita.`,
    extra ? `Preferencias de personalidad de la persona: ${extra}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    let text = "";

    if (geminiKey) {
      const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": geminiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: messages.map((m) => ({
              role: m.role === "assistant" ? "model" : "user",
              parts: [{ text: m.content }],
            })),
            generationConfig: { maxOutputTokens: 1024 },
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        const msg = data?.error?.message || `Error de Gemini (${res.status}).`;
        return reply(res.status === 429 ? 429 : 502, {
          error: res.status === 429 ? "Límite gratuito alcanzado. Espera un minuto y vuelve a probar." : msg,
        });
      }
      text = (data.candidates?.[0]?.content?.parts || [])
        .map((p) => p.text || "")
        .join(" ")
        .trim();
    } else {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": claudeKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
          max_tokens: 400,
          system,
          messages,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        return reply(502, { error: data?.error?.message || `Error de la API (${res.status}).` });
      }
      text = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
    }

    return reply(200, { reply: text || "Se me ha ido el hilo. ¿Me lo repites?" });
  } catch (err) {
    return reply(502, { error: "No pude conectar con la IA. Inténtalo de nuevo." });
  }
};
