/**
 * De SteamDB-kant: het werk-tabblad dat pakketpagina's leest.
 *
 * SteamDB heeft geen API en staat scrapen niet toe. Wat wél kan: dit script
 * draait zelf op steamdb.info, in de browser van de gebruiker. Bij het
 * toevoegen aan de wachtrij opent de Humble-pagina hier één achtergrondtabblad
 * (met `#hsg-worker` in de URL); dat tabblad leest zijn eigen pagina en haalt
 * de overige pagina's één voor één op met gewone same-origin fetches — rustig
 * aan, met pauzes, en alles gaat in een cache van twee weken zodat dezelfde
 * pagina nooit twee keer geladen wordt. Voor SteamDB is dit niet te
 * onderscheiden van gewoon browsen, en een eventuele Cloudflare-controle kan
 * de gebruiker gewoon zelf oplossen.
 *
 * De uitkomst per spel gaat als `steamdb`-veld het wachtrij-item in; de
 * SteamGifts-kant beslist daarmee via `HSG.regionPlan` over de regio.
 */
'use strict';

(function (root) {
  const HSG = (root.HSG = root.HSG || {});
  const SD = HSG.SELECTORS.steamdb;

  const WORKER_MARK = 'hsg-worker';
  /** Na zo lang zonder hartslag geldt een werktabblad als verdwenen. */
  const HEARTBEAT_STALE_MS = 20000;
  const WORKER_ID = `w${Math.random().toString(36).slice(2)}`;

  const isWorkerTab = () => location.hash.indexOf(WORKER_MARK) !== -1;

  // --- pagina's lezen ---------------------------------------------------------

  /**
   * De waardecel van een restrictierij: de landcodes staan vóór de <hr>,
   * daarna volgen vlaggetjes met volledige landnamen die we niet willen.
   */
  function cellValue(td) {
    let text = '';
    for (const node of td.childNodes) {
      if (node.nodeType === 1 && node.tagName === 'HR') break;
      text += node.textContent || '';
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  function rowPairs(doc) {
    const rows = [];
    for (const tr of doc.querySelectorAll(SD.infoRow)) {
      const cells = tr.querySelectorAll('td');
      if (cells.length < 2) continue;
      const label = (cells[0].textContent || '').replace(/\s+/g, ' ').trim();
      if (!label || label.length > 60) continue;
      rows.push({ label, value: cellValue(cells[1]) });
    }
    return rows;
  }

  function pageName(doc) {
    const h1 = doc.querySelector('h1[itemprop="name"], .pagehead h1, h1');
    const fromH1 = h1 && h1.textContent.replace(/\s+/g, ' ').trim();
    if (fromH1) return fromH1;
    return (doc.title || '').replace(/\s*·\s*SteamDB.*$/i, '').trim() || null;
  }

  function parseSubDocument(doc) {
    const bodyText = doc.body ? doc.body.textContent : '';
    return {
      stale: SD.stalePattern.test(bodyText),
      restrictions: HSG.steamdbRestrictions(HSG.steamdbFieldsFromRows(rowPairs(doc))),
      name: pageName(doc),
    };
  }

  function parseAppSubsDocument(doc) {
    const candidates = [];
    const seen = new Set();

    for (const row of doc.querySelectorAll(SD.packageRow)) {
      const subId = row.getAttribute('data-subid');
      if (!subId || seen.has(subId)) continue;
      const cells = row.querySelectorAll('td');
      if (cells.length < 2) continue;
      // Kolommen: SubID | Name | (leeg) | Billing Type | Last Update.
      const billing =
        cells.length >= 4
          ? cells[3].textContent || ''
          : Array.from(cells).slice(2).map((td) => td.textContent).join(' ');
      seen.add(subId);
      candidates.push({
        subId,
        name: (cells[1].textContent || '').replace(/\s+/g, ' ').trim(),
        cdKey: SD.cdKeyPattern.test(billing),
        buyRestrict: SD.buyRestrictPattern.test(billing),
      });
    }

    // Terugval als `tr.package` ooit verdwijnt: rijen met een /sub/-link.
    if (candidates.length === 0) {
      for (const link of doc.querySelectorAll(SD.subLink)) {
        const match = /\/sub\/(\d+)/.exec(link.getAttribute('href') || '');
        const row = link.closest('tr');
        if (!match || !row || seen.has(match[1])) continue;
        const cells = row.querySelectorAll('td');
        if (cells.length < 3) continue;
        seen.add(match[1]);
        const text = row.textContent || '';
        candidates.push({
          subId: match[1],
          name: (cells[1] ? cells[1].textContent : '').replace(/\s+/g, ' ').trim(),
          cdKey: SD.cdKeyPattern.test(text),
          buyRestrict: SD.buyRestrictPattern.test(text),
        });
      }
    }

    const bodyText = doc.body ? doc.body.textContent : '';
    return { candidates, noPackages: SD.noPackagesPattern.test(bodyText) };
  }

  const isChallengeDocument = (doc) =>
    SD.challengePattern.test(doc.title || '') ||
    Boolean(doc.querySelector('#challenge-form, #challenge-running, #cf-challenge-running'));

  // --- ophalen ----------------------------------------------------------------

  /** Ging er in de huidige taak iets over het netwerk? Dan pauzeren we erna. */
  let touchedNetwork = false;

  async function fetchDoc(path) {
    touchedNetwork = true;
    const response = await fetch(path, {
      credentials: 'include',
      headers: { Accept: 'text/html' },
    });

    if (response.status === 429) {
      const retry = Number(response.headers.get('Retry-After')) || 30;
      const error = new Error(`SteamDB vraagt om rust (429).`);
      error.kind = 'ratelimit';
      error.retryAfter = Math.min(retry, 120);
      throw error;
    }

    const text = await response.text();
    if (!response.ok) {
      if (response.status === 404) {
        const error = new Error('Niet gevonden op SteamDB (404).');
        error.kind = 'notfound';
        throw error;
      }
      const error = new Error(`SteamDB antwoordde met ${response.status}.`);
      error.kind =
        response.status === 403 ||
        response.status === 503 ||
        SD.challengePattern.test(text.slice(0, 6000))
          ? 'challenge'
          : 'http';
      throw error;
    }
    return new DOMParser().parseFromString(text, 'text/html');
  }

  /** De eigen pagina van het werktabblad hoeft niet nóg een keer opgehaald. */
  const onOwnPage = (path) =>
    location.pathname === path || location.pathname === path.replace(/\/$/, '');

  async function lookupSub(subId) {
    const cached = HSG.store.readSteamdbSub(subId);
    if (cached) return cached;

    let entry;
    try {
      const path = `/sub/${subId}/`;
      const doc = onOwnPage(path) ? document : await fetchDoc(path);
      entry = { status: 'ok', ...parseSubDocument(doc) };
    } catch (error) {
      if (error.kind !== 'notfound') throw error; // challenge/ratelimit/http bubbelt op
      entry = { status: 'notfound' };
    }
    HSG.store.putSteamdbSub(subId, entry);
    return entry;
  }

  async function lookupApp(appId) {
    const cached = HSG.store.readSteamdbApp(appId);
    if (cached) return cached;

    let entry;
    try {
      const path = `/app/${appId}/subs/`;
      const doc = onOwnPage(path) ? document : await fetchDoc(path);
      entry = { status: 'ok', ...parseAppSubsDocument(doc) };
    } catch (error) {
      if (error.kind !== 'notfound') throw error;
      entry = { status: 'notfound' };
    }
    HSG.store.putSteamdbApp(appId, entry);
    return entry;
  }

  const pause = () => HSG.sleep(2000 + Math.random() * 3000);

  /**
   * Eén spel: van pakket-id (of app-id) naar een regio-uitspraak.
   * Gooit alleen bij challenge/ratelimit/netwerkfouten; inhoudelijke
   * uitkomsten ("niet gevonden", "meerdere kandidaten") zijn gewone statussen.
   */
  async function lookupJob(job) {
    if (job.subId) {
      const entry = await lookupSub(job.subId);
      if (entry.status === 'ok') {
        const resolved = HSG.resolveSteamdbCandidates(
          [{ subId: String(job.subId), stale: entry.stale, restrictions: entry.restrictions }],
          'direct'
        );
        return { ...resolved, subName: entry.name || null };
      }
      // Het directe pakket bestaat niet (meer): door naar de pakketlijst.
    }

    if (!job.appId) return { status: job.subId ? 'nosub' : 'nodata', subIds: [] };

    const appEntry = await lookupApp(job.appId);
    if (appEntry.status !== 'ok' || appEntry.noPackages || (appEntry.candidates || []).length === 0) {
      return { status: 'nosub', subIds: [] };
    }

    const pick = HSG.pickSteamdbSubs(appEntry.candidates);
    if (pick.reason === 'none') return { status: 'nosub', subIds: [] };
    if (pick.reason === 'unrestricted') {
      return { status: 'ok', disallowed: [], exclusive: null, subIds: [] };
    }

    const fetched = [];
    for (const subId of pick.subIds) {
      touchedNetwork = false;
      const entry = await lookupSub(subId);
      if (entry.status === 'ok') {
        fetched.push({ subId: String(subId), stale: entry.stale, restrictions: entry.restrictions });
      }
      if (touchedNetwork) await pause();
    }
    return HSG.resolveSteamdbCandidates(fetched, pick.reason);
  }

  function applyToQueue(itemId, result) {
    HSG.store.withQueue((queue) =>
      HSG.updateItem(queue, itemId, { steamdb: { ...result, checkedAt: Date.now() } })
    );
  }

  // --- de takenlijst (cachebeslissingen zonder netwerk) -----------------------

  const stamp = (result) => ({ ...result });

  /** Zelfde beslissing als `lookupJob`, maar uitsluitend uit de cache. */
  function resolveFromCache(subId, appId) {
    if (subId) {
      const entry = HSG.store.readSteamdbSub(subId);
      if (!entry) return null;
      if (entry.status === 'ok') {
        return stamp({
          ...HSG.resolveSteamdbCandidates(
            [{ subId: String(subId), stale: entry.stale, restrictions: entry.restrictions }],
            'direct'
          ),
          subName: entry.name || null,
        });
      }
      // notfound in cache → beslis via de pakketlijst van de app, indien bekend.
    }
    if (!appId) return subId ? stamp({ status: 'nosub', subIds: [] }) : null;

    const appEntry = HSG.store.readSteamdbApp(appId);
    if (!appEntry) return null;
    if (appEntry.status !== 'ok' || appEntry.noPackages || !(appEntry.candidates || []).length) {
      return stamp({ status: 'nosub', subIds: [] });
    }
    const pick = HSG.pickSteamdbSubs(appEntry.candidates);
    if (pick.reason === 'none') return stamp({ status: 'nosub', subIds: [] });
    if (pick.reason === 'unrestricted') {
      return stamp({ status: 'ok', disallowed: [], exclusive: null, subIds: [] });
    }
    const fetched = [];
    for (const id of pick.subIds) {
      const entry = HSG.store.readSteamdbSub(id);
      if (!entry) return null; // eentje mist → toch een taak voor het werktabblad
      if (entry.status === 'ok') {
        fetched.push({ subId: String(id), stale: entry.stale, restrictions: entry.restrictions });
      }
    }
    return stamp(HSG.resolveSteamdbCandidates(fetched, pick.reason));
  }

  let workerHandle = null;
  let watching = false;

  /** Sluit het werktabblad zodra het klaar meldt. */
  function watchJobs() {
    if (watching) return;
    watching = true;
    HSG.store.onChange(HSG.store.NAMES.STEAMDB_JOBS, () => {
      const record = HSG.store.getSteamdbJobs();
      if (record && record.status === 'done' && workerHandle && !workerHandle.closed) {
        try {
          workerHandle.close();
        } catch (error) {
          // Dan sluit het tabblad zichzelf wel.
        }
        workerHandle = null;
      }
      if (HSG.panel && HSG.panel.render) HSG.panel.render();
    });
  }

  function openWorkerIfNeeded(record) {
    const active =
      record.status === 'running' &&
      record.heartbeatAt &&
      Date.now() - record.heartbeatAt < HEARTBEAT_STALE_MS;
    if (active) return;
    if (workerHandle && !workerHandle.closed) return;

    const first = (record.jobs || []).find((job) => !job.done);
    if (!first) return;
    const path = first.subId
      ? `/sub/${first.subId}/`
      : first.appId
        ? `/app/${first.appId}/subs/`
        : '/';
    try {
      workerHandle = GM_openInTab(`${HSG.URLS.STEAMDB}${path}#${WORKER_MARK}`, {
        active: false,
        insert: true,
        setParent: true,
      });
      if (workerHandle) workerHandle.onclose = () => (workerHandle = null);
    } catch (error) {
      // GM_openInTab niet beschikbaar; de gebruiker kan SteamDB zelf openen.
    }
    watchJobs();
  }

  /**
   * Vanaf de Humble-kant: voor zojuist toegevoegde spellen uitzoeken wat
   * SteamDB van de regio vindt. Wat uit de cache kan wordt meteen beslist;
   * de rest gaat als taak naar het werktabblad.
   */
  function enqueueLookups(entries) {
    const settings = HSG.store.getSettings();
    if (settings.steamdbRegion === false) return { queued: 0 };

    const jobs = [];
    for (const entry of entries || []) {
      const itemId = HSG.itemId(entry.gamekey, entry.machineName);
      const subId = entry.steamPackageId || null;
      const appId = entry.steamAppId || null;

      if (!subId && !appId) {
        applyToQueue(itemId, { status: 'nodata', subIds: [] });
        continue;
      }
      const cached = resolveFromCache(subId, appId);
      if (cached) {
        applyToQueue(itemId, cached);
        continue;
      }
      applyToQueue(itemId, { status: 'pending', subIds: [] });
      jobs.push({ itemId, subId, appId, name: entry.humanName || null, done: false });
    }
    if (jobs.length === 0) return { queued: 0 };

    const existing = HSG.store.getSteamdbJobs();
    const keep =
      existing && Array.isArray(existing.jobs)
        ? existing.jobs.filter(
            (job) => !job.done && !jobs.some((fresh) => fresh.itemId === job.itemId)
          )
        : [];
    const running =
      existing &&
      existing.status === 'running' &&
      existing.heartbeatAt &&
      Date.now() - existing.heartbeatAt < HEARTBEAT_STALE_MS;

    const record = {
      jobs: keep.concat(jobs),
      status: running ? 'running' : 'pending',
      workerId: running ? existing.workerId : null,
      heartbeatAt: running ? existing.heartbeatAt : 0,
      startedAt: Date.now(),
    };
    HSG.store.setSteamdbJobs(record);
    openWorkerIfNeeded(record);
    return { queued: jobs.length };
  }

  /** Voor het paneel: loopt er nog iets, en zit het vast op een controle? */
  function jobsSummary() {
    const record = HSG.store.getSteamdbJobs();
    if (!record || !Array.isArray(record.jobs)) return null;
    const open = record.jobs.filter((job) => !job.done).length;
    if (open === 0) return null;
    return { open, total: record.jobs.length, status: record.status };
  }

  /** Na een opgeloste Cloudflare-controle: opnieuw een werktabblad openen. */
  function retryLookups() {
    const record = HSG.store.getSteamdbJobs();
    if (!record || !(record.jobs || []).some((job) => !job.done)) return false;
    const next = { ...record, status: 'pending', heartbeatAt: 0 };
    HSG.store.setSteamdbJobs(next);
    openWorkerIfNeeded(next);
    return true;
  }

  // --- het werktabblad zelf ---------------------------------------------------

  let overlayNode = null;

  function overlay(message, button) {
    if (!overlayNode) {
      overlayNode = document.createElement('div');
      overlayNode.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:99999;background:#1b2838;' +
        'color:#fff;padding:12px 16px;border-radius:8px;font:13px/1.5 sans-serif;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:340px;';
      document.body.appendChild(overlayNode);
    }
    overlayNode.textContent = '';
    const text = document.createElement('div');
    text.textContent = `Humble → SteamGifts: ${message}`;
    overlayNode.appendChild(text);
    if (button) {
      const node = document.createElement('button');
      node.type = 'button';
      node.textContent = button.label;
      node.style.cssText =
        'margin-top:8px;padding:4px 10px;border:0;border-radius:4px;cursor:pointer;';
      node.addEventListener('click', button.onClick);
      overlayNode.appendChild(node);
    }
  }

  function markJobDone(itemId) {
    const record = HSG.store.getSteamdbJobs();
    if (!record || !Array.isArray(record.jobs)) return;
    HSG.store.setSteamdbJobs({
      ...record,
      jobs: record.jobs.map((job) => (job.itemId === itemId ? { ...job, done: true } : job)),
      heartbeatAt: Date.now(),
    });
  }

  async function runJobs() {
    let record = HSG.store.getSteamdbJobs();
    if (!record || !Array.isArray(record.jobs) || !record.jobs.some((job) => !job.done)) {
      overlay('niets meer te doen — dit tabblad mag dicht.');
      return;
    }
    // Niet met z'n tweeën aan dezelfde lijst werken.
    const otherActive =
      record.status === 'running' &&
      record.workerId &&
      record.workerId !== WORKER_ID &&
      record.heartbeatAt &&
      Date.now() - record.heartbeatAt < HEARTBEAT_STALE_MS;
    if (otherActive) return;

    HSG.store.setSteamdbJobs({
      ...record,
      status: 'running',
      workerId: WORKER_ID,
      heartbeatAt: Date.now(),
    });

    const total = record.jobs.length;
    let waits = 0;

    for (;;) {
      record = HSG.store.getSteamdbJobs();
      const openJobs = (record && record.jobs) || [];
      const job = openJobs.find((entry) => !entry.done);
      if (!job) break;

      const done = openJobs.filter((entry) => entry.done).length;
      overlay(
        `pakketdata lezen — ${job.name || job.subId || job.appId} (${done + 1} van ${Math.max(total, openJobs.length)})…`
      );
      HSG.store.setSteamdbJobs({ ...record, heartbeatAt: Date.now() });

      touchedNetwork = false;
      let result;
      try {
        result = await lookupJob(job);
        waits = 0;
      } catch (error) {
        if (error.kind === 'ratelimit' && waits < 2) {
          waits += 1;
          overlay(`SteamDB vraagt om rust — ${error.retryAfter}s wachten…`);
          await HSG.sleep(error.retryAfter * 1000);
          continue; // zelfde taak opnieuw
        }
        if (error.kind === 'challenge') {
          HSG.store.setSteamdbJobs({ ...HSG.store.getSteamdbJobs(), status: 'challenge' });
          overlay(
            'SteamDB vraagt om een controle. Ververs deze pagina en los de check op — daarna gaat het vanzelf verder.',
            { label: 'Opnieuw proberen', onClick: () => location.reload() }
          );
          return; // tabblad open laten, anders valt er niets op te lossen
        }
        result = { status: 'error', subIds: [], error: String(error.message || error) };
        waits = 0;
      }

      applyToQueue(job.itemId, result);
      markJobDone(job.itemId);
      if (touchedNetwork) await pause();
    }

    HSG.store.setSteamdbJobs({ ...HSG.store.getSteamdbJobs(), status: 'done' });
    overlay('klaar — dit tabblad sluit zichzelf.');
    // De opener sluit ons via zijn tab-handle; dit is de terugval voor als die
    // pagina inmiddels dicht is. Vereist `@grant window.close`.
    setTimeout(() => {
      try {
        window.close();
      } catch (error) {
        // Laatste tabblad van het venster — dan blijft het gewoon staan.
      }
    }, 1500);
  }

  // --- opstarten --------------------------------------------------------------

  function boot() {
    if (isChallengeDocument(document)) {
      const record = HSG.store.getSteamdbJobs();
      if (record && (record.jobs || []).some((job) => !job.done)) {
        HSG.store.setSteamdbJobs({ ...record, status: 'challenge' });
      }
      return; // na het oplossen herlaadt de pagina en draait dit script opnieuw
    }

    if (isWorkerTab()) {
      runJobs().catch((error) =>
        console.error('[Humble → SteamGifts]', HSG.redact(String(error && error.message) || String(error)))
      );
      return;
    }

    // Gewoon aan het browsen op SteamDB. Ligt er nog werk en is er geen
    // werktabblad actief (bijvoorbeeld na een Cloudflare-controle), bied dan
    // aan het hier af te maken — deze pagina is al door de controle heen.
    const record = HSG.store.getSteamdbJobs();
    const waiting = record && (record.jobs || []).some((job) => !job.done);
    const active =
      record &&
      record.status === 'running' &&
      record.heartbeatAt &&
      Date.now() - record.heartbeatAt < HEARTBEAT_STALE_MS;
    if (waiting && !active) {
      const open = record.jobs.filter((job) => !job.done).length;
      overlay(`er staan nog ${open} regiocontrole(s) klaar.`, {
        label: 'Nu uitvoeren',
        onClick: () => runJobs(),
      });
    }
  }

  HSG.steamdb = {
    boot,
    enqueueLookups,
    jobsSummary,
    retryLookups,
    /** Alleen voor tests: de parsers los kunnen aanroepen op een Document. */
    parsers: { cellValue, rowPairs, parseSubDocument, parseAppSubsDocument },
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = HSG;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
