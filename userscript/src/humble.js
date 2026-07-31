/**
 * De Humble-kant: keys van de keys-pagina lezen, aanvullen via de JSON-API, en
 * onthullen wat nog verborgen is.
 *
 * Geport uit de extensieversie. Wat verdween is de berichtenlaag — hier praat
 * alles binnen één script, dus de service worker en zijn router zijn overbodig.
 * Wat bleef is de kennis van de pagina, en die zit in `lib/selectors.js`.
 *
 * De rij ziet er zo uit:
 *   <tr>
 *     <td class="platform"><i class="hb hb-key hb-steam"></i></td>
 *     <td class="game-name"><h4>Dicefolk</h4>
 *       <p><a href="/download?key=…">July 2026 Humble Choice</a></p></td>
 *     <td class="js-redeemer-cell">… <div class="js-keyfield keyfield redeemed enabled" title="…">
 *   </tr>
 */
'use strict';

(function (root) {
  const HSG = (root.HSG = root.HSG || {});
  const H = HSG.SELECTORS.humble;
  const MAX_ORDERS_PER_SCAN = 12;

  const state = {
    gamekey: null,
    csrf: null,
    games: [],
    byId: new Map(),
    domKeys: new Map(),
    domNodes: new Map(),
    apiEntries: [],
    fetchedOrders: new Set(),
    bundles: [],
    truncatedOrders: 0,
    source: null,
    scanError: null,
    scannedSignature: null,
  };

  const isKeysPage = () =>
    location.pathname.startsWith('/home/keys') || location.pathname.startsWith('/download');
  const isMembership = () => /^\/(membership|subscription)(\/|$)/.test(location.pathname);

  // --- herkomst ---------------------------------------------------------------

  function readPageModel() {
    for (const id of H.modelScriptIds) {
      const node = document.getElementById(id);
      if (!node || !node.textContent) continue;
      try {
        return JSON.parse(node.textContent.trim());
      } catch (error) {
        // Volgende kandidaat.
      }
    }
    return null;
  }

  function readGamekey() {
    const fromUrl = new URLSearchParams(location.search).get('key');
    if (fromUrl) return fromUrl;
    const model = readPageModel();
    const options = model && model.contentChoiceOptions;
    return (options && options.gamekey) || (model && model.gamekey) || null;
  }

  function readCsrfToken() {
    const model = readPageModel();
    const raw = model && model.csrfTokenInput;
    const fromModel = typeof raw === 'string' && raw.match(/value=["']([^"']+)["']/);
    if (fromModel) return fromModel[1];

    const input = document.querySelector(H.csrfInput);
    const fromDom = input && input.getAttribute('value');
    if (fromDom) return fromDom;

    const cookie = document.cookie.match(/(?:^|;\s*)csrf_cookie=([^;]+)/);
    return cookie ? decodeURIComponent(cookie[1]) : null;
  }

  // --- DOM --------------------------------------------------------------------

  function findRow(keyField) {
    for (const selector of H.rowContainers) {
      const row = keyField.closest(selector);
      if (row && row !== keyField) return row;
    }
    return keyField.parentElement || keyField;
  }

  function rowTexts(row, keyField) {
    const texts = [];
    for (const node of row.querySelectorAll('*')) {
      if (node.children.length > 0) continue;
      if (keyField.contains(node) || node === keyField) continue;
      texts.push(node.textContent);
    }
    return texts;
  }

  /**
   * Staat er een echt naamelement in de rij, dan is dat het antwoord. De
   * heuristiek is alleen terugval: die koos ooit de disclaimer die in élke rij
   * staat, waarna alle rijen dezelfde naam kregen en de lijst tot één regel
   * samenklapte.
   */
  function readRowName(row, keyField) {
    const named = row.querySelector(H.rowName);
    if (named && !keyField.contains(named)) {
      const text = named.textContent.replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
    return HSG.pickRowName(rowTexts(row, keyField));
  }

  function readRowBundle(row) {
    const link = row.querySelector(H.rowBundleLink);
    if (!link) return { gamekey: null, bundleName: null };
    return {
      gamekey: HSG.parseOrderKey(link.getAttribute('href')),
      bundleName: link.textContent.replace(/\s+/g, ' ').trim() || null,
    };
  }

  function rowPlatform(row) {
    for (const node of row.querySelectorAll(H.platformIcon)) {
      const platform = HSG.detectPlatform(node.className);
      if (platform) return platform;
    }
    return HSG.detectPlatform(row.className);
  }

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
      const unavailable = keyField.classList.contains(H.disabledClass) && !revealedKey;

      const slug = HSG.normalizeTitle(humanName).replace(/\s+/g, '-') || `rij-${index}`;
      let id = HSG.itemId(bundle.gamekey || state.gamekey || 'dom', slug);
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

  // --- API --------------------------------------------------------------------

  async function fetchJson(url) {
    const response = await fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Humble antwoordde met ${response.status} op ${url}`);
    return response.json();
  }

  const fetchOrder = (gamekey) =>
    fetchJson(`/api/v1/order/${encodeURIComponent(gamekey)}?all_tpkds=true`);

  async function fetchAllOrders() {
    const list = await fetchJson('/api/v1/user/order');
    const gamekeys = (list || []).map((entry) => entry.gamekey).filter(Boolean);
    const orders = [];
    for (let i = 0; i < gamekeys.length; i += 20) {
      const params = new URLSearchParams();
      params.set('all_tpkds', 'true');
      for (const gamekey of gamekeys.slice(i, i + 20)) params.append('gamekeys', gamekey);
      const bulk = await fetchJson(`/api/v1/orders?${params.toString()}`);
      orders.push(...Object.values(bulk || {}));
    }
    return orders;
  }

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

  function merge(domEntries, apiEntries) {
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

    // Regels uit dezelfde order die hier niet getoond worden horen er ook bij:
    // dat is meteen het antwoord op Humble's paginering.
    for (const entry of apiEntries) {
      if (!usedApi.has(entry.id)) merged.push(entry);
    }
    return merged;
  }

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
            apiError = String((result.reason && result.reason.message) || result.reason);
          }
        });
      }
    } catch (error) {
      apiError = String(error.message || error);
    }

    const apiEntries = state.apiEntries;
    const games = domEntries.length > 0 ? merge(domEntries, apiEntries) : apiEntries.slice();
    state.source = domEntries.length
      ? apiEntries.length
        ? 'dom+api'
        : 'dom'
      : apiEntries.length
        ? 'api'
        : 'leeg';

    games.sort((a, b) => a.humanName.localeCompare(b.humanName, 'nl'));
    state.games = games;
    state.byId = new Map(games.map((game) => [game.id, game]));
    state.scannedSignature = domSignature();
    state.scanError = apiError;

    publish();
    injectRowCheckboxes();
    return games;
  }

  function publish() {
    HSG.store.setCatalog({
      // Nooit keys meesturen: dit gaat naar de schijf.
      games: state.games,
      gamekey: state.gamekey,
      pageUrl: location.href,
      source: state.source,
      bundles: state.bundles,
      truncatedOrders: state.truncatedOrders,
      apiError: state.scanError,
    });
  }

  // --- onthullen --------------------------------------------------------------

  async function revealViaApi(game) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' };
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

  async function revealViaDom(game) {
    const node = state.domNodes.get(game.id);
    if (!node) throw new Error('Geen keyveld op deze pagina gevonden.');

    const existing = (node.getAttribute('title') || '').trim();
    if (existing) return existing;

    HSG.clickWidget(node.querySelector(H.keyFieldValue) || node);
    const value = await HSG.waitForAttribute(node, 'title', { timeout: 15000 });
    const key = String(value || '').trim();
    if (!key) throw new Error('Het keyveld bleef leeg.');
    return key;
  }

  async function revealKeys(ids) {
    if (state.byId.size === 0) await scan('page');

    let wanted = ids.map((id) => state.byId.get(id)).filter(Boolean);
    if (wanted.length === 0) {
      await scan('page');
      wanted = ids.map((id) => state.byId.get(id)).filter(Boolean);
    }
    if (wanted.length === 0) {
      throw new Error(
        `Deze ${ids.length === 1 ? 'key staat' : 'keys staan'} niet op deze pagina. Ga naar de Humble-pagina waar ze staan en scan opnieuw.`
      );
    }

    // Eén keer de order ophalen levert alle al onthulde keys in één klap.
    const known = new Map();
    const gamekeys = Array.from(new Set(wanted.map((game) => game.gamekey).filter(Boolean)));
    for (const gamekey of gamekeys) {
      try {
        const order = await fetchOrder(gamekey);
        const tpks = (order && order.tpkd_dict && order.tpkd_dict.all_tpks) || [];
        for (const tpk of tpks) {
          if (!tpk.redeemed_key_val) continue;
          known.set(HSG.itemId(gamekey, tpk.machine_name), tpk.redeemed_key_val);
        }
      } catch (error) {
        // Niet fataal: terugval op de DOM of op onthullen.
      }
    }

    const delayMs = HSG.store.getSettings().revealDelayMs;
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

        if (!key && game.unavailable) throw new Error('Humble biedt deze key niet meer aan.');
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
        if (didReveal && i < wanted.length - 1) await HSG.sleep(delayMs);
      } catch (error) {
        results.push({ ...base, error: String(error.message || error) });
      }
    }

    publish();
    injectRowCheckboxes();
    return results;
  }

  // --- vinkjes in de rijen ----------------------------------------------------

  /**
   * Een <label> rechtstreeks in een <tr> is ongeldige HTML — de browser schuift
   * hem dan buiten de tabel. Het gaat dus in een cel, en bij voorkeur de
   * naamcel: de eerste cel bevat alleen een icoontje en is zo smal dat het
   * vinkje daar makkelijk buiten beeld valt.
   */
  function checkboxHost(row) {
    if (row.tagName !== 'TR') return row;
    return row.querySelector('.game-name') || row.querySelector('td, th') || row;
  }

  function injectRowCheckboxes() {
    const placed = new Set();

    for (const game of state.games) {
      const keyField = state.domNodes.get(game.id);
      // Losgekoppelde nodes overslaan: Humble hertekent rijen, en dan wijst een
      // eerder vastgelegde verwijzing nergens meer naartoe.
      if (!keyField || !keyField.isConnected) continue;
      const row = findRow(keyField);
      if (!row) continue;

      const existing = row.querySelector('.hsg-row-check');
      if (existing) {
        if (existing.dataset.hsgId === game.id) {
          placed.add(game.id);
          continue;
        }
        // De id van deze rij is veranderd — een DOM-id wordt een API-id zodra de
        // aanvulling alsnog lukt. Het oude vinkje zou dan een id in de selectie
        // zetten dat nergens meer bestaat, en "Make giveaway" faalt.
        if (HSG.panel.selection.delete(existing.dataset.hsgId)) {
          HSG.panel.selection.add(game.id);
        }
        existing.remove();
      }

      const label = document.createElement('label');
      label.className = `hsg-row-check${game.unavailable ? ' is-unavailable' : ''}`;
      label.dataset.hsgId = game.id;
      label.title = `${game.humanName} — aanvinken om weg te geven`;

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = HSG.panel.isSelected(game.id);
      input.disabled = Boolean(game.unavailable);
      input.addEventListener('change', () => HSG.panel.setSelected(game.id, input.checked));

      const text = document.createElement('span');
      text.textContent = 'Giveaway';
      label.append(input, text);
      label.addEventListener('click', (event) => event.stopPropagation());
      const host = checkboxHost(row);
      host.insertBefore(label, host.firstChild);
      placed.add(game.id);
    }

    // Weesvinkjes van spellen die niet meer in de catalogus staan.
    document.querySelectorAll('.hsg-row-check').forEach((label) => {
      if (!placed.has(label.dataset.hsgId)) label.remove();
    });
  }

  /** Vinkjes gelijktrekken nadat de selectie elders veranderde. */
  function syncSelection() {
    document.querySelectorAll('.hsg-row-check').forEach((label) => {
      const input = label.querySelector('input');
      const wanted = HSG.panel.isSelected(label.dataset.hsgId);
      if (input && input.checked !== wanted) input.checked = wanted;
    });
  }

  // --- diagnose ---------------------------------------------------------------

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
    const redeemed = document.querySelectorAll(`${H.keyField}.${H.redeemedClass}`);
    const gamekey = readGamekey();
    const domEntries = scanDom();
    const bundles = Array.from(
      new Set(domEntries.map((entry) => entry.bundleName).filter(Boolean))
    );

    const checks = [
      {
        label: 'Soort pagina',
        ok: isKeysPage(),
        detail: isKeysPage()
          ? location.pathname
          : `${location.pathname} — open je keys-pagina (/home/keys of /download?key=…)`,
      },
      {
        label: 'Keyvelden op de pagina',
        ok: keyFields.length > 0,
        detail: `${keyFields.length} gevonden, waarvan ${redeemed.length} al onthuld`,
      },
      {
        // Ongelijke aantallen betekenen dat rijen samenklappen doordat ze
        // dezelfde naam krijgen — precies de fout die dit ooit tot één regel
        // terugbracht.
        label: 'Rijen met een leesbare naam',
        ok: domEntries.length === keyFields.length && domEntries.length > 0,
        detail: `${domEntries.length} van ${keyFields.length} keyvelden`,
      },
      {
        label: 'Gelezen spelnamen',
        ok: domEntries.length > 0,
        detail: domEntries.slice(0, 6).map((entry) => entry.humanName).join(' · ') || 'geen',
      },
      {
        label: 'Bundels op deze pagina',
        ok: domEntries.some((entry) => entry.gamekey),
        detail: bundles.length
          ? `${bundles.length} bundel(s), ${domEntries.filter((e) => e.gamekey).length} rijen met order-sleutel — ${bundles.slice(0, 4).join(' · ')}`
          : 'geen bundellink gevonden — dan missen de Steam-appids',
      },
      { label: 'CSRF-token', ok: Boolean(readCsrfToken()), detail: readCsrfToken() ? 'gevonden' : 'niet gevonden' },
    ];

    const probeKey = gamekey || (domEntries.find((entry) => entry.gamekey) || {}).gamekey || null;
    let apiOk = false;
    let apiDetail = 'overgeslagen: geen order-sleutel gevonden';
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

  // --- opstarten --------------------------------------------------------------

  async function boot() {
    HSG.site = { name: 'humble', scan, revealKeys, diagnose, syncSelection };
    HSG.panel.mount();

    if (isMembership()) {
      HSG.panel.notice(
        'Haal hier de spellen op die je wilt weggeven en ga daarna naar humblebundle.com/home/keys.',
        'ok'
      );
      return;
    }
    if (!isKeysPage()) return;

    try {
      await scan('page');
      HSG.panel.render();
    } catch (error) {
      HSG.panel.notice(`Scannen mislukt: ${String(error.message || error)}`, 'error');
    }

    // De keys-pagina laadt rijen bij en hertekent bij het bladeren. Alleen echt
    // opnieuw scannen als de rijen veranderd zijn: elke scan schrijft naar de
    // opslag, en dat liet het paneel hertekenen terwijl je aan het aanvinken was.
    let timer = null;
    const observer = new MutationObserver((mutations) => {
      const fromPage = mutations.some((mutation) => {
        const target = mutation.target;
        return !(target instanceof Element) || !target.closest('.hsg-row-check, .hsg-launcher');
      });
      if (!fromPage) return;

      clearTimeout(timer);
      timer = setTimeout(async () => {
        // De vingerafdruk zegt iets over de inhoud, niet over de identiteit van
        // de nodes. Hertekent Humble dezelfde rijen — dat gebeurt na het
        // onthullen van een key — dan blijft de vingerafdruk gelijk terwijl onze
        // verwijzingen dood zijn, en komt er nooit meer een vinkje in een
        // levende rij. Daarom eerst kijken of ze nog aan het document hangen.
        const nodesLive = Array.from(state.domNodes.values()).every(
          (node) => node.isConnected
        );
        if (nodesLive && domSignature() === state.scannedSignature) {
          injectRowCheckboxes();
          syncSelection();
          return;
        }
        await scan('dom').catch(() => null);
        HSG.panel.render();
      }, 600);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  HSG.humble = { boot };
})(typeof globalThis !== 'undefined' ? globalThis : window);
