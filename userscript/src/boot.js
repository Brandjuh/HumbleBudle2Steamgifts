/**
 * Welke site zijn we? Eén script, twee gastheren.
 */
'use strict';

(function (root) {
  const HSG = (root.HSG = root.HSG || {});

  function start() {
    try {
      if (location.host === 'www.humblebundle.com') HSG.humble.boot();
      else if (location.host === 'www.steamgifts.com') HSG.steamgifts.boot();
    } catch (error) {
      console.error('[Humble → SteamGifts]', HSG.redact(String(error && error.stack) || error));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
