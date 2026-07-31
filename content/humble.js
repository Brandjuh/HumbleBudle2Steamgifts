/**
 * Content script voor humblebundle.com.
 *
 * Werkt op de **keys-pagina** (`/downloads?key=…` of `/home/keys`). Daar staan
 * de keys die je op de maandpagina hebt opgehaald, en daar begint dus onze flow:
 * aanvinken wat je weg wilt geven → keys ophalen → wachtrij.
 *
 * De DOM is de primaire bron. Het keyveld ziet er zo uit:
 *
 *   <div class="js-keyfield keyfield redeemed enabled" title="XXXXX-YYYYY-ZZZZZ">
 *
 * De JSON-API is de aanvulling: die levert `steam_app_id`, `key_type`,
 * `machine_name` en `keyindex`. Het appid is wat de SteamGifts-kant eenduidig
 * laat matchen, dus die aanvulling is de moeite waard — maar zonder werkt het
 * ook, dan wordt er op titel gezocht.
 *
 * (Eerder haalde dit script alles uit een JSON-blob op de membership-pagina.
 * Die blob staat er niet meer, waardoor de scan terugviel op álle orders en de
 * hele bibliotheek toonde in plaats van de maand.)
 *
 * Alle netwerkcalls naar Humble gebeuren hier en nergens anders. Vanuit de
 * service worker zouden het cross-origin requests worden — die zijn in MV3
 * CORS-geblokkeerd, en Humble zit bovendien achter Cloudflare. Same-origin
 * vanuit de pagina zelf gaat goed en stuurt de sessiecookie mee.
 */
'use strict';

(() => {
  const { MSG, SELECTORS } = HSG;
  const H = SELECTORS.humble;

  const state = {
    gamekey: null,
    csrf: null,
    games: [],
    byId: new Map(),
    selected: new Set(),
    /** Keys die al in de DOM stonden. Bewust apart: deze gaan nooit mee in de
     *  catalogus, want die belandt via de service worker in storage.local. */
    domKeys: new Map(),
    /** DOM-element per catalogusregel, voor de onthul-terugval. */
    domNodes: new Map(),
    source: null,
    scanError: null,
    bundles: [],
    truncatedOrders: 0,
    /** Orders die we deze sessie al opgehaald hebben; niet nog eens doen. */
    fetchedOrders: new Set(),
    /** Verzamelde API-regels, groeit mee terwijl je door Humble bladert. */
    apiEntries: [],
    /** Laatst gepubliceerde vingerafdruk; voorkomt overbodige storage-schrijfacties. */
    publishedSignature: null,
    /** Vingerafdruk van de DOM bij de laatste scan. */
    scannedSignature: null,
  };

  /** Zoveel orders halen we hooguit op per scan; daarboven meldt het zijpaneel het. */
  const MAX_ORDERS_PER_SCAN = 12;

  const page = {
    get isKeysPage() {
      // Humble gebruikt zowel /download?key=… (de bundellink in een key-rij) als
      // /downloads?key=… — beide dekken met één prefix.
      return (
        location.pathname.startsWith('/home/keys') ||
        location.pathname.startsWith('/download')
      );
    },
    get isMembership() {
      return /^\/(membership|subscription)(\/|$)/.test(location.pathname);
    },
  };

  // --- herkomst van de order ---------------------------------------------------

  /**
   * De order-sleutel. Op `/downloads?key=…` staat die gewoon in de URL — veruit
   * de betrouwbaarste bron, en precies waarom deze pagina zoveel beter werkt
   * dan de maandpagina.
   */
  function readGamekey() {
    const fromUrl = new URLSearchParams(location.search).get('key');
    if (fromUrl) return fromUrl;

    const model = readPageModel();
    if (!model) return null;
    const options = model.data && model.data.contentChoiceOptions;
    return (options && options.gamekey) || (model.data && model.data.gamekey) || null;
  }

  /** Bonus-bron; op de meeste pagina's afwezig. */
  function readPageModel() {
    for (const id of H.modelScriptIds) {
      const el = document.getElementById(id);
      if (!el || !el.textContent) continue;
      try {
        return { id, data: JSON.parse(el.textContent.trim()) };
      } catch (error) {
        // Volgende kandidaat proberen.
      }
    }
    return null;
  }

  function readCsrfToken() {
    const model = readPageModel();
    const raw = model && model.data && model.data.csrfTokenInput;
    const fromModel = typeof raw === 'string' && raw.match(/value=["']([^"']+)["']/);
    if (fromModel) return fromModel[1];

    const input = document.querySelector(H.csrfInput);
    const fromDom = input && input.getAttribute('value');
    if (fromDom) return fromDom;

    const cookie = document.cookie.match(/(?:^|;\s*)csrf_cookie=([^;]+)/);
    return cookie ? decodeURIComponent(cookie[1]) : null;
  }

  // --- DOM-scan ----------------------------------------------------------------

  /** Klimt vanaf het keyveld omhoog naar de rij die er omheen zit. */
  function findRow(keyField) {
    for (const selector of H.rowContainers) {
      const row = keyField.closest(selector);
      if (row && row !== keyField) return row;
    }
    return keyField.parentElement || keyField;
  }

  /** Verzamelt de losse teksten in een rij, zonder die van het keyveld zelf. */
  function rowTexts(row, keyField) {
    const texts = [];
    for (const el of row.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      if (keyField.contains(el) || el === keyField) continue;
      texts.push(el.textContent);
    }
    return texts;
  }

  /**
   * De spelnaam. Staat er een echt naamelement in de rij (`.game-name h4`), dan
   * is dat het antwoord — punt. Alleen als dat ontbreekt vallen we terug op de
   * heuristiek, en die kan ernaast zitten: eerder koos hij de disclaimer die in
   * elke rij staat, waardoor alle rijen dezelfde naam kregen.
   */
  function readRowName(row, keyField) {
    const named = row.querySelector(H.rowName);
    if (named && !keyField.contains(named)) {
      const text = named.textContent.replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
    return HSG.pickRowName(rowTexts(row, keyField));
  }

  /** De bundel waar deze rij bij hoort, inclusief order-sleutel. */
  function readRowBundle(row) {
    const link = row.querySelector(H.rowBundleLink);
    if (!link) return { gamekey: null, bundleName: null };
    return {
      gamekey: HSG.parseOrderKey(link.getAttribute('href')),
      bundleName: link.textContent.replace(/\s+/g, ' ').trim() || null,
    };
  }

  function rowPlatform(row) {
    for (const el of row.querySelectorAll(H.platformIcon)) {
      const platform = HSG.detectPlatform(el.className);
      if (platform) return platform;
    }
    return HSG.detectPlatform(row.className);
  }

  /**
   * Leest wat er op deze pagina aan keys staat. Doet geen enkel netwerkverzoek
   * en onthult niets — puur wat al zichtbaar is.
   */
  function scanDom() {
    const entries = [];
    const used = new Set();

    document.querySelectorAll(H.keyField).forEach((keyField, index) => {
      const row = findRow(keyField);
      const humanName = readRowName(row, keyField);
      if (!humanName) return;

      const bundle = readRowBundle(row);
      const revealedKey = keyField.classList.contains(H.redeemedClass)
        ? (keyField.getAttribute('title') || '').trim()
        : '';
      const unavailable =
        keyField.classList.contains(H.disabledClass) && !revealedKey;

      // Zonder machine_name (die komt uit de API) is de genormaliseerde naam de
      // enige stabiele sleutel. Stabiel is belangrijk: onder deze id staat
      // straks de key in session storage.
      const slug = HSG.normalizeTitle(humanName).replace(/\s+/g, '-') || `rij-${index}`;
      let id = HSG.itemId(bundle.gamekey || state.gamekey || 'dom', slug);

      // Botsen twee rijen tóch, dan krijgen ze een volgnummer. De tweede stil
      // laten vallen is precies hoe de lijst eerder tot één regel samenklapte.
      if (used.has(id)) {
        let suffix = 2;
        while (used.has(`${id}-${suffix}`)) suffix += 1;
        id = `${id}-${suffix}`;
      }
      used.add(id);

      entries.push({
        id,
        machineName: null,
        humanName,
        gamekey: bundle.gamekey || state.gamekey || null,
        keyindex: null,
        steamAppId: null,
        keyType: rowPlatform(row),
        revealed: Boolean(revealedKey),
        unavailable,
        disallowedCountries: [],
        exclusiveCountries: [],
        bundleName: bundle.bundleName,
        fromDom: true,
      });

      if (revealedKey) state.domKeys.set(id, revealedKey);
      state.domNodes.set(id, keyField);
    });

    return entries;
  }

  // --- Humble API --------------------------------------------------------------

  async function fetchJson(url) {
    const response = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Humble antwoordde met ${response.status} op ${url}`);
    }
    return response.json();
  }

  const fetchOrder = (gamekey) =>
    fetchJson(`/api/v1/order/${encodeURIComponent(gamekey)}?all_tpkds=true`);

  async function fetchAllOrders() {
    const list = await fetchJson('/api/v1/user/order');
    const gamekeys = (list || []).map((entry) => entry.gamekey).filter(Boolean);
    const orders = [];
    for (let i = 0; i < gamekeys.length; i += 20) {
      const chunk = gamekeys.slice(i, i + 20);
      const params = new URLSearchParams();
      params.set('all_tpkds', 'true');
      for (const gamekey of chunk) params.append('gamekeys', gamekey);
      const bulk = await fetchJson(`/api/v1/orders?${params.toString()}`);
      orders.push(...Object.values(bulk || {}));
    }
    return orders;
  }

  /** Zet een order-object om in catalogusregels. */
  function toApiEntries(order) {
    const gamekey = order && order.gamekey;
    const tpks = (order && order.tpkd_dict && order.tpkd_dict.all_tpks) || [];
    return tpks.filter(HSG.isUsableTpk).map((tpk) => ({
      id: HSG.itemId(gamekey, tpk.machine_name),
      machineName: tpk.machine_name,
      humanName: tpk.human_name || tpk.machine_name,
      gamekey,
      keyindex: tpk.keyindex != null ? tpk.keyindex : 0,
      steamAppId: HSG.normalizeAppId(tpk.steam_app_id),
      keyType: 'steam',
      revealed: Boolean(tpk.redeemed_key_val),
      unavailable: false,
      disallowedCountries: tpk.disallowed_countries || [],
      exclusiveCountries: tpk.exclusive_countries || [],
      bundleName: (order.product && order.product.human_name) || null,
      fromDom: false,
    }));
  }

  /**
   * Voegt DOM- en API-regels samen op genormaliseerde titel.
   *
   * De API wint qua metadata (machine_name, appid, keyindex — daar kunnen we
   * mee onthullen en zoeken), de DOM levert de key die al zichtbaar was. Staat
   * een spel alleen in de DOM, dan gaat het mee zonder appid.
   */
  function merge(domEntries, apiEntries) {
    // Twee sleutels: bundel+titel is eenduidig, titel alleen is de terugval voor
    // rijen waarvan we de order-sleutel niet konden lezen. Zonder de eerste zou
    // hetzelfde spel uit twee bundels door elkaar kunnen lopen.
    const byBundleAndName = new Map();
    const byName = new Map();
    for (const entry of apiEntries) {
      const name = HSG.normalizeTitle(entry.humanName);
      byBundleAndName.set(`${entry.gamekey}|${name}`, entry);
      if (!byName.has(name)) byName.set(name, entry);
    }

    const merged = [];
    const usedApi = new Set();

    for (const domEntry of domEntries) {
      const name = HSG.normalizeTitle(domEntry.humanName);
      const candidate =
        (domEntry.gamekey && byBundleAndName.get(`${domEntry.gamekey}|${name}`)) ||
        byName.get(name);
      const match = candidate && !usedApi.has(candidate.id) ? candidate : null;

      if (!match) {
        merged.push(domEntry);
        continue;
      }
      usedApi.add(match.id);

      // De id verspringt naar die van de API-regel; de al gelezen key en het
      // DOM-element moeten mee, anders raken we ze kwijt.
      const domKey = state.domKeys.get(domEntry.id);
      const node = state.domNodes.get(domEntry.id);
      if (domKey) state.domKeys.set(match.id, domKey);
      if (node) state.domNodes.set(match.id, node);

      merged.push({
        ...match,
        revealed: match.revealed || domEntry.revealed,
        unavailable: domEntry.unavailable,
        bundleName: domEntry.bundleName || match.bundleName,
      });
    }

    // API-regels die niet in de DOM staan horen er ook bij. Dat is meteen de
    // oplossing voor de paginering van Humble: zie je drie rijen van een maand,
    // dan lever de order alsnog álle keys van die maand.
    for (const entry of apiEntries) {
      if (!usedApi.has(entry.id)) merged.push(entry);
    }
    return merged;
  }

  /**
   * @param {'page'|'dom'|'library'} scope
   *   `page`    volledige verse scan van deze pagina
   *   `dom`     alleen de DOM opnieuw lezen; orders die we al hadden niet nog eens
   *             ophalen (gebruikt als Humble rijen bijlaadt of je doorbladert)
   *   `library` alle orders van het account (traag, honderden spellen)
   */
  async function scan(scope) {
    state.scanError = null;
    state.gamekey = readGamekey();
    state.csrf = readCsrfToken();
    state.domNodes.clear();

    if (scope !== 'dom') {
      state.domKeys.clear();
      state.apiEntries = [];
      state.fetchedOrders = new Set();
      state.truncatedOrders = 0;
    }

    const domEntries = scanDom();
    state.bundles = Array.from(
      new Set(domEntries.map((entry) => entry.bundleName).filter(Boolean))
    );

    let apiError = null;
    try {
      if (scope === 'library') {
        state.apiEntries = (await fetchAllOrders()).flatMap(toApiEntries);
      } else {
        // Alleen de orders die op deze pagina voorkomen. Dat is doorgaans een
        // handvol, levert de Steam-appid's, en maakt een maand compleet ongeacht
        // op welke pagina van Humble je staat.
        const wanted = new Set(domEntries.map((entry) => entry.gamekey).filter(Boolean));
        if (state.gamekey) wanted.add(state.gamekey);

        const missing = Array.from(wanted).filter((key) => !state.fetchedOrders.has(key));
        const room = Math.max(0, MAX_ORDERS_PER_SCAN - state.fetchedOrders.size);
        const take = missing.slice(0, room);
        state.truncatedOrders += missing.length - take.length;

        const settled = await Promise.allSettled(take.map(fetchOrder));
        settled.forEach((result, index) => {
          state.fetchedOrders.add(take[index]);
          if (result.status === 'fulfilled') {
            state.apiEntries.push(...toApiEntries(result.value));
          } else {
            apiError = String(
              (result.reason && result.reason.message) || result.reason
            );
          }
        });
      }
    } catch (error) {
      // Niet fataal: zonder API missen we alleen het appid.
      apiError = String(error.message || error);
    }

    const apiEntries = state.apiEntries;
    const games = domEntries.length > 0 ? merge(domEntries, apiEntries) : apiEntries.slice();
    if (domEntries.length > 0) state.source = apiEntries.length ? 'dom+api' : 'dom';
    else state.source = apiEntries.length ? 'api' : 'leeg';

    games.sort((a, b) => a.humanName.localeCompare(b.humanName, 'nl'));

    state.games = games;
    state.scannedSignature = domSignature();
    state.byId = new Map(games.map((game) => [game.id, game]));
    for (const id of Array.from(state.selected)) {
      if (!state.byId.has(id)) state.selected.delete(id);
    }
    state.scanError = apiError;
    return games;
  }

  function catalogPayload() {
    return {
      // Let op: `games` gaat naar storage.local. Nooit keys meesturen —
      // die leven uitsluitend in storage.session, gezet door de service worker.
      games: state.games,
      gamekey: state.gamekey,
      pageUrl: location.href,
      source: state.source,
      keyFieldCount: document.querySelectorAll(H.keyField).length,
      bundles: state.bundles,
      truncatedOrders: state.truncatedOrders,
      apiError: state.scanError,
      hasCsrf: Boolean(state.csrf),
    };
  }

  /**
   * Goedkope vingerafdruk van wat er op de pagina staat. Wordt gebruikt om
   * nutteloos werk te vermijden: elke publicatie naar storage wekt het
   * zijpaneel, en dat hertekende dan zijn lijst terwijl je aan het aanvinken
   * was.
   */
  function domSignature() {
    const fields = document.querySelectorAll(H.keyField);
    if (fields.length === 0) return '0';
    const first = fields[0];
    const last = fields[fields.length - 1];
    return [
      fields.length,
      readRowName(findRow(first), first) || '',
      readRowName(findRow(last), last) || '',
    ].join('|');
  }

  function publishCatalog(force) {
    const payload = catalogPayload();
    const signature = `${payload.games.length}|${payload.source}|${domSignature()}`;
    if (!force && signature === state.publishedSignature) return Promise.resolve(null);
    state.publishedSignature = signature;
    return send({ type: MSG.HUMBLE_CATALOG, catalog: payload });
  }

  // --- keys onthullen ----------------------------------------------------------

  /**
   * Onthult via de API. `gift` wordt bewust nooit meegestuurd: dat levert een
   * gift-link in plaats van een key op en is onomkeerbaar.
   */
  async function revealViaApi(game) {
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    };
    if (state.csrf) headers['CSRF-Prevention-Token'] = state.csrf;

    const response = await fetch('/humbler/redeemkey', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: new URLSearchParams({
        keytype: game.machineName,
        key: game.gamekey,
        keyindex: String(game.keyindex != null ? game.keyindex : 0),
      }),
    });

    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      throw new Error(`Onverwacht antwoord van Humble (HTTP ${response.status})`);
    }
    if (!data || data.success !== true || !data.key) {
      const reason = data && (data.error_msg || data.error);
      throw new Error(reason ? String(reason) : 'Onthullen mislukt');
    }
    return data.key;
  }

  /**
   * Terugval als we geen machine_name/keyindex hebben: het keyveld op de pagina
   * aanklikken en wachten tot `title` gevuld wordt.
   */
  async function revealViaDom(game) {
    const node = state.domNodes.get(game.id);
    if (!node) throw new Error('Geen keyveld op deze pagina gevonden.');

    const existing = (node.getAttribute('title') || '').trim();
    if (existing) return existing;

    // Het klikbare vlak is `.keyfield-value` ("Reveal your Steam key"); zonder
    // dat vlak het keyveld zelf.
    HSG.clickWidget(node.querySelector(H.keyFieldValue) || node);
    const value = await HSG.waitForAttribute(node, 'title', { timeout: 15000 });
    const key = String(value || '').trim();
    if (!key) throw new Error('Het keyveld bleef leeg.');
    return key;
  }

  /**
   * Haalt de keys op voor de gegeven ids, in volgorde van goedkoop naar duur:
   * wat al in de DOM stond, dan de order opnieuw opvragen, dan pas onthullen.
   */
  async function revealKeys(ids, delayMs) {
    // Het zijpaneel werkt op een catalogus uit storage; dit script kan intussen
    // herladen zijn of naar een andere pagina gebladerd. Dan is state leeg of
    // verouderd en zouden we stil niets doen.
    if (state.byId.size === 0) await scan('page');

    let wanted = ids.map((id) => state.byId.get(id)).filter(Boolean);
    if (wanted.length === 0) {
      // Eén keer verse scan proberen voor we het opgeven: de catalogus in het
      // zijpaneel kan van een vorige pagina komen.
      await scan('page');
      wanted = ids.map((id) => state.byId.get(id)).filter(Boolean);
    }
    if (wanted.length === 0) {
      throw new Error(
        `Deze ${ids.length === 1 ? 'key staat' : 'keys staan'} niet op deze pagina. Ga naar de Humble-pagina waar ze staan en klik op "Deze pagina scannen".`
      );
    }

    // Eén keer de order ophalen levert alle al onthulde keys in één klap.
    const known = new Map();
    const gamekeys = Array.from(
      new Set(wanted.map((game) => game.gamekey).filter(Boolean))
    );
    for (const gamekey of gamekeys) {
      try {
        const order = await fetchOrder(gamekey);
        const tpks = (order && order.tpkd_dict && order.tpkd_dict.all_tpks) || [];
        for (const tpk of tpks) {
          if (!tpk.redeemed_key_val) continue;
          known.set(HSG.itemId(gamekey, tpk.machine_name), tpk.redeemed_key_val);
        }
      } catch (error) {
        // Niet fataal: we vallen terug op de DOM of op onthullen.
      }
    }

    const results = [];
    for (let i = 0; i < wanted.length; i += 1) {
      const game = wanted[i];
      const base = {
        machineName: game.machineName || game.id.split(':').pop(),
        humanName: game.humanName,
        gamekey: game.gamekey || 'dom',
        keyindex: game.keyindex != null ? game.keyindex : 0,
        steamAppId: game.steamAppId,
        disallowedCountries: game.disallowedCountries || [],
        exclusiveCountries: game.exclusiveCountries || [],
      };
      try {
        const cached = state.domKeys.get(game.id) || known.get(game.id) || null;
        let key = cached;
        let didReveal = false;

        if (!key && game.unavailable) {
          throw new Error('Humble biedt deze key niet meer aan.');
        }
        if (!key) {
          key =
            game.machineName && game.gamekey
              ? await revealViaApi(game)
              : await revealViaDom(game);
          didReveal = true;
        }

        results.push({ ...base, key, wasAlreadyRevealed: !didReveal });
        game.revealed = true;
        state.domKeys.set(game.id, key);

        if (didReveal && i < wanted.length - 1) {
          await HSG.sleep(delayMs != null ? delayMs : 700);
        }
      } catch (error) {
        results.push({ ...base, error: String(error.message || error) });
      }
    }
    return results;
  }

  // --- berichten ---------------------------------------------------------------

  function send(message) {
    return chrome.runtime.sendMessage(message).catch(() => null);
  }

  const HANDLED = new Set([MSG.HUMBLE_SCAN, MSG.HUMBLE_REVEAL, MSG.HUMBLE_DIAGNOSE]);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !HANDLED.has(message.type)) return false;

    const run = async () => {
      switch (message.type) {
        // Expliciet gevraagd, dus altijd publiceren — ook als er niets veranderd
        // is; anders lijkt "Opnieuw scannen" niets te doen.
        case MSG.HUMBLE_SCAN: {
          await scan(message.scope === 'library' ? 'library' : 'page');
          renderUi();
          await publishCatalog(true);
          return { catalog: catalogPayload() };
        }
        case MSG.HUMBLE_REVEAL: {
          const results = await revealKeys(message.ids || [], message.delayMs);
          renderUi();
          await publishCatalog(true);
          return { results };
        }
        default:
          return diagnose();
      }
    };

    run().then(
      (result) => sendResponse(result),
      (error) => sendResponse({ error: String(error.message || error) })
    );
    return true;
  });

  // --- diagnose (read-only) ----------------------------------------------------

  /** Eén rij als HTML, met alle keys eruit gefilterd. */
  function sampleRow() {
    const keyField = document.querySelector(H.keyField);
    if (!keyField) return 'geen keyveld op deze pagina';
    return findRow(keyField)
      .outerHTML.replace(/title="[^"]*"/g, 'title="KEY-WEGGELATEN"')
      .replace(/[A-Z0-9]{5}(-[A-Z0-9]{5}){2,4}/gi, 'KEY-WEGGELATEN')
      .slice(0, 900);
  }

  async function diagnose() {
    const keyFields = document.querySelectorAll(H.keyField);
    const redeemed = document.querySelectorAll(
      `${H.keyField}.${H.redeemedClass}`
    );
    const gamekey = readGamekey();
    const domEntries = scanDom();

    const checks = [
      {
        label: 'Soort pagina',
        ok: page.isKeysPage,
        detail: page.isKeysPage
          ? location.pathname
          : `${location.pathname} — open je keys-pagina (/downloads?key=… of /home/keys)`,
      },
      {
        label: 'Keyvelden op de pagina',
        ok: keyFields.length > 0,
        detail: `${keyFields.length} gevonden, waarvan ${redeemed.length} al onthuld (${H.keyField})`,
      },
      {
        // Ongelijke aantallen betekenen dat rijen samenklappen doordat ze
        // dezelfde naam krijgen — precies de fout die dit eerder tot één regel
        // terugbracht. Daarom staan beide getallen hier naast elkaar.
        label: 'Rijen met een leesbare naam',
        ok: domEntries.length === keyFields.length && domEntries.length > 0,
        detail: `${domEntries.length} van ${keyFields.length} keyvelden`,
      },
      {
        label: 'Gelezen spelnamen',
        ok: domEntries.length > 0,
        detail:
          domEntries.length > 0
            ? domEntries.slice(0, 6).map((entry) => entry.humanName).join(' · ')
            : 'geen naam kunnen bepalen — zie de rij-dump hieronder',
      },
      {
        label: 'Bundels op deze pagina',
        ok: domEntries.some((entry) => entry.gamekey),
        detail: (() => {
          const bundles = Array.from(
            new Set(domEntries.map((entry) => entry.bundleName).filter(Boolean))
          );
          const withKey = domEntries.filter((entry) => entry.gamekey).length;
          return bundles.length
            ? `${bundles.length} bundel(s), ${withKey} rijen met order-sleutel — ${bundles.slice(0, 4).join(' · ')}`
            : 'geen bundellink in de rijen gevonden — dan missen de Steam-appids';
        })(),
      },
      {
        label: 'Order-sleutel uit de URL',
        ok: Boolean(gamekey),
        detail: gamekey
          ? 'gevonden'
          : 'niet in de URL — op /home/keys normaal; de sleutels komen per rij uit de bundellink',
      },
      {
        label: 'CSRF-token',
        ok: Boolean(readCsrfToken()),
        detail: readCsrfToken() ? 'gevonden' : 'niet gevonden',
      },
    ];

    const probeKey =
      gamekey || (domEntries.find((entry) => entry.gamekey) || {}).gamekey || null;
    let apiOk = false;
    let apiDetail = 'overgeslagen: geen order-sleutel gevonden op deze pagina';
    try {
      if (probeKey) {
        const order = await fetchOrder(probeKey);
        const tpks = (order && order.tpkd_dict && order.tpkd_dict.all_tpks) || [];
        apiOk = true;
        apiDetail = `${tpks.length} keys in die order, waarvan ${tpks.filter(HSG.isUsableTpk).length} bruikbare Steam-keys`;
      }
    } catch (error) {
      apiDetail = String(error.message || error);
    }
    checks.push({ label: 'Humble JSON-API', ok: apiOk || !probeKey, detail: apiDetail });

    checks.push({ label: 'Voorbeeldrij (keys weggelaten)', ok: true, detail: sampleRow() });

    return { site: 'humble', checks };
  }

  // --- UI op de pagina ---------------------------------------------------------

  let bar = null;

  function ensureBar() {
    if (bar && document.body.contains(bar)) return bar;
    bar = document.createElement('div');
    bar.className = 'hsg-bar';
    bar.innerHTML = `
      <span class="hsg-bar__title">Humble → SteamGifts</span>
      <span class="hsg-bar__status" data-role="status"></span>
      <span class="hsg-bar__spacer"></span>
      <button type="button" class="hsg-btn" data-action="all">Alles</button>
      <button type="button" class="hsg-btn" data-action="none">Niets</button>
      <button type="button" class="hsg-btn hsg-btn--primary" data-action="add">
        Make giveaway
      </button>
    `;
    bar.addEventListener('click', onBarClick);
    document.body.appendChild(bar);
    return bar;
  }

  /** Op de maandpagina ontleden we niets meer; alleen de weg wijzen. */
  function ensureHintBar() {
    if (bar && document.body.contains(bar)) return bar;
    bar = document.createElement('div');
    bar.className = 'hsg-bar';
    bar.innerHTML = `
      <span class="hsg-bar__title">Humble → SteamGifts</span>
      <span class="hsg-bar__status">
        Haal hier de spellen op die je wilt weggeven, en ga daarna naar je keys.
      </span>
      <span class="hsg-bar__spacer"></span>
      <a class="hsg-btn hsg-btn--primary" href="/home/keys">Naar mijn keys</a>
    `;
    document.body.appendChild(bar);
    return bar;
  }

  async function onBarClick(event) {
    const action = event.target.closest('[data-action]');
    if (!action) return;

    if (action.dataset.action === 'all') {
      // Alleen wat op deze pagina staat. state.games bevat ook regels uit de
      // order die hier niet getoond worden; die allemaal aanvinken zou zomaar
      // honderden keys onthullen.
      for (const game of state.games) {
        if (state.domNodes.has(game.id) && !game.unavailable) state.selected.add(game.id);
      }
      renderUi();
      return;
    }
    if (action.dataset.action === 'none') {
      state.selected.clear();
      renderUi();
      return;
    }
    if (action.dataset.action === 'add') {
      const ids = Array.from(state.selected);
      if (ids.length === 0) {
        setStatus('Vink eerst een spel aan.');
        return;
      }
      // Onthullen kost je bij Humble de gift-link-optie en is niet terug te
      // draaien. Bij een grote selectie eerst even vragen.
      if (ids.length > 25 && !confirm(`${ids.length} keys ophalen bij Humble. Doorgaan?`)) {
        return;
      }
      setBusy(true);
      setStatus(`Keys ophalen voor ${ids.length} ${ids.length === 1 ? 'spel' : 'spellen'}…`);
      try {
        const results = await revealKeys(ids, 700);
        const response = await send({ type: MSG.HUMBLE_ADD_SELECTION, results });
        const failed = results.filter((result) => result.error);
        state.selected.clear();
        renderUi();
        if (!response || !response.ok) {
          setStatus('Toevoegen aan de wachtrij mislukt.');
        } else if (failed.length) {
          setStatus(
            `${results.length - failed.length} toegevoegd, ${failed.length} mislukt — zie het zijpaneel.`
          );
        } else {
          setStatus(`${results.length} toegevoegd. Open het zijpaneel om te starten.`);
        }
      } catch (error) {
        setStatus(String(error.message || error));
      } finally {
        setBusy(false);
      }
    }
  }

  function setStatus(text) {
    const el = bar && bar.querySelector('[data-role="status"]');
    if (el) el.textContent = text;
  }

  function setBusy(busy) {
    if (!bar) return;
    bar.classList.toggle('hsg-bar--busy', busy);
    bar.querySelectorAll('button').forEach((button) => {
      button.disabled = busy;
    });
  }

  /**
   * Waar het vinkje in de rij komt te hangen.
   *
   * Een <label> rechtstreeks in een <tr> is ongeldige HTML — de browser schuift
   * hem dan buiten de tabel. Het gaat dus in een cel, en bij voorkeur in de
   * naamcel: de eerste cel bevat alleen het platform-icoontje en is zo smal dat
   * het vinkje daar makkelijk buiten beeld valt.
   */
  function checkboxHost(row) {
    if (row.tagName !== 'TR') return row;
    return (
      row.querySelector('.game-name') ||
      row.querySelector('td, th') ||
      row
    );
  }

  /** Zet een vinkje in elke rij die een key bevat. */
  function injectRowCheckboxes() {
    const placed = new Set();

    for (const game of state.games) {
      const keyField = state.domNodes.get(game.id);
      // Losgekoppelde nodes overslaan: Humble hertekent rijen, en dan wijst een
      // eerder vastgelegde verwijzing nergens meer naartoe.
      if (!keyField || !keyField.isConnected) continue;
      const row = findRow(keyField);
      if (!row) continue;

      const existing = row.querySelector('.hsg-tile-check');
      if (existing) {
        if (existing.dataset.hsgId === game.id) {
          placed.add(game.id);
          continue;
        }
        // De id van deze rij is veranderd — een DOM-id wordt een API-id zodra de
        // aanvulling alsnog lukt. Het oude vinkje zou dan een id in de selectie
        // zetten dat nergens meer bestaat, en "Make giveaway" faalt.
        if (state.selected.delete(existing.dataset.hsgId)) state.selected.add(game.id);
        existing.remove();
      }

      const label = document.createElement('label');
      label.className = 'hsg-tile-check hsg-tile-check--inline';
      label.dataset.hsgId = game.id;
      label.title = `${game.humanName} — aanvinken om als giveaway weg te geven`;

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = state.selected.has(game.id);
      input.addEventListener('change', () => {
        if (input.checked) state.selected.add(game.id);
        else state.selected.delete(game.id);
        renderUi();
      });

      const text = document.createElement('span');
      text.textContent = 'Giveaway';

      label.append(input, text);
      label.addEventListener('click', (event) => event.stopPropagation());
      const host = checkboxHost(row);
      host.insertBefore(label, host.firstChild);
      placed.add(game.id);
    }

    // Weesvinkjes van spellen die niet meer in de catalogus staan.
    document.querySelectorAll('.hsg-tile-check').forEach((label) => {
      if (!placed.has(label.dataset.hsgId)) label.remove();
    });
    return placed.size;
  }

  function renderUi() {
    if (state.games.length === 0) return;
    ensureBar();
    injectRowCheckboxes();

    document.querySelectorAll('.hsg-tile-check').forEach((label) => {
      const input = label.querySelector('input');
      const wanted = state.selected.has(label.dataset.hsgId);
      if (input && input.checked !== wanted) input.checked = wanted;
    });

    const selected = state.selected.size;
    const addButton = bar.querySelector('[data-action="add"]');
    if (addButton) {
      addButton.textContent =
        selected > 1 ? `Make ${selected} giveaways` : 'Make giveaway';
      addButton.disabled = selected === 0;
    }
    // Het aantal aanvinkbare rijen erbij: is dat 0 terwijl er wel spellen
    // gevonden zijn, dan lukt het injecteren van de vinkjes niet en moet je het
    // zijpaneel gebruiken. Zonder dat getal is dat niet te zien.
    const onPage = document.querySelectorAll('.hsg-tile-check').length;
    setStatus(
      `${state.games.length} ${state.games.length === 1 ? 'spel' : 'spellen'} · ` +
        `${onPage} aanvinkbaar op deze pagina · ${selected} geselecteerd`
    );
  }

  // --- opstarten ---------------------------------------------------------------

  async function boot() {
    if (page.isMembership) {
      ensureHintBar();
      return;
    }
    if (!page.isKeysPage) return;

    try {
      await scan('page');
      if (state.games.length === 0) {
        ensureBar();
        setStatus('Geen keys op deze pagina gevonden.');
      } else {
        renderUi();
      }
      await publishCatalog();
    } catch (error) {
      state.scanError = String(error.message || error);
      ensureBar();
      setStatus(`Scannen mislukt: ${state.scanError}`);
    }
  }

  // De keys-pagina rendert rijen bij (paginering, "toon meer"). Mutaties in onze
  // eigen UI negeren, anders houdt renderUi zichzelf aan de gang.
  let rescanTimer = null;
  const observer = new MutationObserver((mutations) => {
    if (!page.isKeysPage) return;
    const fromPage = mutations.some((mutation) => {
      const target = mutation.target;
      return !(target instanceof Element) || !target.closest('.hsg-bar, .hsg-tile-check');
    });
    if (!fromPage) return;

    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(async () => {
      // Alleen echt opnieuw scannen als de rijen veranderd zijn (bladeren,
      // bijladen). Anders hooguit de vinkjes terugzetten die Humble bij een
      // herteken kwijtraakte.
      //
      // Dit onderscheid is niet cosmetisch: elke scan publiceert de catalogus,
      // en elke publicatie liet het zijpaneel zijn lijst hertekenen — precies
      // op het moment dat je daar iets probeerde aan te vinken.
      //
      // Maar de vingerafdruk zegt iets over de inhoud, niet over de identiteit
      // van de nodes. Hertekent Humble dezelfde rijen — dat gebeurt na het
      // onthullen van een key — dan blijft de vingerafdruk gelijk terwijl onze
      // verwijzingen dood zijn, en komt er nooit meer een vinkje in een levende
      // rij. Daarom eerst kijken of ze nog aan het document hangen.
      const nodesLive = Array.from(state.domNodes.values()).every(
        (node) => node.isConnected
      );
      if (nodesLive && domSignature() === state.scannedSignature) {
        renderUi();
        return;
      }
      await scan('dom').catch(() => null);
      renderUi();
      await publishCatalog();
    }, 600);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  boot();
})();
