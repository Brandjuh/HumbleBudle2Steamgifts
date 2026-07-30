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
    lastKeyFieldCount: 0,
  };

  const page = {
    get isKeysPage() {
      return (
        location.pathname.startsWith('/home/keys') ||
        location.pathname.startsWith('/downloads')
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
    const named = row.querySelector(H.rowName);
    if (named && !keyField.contains(named)) texts.push(named.textContent);

    for (const el of row.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      if (keyField.contains(el) || el === keyField) continue;
      texts.push(el.textContent);
    }
    return texts;
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
    const seen = new Set();

    document.querySelectorAll(H.keyField).forEach((keyField, index) => {
      const row = findRow(keyField);
      const humanName = HSG.pickRowName(rowTexts(row, keyField));
      if (!humanName) return;

      const revealedKey = keyField.classList.contains(H.redeemedClass)
        ? (keyField.getAttribute('title') || '').trim()
        : '';

      // Zonder machine_name (die komt uit de API) is de genormaliseerde naam de
      // enige stabiele sleutel. Stabiel is hier belangrijk: onder deze id staat
      // straks de key in session storage.
      const slug = HSG.normalizeTitle(humanName).replace(/\s+/g, '-') || `rij-${index}`;
      const id = HSG.itemId(state.gamekey || 'dom', slug);
      if (seen.has(id)) return;
      seen.add(id);

      entries.push({
        id,
        machineName: null,
        humanName,
        gamekey: state.gamekey || null,
        keyindex: null,
        steamAppId: null,
        keyType: rowPlatform(row),
        revealed: Boolean(revealedKey),
        disallowedCountries: [],
        bundleName: null,
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
      disallowedCountries: tpk.disallowed_countries || [],
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
    const byName = new Map();
    for (const entry of apiEntries) {
      byName.set(HSG.normalizeTitle(entry.humanName), entry);
    }

    const merged = [];
    const usedApi = new Set();

    for (const domEntry of domEntries) {
      const match = byName.get(HSG.normalizeTitle(domEntry.humanName));
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

      merged.push({ ...match, revealed: match.revealed || domEntry.revealed });
    }

    // API-regels die niet in de DOM staan (bijv. buiten de zichtbare pagina)
    // horen er ook bij.
    for (const entry of apiEntries) {
      if (!usedApi.has(entry.id)) merged.push(entry);
    }
    return merged;
  }

  /**
   * @param {'page'|'library'} scope `page` = wat op deze pagina staat (snel),
   *   `library` = alle orders van het account ophalen (traag, honderden spellen).
   */
  async function scan(scope) {
    state.scanError = null;
    state.gamekey = readGamekey();
    state.csrf = readCsrfToken();
    state.domKeys.clear();
    state.domNodes.clear();

    const domEntries = scanDom();

    let apiEntries = [];
    let apiError = null;
    try {
      if (scope === 'library') {
        apiEntries = (await fetchAllOrders()).flatMap(toApiEntries);
      } else if (state.gamekey) {
        apiEntries = toApiEntries(await fetchOrder(state.gamekey));
      }
    } catch (error) {
      // Niet fataal: zonder API missen we alleen het appid.
      apiError = String(error.message || error);
    }

    const games = domEntries.length > 0 ? merge(domEntries, apiEntries) : apiEntries;
    if (domEntries.length > 0) state.source = apiEntries.length ? 'dom+api' : 'dom';
    else state.source = apiEntries.length ? 'api' : 'leeg';

    games.sort((a, b) => a.humanName.localeCompare(b.humanName, 'nl'));

    state.games = games;
    state.lastKeyFieldCount = document.querySelectorAll(H.keyField).length;
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
      apiError: state.scanError,
      hasCsrf: Boolean(state.csrf),
    };
  }

  function publishCatalog() {
    return send({ type: MSG.HUMBLE_CATALOG, catalog: catalogPayload() });
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

    HSG.clickWidget(node);
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
    // herladen zijn. Dan is state leeg en zouden we stil niets doen.
    if (state.byId.size === 0) await scan('page');

    const wanted = ids.map((id) => state.byId.get(id)).filter(Boolean);
    if (wanted.length === 0) {
      throw new Error(
        'Deze spellen staan niet op deze pagina. Open je keys-pagina en scan opnieuw.'
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
      };
      try {
        const cached = state.domKeys.get(game.id) || known.get(game.id) || null;
        let key = cached;
        let didReveal = false;

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
        case MSG.HUMBLE_SCAN: {
          await scan(message.scope === 'library' ? 'library' : 'page');
          renderUi();
          await publishCatalog();
          return { catalog: catalogPayload() };
        }
        case MSG.HUMBLE_REVEAL: {
          const results = await revealKeys(message.ids || [], message.delayMs);
          renderUi();
          await publishCatalog();
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
        label: 'Spelnamen uit de rijen gelezen',
        ok: domEntries.length > 0,
        detail:
          domEntries.length > 0
            ? domEntries
                .slice(0, 5)
                .map((entry) => entry.humanName)
                .join(' · ')
            : 'geen naam kunnen bepalen — zie de rij-dump hieronder',
      },
      {
        label: 'Order-sleutel',
        ok: Boolean(gamekey),
        detail: gamekey
          ? 'gevonden in de URL of het paginamodel'
          : 'niet gevonden — werkt nog, maar zonder Steam-appid uit de API',
      },
      {
        label: 'CSRF-token',
        ok: Boolean(readCsrfToken()),
        detail: readCsrfToken() ? 'gevonden' : 'niet gevonden',
      },
    ];

    let apiOk = false;
    let apiDetail = 'overgeslagen: geen order-sleutel op deze pagina';
    try {
      if (gamekey) {
        const order = await fetchOrder(gamekey);
        const tpks = (order && order.tpkd_dict && order.tpkd_dict.all_tpks) || [];
        apiOk = true;
        apiDetail = `${tpks.length} keys in deze order, waarvan ${tpks.filter(HSG.isUsableTpk).length} bruikbare Steam-keys`;
      }
    } catch (error) {
      apiDetail = String(error.message || error);
    }
    checks.push({ label: 'Humble JSON-API', ok: apiOk || !gamekey, detail: apiDetail });

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
      state.games.forEach((game) => state.selected.add(game.id));
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
   * Een <label> rechtstreeks in een <tr> hangen is ongeldige HTML — de browser
   * schuift 'm dan buiten de tabel. In een tabelrij gaat hij dus in de eerste cel.
   */
  function checkboxHost(row) {
    if (row.tagName === 'TR') return row.querySelector('td, th') || row;
    return row;
  }

  /** Zet een vinkje in elke rij die een key bevat. */
  function injectRowCheckboxes() {
    let placed = 0;
    for (const game of state.games) {
      const keyField = state.domNodes.get(game.id);
      if (!keyField) continue;
      const row = findRow(keyField);
      if (!row || row.querySelector('.hsg-tile-check')) continue;

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
      placed += 1;
    }
    return placed;
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
    setStatus(
      `${state.games.length} ${state.games.length === 1 ? 'spel' : 'spellen'} gevonden · ${selected} geselecteerd`
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
      // Alleen opnieuw scannen als er echt rijen bij of af zijn gekomen
      // (paginering, "toon meer"). Anders alleen de vinkjes terugzetten —
      // scannen doet een netwerkverzoek en dat hoeft hier niet.
      const count = document.querySelectorAll(H.keyField).length;
      if (count === state.lastKeyFieldCount) {
        renderUi();
        return;
      }
      await scan('page').catch(() => null);
      renderUi();
      await publishCatalog();
    }, 600);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  boot();
})();
