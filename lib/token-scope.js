'use strict';
// A playback capability is confined to its media session, even when the
// administrator generated that preview. It is never an account credential.
function isAccountToken(claims) {
    return !!claims && typeof claims.sub === 'string' && !!claims.sub && !claims.guest &&
        !claims.videoId && !claims.sessionId && !['media', 'perm'].includes(claims.role);
}
module.exports = { isAccountToken };
