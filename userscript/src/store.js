/**
 * Opslag. Vervangt de service worker van de extensieversie.
 *
 * Tampermonkey's `GM_setValue` is gedeeld tussen alle pagina's waar dit script
 * draait, dus Humble en SteamGifts kijken naar dezelfde wachtrij zonder dat er
 * berichten heen en weer hoeven. Dat scheelt de hele router.
 *
 * Wat we hier wél moeten oplossen en de extensie gratis kreeg: `GM_setValue`
 * schrijft naar schijf. Er is geen tegenhanger van `chrome.storage.session`.
 * Keys krijgen daarom een vervaldatum en worden gewist zodra ze geplakt zijn.
 */
'use strict';

(function (root) {
  const HSG = (root.HSG = root.HSG || {});

  const KEYS = {
    SETTINGS: 'settings',
    QUEUE: 'queue',
    CATALOG: 'catalog',
    SECRETS: 'secrets',
    STEAMDB_CACHE: 'steamdbCache',
    STEAMDB_JOBS: 'steamdbJobs',
  };

  /** Hoe lang SteamDB-pakketdata houdbaar is. Restricties wijzigen zelden. */
  const STEAMDB_TTL_OK_MS = 14 * 24 * 3600 * 1000;
  /** Negatieve of verouderde uitkomsten korter bewaren: die kunnen bijtrekken. */
  const STEAMDB_TTL_BAD_MS = 24 * 3600 * 1000;

  const read = (name, fallback) => {
    try {
      const raw = GM_getValue(name, null);
      if (raw == null) return fallback;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (error) {
      return fallback;
    }
  };

  const write = (name, value) => GM_setValue(name, JSON.stringify(value));

  /** Een cache-item alleen teruggeven zolang het houdbaar is. */
  const freshSteamdbEntry = (entry) => {
    if (!entry || !entry.fetchedAt) return null;
    const ttl = entry.status === 'ok' ? STEAMDB_TTL_OK_MS : STEAMDB_TTL_BAD_MS;
    return Date.now() - entry.fetchedAt < ttl ? entry : null;
  };

  const store = {
    // --- instellingen ---------------------------------------------------------

    getSettings() {
      return { ...HSG.DEFAULT_SETTINGS, ...read(KEYS.SETTINGS, {}) };
    },

    setSettings(patch) {
      const settings = { ...store.getSettings(), ...patch };
      write(KEYS.SETTINGS, settings);
      return settings;
    },

    // --- catalogus ------------------------------------------------------------

    getCatalog() {
      return read(KEYS.CATALOG, null);
    },

    setCatalog(catalog) {
      write(KEYS.CATALOG, catalog);
    },

    // --- wachtrij -------------------------------------------------------------

    getQueue() {
      return { ...HSG.emptyQueue(), ...read(KEYS.QUEUE, {}) };
    },

    setQueue(queue) {
      write(KEYS.QUEUE, queue);
      return queue;
    },

    /**
     * Lees-wijzig-schrijf op één plek. GM_setValue is synchroon, dus binnen één
     * pagina is dit veilig; twee tabbladen die tegelijk schrijven blijft een
     * theoretisch risico, maar in deze flow werkt er maar één tegelijk.
     */
    withQueue(mutator) {
      const result = mutator(store.getQueue());
      const queue = result && result.queue ? result.queue : result;
      return store.setQueue(queue || store.getQueue());
    },

    // --- keys -----------------------------------------------------------------

    /**
     * Keys staan als `{ key, at }` opgeslagen. De tijdstempel is er niet voor de
     * sier: dit is schijfopslag, dus alles wat te lang blijft liggen gooien we
     * weg in plaats van het te laten rondslingeren.
     */
    readSecrets() {
      const ttlHours = store.getSettings().keyTtlHours || 12;
      const cutoff = Date.now() - ttlHours * 3600 * 1000;
      const stored = read(KEYS.SECRETS, {});
      const kept = {};
      let dropped = 0;

      for (const [id, entry] of Object.entries(stored)) {
        if (!entry || !entry.key) continue;
        if (entry.at && entry.at < cutoff) {
          dropped += 1;
          continue;
        }
        kept[id] = entry;
      }
      if (dropped) write(KEYS.SECRETS, kept);
      return kept;
    },

    getKey(id) {
      const entry = store.readSecrets()[id];
      return entry ? entry.key : null;
    },

    hasKey(id) {
      return Boolean(store.getKey(id));
    },

    keyIds() {
      return Object.keys(store.readSecrets());
    },

    putKeys(pairs) {
      const secrets = store.readSecrets();
      const at = Date.now();
      for (const [id, key] of Object.entries(pairs || {})) {
        if (key) secrets[id] = { key, at };
      }
      write(KEYS.SECRETS, secrets);
    },

    forgetKey(id) {
      const secrets = store.readSecrets();
      if (!(id in secrets)) return;
      delete secrets[id];
      write(KEYS.SECRETS, secrets);
    },

    clearKeys() {
      write(KEYS.SECRETS, {});
    },

    // --- SteamDB-cache --------------------------------------------------------

    /**
     * Pakketdata van SteamDB, gesleuteld op subid/appid. Vers genoeg = niet
     * opnieuw ophalen; zo blijft het aantal paginaweergaven minimaal.
     */
    readSteamdbSub(subId) {
      const cache = read(KEYS.STEAMDB_CACHE, {});
      return freshSteamdbEntry((cache.subs || {})[String(subId)]);
    },

    putSteamdbSub(subId, entry) {
      const cache = read(KEYS.STEAMDB_CACHE, {});
      cache.subs = cache.subs || {};
      cache.subs[String(subId)] = { ...entry, fetchedAt: Date.now() };
      write(KEYS.STEAMDB_CACHE, cache);
    },

    readSteamdbApp(appId) {
      const cache = read(KEYS.STEAMDB_CACHE, {});
      return freshSteamdbEntry((cache.apps || {})[String(appId)]);
    },

    putSteamdbApp(appId, entry) {
      const cache = read(KEYS.STEAMDB_CACHE, {});
      cache.apps = cache.apps || {};
      cache.apps[String(appId)] = { ...entry, fetchedAt: Date.now() };
      write(KEYS.STEAMDB_CACHE, cache);
    },

    steamdbCacheStats() {
      const cache = read(KEYS.STEAMDB_CACHE, {});
      return {
        subs: Object.keys(cache.subs || {}).length,
        apps: Object.keys(cache.apps || {}).length,
      };
    },

    clearSteamdbCache() {
      write(KEYS.STEAMDB_CACHE, {});
    },

    /** Het takenlijstje voor het SteamDB-werktabblad. */
    getSteamdbJobs() {
      return read(KEYS.STEAMDB_JOBS, null);
    },

    setSteamdbJobs(record) {
      write(KEYS.STEAMDB_JOBS, record ? { ...record, updatedAt: Date.now() } : null);
    },

    // --- meeluisteren ---------------------------------------------------------

    /**
     * Wijzigingen uit een ander tabblad. Zo ziet het paneel op Humble dat de
     * SteamGifts-tab een giveaway heeft aangemaakt.
     */
    onChange(name, callback) {
      if (typeof GM_addValueChangeListener !== 'function') return;
      GM_addValueChangeListener(name, (key, oldValue, newValue, remote) => {
        callback({ remote });
      });
    },

    NAMES: KEYS,
  };

  // --- wachtrij-acties --------------------------------------------------------

  /**
   * Neemt de uitkomst van een reveal-ronde over: keys apart, metadata in de
   * wachtrij. Mislukte spellen komen wél in de lijst, met foutstatus, zodat je
   * ziet wat er niet gelukt is.
   */
  HSG.storeRevealResults = function (results) {
    const ok = [];
    const failed = [];
    const pairs = {};

    for (const result of results || []) {
      const id = HSG.itemId(result.gamekey, result.machineName);
      if (result.key) {
        pairs[id] = result.key;
        ok.push(result);
      } else {
        failed.push(result);
      }
    }
    store.putKeys(pairs);

    const queue = store.withQueue((current) => {
      let next = HSG.addItems(current, ok.concat(failed)).queue;

      // addItems laat bestaande items met rust. Een spel dat de vorige keer
      // mislukte en nu wél een key opleverde moet daarom expliciet terug op
      // pending, anders blijft het als fout in de wachtrij hangen.
      for (const result of ok) {
        const id = HSG.itemId(result.gamekey, result.machineName);
        const existing = next.items.find((item) => item.id === id);
        if (existing && existing.status === HSG.STATUS.ERROR) {
          next = HSG.updateItem(next, id, { status: HSG.STATUS.PENDING, error: null });
        }
      }
      for (const result of failed) {
        next = HSG.updateItem(next, HSG.itemId(result.gamekey, result.machineName), {
          status: HSG.STATUS.ERROR,
          error: result.error || 'Key ophalen mislukt',
        });
      }
      return { queue: next };
    });

    return { added: ok.length, failed: failed.length, queue };
  };

  HSG.store = store;

  if (typeof module === 'object' && module.exports) {
    module.exports = HSG;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
