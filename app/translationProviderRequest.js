const createTranslationCompletionRequest = async ({ client, payload, signal }) => {
    const request = client.chat.completions.create(payload, { signal });
    if (!request || typeof request.withResponse !== 'function') {
        throw new TypeError('OpenAI SDK response metadata is unavailable');
    }
    return request.withResponse();
};

export {
    createTranslationCompletionRequest,
};
