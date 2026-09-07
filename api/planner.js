// Serverless proxy for the Temple Planner chat feature.
// Runs on Vercel (Node.js runtime). The Groq API key lives only in this
// server-side environment variable — it is never sent to the browser.
//
// Deploy: put this file at /api/planner.js in the same project as
// index.html, then in the Vercel project dashboard go to
// Settings -> Environment Variables and add:
//   GROQ_API_KEY = your key from https://console.groq.com/keys

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-120b';

// Very small in-memory rate limiter. Resets whenever the serverless
// function cold-starts, so it's a soft speed bump, not a hard guarantee —
// good enough to blunt casual abuse without adding a database. For
// stronger protection, swap this for Vercel KV / Upstash Redis.
const requestLog = new Map(); // ip -> array of request timestamps (ms)
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 8;

function isRateLimited(ip) {
    const now = Date.now();
    const timestamps = (requestLog.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    timestamps.push(now);
    requestLog.set(ip, timestamps);
    return timestamps.length > RATE_LIMIT_MAX_REQUESTS;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        console.error('GROQ_API_KEY is not set in the server environment.');
        return res.status(500).json({ error: 'Planner is not configured on the server yet.' });
    }

    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    if (isRateLimited(ip)) {
        return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }

    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'A non-empty "messages" array is required.' });
    }
    if (messages.length > 20) {
        return res.status(400).json({ error: 'Conversation is too long for one request.' });
    }
    // Cap total payload size so a malicious caller can't send a huge system
    // prompt through this endpoint and run up token costs.
    const totalChars = messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0);
    if (totalChars > 20000) {
        return res.status(400).json({ error: 'Message content is too large.' });
    }

    try {
        const groqResponse = await fetch(GROQ_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: GROQ_MODEL,
                temperature: 0.4,
                max_tokens: 700,
                messages
            })
        });

        const data = await groqResponse.json();

        if (!groqResponse.ok) {
            console.error('Groq API error:', data);
            return res.status(groqResponse.status).json({ error: data?.error?.message || 'Groq API error.' });
        }

        return res.status(200).json(data);
    } catch (err) {
        console.error('Proxy error:', err);
        return res.status(500).json({ error: 'Failed to reach the AI service.' });
    }
}
