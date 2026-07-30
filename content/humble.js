/**
 * Content script voor humblebundle.com.
 *
 * Doet drie dingen: de maandcatalogus uitlezen, keys onthullen, en een balk +
 * vinkjes op de pagina zetten zodat je spellen kunt aanvinken.
 *
 * Alle netwerkcalls naar Humble gebeuren hier en nergens anders. Vanuit de
 * service worker zouden het cross-origin requests worden — die zijn in MV3
 * CORS-geblokkeerd, en Humble zit bovendien achter Cloudflare, dat verkeer met
 * een afwijkende herkomst niet waardeert. Same-origin vanuit de pagina zelf
 * gaat gewoon goed en stuurt de sessiecookie mee.
 */
'use strict';

(() => {
  const { MSG, SELECTORS } = HSG;
  const state = {
    gamekey: null,
    csrf: null,
    games: [],
    byId: new Map(),
    selected: new Set(),
    monthGameCount: null,
    scanError: null,
  };

  // --- paginamodel -----------------------------------------------------------

  function readPageModel() {
    for (const id of SELECTORS.humble.modelScriptIds) {
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

  function readGamekey(model) {
    if (!model) return null;
    const options = model.data && model.data.contentChoiceOptions;
    return (options && options.gamekey) || (model.data && model.data.gamekey) || null;
  }

  function readMonthGameCount(model) {
    const options = model && model.data && model.data.contentChoiceOptions;
    const data = options && options.contentChoiceData;
    if (!data) return null;
    for (const value of Object.values(data)) {
      if (value && value.content_choices) {
        return Object.keys(value.content_choices).length;
      }
    }
    return null;
  }

  function readCsrfToken(model) {
    const raw = model && model.data && model.data.csrfTokenInput;
    const fromModel = typeof raw === 'string' && raw.match(/value=["']([^"']+)["']/);
    if (fromModel) return fromModel[1];

    const input = document.querySelector(SELECTORS.humble.csrfInput);
    const fromDom = input && input.getAttribute('value');
    if (fromDom) return fromDom;

    const cookie = document.cookie.match(/(?:^|;\s*)csrf_cookie=([^;]+)/);
    return cookie ? decodeURIComponent(cookie[1]) : null;
  }

  // --- Humble API ------------------------------------------------------------

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

  /** Zet een order-object om in onze catalogusregels. */
  function toCatalogEntries(order) {
    const gamekey = order && order.gamekey;
    const tpks = (order && order.tpkd_dict && order.tpkd_dict.all_tpks) || [];
    return tpks.filter(HSG.isUsableTpk).map((tpk) => ({
      id: HSG.itemId(gamekey, tpk.machine_name),
      machineName: tpk.machine_name,
      humanName: tpk.human_name || tpk.machine_name,
      gamekey,
      keyindex: tpk.keyindex != null ? tpk.keyindex : 0,
      steamAppId: HSG.normalizeAppId(tpk.steam_app_id),
      revealed: Boolean(tpk.redeemed_key_val),
      disallowedCountries: tpk.disallowed_countries || [],
      bundleName: (order.product && order.product.human_name) || null,
    }));
  }

  /**
   * @param {boolean} deep Ook alle andere orders ophalen (voor /home/keys).
   *   De maandpagina heeft genoeg aan zijn eigen order en is dan veel sneller.
   */
  async function scan(deep) {
    const model = readPageModel();
    state.csrf = readCsrfToken(model);
    state.gamekey = readGamekey(model);
    state.monthGameCount = readMonthGameCount(model);
    state.scanError = null;

    let orders;
    if (state.gamekey && !deep) {
      orders = [await fetchOrder(state.gamekey)];
    } else if (state.gamekey && deep) {
      orders = await fetchAllOrders();
    } else {
      orders = await fetchAllOrders();
    }

    const games = orders.flatMap(toCatalogEntries);
    games.sort((a, b) => a.humanName.localeCompare(b.humanName, 'nl'));

    state.games = games;
    state.byId = new Map(games.map((game) => [game.id, game]));
    for (const id of Array.from(state.selected)) {
      if (!state.byId.has(id)) state.selected.delete(id);
    }
    return games;
  }

  function catalogPayload() {
    return {
      games: state.games,
      gamekey: state.gamekey,
      monthGameCount: state.monthGameCount,
      pageUrl: location.href,
      hasCsrf: Boolean(state.csrf),
    };
  }

  function publishCatalog() {
    return send({ type: MSG.HUMBLE_CATALOG, catalog: catalogPayload() });
  }

  // --- keys onthullen --------------------------------------------------------

  /**
   * Onthult één key. `gift` wordt bewust nooit meegestuurd: dat levert een
   * gift-link in plaats van een key op en is onomkeerbaar.
   */
  async function revealOne(game) {
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
        keyindex: String(game.keyindex),
      }),
    });

    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      throw new Error(`Onverwacht antwoord van Humble (HTTP ${response.status})`);
    }
    if (!data || data.success !== true || !data.key) {
      throw new Error(data && (data.error_msg || data.error) ? String(data.error_msg || data.error) : 'Onthullen mislukt');
    }
    return data.key;
  }

  /**
   * Haalt de keys op voor de gegeven ids. Vraagt de order opnieuw op zodat
   * `redeemed_key_val` actueel is — al onthulde keys hoeven niet opnieuw door
   * `/humbler/redeemkey` heen.
   */
  async function revealKeys(ids, delayMs) {
    // Het zijpaneel werkt op een catalogus die in storage staat; dit content
    // script kan intussen herladen zijn (navigatie, extensie-reload). Dan is
    // state leeg en zouden we stilletjes niets doen.
    if (state.byId.size === 0) await scan(true);

    const wanted = ids.map((id) => state.byId.get(id)).filter(Boolean);
    if (wanted.length === 0) {
      throw new Error(
        'Deze spellen staan niet in de catalogus van deze pagina. Scan opnieuw op je Humble-maandpagina.'
      );
    }

    const gamekeys = Array.from(new Set(wanted.map((game) => game.gamekey)));
    const known = new Map();
    for (const gamekey of gamekeys) {
      try {
        const order = await fetchOrder(gamekey);
        const tpks = (order && order.tpkd_dict && order.tpkd_dict.all_tpks) || [];
        for (const tpk of tpks) {
          known.set(HSG.itemId(gamekey, tpk.machine_name), tpk.redeemed_key_val || null);
        }
      } catch (error) {
        // Niet fataal: we vallen terug op onthullen.
      }
    }

    const results = [];
    for (let i = 0; i < wanted.length; i += 1) {
      const game = wanted[i];
      const base = {
        machineName: game.machineName,
        humanName: game.humanName,
        gamekey: game.gamekey,
        keyindex: game.keyindex,
        steamAppId: game.steamAppId,
        disallowedCountries: game.disallowedCountries,
      };
      try {
        const existing = known.get(game.id);
        const key = existing || (await revealOne(game));
        results.push({ ...base, key, wasAlreadyRevealed: Boolean(existing) });
        game.revealed = true;
        if (!existing && i < wanted.length - 1) {
          await HSG.sleep(delayMs != null ? delayMs : 700);
        }
      } catch (error) {
        results.push({ ...base, error: String(error.message || error) });
      }
    }
    return results;
  }

  // --- berichten -------------------------------------------------------------

  function send(message) {
    return chrome.runtime.sendMessage(message).catch(() => null);
  }

  const HANDLED = new Set([MSG.HUMBLE_SCAN, MSG.HUMBLE_REVEAL, MSG.HUMBLE_DIAGNOSE]);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !HANDLED.has(message.type)) return false;

    const run = async () => {
      switch (message.type) {
        case MSG.HUMBLE_SCAN: {
          await scan(true);
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

  // --- diagnose (read-only) --------------------------------------------------

  async function diagnose() {
    const model = readPageModel();
    const checks = [
      {
        label: 'Paginamodel (JSON-blob)',
        ok: Boolean(model),
        detail: model ? `#${model.id}` : SELECTORS.humble.modelScriptIds.join(', '),
      },
      {
        label: 'Maand-gamekey',
        ok: Boolean(readGamekey(model)),
        detail: readGamekey(model) ? 'gevonden' : 'niet gevonden — scan valt terug op alle orders',
      },
      {
        label: 'CSRF-token',
        ok: Boolean(readCsrfToken(model)),
        detail: readCsrfToken(model) ? 'gevonden' : 'niet gevonden',
      },
      {
        label: 'Pagina-root voor onze balk',
        ok: Boolean(document.querySelector(SELECTORS.humble.pageRoot)),
        detail: SELECTORS.humble.pageRoot,
      },
    ];

    let apiOk = false;
    let apiDetail = 'niet geprobeerd';
    const gamekey = readGamekey(model);
    try {
      if (gamekey) {
        const order = await fetchOrder(gamekey);
        const tpks = (order && order.tpkd_dict && order.tpkd_dict.all_tpks) || [];
        const steamKeys = tpks.filter(HSG.isUsableTpk);
        apiOk = true;
        apiDetail = `${tpks.length} keys in de order, waarvan ${steamKeys.length} bruikbare Steam-keys`;
      } else {
        const list = await fetchJson('/api/v1/user/order');
        apiOk = Array.isArray(list);
        apiDetail = `${(list || []).length} orders op je account`;
      }
    } catch (error) {
      apiDetail = String(error.message || error);
    }
    checks.push({ label: 'Humble JSON-API', ok: apiOk, detail: apiDetail });

    const monthCount = readMonthGameCount(model);
    if (monthCount != null) {
      checks.push({
        label: 'Spellen op de maandpagina',
        ok: true,
        detail: String(monthCount),
      });
    }

    return { site: 'humble', checks };
  }

  // --- UI op de pagina -------------------------------------------------------

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
   * Plaatst een vinkje op de tegel van elk spel.
   *
   * Bewust best-effort: de opmaak van Humble is niet gedocumenteerd en verandert.
   * Lukt het niet, dan blijft de balk en het zijpaneel gewoon werken — daar leunt
   * de rest van de extensie op.
   */
  function injectTileCheckboxes() {
    const remaining = new Map();
    for (const game of state.games) {
      remaining.set(HSG.normalizeTitle(game.humanName), game);
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.closest('.hsg-bar, .hsg-tile-check')) return NodeFilter.FILTER_REJECT;
        if (node.children.length > 0) return NodeFilter.FILTER_SKIP;
        const text = node.textContent;
        if (!text || text.length > 100) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const placements = [];
    while (walker.nextNode() && remaining.size > 0) {
      const node = walker.currentNode;
      const game = remaining.get(HSG.normalizeTitle(node.textContent));
      if (!game) continue;
      const tile = findTile(node);
      if (!tile || tile.querySelector('.hsg-tile-check')) continue;
      remaining.delete(HSG.normalizeTitle(node.textContent));
      placements.push({ tile, game });
    }

    for (const { tile, game } of placements) {
      const label = document.createElement('label');
      label.className = 'hsg-tile-check';
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
      // De tegel zelf is een link naar de spelpagina; die willen we niet openen.
      label.addEventListener('click', (event) => event.stopPropagation());

      if (getComputedStyle(tile).position === 'static') {
        tile.classList.add('hsg-tile-anchor');
      }
      tile.appendChild(label);
    }

    return placements.length;
  }

  /** Klimt vanaf de titel omhoog tot iets dat op een tegel lijkt. */
  function findTile(node) {
    let element = node.parentElement;
    for (let depth = 0; element && depth < 6; depth += 1) {
      const looksLikeTile =
        element.querySelector('img') ||
        /url\(/.test(getComputedStyle(element).backgroundImage || '');
      if (looksLikeTile && element.clientHeight > 60) return element;
      element = element.parentElement;
    }
    return node.parentElement;
  }

  function renderUi() {
    if (state.games.length === 0) return;
    ensureBar();
    injectTileCheckboxes();

    // Vinkjes gelijktrekken met de selectie (bijv. na "Alles" of "Niets").
    document.querySelectorAll('.hsg-tile-check').forEach((label) => {
      const input = label.querySelector('input');
      const wanted = state.selected.has(label.dataset.hsgId);
      if (input && input.checked !== wanted) input.checked = wanted;
    });

    const selected = state.selected.size;
    const addButton = bar.querySelector('[data-action="add"]');
    addButton.textContent =
      selected > 1 ? `Make ${selected} giveaways` : 'Make giveaway';
    addButton.disabled = selected === 0;
    setStatus(
      `${state.games.length} ${state.games.length === 1 ? 'spel' : 'spellen'} gevonden · ${selected} geselecteerd`
    );
  }

  // --- opstarten -------------------------------------------------------------

  async function boot() {
    try {
      const model = readPageModel();
      const gamekey = readGamekey(model);
      // Zonder maand-gamekey (bijv. op /home/keys) is een automatische scan te
      // duur: die zou álle orders ophalen. Daar wacht de gebruiker op de knop.
      if (!gamekey) return;
      await scan(false);
      if (state.games.length === 0) {
        ensureBar();
        setStatus('Geen bruikbare Steam-keys in deze order gevonden.');
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

  // Humble is een SPA: na navigeren binnen de maandpagina moeten de vinkjes terug.
  // Mutaties in onze eigen UI negeren, anders houdt renderUi zichzelf aan de gang.
  let reinjectTimer = null;
  const observer = new MutationObserver((mutations) => {
    if (state.games.length === 0) return;
    const fromPage = mutations.some((mutation) => {
      const target = mutation.target;
      return (
        !(target instanceof Element) ||
        !target.closest('.hsg-bar, .hsg-tile-check')
      );
    });
    if (!fromPage) return;
    clearTimeout(reinjectTimer);
    reinjectTimer = setTimeout(() => renderUi(), 400);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  boot();
})();
