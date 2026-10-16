/*
 * AI szolgáltatók közös felülete: modelllista és egy strukturált (JSON sémás) hívás.
 * Gemini és Anthropic a hivatalos SDK-val, az OpenAI-kompatibilis szolgáltatók sima fetch-csel.
 */
const dns = require('dns').promises;
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenAI } = require('@google/genai');
const { isPrivateAddress, normalizeBaseUrl } = require('./ai-actions');

const REQUEST_TIMEOUT_MS = 30000;
const MAX_OUTPUT_TOKENS = 8000;
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** An error with a Hungarian message and the HTTP status the API returns to the browser. */
class AiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/** Maps a provider HTTP status to a Hungarian message. */
function providerError(status) {
    if (status === 401 || status === 403) return new AiError(400, 'Az API kulcs hibás, lejárt, vagy nincs hozzáférése ehhez a modellhez.');
    if (status === 429) return new AiError(429, 'A szolgáltató korlátja elfogyott (pl. az ingyenes keret vagy az egyenleg). Próbáld újra később.');
    if (status === 404) return new AiError(400, 'A kiválasztott modell nem érhető el. Válassz másikat a Beállítások AI fülén.');
    if (status === 402) return new AiError(400, 'A szolgáltatónál elfogyott az egyenleg.');
    if (status === 400) return new AiError(400, 'A szolgáltató elutasította a kérést (rossz modell vagy beállítás).');
    if (status === 408 || status === 504) return new AiError(504, 'Az AI nem válaszolt időben. Próbáld újra.');
    return new AiError(502, `Az AI hívás nem sikerült${status ? ` (HTTP ${status})` : ''}. Próbáld újra később.`);
}

function wrapError(err) {
    if (err instanceof AiError) return err;
    if (err instanceof Anthropic.APIConnectionTimeoutError || err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        return new AiError(504, 'Az AI nem válaszolt időben. Próbáld újra.');
    }
    // A Gemini hibás kulcsra 400-at ad („API key not valid”).
    if (err?.status === 400 && /api[ _-]?key/i.test(String(err.message))) return providerError(401);
    if (typeof err?.status === 'number') return providerError(err.status);
    return new AiError(502, 'Az AI szolgáltató nem érhető el. Próbáld újra később.');
}

/** Reads the JSON object from a model's text answer (tolerates a ```json fence). */
function parseJsonText(text) {
    const trimmed = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
    try {
        return JSON.parse(trimmed);
    } catch (err) {
        throw new AiError(502, 'Az AI nem érvényes választ adott. Próbáld újra.');
    }
}

// ---------- Gemini ----------

const gemini = {
    label: 'Gemini',
    defaultModels: ['gemini-flash-latest', 'gemini-flash-lite-latest'],
    client(apiKey) {
        return new GoogleGenAI({ apiKey, vertexai: false, httpOptions: { timeout: REQUEST_TIMEOUT_MS } });
    },
    async listModels({ apiKey }) {
        const pager = await this.client(apiKey).models.list({ config: { pageSize: 100 } });
        const models = [];
        for await (const model of pager) {
            const id = String(model.name || '').replace(/^models\//, '');
            if (!id.startsWith('gemini')) continue;
            if (Array.isArray(model.supportedActions) && !model.supportedActions.includes('generateContent')) continue;
            if (/embed|image|tts|audio|live|robotics|computer-use/i.test(id)) continue;
            models.push({ id, label: model.displayName || id });
        }
        return models;
    },
    async generate({ apiKey, model, system, user, schema }) {
        const response = await this.client(apiKey).models.generateContent({
            model,
            contents: user,
            config: {
                systemInstruction: system,
                responseMimeType: 'application/json',
                responseJsonSchema: schema,
                maxOutputTokens: MAX_OUTPUT_TOKENS
            }
        });
        if (response.promptFeedback?.blockReason) throw new AiError(422, 'Az AI ezt a kérést elutasította.');
        const finish = response.candidates?.[0]?.finishReason;
        if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' || finish === 'BLOCKLIST') throw new AiError(422, 'Az AI ezt a kérést elutasította.');
        if (finish === 'MAX_TOKENS') throw new AiError(502, 'Az AI válasza túl hosszú lett. Próbáld rövidebb szöveggel.');
        return parseJsonText(response.text);
    }
};

// ---------- Anthropic (Claude) ----------

const anthropic = {
    label: 'Claude (Anthropic)',
    defaultModels: ['claude-haiku-5-5', 'claude-sonnet-5-5'],
    client(apiKey) {
        return new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 });
    },
    async listModels({ apiKey }) {
        const models = [];
        for await (const model of this.client(apiKey).models.list({ limit: 100 })) {
            models.push({ id: model.id, label: model.display_name || model.id });
        }
        return models;
    },
    async generate({ apiKey, model, system, user, schema }) {
        const client = this.client(apiKey);
        const request = {
            model,
            max_tokens: MAX_OUTPUT_TOKENS,
            system,
            messages: [{ role: 'user', content: user }],
            output_config: { format: { type: 'json_schema', schema }, effort: 'low' }
        };
        let response;
        try {
            response = await client.messages.create(request);
        } catch (err) {
            // Régebbi modellek nem ismerik az effort beállítást: akkor nélküle próbálja újra.
            if (!(err instanceof Anthropic.BadRequestError) || !/effort/i.test(err.message)) throw err;
            response = await client.messages.create({ ...request, output_config: { format: request.output_config.format } });
        }
        if (response.stop_reason === 'refusal') throw new AiError(422, 'Az AI ezt a kérést elutasította.');
        if (response.stop_reason === 'max_tokens') throw new AiError(502, 'Az AI válasza túl hosszú lett. Próbáld rövidebb szöveggel.');
        const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('');
        return parseJsonText(text);
    }
};

// ---------- OpenAI-kompatibilis (OpenAI, OpenRouter, Mistral, Groq, saját szerver) ----------

/** Refuses base URLs that are not https or that resolve to a private / loopback address. */
async function assertPublicBaseUrl(baseUrl) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) throw new AiError(400, 'A szolgáltató címe csak nyilvános https:// cím lehet.');
    const host = new URL(normalized).hostname.replace(/^\[|\]$/g, '');
    let addresses;
    try {
        addresses = await dns.lookup(host, { all: true, verbatim: true });
    } catch (err) {
        throw new AiError(400, 'A szolgáltató címe nem található.');
    }
    if (!addresses.length || addresses.some(entry => isPrivateAddress(entry.address))) {
        throw new AiError(400, 'A szolgáltató címe csak nyilvános https:// cím lehet.');
    }
    return normalized;
}

async function openAiFetch(baseUrl, apiKey, path, options = {}) {
    const base = await assertPublicBaseUrl(baseUrl || DEFAULT_OPENAI_BASE_URL);
    const response = await fetch(`${base}${path}`, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    if (!response.ok) throw providerError(response.status);
    return response.json();
}

const openai = {
    label: 'OpenAI-kompatibilis',
    defaultModels: ['gpt-5-mini', 'gpt-4.1-mini'],
    async listModels({ apiKey, baseUrl }) {
        const body = await openAiFetch(baseUrl, apiKey, '/models');
        const list = Array.isArray(body?.data) ? body.data : [];
        return list.map(model => ({ id: String(model.id), label: String(model.name || model.id) })).filter(model => model.id);
    },
    async generate({ apiKey, baseUrl, model, system, user, schema, schemaName }) {
        const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
        let body;
        try {
            body = await openAiFetch(baseUrl, apiKey, '/chat/completions', {
                method: 'POST',
                body: JSON.stringify({ model, messages, max_tokens: MAX_OUTPUT_TOKENS, response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } } })
            });
        } catch (err) {
            // Nem minden kompatibilis szolgáltató ismeri a JSON sémát: akkor sima JSON módban próbálja.
            if (!(err instanceof AiError) || err.status !== 400) throw err;
            body = await openAiFetch(baseUrl, apiKey, '/chat/completions', {
                method: 'POST',
                body: JSON.stringify({
                    model,
                    messages: [{ role: 'system', content: `${system}\nJSON schema of the answer:\n${JSON.stringify(schema)}` }, messages[1]],
                    max_tokens: MAX_OUTPUT_TOKENS,
                    response_format: { type: 'json_object' }
                })
            });
        }
        const message = body?.choices?.[0]?.message;
        if (message?.refusal) throw new AiError(422, 'Az AI ezt a kérést elutasította.');
        if (body?.choices?.[0]?.finish_reason === 'length') throw new AiError(502, 'Az AI válasza túl hosszú lett. Próbáld rövidebb szöveggel.');
        return parseJsonText(message?.content);
    }
};

const PROVIDERS = { gemini, anthropic, openai };

/** The recommended model from a listed set: the first preferred id that exists, else the first model. */
function pickDefaultModel(provider, models) {
    const ids = models.map(model => model.id);
    const preferred = PROVIDERS[provider].defaultModels.find(id => ids.includes(id));
    return preferred || ids[0] || PROVIDERS[provider].defaultModels[0];
}

async function listModels(provider, credentials) {
    try {
        const models = await PROVIDERS[provider].listModels(credentials);
        return models.sort((a, b) => a.id.localeCompare(b.id));
    } catch (err) {
        throw wrapError(err);
    }
}

async function generate(provider, request) {
    try {
        return await PROVIDERS[provider].generate(request);
    } catch (err) {
        throw wrapError(err);
    }
}

module.exports = { PROVIDERS, AiError, listModels, generate, pickDefaultModel, assertPublicBaseUrl, DEFAULT_OPENAI_BASE_URL };
