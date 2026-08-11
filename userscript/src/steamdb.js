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
 * De uitkomst per spel gaat naar een eigen opslagsleutel
 * (`store.putSteamdbResult`), niet de wachtrij in: de wachtrij wordt alleen
 * door de Humble- en SteamGifts-tabs beschreven, en een tweede schrijver zou
 * daar zonder slot statussen kunnen terugdraaien. De SteamGifts-kant plakt de
 * uitspraak er bij het invullen zelf bij en beslist via `HSG.regionPlan`.
 *
 * Belangrijkste veiligheidsregel hier: alleen een pagina die zichzelf als
 * pakketpagina bewijst telt als antwoord. "Geen restrictierijen gevonden" op
 * een niet-herkende pagina is geen "geen beperking" — juist die uitkomst zou
 * Humble overschrijven.
 */
'use strict';

(function (root) {
  const HSG = (root.HSG = root.HSG || {});
  const SD = HSG.SELECTORS.steamdb;

  const WORKER_MARK = 'hsg-worker';
  /** Na zo lang zonder hartslag geldt een werktabblad als verdwenen. */
  const HEARTBEAT_STALE_MS = 20000;
  /** De werker klopt elke paar seconden, ook tijdens pauzes en wachttijden. */
  const HEARTBEAT_EVERY_MS = 5000;
  const WORKER_ID = `w${Math.random().toString(36).slice(2)}`;

  const isWorkerTab = () => location.hash.indexOf(WORKER_MARK) !== -1;

  const heartbeatFresh = (record) =>
    Boolean(record && record.heartbeatAt && Date.now() - record.heartbeatAt < HEARTBEAT_STALE_MS);

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
    const fields = HSG.steamdbFieldsFromRows(rowPairs(doc));
    return {
      // Restrictierijen gevonden is bewijs genoeg; zonder restricties moet de
      // pagina zich met een van de vaste pakketteksten bewijzen.
      proof: Object.keys(fields).length > 0 || SD.subPageProof.test(bodyText),
      stale: SD.stalePattern.test(bodyText),
      restrictions: HSG.steamdbRestrictions(fields),
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
    const noPackages = SD.noPackagesPattern.test(bodyText);
    return {
      proof: candidates.length > 0 || noPackages || SD.appSubsProof.test(bodyText),
      candidates,
      noPackages,
    };
  }

  const isChallengeDocument = (doc) =>
    SD.challengePattern.test(doc.title || '') ||
    Boolean(doc.querySelector('#challenge-form, #challenge-running, #cf-challenge-running'));

  // --- ophalen ----------------------------------------------------------------

  /**
   * Alle netwerkverkeer loopt hierlangs, en dit is ook de plek die het tempo
   * bewaakt: minimaal 2-5 s (met jitter) tussen twee fetches, wat de aanroeper
   * ook doet. SteamDB verbiedt agressief scrapen; wij gedragen ons als een
   * rustige bezoeker.
   */
  let lastFetchAt = 0;

  async function fetchDoc(path) {
    const wait = lastFetchAt + 2000 + Math.random() * 3000 - Date.now();
    if (wait > 0) await HSG.sleep(wait);
    lastFetchAt = Date.now();

    const response = await fetch(path, {
      credentials: 'include',
      headers: { Accept: 'text/html' },
    });

    if (response.status === 429) {
      const retry = Number(response.headers.get('Retry-After')) || 30;
      const error = new Error('SteamDB vraagt om rust (429).');
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

    const doc = new DOMParser().parseFromString(text, 'text/html');
    // Ook een 200 kan een tussenpagina zijn; die mag nooit als inhoud tellen.
    if (isChallengeDocument(doc)) {
      const error = new Error('SteamDB toont een controlepagina.');
      error.kind = 'challenge';
      throw error;
    }
    return doc;
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
      const parsed = parseSubDocument(doc);
      // Zonder bewijs van een pakketpagina is "geen restricties" geen
      // uitkomst maar een leesfout — kort cachen en terugvallen op Humble.
      entry = parsed.proof
        ? { status: 'ok', stale: parsed.stale, restrictions: parsed.restrictions, name: parsed.name }
        : { status: 'unparsed' };
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
      const parsed = parseAppSubsDocument(doc);
      entry = parsed.proof
        ? { status: 'ok', candidates: parsed.candidates, noPackages: parsed.noPackages }
        : { status: 'unparsed' };
    } catch (error) {
      if (error.kind !== 'notfound') throw error;
      entry = { status: 'notfound' };
    }
    HSG.store.putSteamdbApp(appId, entry);
    return entry;
  }

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
      if (entry.status === 'unparsed' && !job.appId) return { status: 'unparsed', subIds: [] };
      // Het directe pakket bestaat niet (meer) of was onleesbaar:
      // door naar de pakketlijst van de app.
    }

    if (!job.appId) return { status: job.subId ? 'nosub' : 'nodata', subIds: [] };

    const appEntry = await lookupApp(job.appId);
    if (appEntry.status === 'unparsed') return { status: 'unparsed', subIds: [] };
    if (appEntry.status !== 'ok' || appEntry.noPackages || (appEntry.candidates || []).length === 0) {
      return { status: 'nosub', subIds: [] };
    }

    const pick = HSG.pickSteamdbSubs(appEntry.candidates);
    if (pick.reason === 'none') return { status: 'nosub', subIds: [] };
    if (pick.reason === 'many') return { status: 'ambiguous', subIds: [] };

    const fetched = [];
    for (const subId of pick.subIds) {
      const entry = await lookupSub(subId);
      if (entry.status === 'ok') {
        fetched.push({ subId: String(subId), stale: entry.stale, restrictions: entry.restrictions });
      }
    }
    return HSG.resolveSteamdbCandidates(fetched, pick.reason, pick.subIds.length);
  }

  /** De uitspraak opslaan — in de eigen resultatenmap, niet in de wachtrij. */
  function applyResult(itemId, result) {
    HSG.store.putSteamdbResult(itemId, { ...result, checkedAt: Date.now() });
  }

  // --- de takenlijst (cachebeslissingen zonder netwerk) -----------------------

  /** Zelfde beslissing als `lookupJob`, maar uitsluitend uit de cache. */
  function resolveFromCache(subId, appId) {
    if (subId) {
      const entry = HSG.store.readSteamdbSub(subId);
      if (!entry) return null;
      if (entry.status === 'ok') {
        return {
          ...HSG.resolveSteamdbCandidates(
            [{ subId: String(subId), stale: entry.stale, restrictions: entry.restrictions }],
            'direct'
          ),
          subName: entry.name || null,
        };
      }
      if (entry.status === 'unparsed' && !appId) return { status: 'unparsed', subIds: [] };
      // notfound/onleesbaar in cache → beslis via de pakketlijst, indien bekend.
    }
    if (!appId) return subId ? { status: 'nosub', subIds: [] } : null;

    const appEntry = HSG.store.readSteamdbApp(appId);
    if (!appEntry) return null;
    if (appEntry.status === 'unparsed') return { status: 'unparsed', subIds: [] };
    if (appEntry.status !== 'ok' || appEntry.noPackages || !(appEntry.candidates || []).length) {
      return { status: 'nosub', subIds: [] };
    }
    const pick = HSG.pickSteamdbSubs(appEntry.candidates);
    if (pick.reason === 'none') return { status: 'nosub', subIds: [] };
    if (pick.reason === 'many') return { status: 'ambiguous', subIds: [] };
    const fetched = [];
    for (const id of pick.subIds) {
      const entry = HSG.store.readSteamdbSub(id);
      if (!entry) return null; // eentje mist → toch een taak voor het werktabblad
      if (entry.status === 'ok') {
        fetched.push({ subId: String(id), stale: entry.stale, restrictions: entry.restrictions });
      }
    }
    return HSG.resolveSteamdbCandidates(fetched, pick.reason, pick.subIds.length);
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
    if (record.status === 'running' && heartbeatFresh(record)) return;
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

    // Uitspraken van verdwenen wachtrij-items opruimen, nu we hier toch zijn.
    const queueIds = HSG.store.getQueue().items.map((item) => item.id);
    HSG.store.pruneSteamdbResults(
      queueIds.concat((entries || []).map((entry) => HSG.itemId(entry.gamekey, entry.machineName)))
    );

    const jobs = [];
    for (const entry of entries || []) {
      const itemId = HSG.itemId(entry.gamekey, entry.machineName);
      const subId = entry.steamPackageId || null;
      const appId = entry.steamAppId || null;

      if (!subId && !appId) {
        applyResult(itemId, { status: 'nodata', subIds: [] });
        continue;
      }
      const cached = resolveFromCache(subId, appId);
      if (cached) {
        applyResult(itemId, cached);
        continue;
      }
      applyResult(itemId, { status: 'pending', subIds: [] });
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
    const running = existing && existing.status === 'running' && heartbeatFresh(existing);
    // Een openstaande Cloudflare-controle blijft staan: een nieuw tabblad zou
    // op dezelfde muur stuiten, en het paneel toont al een herstelknop.
    const status = running
      ? 'running'
      : existing && existing.status === 'challenge'
        ? 'challenge'
        : 'pending';

    const record = {
      jobs: keep.concat(jobs),
      status,
      workerId: running ? existing.workerId : null,
      heartbeatAt: running ? existing.heartbeatAt : 0,
      startedAt: Date.now(),
    };
    HSG.store.setSteamdbJobs(record);
    if (status !== 'challenge') openWorkerIfNeeded(record);
    return { queued: jobs.length };
  }

  /** Voor het paneel: loopt er nog iets, zit het vast, of ligt het stil? */
  function jobsSummary() {
    const record = HSG.store.getSteamdbJobs();
    if (!record || !Array.isArray(record.jobs)) return null;
    const open = record.jobs.filter((job) => !job.done).length;
    if (open === 0) return null;
    const stalled =
      record.status !== 'challenge' &&
      !heartbeatFresh(record) &&
      Date.now() - (record.startedAt || 0) > 30000;
    return { open, total: record.jobs.length, status: record.status, stalled };
  }

  /** Herstelknop: vastgelopen of geblokkeerde controles opnieuw aanzwengelen. */
  function retryLookups() {
    const record = HSG.store.getSteamdbJobs();
    if (!record || !(record.jobs || []).some((job) => !job.done)) return false;
    // Een hangend werktabblad eerst sluiten, anders houdt de open-check het
    // nieuwe tabblad tegen en gebeurt er stilletjes niets.
    if (workerHandle && !workerHandle.closed) {
      try {
        workerHandle.close();
      } catch (error) {
        // Prima, dan blijft het staan.
      }
      workerHandle = null;
    }
    const next = { ...record, status: 'pending', workerId: null, heartbeatAt: 0, startedAt: Date.now() };
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
      if (isWorkerTab()) overlay('niets meer te doen — dit tabblad mag dicht.');
      return;
    }
    // Niet met z'n tweeën aan dezelfde lijst werken.
    const otherActive =
      record.status === 'running' && record.workerId !== WORKER_ID && heartbeatFresh(record);
    if (otherActive) return;

    HSG.store.setSteamdbJobs({
      ...record,
      status: 'running',
      workerId: WORKER_ID,
      heartbeatAt: Date.now(),
    });

    // De hartslag loopt óók tijdens fetch-pauzes en 429-wachttijden; een taak
    // kan zo langer duren dan het verversvenster, en zonder slag zou een
    // tweede tabblad denken dat wij verdwenen zijn en ernaast gaan draaien.
    const beat = setInterval(() => {
      const current = HSG.store.getSteamdbJobs();
      if (current) HSG.store.setSteamdbJobs({ ...current, heartbeatAt: Date.now() });
    }, HEARTBEAT_EVERY_MS);

    let waits = 0;
    try {
      for (;;) {
        record = HSG.store.getSteamdbJobs();
        const openJobs = (record && record.jobs) || [];
        const job = openJobs.find((entry) => !entry.done);

        if (!job) {
          // Afmelden gebeurt met hartslag op nul: een toevoeging die nét in
          // ons vensterken valt ziet dan geen "levende werker" meer en opent
          // gewoon een vers tabblad in plaats van op ons te wachten.
          const latest = HSG.store.getSteamdbJobs() || { jobs: [] };
          if ((latest.jobs || []).some((entry) => !entry.done)) continue;
          HSG.store.setSteamdbJobs({ ...latest, status: 'done', workerId: null, heartbeatAt: 0 });
          // Kwam er tijdens het afronden nét een taak bij, pak die dan alsnog
          // op in plaats van hem als wees achter te laten.
          const recheck = HSG.store.getSteamdbJobs();
          if (recheck && (recheck.jobs || []).some((entry) => !entry.done)) {
            HSG.store.setSteamdbJobs({
              ...recheck,
              status: 'running',
              workerId: WORKER_ID,
              heartbeatAt: Date.now(),
            });
            continue;
          }
          break;
        }

        const done = openJobs.filter((entry) => entry.done).length;
        overlay(
          `pakketdata lezen — ${job.name || job.subId || job.appId} (${done + 1} van ${openJobs.length})…`
        );

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

        applyResult(job.itemId, result);
        markJobDone(job.itemId);
      }
    } finally {
      clearInterval(beat);
    }

    if (isWorkerTab()) {
      overlay('klaar — dit tabblad sluit zichzelf.');
      // De opener sluit ons via zijn tab-handle; dit is de terugval voor als
      // die pagina inmiddels dicht is. Vereist `@grant window.close`. In een
      // gewoon browse-tabblad (de "Nu uitvoeren"-knop) blijven we van het
      // tabblad van de gebruiker af.
      setTimeout(() => {
        try {
          window.close();
        } catch (error) {
          // Laatste tabblad van het venster — dan blijft het gewoon staan.
        }
      }, 1500);
    } else {
      overlay('regiocontroles afgerond.');
    }
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
    const active = record && record.status === 'running' && heartbeatFresh(record);
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
