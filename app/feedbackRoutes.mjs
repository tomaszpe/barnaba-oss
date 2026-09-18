import { createFeedbackStore, FeedbackInputError, FeedbackLimitError } from './feedbackStore.mjs';

export const FEEDBACK_VERSION = 'listener-feedback-v3';

export function feedbackPublicConfig(url) {
    return { url: url || null, clientVersion: FEEDBACK_VERSION };
}

export function registerFeedbackRoutes(app, options, jsonParser) {
    const store = options.store || createFeedbackStore(options);
    const origins = new Set(options.allowedOrigins.filter(Boolean).map(value => new URL(value).origin));
    function originCheck(req, res, next) {
        res.set('Cache-Control', 'no-store');
        const origin = req.get('Origin');
        if (origin && !origins.has(origin)) return res.status(403).json({ error: 'Origin not allowed' });
        if (origin) {
            res.set('Access-Control-Allow-Origin', origin);
            res.vary('Origin');
        }
        next();
    }

    app.options('/api/feedback', originCheck, (req, res) => {
        res.set('Access-Control-Allow-Methods', 'POST');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        res.sendStatus(204);
    });

    app.post('/api/feedback', originCheck, jsonParser, async (req, res) => {
        if (!req.is('application/json')) return res.status(415).json({ error: 'JSON required' });
        const sessionId = req.body?.sessionId;
        if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128) {
            return res.status(400).json({ error: 'Invalid sessionId' });
        }
        if (req.body.kind === 'issue' && !options.instantEnabled) return res.sendStatus(404);
        try {
            const result = await store.save(req.body);
            res.status(result.duplicate ? 200 : 201).json({ success: true, ...result });
        } catch (error) {
            if (error instanceof FeedbackLimitError) return res.status(429).json({ code: 'session_limit' });
            if (error instanceof FeedbackInputError) return res.status(400).json({
                code: error.field === 'email' ? 'invalid_email' : 'invalid_feedback',
            });
            console.warn('[Feedback] Persistent storage unavailable');
            res.status(503).json({ error: 'Unable to save feedback' });
        }
    });

    app.use('/api/feedback', (error, req, res, next) => {
        if (!error) return next();
        res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'Invalid feedback body' });
    });
    return store;
}
