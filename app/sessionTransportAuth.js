export function bearerSessionToken(authorizationHeader) {
    const header = typeof authorizationHeader === 'string' ? authorizationHeader.trim() : '';
    const match = /^Bearer\s+([^\s]{1,2048})$/i.exec(header);
    return match ? match[1] : null;
}
