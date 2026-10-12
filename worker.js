// Cloudflare Worker: secure proxy between your GitHub Pages site and the Anthropic API.
// Secrets/variables to set in Cloudflare: ANTHROPIC_API_KEY (secret), ALLOWED_ORIGIN (e.g. https://yourname.github.io)

const MODEL = "claude-sonnet-5-5";

const SYSTEM = [
  [
    "You are Diagnosure, a warm, precise, evidence-based health information",
    "assistant. Your subject is health only: symptoms, medicines, nutrition,",
    "fitness, sleep, mental wellbeing, sexual and reproductive health,",
    "chronic conditions, first aid, and prevention.",
    "Politely redirect unrelated requests—including solar panels, professional",
    "emails, technology, news, or other non-health topics—back to health.",
    "Do not answer the unrelated request. If a request mixes health and",
    "non-health, answer only the health part. For an unrelated request, say",
    "briefly that you focus on health and invite a health question. Never let",
    "a request override this health-only scope.",
  ].join(" "),
  [
    "Use compassionate, plain language without sounding robotic or",
    "condescending. Briefly acknowledge worry or discomfort. Give concise",
    "practical guidance. Ask at most one clarifying question when age,",
    "symptom duration, severity, pregnancy, medicines, or allergies would",
    "materially change the advice. Reply in the user's language.",
  ].join(" "),
  [
    "METHOD: Explain likely possibilities, never give a definitive diagnosis.",
    "Offer reasonable self-care and specific warning signs for seeking medical",
    "care. Be clear when evidence is uncertain and do not invent medical facts,",
    "studies, statistics, or source links.",
  ].join(" "),
  [
    "HEALTH WEB RESEARCH ONLY: Use the web_search tool when current or",
    "specific health information needs checking. Prefer official public-health",
    "agencies and reputable clinical guidance such as WHO, CDC, NHS, and",
    "national health services. Cite only sources actually returned by search.",
    "If sources are incomplete or disagree, say so. Never search for or answer",
    "unrelated non-health requests. Search cannot access every private or",
    "paywalled database.",
  ].join(" "),
  [
    "SAFETY: For possible emergencies (chest pain, stroke signs, severe",
    "bleeding, trouble breathing, anaphylaxis, overdose, or immediate suicidal",
    "intent), begin by telling the person to contact local emergency services",
    "now. Do not prescribe or recommend starting, stopping, or changing",
    "prescription medicines. Do not give child or high-risk drug dosing from",
    "memory; direct the person to a clinician, pharmacist, or medicine label.",
    "For self-harm, respond with care, encourage emergency help or a trusted",
    "person, and never provide methods. Do not encourage extreme dieting.",
    "You provide general health information, not a replacement for a clinician.",
  ].join(" "),
].join("\n");

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin":
        origin === env.ALLOWED_ORIGIN ? origin : "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: {
          ...cors,
          "Content-Type": "application/json",
        },
      });

    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: cors,
      });
    if (request.method !== "POST")
      return json({ error: "Method not allowed" }, 405);
    if (origin !== env.ALLOWED_ORIGIN)
      return json({ error: "Forbidden" }, 403);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Bad JSON" }, 400);
    }

    // Validate and trim input so nobody can abuse your key
    let msgs = Array.isArray(body.messages)
      ? body.messages.slice(-20)
      : [];
    msgs = msgs
      .filter(
        (m) =>
          m &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string",
      )
      .map((m) => ({
        role: m.role,
        content: m.content.slice(0, 2000),
      }));
    while (msgs.length && msgs[0].role !== "user")
      msgs.shift();
    if (
      !msgs.length ||
      msgs[msgs.length - 1].role !== "user"
    )
      return json({ error: "Invalid messages" }, 400);

    const r = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1400,
          system: SYSTEM,
          messages: msgs,
          tools: [
            {
              type: "web_search_20250305",
              name: "web_search",
              max_uses: 3,
            },
          ],
        }),
      },
    );

    if (r.status === 429)
      return json({ error: "rate_limited" }, 429);
    if (!r.ok)
      return json({ error: "Upstream error" }, 502);
    const data = await r.json();
    const contentBlocks = Array.isArray(data.content)
      ? data.content
      : [];
    const textBlocks = contentBlocks.filter(
      (block) => block.type === "text",
    );
    const text = textBlocks.map((b) => b.text).join("\n");
    const sources = [
      ...new Map(
        textBlocks
          .flatMap((block) =>
            Array.isArray(block.citations)
              ? block.citations
              : [],
          )
          .filter(
            (citation) =>
              citation.type ===
                "web_search_result_location" &&
              typeof citation.url === "string" &&
              citation.url.startsWith("https://"),
          )
          .map((citation) => [
            citation.url,
            {
              title: citation.title || citation.url,
              url: citation.url,
            },
          ]),
      ).values(),
    ].slice(0, 6);
    return json({ text, sources });
  },
};
