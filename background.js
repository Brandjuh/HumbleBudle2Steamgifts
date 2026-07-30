/**
 * Service worker: router en state machine voor de wachtrij.
 *
 * Deze worker is bewust stateloos. MV3 sloopt hem na ~30 seconden inactiviteit
 * en start hem daarna opnieuw vanaf regel 1, dus alles wat langer moet leven
 * gaat door storage heen. Alle listeners staan om diezelfde reden synchroon op
 * top level geregistreerd.
 */
'use strict';

importScripts(
  'lib/shared.js',
  'lib/selectors.js',
  'lib/format.js',
  'lib/queue.js'
);

const { MSG, STATUS, STORAGE_KEYS, URLS, DEFAULT_SETTINGS } = HSG;

// --- storage -----------------------------------------------------------------

async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.SETTINGS] || {}) };
}

async function getQueue() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.QUEUE);
  return { ...HSG.emptyQueue(), ...(stored[STORAGE_KEYS.QUEUE] || {}) };
}

async function getCatalog() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.CATALOG);
  return stored[STORAGE_KEYS.CATALOG] || null;
}

/**
 * Read-modify-write op storage is niet atomair, en twee content scripts kunnen
 * in dezelfde tick schrijven. Alles door één promise-keten duwen.
 */
let writeChain = Promise.resolve();
function withQueue(mutator) {
  const next = writeChain.then(async () => {
    const queue = await getQueue();
    const result = await mutator(queue);
    const updated = result && result.queue ? result.queue : queue;
    await chrome.storage.local.set({ [STORAGE_KEYS.QUEUE]: updated });
    return result && result.value !== undefined ? result.value : updated;
  });
  writeChain = next.catch(() => {});
  return next;
}

// --- keys (uitsluitend in session storage) -----------------------------------

async function readKeys() {
  const stored = await chrome.storage.session.get(STORAGE_KEYS.KEYS);
  return stored[STORAGE_KEYS.KEYS] || {};
}

async function writeKeys(keys) {
  await chrome.storage.session.set({ [STORAGE_KEYS.KEYS]: keys });
}

async function forgetKey(itemId) {
  const keys = await readKeys();
  if (!(itemId in keys)) return;
  delete keys[itemId];
  await writeKeys(keys);
}

// --- tabs --------------------------------------------------------------------

async function findTab(urlPattern) {
  const tabs = await chrome.tabs.query({ url: urlPattern });
  return tabs.length ? tabs[0] : null;
}

async function openOrFocusSteamGifts(queue) {
  if (queue.sgTabId != null) {
    try {
      await chrome.tabs.update(queue.sgTabId, {
        url: URLS.SG_NEW_GIVEAWAY,
        active: true,
      });
      return queue.sgTabId;
    } catch (error) {
      // Tab is inmiddels gesloten; verderop maken we een nieuwe.
    }
  }
  const tab = await chrome.tabs.create({ url: URLS.SG_NEW_GIVEAWAY, active: true });
  return tab.id;
}

// --- reveal-resultaten opslaan ----------------------------------------------

/**
 * Neemt de uitkomst van een reveal-ronde op de Humble-pagina over: keys naar
 * session storage, metadata naar de wachtrij. Mislukte spellen komen wél in de
 * lijst, met foutstatus, zodat je ziet wat er niet gelukt is.
 */
async function storeRevealResults(results) {
  const ok = [];
  const failed = [];
  const keys = await readKeys();

  for (const result of results || []) {
    const id = HSG.itemId(result.gamekey, result.machineName);
    if (result.key) {
      keys[id] = result.key;
      ok.push(result);
    } else {
      failed.push(result);
    }
  }
  await writeKeys(keys);

  return withQueue(async (queue) => {
    let next = HSG.addItems(queue, ok.concat(failed)).queue;

    // addItems laat bestaande items met rust. Een spel dat de vorige keer
    // mislukte en nu wél een key opleverde moet daarom expliciet terug op
    // pending — anders blijft het als fout in de wachtrij hangen.
    for (const result of ok) {
      const id = HSG.itemId(result.gamekey, result.machineName);
      const existing = next.items.find((item) => item.id === id);
      if (existing && existing.status === STATUS.ERROR) {
        next = HSG.updateItem(next, id, { status: STATUS.PENDING, error: null });
      }
    }
    for (const result of failed) {
      next = HSG.updateItem(next, HSG.itemId(result.gamekey, result.machineName), {
        status: STATUS.ERROR,
        error: result.error || 'Key ophalen mislukt',
      });
    }
    return {
      queue: next,
      value: { added: ok.length, failed: failed.length, queue: next },
    };
  });
}

// --- berichtafhandeling ------------------------------------------------------

const handlers = {
  async [MSG.GET_STATE]() {
    const [settings, queue, catalog, stored, keys] = await Promise.all([
      getSettings(),
      getQueue(),
      getCatalog(),
      chrome.storage.local.get(STORAGE_KEYS.DIAGNOSTICS),
      readKeys(),
    ]);
    return {
      settings,
      queue,
      catalog,
      diagnostics: stored[STORAGE_KEYS.DIAGNOSTICS] || null,
      keyIds: Object.keys(keys),
      summary: HSG.summarize(queue),
    };
  },

  async [MSG.SET_SETTINGS](message) {
    const settings = { ...(await getSettings()), ...(message.patch || {}) };
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
    return { settings };
  },

  /** Het zijpaneel vraagt de Humble-tab om opnieuw te scannen. */
  async [MSG.HUMBLE_SCAN_REQUEST]() {
    const tab = await findTab('https://www.humblebundle.com/*');
    if (!tab) {
      throw new Error(
        'Geen Humble-tab open. Ga naar je Humble Choice-maandpagina en probeer opnieuw.'
      );
    }
    const response = await chrome.tabs.sendMessage(tab.id, { type: MSG.HUMBLE_SCAN });
    if (response && response.error) throw new Error(response.error);
    return response;
  },

  /** Catalogus die de Humble-tab uit zichzelf doorgeeft bij het laden. */
  async [MSG.HUMBLE_CATALOG](message, sender) {
    const catalog = {
      ...message.catalog,
      tabId: sender.tab ? sender.tab.id : null,
      scannedAt: Date.now(),
    };
    await chrome.storage.local.set({ [STORAGE_KEYS.CATALOG]: catalog });
    return { ok: true };
  },

  /** Reveal-resultaten die vanaf de pagina-balk binnenkomen. */
  async [MSG.HUMBLE_ADD_SELECTION](message) {
    return storeRevealResults(message.results);
  },

  /** Het zijpaneel wil games toevoegen; de Humble-tab doet het onthullen. */
  async [MSG.QUEUE_ADD](message) {
    // Bij voorkeur de tab die de catalogus aanleverde; die is inmiddels
    // misschien weggenavigeerd, vandaar de url-controle en de terugval.
    const catalog = await getCatalog();
    const remembered =
      catalog && catalog.tabId != null
        ? await chrome.tabs.get(catalog.tabId).catch(() => null)
        : null;
    const usable =
      remembered && String(remembered.url || '').startsWith('https://www.humblebundle.com/')
        ? remembered
        : null;
    const tab = usable || (await findTab('https://www.humblebundle.com/*'));

    if (!tab) {
      throw new Error(
        'Geen Humble-tab open. De keys kunnen alleen vanaf humblebundle.com opgehaald worden.'
      );
    }

    const settings = await getSettings();
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: MSG.HUMBLE_REVEAL,
      ids: message.ids || [],
      delayMs: settings.revealDelayMs,
    });
    if (response && response.error) throw new Error(response.error);
    return storeRevealResults(response.results);
  },

  async [MSG.QUEUE_REMOVE](message) {
    await forgetKey(message.id);
    return withQueue((queue) => ({ queue: HSG.removeItem(queue, message.id) }));
  },

  async [MSG.QUEUE_MOVE](message) {
    return withQueue((queue) => ({
      queue: HSG.moveItem(queue, message.id, message.delta),
    }));
  },

  async [MSG.QUEUE_CLEAR]() {
    await chrome.storage.session.remove(STORAGE_KEYS.KEYS);
    return withQueue(() => ({ queue: HSG.emptyQueue() }));
  },

  async [MSG.QUEUE_RETRY](message) {
    return withQueue((queue) => ({ queue: HSG.retryItem(queue, message.id) }));
  },

  async [MSG.QUEUE_START]() {
    const queue = await getQueue();
    const startIndex = queue.items.findIndex(
      (item) => item.status !== STATUS.DONE && item.status !== STATUS.ERROR
    );
    if (startIndex === -1) {
      throw new Error('Er staat niets meer klaar in de wachtrij.');
    }
    const tabId = await openOrFocusSteamGifts(queue);
    return withQueue((current) => ({
      queue: { ...current, cursor: startIndex, running: true, sgTabId: tabId },
    }));
  },

  async [MSG.QUEUE_PAUSE]() {
    return withQueue((queue) => ({ queue: { ...queue, running: false } }));
  },

  async [MSG.KEYS_CLEAR]() {
    await chrome.storage.session.remove(STORAGE_KEYS.KEYS);
    return { ok: true };
  },

  /**
   * Read-only controle of onze selectors nog kloppen. Verandert niets en
   * onthult niets — bedoeld om vóór het echte werk te draaien.
   */
  async [MSG.RUN_DIAGNOSE](message) {
    const isHumble = message.site === 'humble';
    const pattern = isHumble
      ? 'https://www.humblebundle.com/*'
      : 'https://www.steamgifts.com/*';
    const tab = await findTab(pattern);
    if (!tab) {
      throw new Error(
        isHumble
          ? 'Open eerst je Humble Choice-maandpagina in een tab.'
          : 'Open eerst https://www.steamgifts.com/giveaways/new in een tab.'
      );
    }
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: isHumble ? MSG.HUMBLE_DIAGNOSE : MSG.SG_DIAGNOSE,
    });

    const stored = await chrome.storage.local.get(STORAGE_KEYS.DIAGNOSTICS);
    const diagnostics = {
      ...(stored[STORAGE_KEYS.DIAGNOSTICS] || {}),
      [message.site]: { ...response, at: Date.now(), url: tab.url },
    };
    await chrome.storage.local.set({ [STORAGE_KEYS.DIAGNOSTICS]: diagnostics });
    return diagnostics;
  },

  /** Gebruiker koos handmatig het juiste spel na een dubbelzinnige match. */
  async [MSG.PICK_CANDIDATE](message) {
    const result = await withQueue((queue) => {
      const next = HSG.updateItem(queue, message.id, {
        sgGameId: message.gameId,
        sgGameName: message.gameName,
        status: STATUS.PENDING,
        candidates: null,
        error: null,
      });
      const index = next.items.findIndex((item) => item.id === message.id);
      return {
        queue: { ...next, cursor: index === -1 ? next.cursor : index, running: true },
      };
    });
    await openOrFocusSteamGifts(result);
    return result;
  },

  /** SteamGifts-formulier is geladen en vraagt om werk. */
  async [MSG.SG_READY](message, sender) {
    const queue = await getQueue();
    if (!queue.running) return { job: null };

    const senderTabId = sender.tab ? sender.tab.id : null;
    if (queue.sgTabId != null && senderTabId !== queue.sgTabId) {
      return { job: null };
    }

    const item = HSG.currentItem(queue);
    if (!item || item.status === STATUS.DONE || item.status === STATUS.ERROR) {
      return { job: null };
    }

    const keys = await readKeys();
    const key = keys[item.id];
    if (!key) {
      await withQueue((current) => ({
        queue: {
          ...HSG.updateItem(current, item.id, {
            status: STATUS.ERROR,
            error:
              'Key niet meer beschikbaar (browser herstart?). Haal hem opnieuw op via de Humble-pagina.',
          }),
          running: false,
        },
      }));
      return { job: null };
    }

    if (senderTabId != null && queue.sgTabId == null) {
      await withQueue((current) => ({ queue: { ...current, sgTabId: senderTabId } }));
    }

    const settings = await getSettings();
    return {
      job: {
        item,
        key,
        settings,
        index: queue.cursor,
        total: queue.items.length,
      },
    };
  },

  async [MSG.SG_FILLED](message) {
    return withQueue((queue) => ({
      queue: HSG.updateItem(queue, message.id, {
        status: STATUS.FILLED,
        sgGameId: message.sgGameId || null,
        sgGameName: message.sgGameName || null,
        error: null,
      }),
    }));
  },

  async [MSG.SG_NEEDS_CHOICE](message) {
    return withQueue((queue) => ({
      queue: {
        ...HSG.updateItem(queue, message.id, {
          status: STATUS.NEEDS_CHOICE,
          candidates: message.candidates || [],
          error: message.reason || 'Geen eenduidige match op SteamGifts.',
        }),
        running: false,
      },
    }));
  },

  async [MSG.SG_FAILED](message) {
    return withQueue((queue) => ({
      queue: {
        ...HSG.updateItem(queue, message.id, {
          status: STATUS.ERROR,
          error: message.message || 'Onbekende fout',
        }),
        running: false,
      },
    }));
  },

  /**
   * Een giveaway-pagina is geladen. We accepteren dit alleen als het echt onze
   * tab is en het huidige item daadwerkelijk klaarstond om verzonden te worden —
   * anders zou gewoon rondklikken op SteamGifts items als klaar markeren.
   */
  async [MSG.SG_CREATED](message, sender) {
    const queue = await getQueue();
    const senderTabId = sender.tab ? sender.tab.id : null;
    const item = HSG.currentItem(queue);

    if (
      !queue.running ||
      !item ||
      item.status !== STATUS.FILLED ||
      (queue.sgTabId != null && senderTabId !== queue.sgTabId)
    ) {
      return { accepted: false };
    }

    await forgetKey(item.id);
    const updated = await withQueue((current) => {
      const marked = HSG.updateItem(current, item.id, {
        status: STATUS.DONE,
        giveawayUrl: message.url || null,
        error: null,
      });
      return { queue: HSG.advance(marked) };
    });

    if (updated.running && HSG.currentItem(updated) && senderTabId != null) {
      await chrome.tabs.update(senderTabId, { url: URLS.SG_NEW_GIVEAWAY });
    }
    return { accepted: true, done: !updated.running };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message && message.type];
  if (!handler) return false;

  Promise.resolve(handler(message, sender)).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: String((error && error.message) || error) })
  );
  return true; // houdt het antwoordkanaal open
});

// --- levenscyclus ------------------------------------------------------------

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

chrome.runtime.onStartup.addListener(() => {
  // session storage is bij een browserstart al leeg; dit is bandenplak-werk.
  chrome.storage.session.remove(STORAGE_KEYS.KEYS).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  withQueue((queue) =>
    queue.sgTabId === tabId ? { queue: { ...queue, sgTabId: null } } : { queue }
  ).catch(() => {});
});
