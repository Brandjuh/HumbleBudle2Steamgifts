/**
 * De wachtrij als pure reducer. Geen chrome-API's hier, zodat dit met
 * `node --test` te testen is en de service worker er alleen state in en uit
 * hoeft te schuiven.
 *
 * Ontwerpregel: de wachtrij bevat nooit een key. Keys leven in
 * chrome.storage.session, gesleuteld op item-id. Zo kan de wachtrij zelf
 * gewoon op schijf staan.
 */
'use strict';

(function (root) {
  const HSG = (root.HSG = root.HSG || {});
  const STATUS = HSG.STATUS;

  HSG.emptyQueue = function () {
    return { items: [], cursor: 0, running: false, sgTabId: null };
  };

  /** Maakt een wachtrij-item van een catalogusregel. */
  HSG.makeItem = function (game) {
    return {
      id: HSG.itemId(game.gamekey, game.machineName),
      machineName: game.machineName,
      humanName: game.humanName,
      gamekey: game.gamekey,
      keyindex: game.keyindex,
      steamAppId: game.steamAppId != null ? game.steamAppId : null,
      steamPackageId: game.steamPackageId != null ? game.steamPackageId : null,
      disallowedCountries: game.disallowedCountries || [],
      exclusiveCountries: game.exclusiveCountries || [],
      expiry: game.expiry || null,
      steamdb: game.steamdb || null,
      status: STATUS.PENDING,
      error: null,
      sgGameId: null,
      sgGameName: null,
      giveawayUrl: null,
      candidates: null,
    };
  };

  /** Voegt toe zonder duplicaten; bestaande items blijven met hun status staan. */
  HSG.addItems = function (queue, games) {
    const next = { ...queue, items: queue.items.slice() };
    const known = new Set(next.items.map((item) => item.id));
    let added = 0;
    for (const game of games || []) {
      const item = HSG.makeItem(game);
      if (known.has(item.id)) continue;
      known.add(item.id);
      next.items.push(item);
      added += 1;
    }
    return { queue: next, added };
  };

  /**
   * Verwijdert een item en houdt de cursor op hetzelfde item gericht.
   * Zonder die correctie slaat het verwijderen van een afgehandeld item stilletjes
   * het volgende spel over.
   */
  HSG.removeItem = function (queue, id) {
    const index = queue.items.findIndex((item) => item.id === id);
    if (index === -1) return queue;
    const items = queue.items.slice();
    items.splice(index, 1);
    const cursor = index < queue.cursor ? queue.cursor - 1 : queue.cursor;
    return { ...queue, items, cursor: Math.max(0, Math.min(cursor, items.length)) };
  };

  /** Verschuift een item in de lijst. De cursor volgt de inhoud, niet de index. */
  HSG.moveItem = function (queue, id, delta) {
    const from = queue.items.findIndex((item) => item.id === id);
    if (from === -1) return queue;
    const to = from + delta;
    if (to < 0 || to >= queue.items.length) return queue;

    const currentId = queue.items[queue.cursor] ? queue.items[queue.cursor].id : null;
    const items = queue.items.slice();
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);

    let cursor = queue.cursor;
    if (currentId) {
      const found = items.findIndex((item) => item.id === currentId);
      if (found !== -1) cursor = found;
    }
    return { ...queue, items, cursor };
  };

  HSG.currentItem = function (queue) {
    return queue.items[queue.cursor] || null;
  };

  HSG.updateItem = function (queue, id, patch) {
    const items = queue.items.map((item) =>
      item.id === id ? { ...item, ...patch } : item
    );
    return { ...queue, items };
  };

  /**
   * Schuift de cursor naar het eerstvolgende item dat nog werk nodig heeft.
   * Items met status DONE of ERROR worden overgeslagen; ERROR blijft in de lijst
   * staan zodat je 'm in het zijpaneel kunt zien en opnieuw kunt proberen.
   */
  HSG.advance = function (queue) {
    let cursor = queue.cursor + 1;
    while (
      cursor < queue.items.length &&
      (queue.items[cursor].status === STATUS.DONE ||
        queue.items[cursor].status === STATUS.ERROR)
    ) {
      cursor += 1;
    }
    const running = cursor < queue.items.length ? queue.running : false;
    return { ...queue, cursor, running };
  };

  /** Zet een item terug op pending en richt de cursor erop. */
  HSG.retryItem = function (queue, id) {
    const index = queue.items.findIndex((item) => item.id === id);
    if (index === -1) return queue;
    const next = HSG.updateItem(queue, id, {
      status: STATUS.PENDING,
      error: null,
      candidates: null,
    });
    return { ...next, cursor: index };
  };

  HSG.summarize = function (queue) {
    const counts = { pending: 0, filled: 0, done: 0, error: 0, needsChoice: 0 };
    for (const item of queue.items) {
      if (item.status === STATUS.DONE) counts.done += 1;
      else if (item.status === STATUS.ERROR) counts.error += 1;
      else if (item.status === STATUS.NEEDS_CHOICE) counts.needsChoice += 1;
      else if (item.status === STATUS.FILLED) counts.filled += 1;
      else counts.pending += 1;
    }
    return { total: queue.items.length, ...counts };
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = HSG;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
