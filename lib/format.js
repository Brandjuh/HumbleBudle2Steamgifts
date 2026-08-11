/**
 * Pure functies: datumopmaak voor SteamGifts en het koppelen van een
 * Humble-titel aan het juiste spel in de SteamGifts-catalogus.
 *
 * Alles hier is testbaar zonder browser — zie test/format.test.js.
 */
'use strict';

(function (root) {
  const HSG = (root.HSG = root.HSG || {});

  const MONTHS = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];

  /**
   * SteamGifts verwacht `MMM d, yyyy h:mm a` (date-fns v2), bijv.
   * "Jul 30, 2026 8:00 PM". Een afwijkend formaat wordt stil genegeerd en
   * levert een onbruikbare giveaway op — dit is de klassieke valkuil.
   */
  HSG.formatSteamGiftsDate = function (date) {
    const hours24 = date.getHours();
    const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const meridiem = hours24 < 12 ? 'AM' : 'PM';
    return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} ${hours12}:${minutes} ${meridiem}`;
  };

  const HOUR = 3600000;
  const DAY = 86400000;
  /** SteamGifts: "minimum time open of 1 hour", "within the next 30 days". */
  const SG_MIN_OPEN = HOUR;
  const SG_MAX_RANGE = 30 * DAY;
  /** Marge tussen het sluiten van de giveaway en het verlopen van de key. */
  const REDEEM_MARGIN = 7 * DAY;

  /**
   * Start- en eindtijd afleiden uit de instellingen, met de uiterste
   * inwisseldatum als bovengrens.
   *
   * Volgorde van de regels — die is betekenisvol:
   * 1. eindtijd uit de instellingen;
   * 2. is er een deadline, dan uiterlijk een week daarvóór, zodat de winnaar tijd
   *    heeft om in te wisselen;
   * 3. minstens een uur open, want minder accepteert SteamGifts niet;
   * 4. binnen dertig dagen, want verder vooruit accepteert SteamGifts niet;
   * 5. past zelfs dat uur niet meer vóór de deadline, dan is er geen zinnige
   *    giveaway te maken → `impossible`.
   *
   * @param {Date} [deadline] het veilige moment waarop de key verloopt
   */
  HSG.computeSchedule = function (settings, now, deadline) {
    const base = now instanceof Date ? now.getTime() : Date.now();
    const start = new Date(base + (settings.startOffsetMinutes || 0) * 60000);
    const limit = deadline instanceof Date ? deadline.getTime() : null;

    let end = start.getTime() + (settings.durationDays || 7) * DAY;
    let cappedBy = null;

    if (limit != null && limit - REDEEM_MARGIN < end) {
      end = limit - REDEEM_MARGIN;
      cappedBy = 'deadline';
    }
    if (end < start.getTime() + SG_MIN_OPEN) {
      end = start.getTime() + SG_MIN_OPEN;
      cappedBy = 'minimum';
    }
    if (end > base + SG_MAX_RANGE) {
      end = base + SG_MAX_RANGE;
      cappedBy = cappedBy || 'maxRange';
    }

    const endDate = new Date(end);
    return {
      start,
      end: endDate,
      startText: HSG.formatSteamGiftsDate(start),
      endText: HSG.formatSteamGiftsDate(endDate),
      deadline: limit != null ? new Date(limit) : null,
      cappedBy,
      impossible: limit != null && end > limit,
    };
  };

  // --- uiterste inwisseldatum -------------------------------------------------

  const PACIFIC = 'America/Los_Angeles';
  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  /** Verschil tussen een zone en UTC op een bepaald moment, in milliseconden. */
  function zoneOffsetMs(date, timeZone) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = {};
    for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second)
    );
    return asUtc - date.getTime();
  }

  /**
   * Wandklok-tijd in een tijdzone omrekenen naar het werkelijke moment.
   * Twee rondes, want de eerste schatting kan aan de verkeerde kant van een
   * zomertijdovergang liggen.
   */
  HSG.zonedTimeToUtc = function (parts, timeZone) {
    const wall = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour || 0,
      parts.minute || 0,
      parts.second || 0
    );
    let stamp = wall - zoneOffsetMs(new Date(wall), timeZone);
    stamp = wall - zoneOffsetMs(new Date(stamp), timeZone);
    return new Date(stamp);
  };

  /**
   * Humble's `expiry_date` naar een datum.
   *
   * Meestal een kale datum ("2026-08-15"), soms een datetime zonder offset,
   * zelden met `Z`. Kaal `new Date(raw)` is daarom gevaarlijk: JS leest
   * "2026-08-15" als UTC-middernacht maar "2026-08-15T00:00:00" als lókale
   * middernacht — een verschil van een dag.
   *
   * Niet te parsen levert `null`: liever geen deadline dan een verkeerde.
   */
  HSG.parseExpiry = function (raw) {
    const value = String(raw == null ? '' : raw).trim();
    if (!value) return null;

    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : { date, dateOnly: false };
    }

    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (day) {
      return { date: new Date(Date.UTC(+day[1], +day[2] - 1, +day[3])), dateOnly: true };
    }

    const stamp = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
    if (stamp) {
      return {
        date: new Date(
          Date.UTC(+stamp[1], +stamp[2] - 1, +stamp[3], +stamp[4], +stamp[5], stamp[6] ? +stamp[6] : 0)
        ),
        dateOnly: false,
      };
    }
    return null;
  };

  /**
   * Het moment waarop je de key zeker niet meer moet willen gebruiken.
   *
   * Humble zet keys op wisselende momenten gedurende de expiratiedag uit, in
   * Pacific-tijd. Veilig rekenen is dus: het begin van die dag daar, oftewel het
   * eind van de dag ervóór.
   */
  HSG.safeDeadline = function (parsed) {
    if (!parsed || !(parsed.date instanceof Date)) return null;
    if (!parsed.dateOnly) return parsed.date;
    return HSG.zonedTimeToUtc(
      {
        year: parsed.date.getUTCFullYear(),
        month: parsed.date.getUTCMonth() + 1,
        day: parsed.date.getUTCDate(),
      },
      PACIFIC
    );
  };

  HSG.stripHtml = function (html) {
    return String(html || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();
  };

  /**
   * Een datum uit lopende instructietekst vissen ("must be redeemed by
   * August 15, 2026").
   *
   * Er moet een signaalwoord vlak vóór de datum staan. Zonder die eis pikt dit
   * ook release- en aanbiedingsdatums op, en een verzonnen deadline is erger dan
   * geen deadline.
   */
  HSG.deadlineFromText = function (text) {
    const value = String(text || '');
    const pattern =
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/gi;

    for (const match of value.matchAll(pattern)) {
      const before = value.slice(Math.max(0, match.index - 80), match.index);
      if (!/(redeem|expir|valid|must be|deadline)/i.test(before)) continue;

      const month = MONTH_NAMES.findIndex(
        (name) => name.toLowerCase() === match[1].toLowerCase()
      );
      const day = Number(match[2]);
      if (month < 0 || day < 1 || day > 31) continue;
      return { date: new Date(Date.UTC(Number(match[3]), month, day)), dateOnly: true };
    }
    return null;
  };

  /**
   * De deadline van een tpk. `expiry_date` is de bron; ontbreekt die, dan een
   * terugval op de instructietekst — gemarkeerd als `derived`, want dat is een
   * gok en hoort niet als zekerheid te klinken.
   */
  HSG.deadlineFromTpk = function (tpk) {
    const direct = HSG.parseExpiry(tpk && tpk.expiry_date);
    if (direct) return { ...direct, source: 'field' };

    const html = (tpk && (tpk.custom_instructions_html || tpk.instructions_html)) || '';
    const derived = HSG.deadlineFromText(HSG.stripHtml(html));
    return derived ? { ...derived, source: 'derived' } : null;
  };

  /** De regel die in de beschrijving van de giveaway komt. Engels: SteamGifts is dat ook. */
  HSG.describeDeadline = function (parsed) {
    if (!parsed || !(parsed.date instanceof Date)) return '';
    const date = parsed.date;
    let when = `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
    if (!parsed.dateOnly) {
      const hh = String(date.getUTCHours()).padStart(2, '0');
      const mm = String(date.getUTCMinutes()).padStart(2, '0');
      when += `, ${hh}:${mm} UTC`;
    } else {
      when += ' (Pacific time)';
    }
    const verb = parsed.source === 'derived' ? 'appears to expire around' : 'expires';
    return `⚠ This Humble key ${verb} ${when} — please redeem it on Steam well before then.`;
  };

  /**
   * Heen en weer tussen een geparseerde deadline en iets dat door JSON past —
   * de wachtrij en de catalogus gaan door storage heen, en een `Date` overleeft
   * dat niet.
   */
  HSG.storeExpiry = function (parsed) {
    if (!parsed || !(parsed.date instanceof Date)) return null;
    return {
      at: parsed.date.toISOString(),
      dateOnly: Boolean(parsed.dateOnly),
      source: parsed.source || 'field',
    };
  };

  HSG.readExpiry = function (stored) {
    if (!stored || !stored.at) return null;
    const date = new Date(stored.at);
    if (Number.isNaN(date.getTime())) return null;
    return {
      date,
      dateOnly: Boolean(stored.dateOnly),
      source: stored.source || 'field',
    };
  };

  /** Voor de UI: "verloopt over 12 dagen". */
  HSG.daysUntil = function (date, now) {
    if (!(date instanceof Date)) return null;
    const base = now instanceof Date ? now.getTime() : Date.now();
    return Math.floor((date.getTime() - base) / DAY);
  };

  /**
   * Titels van Humble en SteamGifts lopen net uiteen: trademark-tekens,
   * "Definitive Edition", accenten, rare streepjes. Normaliseren voor we
   * vergelijken.
   */
  HSG.normalizeTitle = function (value) {
    return String(value || '')
      // ™ en ® eerst weg: NFKD zou er "tm" / "r" van maken en dat plakt
      // aan het voorgaande woord vast.
      .replace(/[™®©]/g, '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  };

  /**
   * Kies het juiste spel uit de autocomplete-resultaten.
   *
   * Bewust conservatief: liever één keer vragen dan een key aan het verkeerde
   * spel hangen. Dat laatste is namelijk niet meer terug te draaien zodra de
   * giveaway loopt.
   *
   * @param {{id: string, name: string}[]} rows
   * @param {string} humbleName
   * @returns {{match: object|null, reason: string, candidates: object[]}}
   */
  HSG.pickGameMatch = function (rows, humbleName) {
    const candidates = (rows || []).filter((row) => row && row.id && row.name);
    if (candidates.length === 0) {
      return { match: null, reason: 'none', candidates: [] };
    }

    const wanted = HSG.normalizeTitle(humbleName);
    const exact = candidates.filter((row) => HSG.normalizeTitle(row.name) === wanted);
    if (exact.length === 1) {
      return { match: exact[0], reason: 'exact', candidates };
    }
    if (exact.length > 1) {
      return { match: null, reason: 'ambiguous', candidates: exact };
    }
    if (candidates.length === 1) {
      return { match: candidates[0], reason: 'only-result', candidates };
    }
    return { match: null, reason: 'ambiguous', candidates };
  };

  /**
   * Tekst die in een key-rij naast de spelnaam staat en dus geen titel is.
   * Bewust klein gehouden: te agressief filteren gooit echte titels weg.
   */
  const ROW_NOISE = new Set([
    'steam', 'gog', 'epic', 'origin', 'uplay', 'battlenet', 'ubisoft connect',
    'key', 'keys', 'steam key', 'reveal', 'reveal your key', 'redeem', 'redeemed',
    'copy', 'copied', 'show', 'hide', 'gift', 'gift this', 'claimed', 'expired',
    'download', 'downloads', 'platform', 'game', 'name',
  ]);

  /**
   * Kiest de spelnaam uit de losse tekstjes van een rij op de keys-pagina.
   *
   * Humble's rijen bevatten naast de titel ook knoplabels ("Reveal your key"),
   * een platformnaam en soms een datum. De titel is doorgaans de langste
   * overgebleven tekst; keys en labels vallen eerst af.
   *
   * @param {string[]} candidates ruwe teksten uit de rij
   * @returns {string|null}
   */
  HSG.pickRowName = function (candidates) {
    let best = null;
    for (const raw of candidates || []) {
      const text = String(raw || '').replace(/\s+/g, ' ').trim();
      if (text.length < 2 || text.length > 80) continue;
      // Een Steam-key is geen titel.
      if (/^[A-Z0-9]{5}(-[A-Z0-9]{5}){2,4}$/i.test(text)) continue;
      if (ROW_NOISE.has(text.toLowerCase())) continue;
      // Losse getallen, datums en bedragen.
      if (/^[\d\s./:$€,-]+$/.test(text)) continue;
      if (HSG.looksLikeProse(text)) continue;
      if (!best || text.length > best.length) best = text;
    }
    return best;
  };

  /**
   * Volzinnen weren. Humble zet in elke key-rij dezelfde disclaimer ("Steam will
   * not provide extra giftable copies of games you already own."), en omdat die
   * langer is dan de meeste speltitels won hij van de titel — waarna elke rij
   * dezelfde naam kreeg en de hele lijst tot één regel samenklapte.
   *
   * Een punt aan het eind én vier of meer woorden is proza. `S.T.A.L.K.E.R.`
   * eindigt ook op een punt maar is één woord, dus die blijft staan.
   */
  HSG.looksLikeProse = function (text) {
    const value = String(text || '').trim();
    if (!/[.!?]$/.test(value)) return false;
    return value.split(/\s+/).length >= 4;
  };

  /**
   * Haalt de order-sleutel uit een bundellink: `/download?key=5UpZdUyMHhmZxuqa`.
   * Met die sleutel kunnen we de hele order opvragen — dat levert de Steam-appid's
   * én alle keys van die bundel, ook de exemplaren die op een volgende pagina
   * van Humble staan.
   */
  HSG.parseOrderKey = function (href) {
    const match = /[?&]key=([^&#]+)/.exec(String(href || ''));
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]) || null;
    } catch (error) {
      return match[1] || null;
    }
  };

  const PLATFORM_PATTERN =
    /\b(?:hb|platform|icon)[-_]?(steam|gog|epic|origin|uplay|battlenet)\b/i;

  /**
   * Leest het platform uit de klassenamen van een icoontje in de rij.
   * Geeft null terug als er niets herkenbaars in staat — dan weten we het niet,
   * en dat is iets anders dan "geen Steam".
   */
  HSG.detectPlatform = function (classNames) {
    const match = PLATFORM_PATTERN.exec(String(classNames || ''));
    return match ? match[1].toLowerCase() : null;
  };

  /**
   * De ISO-landcode uit het `data-name` van een SteamGifts-landrij.
   *
   * SteamGifts identificeert landen met een eigen nummer, niet met de landcode:
   *   <div data-name="Netherlands NL" data-item-id="160">
   *   <div data-name="Brazil BR"      data-item-id="30">
   *
   * De code staat als laatste woord in `data-name`. Zonder deze vertaalslag valt
   * Humble's "BR" nergens op te leggen.
   */
  HSG.parseCountryCode = function (dataName) {
    const match = /(?:^|\s)([A-Z]{2})$/.exec(String(dataName || '').trim());
    return match ? match[1] : null;
  };

  const upperList = (values) =>
    (values || []).map((code) => String(code).trim().toUpperCase()).filter(Boolean);

  /**
   * Keert Humble's regio-informatie om naar de toestemmingslijst die SteamGifts
   * wil. Op SteamGifts betekent een aangevinkt land "hier mag men meedoen".
   *
   * Humble heeft twee velden, en ze werken tegengesteld:
   * - `disallowed_countries` — hier werkt de key NIET; de rest wel.
   * - `exclusive_countries`  — de key werkt ALLEEN hier.
   *
   * Is `exclusive_countries` gevuld, dan is dat leidend en telt `disallowed`
   * daar nog bovenop. Wie alleen naar `disallowed` kijkt, zet een exclusieve key
   * open voor de hele wereld.
   *
   * @param {{id: string, code: string|null}[]} items landrijen van SteamGifts
   * @param {string[]} disallowed ISO-landcodes waar de key niet werkt
   * @param {string[]} [exclusive] ISO-landcodes waar de key uitsluitend werkt
   * @returns {{allowedIds: string[], blockedCodes: string[], unknownCodes: string[], unmapped: string[]}}
   */
  HSG.allowedCountries = function (items, disallowed, exclusive) {
    const blockSet = new Set(upperList(disallowed));
    const onlySet = new Set(upperList(exclusive));
    const hasExclusive = onlySet.size > 0;

    const allowedIds = [];
    const blockedCodes = [];
    const unmapped = [];
    const known = new Set();

    for (const item of items || []) {
      if (!item || !item.id) continue;
      const code = item.code ? String(item.code).trim().toUpperCase() : null;

      if (!code) {
        // Geen leesbare landcode. Bij een exclusieve key kunnen we niet
        // vaststellen dat dit land erbij hoort, dus dan valt hij af.
        unmapped.push(item.id);
        if (!hasExclusive) allowedIds.push(item.id);
        continue;
      }

      known.add(code);
      const blocked = blockSet.has(code) || (hasExclusive && !onlySet.has(code));
      if (blocked) blockedCodes.push(code);
      else allowedIds.push(item.id);
    }

    const mentioned = new Set([...blockSet, ...onlySet]);
    const unknownCodes = Array.from(mentioned).filter((code) => !known.has(code));
    return { allowedIds, blockedCodes, unknownCodes, unmapped };
  };

  // --- SteamDB-pakketdata -----------------------------------------------------

  /**
   * Een landenlijst zoals SteamDB die toont: ISO-codes, gescheiden door spaties
   * óf komma's ("RU BY KZ", "RU,BY"). Alles wat geen tweeletterige code is —
   * vlagteksten, volledige landnamen — valt af.
   */
  HSG.splitCountryList = function (value) {
    return String(value || '')
      .split(/[\s,]+/)
      .map((code) => code.trim().toUpperCase())
      .filter((code) => /^[A-Z]{2}$/.test(code));
  };

  /**
   * De vijf velden op een pakketpagina die over regio's gaan. De vlaggen zijn
   * geen aparte beperkingen maar richtingaanwijzers: ze bepalen of de
   * bijbehorende lijst een zwarte of een witte lijst is.
   */
  const STEAMDB_FIELDS = {
    purchaserestrictedcountries: 'list',
    allowpurchasefromrestrictedcountries: 'flag',
    restrictedcountries: 'list',
    onlyallowrestrictedcountries: 'flag',
    onlyallowrunincountries: 'list',
  };

  /**
   * Van ruwe tabelrijen ({label, value}) naar de bekende velden. Labels worden
   * op tekst gematcht, niet op opmaak: SteamDB toont bekende sleutels als
   * "PurchaseRestrictedCountries" en onbekende als "onlyallowrunincountries",
   * en de CSS eromheen is al eens veranderd.
   */
  HSG.steamdbFieldsFromRows = function (rows) {
    const fields = {};
    for (const row of rows || []) {
      const label = String((row && row.label) || '').trim().toLowerCase();
      const kind = STEAMDB_FIELDS[label];
      if (!kind) continue;
      if (kind === 'list') fields[label] = HSG.splitCountryList(row.value);
      else fields[label] = /^\s*(yes|true|1)\s*$/i.test(String((row && row.value) || ''));
    }
    return fields;
  };

  /**
   * De betekenis van de velden, overgenomen uit hoe Steam ze zelf toepast:
   * een land mag activeren als `(land ∈ lijst) == vlag`. Vlag aan maakt de
   * lijst dus een witte lijst ("alleen hier"), vlag uit een zwarte lijst.
   * `onlyallowrunincountries` is altijd een witte lijst (het spel start alleen
   * dáár — strenger dan een activatieslot, dus nemen we hem mee).
   *
   * @returns {{disallowed: string[], exclusive: string[]|null}}
   *   `exclusive: null` = geen witte lijst; een lege array betekent dat de
   *   witte lijsten elkaar tegenspreken (nergens toegestaan).
   */
  HSG.steamdbRestrictions = function (fields) {
    const f = fields || {};
    const disallowed = new Set();
    const whitelists = [];

    const pair = (list, flag) => {
      if (!list || list.length === 0) return;
      if (flag) whitelists.push(list);
      else for (const code of list) disallowed.add(code);
    };
    pair(f.purchaserestrictedcountries, f.allowpurchasefromrestrictedcountries);
    pair(f.restrictedcountries, f.onlyallowrestrictedcountries);
    if (f.onlyallowrunincountries && f.onlyallowrunincountries.length) {
      whitelists.push(f.onlyallowrunincountries);
    }

    let exclusive = null;
    for (const list of whitelists) {
      if (exclusive === null) {
        exclusive = Array.from(new Set(list));
      } else {
        const keep = new Set(list);
        exclusive = exclusive.filter((code) => keep.has(code));
      }
    }
    return { disallowed: Array.from(disallowed), exclusive };
  };

  /**
   * Meerdere pakketten samenvoegen tot de strengste uitkomst: zwarte lijsten
   * opgeteld, witte lijsten gesneden.
   */
  HSG.combineRestrictions = function (parts) {
    const disallowed = new Set();
    let exclusive = null;
    for (const part of parts || []) {
      if (!part) continue;
      for (const code of part.disallowed || []) disallowed.add(code);
      if (part.exclusive != null) {
        if (exclusive === null) {
          exclusive = Array.from(new Set(part.exclusive));
        } else {
          const keep = new Set(part.exclusive);
          exclusive = exclusive.filter((code) => keep.has(code));
        }
      }
    }
    return { disallowed: Array.from(disallowed), exclusive };
  };

  /**
   * Welke pakketten van een spel zijn het bekijken waard? Kandidaten komen uit
   * de pakketlijst op SteamDB: alleen pakketten waar keys tegen aangemaakt
   * worden tellen (`cdKey`).
   *
   * Een Humble-key hoort meestal bij een generiek retail-pakket, soms bij een
   * pakket met "Humble" in de naam. Regiovarianten ("… Turkey Retail Keys")
   * staan er ook tussen, en dáár mag de uitkomst niet van afhangen — zie
   * `resolveSteamdbCandidates`. Bij meer dan vier kandidaten wordt daarom
   * helemaal niet gegokt: dan is het antwoord alleen te bewijzen door álles te
   * lezen, en dat is SteamDB te veel gevraagd. (Een eerdere versie koos hier op
   * SteamDB's "(Buy Restrict)"-markering, maar die faalt naar twee kanten:
   * geen markering is geen bewijs van "onbeperkt", en alleen de gemarkeerde
   * pakketten lezen sluit een wereldwijde key op in een regiovariant.)
   */
  HSG.pickSteamdbSubs = function (candidates) {
    const keySubs = (candidates || []).filter((c) => c && c.subId && c.cdKey);
    if (keySubs.length === 0) return { subIds: [], reason: 'none' };

    const humble = keySubs.filter((c) => /humble/i.test(c.name || ''));
    if (humble.length > 0) {
      return { subIds: humble.slice(0, 3).map((c) => c.subId), reason: 'humble' };
    }
    if (keySubs.length === 1) return { subIds: [keySubs[0].subId], reason: 'single' };
    if (keySubs.length <= 4) return { subIds: keySubs.map((c) => c.subId), reason: 'all' };
    return { subIds: [], reason: 'many' };
  };

  /**
   * De opgehaalde pakketten naar één uitspraak. Bij een pakket dat duidelijk
   * bij Humble hoort (of het enige key-pakket is) volgen we dat pakket; bij
   * meerdere kandidaten alleen als ze állemaal gelezen zijn én hetzelfde
   * zeggen. Anders zouden we een wereldwijde key kunnen opsluiten in de regio
   * van een lokale winkelvariant — of omgekeerd.
   *
   * @param {{subId: string, stale: boolean, restrictions: object}[]} fetched
   * @param {string} reason uit `pickSteamdbSubs` ('direct' voor een
   *   rechtstreeks bekend pakketnummer)
   * @param {number} [expected] hoeveel kandidaten er gelezen hadden moeten
   *   worden; minder gelukt = geen volledig beeld = geen uitspraak
   * @returns {{status: 'ok'|'stale'|'ambiguous'|'nosub', disallowed?, exclusive?, subIds: string[]}}
   */
  HSG.resolveSteamdbCandidates = function (fetched, reason, expected) {
    const usable = (fetched || []).filter(Boolean);
    const subIds = usable.map((f) => f.subId);
    if (usable.length === 0) return { status: 'nosub', subIds: [] };
    // Verouderde pakketdata is geen basis voor een uitspraak.
    if (usable.some((f) => f.stale)) return { status: 'stale', subIds };

    const restrictions = usable.map((f) => f.restrictions || { disallowed: [], exclusive: null });
    const trusted = reason === 'direct' || reason === 'humble' || reason === 'single';
    if (trusted) {
      return { status: 'ok', ...HSG.combineRestrictions(restrictions), subIds };
    }

    // Meerdere gelijkwaardige kandidaten: alleen een uitspraak als het beeld
    // compleet is en eensluidend.
    if (expected != null && usable.length < expected) return { status: 'ambiguous', subIds };
    const signature = (r) =>
      JSON.stringify({
        d: (r.disallowed || []).slice().sort(),
        e: r.exclusive == null ? null : r.exclusive.slice().sort(),
      });
    if (new Set(restrictions.map(signature)).size === 1) {
      return { status: 'ok', ...HSG.combineRestrictions([restrictions[0]]), subIds };
    }
    return { status: 'ambiguous', subIds };
  };

  /**
   * Welke regiobron geldt voor dit wachtrij-item? Eén beslispunt, zodat het
   * formulier en het paneel hetzelfde verhaal vertellen.
   *
   * De volgorde is afgesproken: verse SteamDB-data is leidend — ook als die
   * zegt "geen beperking" terwijl Humble wél landen noemt. Pas als SteamDB
   * niets bruikbaars heeft vallen we terug op Humble, en daarna op de vaste
   * instelling.
   *
   * @returns {{mode: 'steamdb'|'humble'|'fixed'|'none'|'off', disallowed: string[], exclusive: string[]|null, notes: string[]}}
   *   `none` = een bron zegt expliciet "geen beperking"; `off` = niets bekend
   *   en geen vaste restrictie ingesteld.
   */
  HSG.regionPlan = function (item, settings) {
    const notes = [];
    const humbleDisallowed = upperList(item && item.disallowedCountries);
    const humbleExclusive = upperList(item && item.exclusiveCountries);
    const humbleHas = humbleDisallowed.length > 0 || humbleExclusive.length > 0;
    const sdb = (item && item.steamdb) || null;
    const sdbUsable = settings.steamdbRegion !== false && sdb && sdb.status === 'ok';

    const fixed = () => {
      if (settings.regionRestricted) {
        return { mode: 'fixed', disallowed: [], exclusive: null, notes };
      }
      return { mode: 'off', disallowed: [], exclusive: null, notes };
    };

    if (settings.regionFromHumble === false) {
      if (humbleHas || (sdbUsable && ((sdb.disallowed || []).length || sdb.exclusive != null))) {
        notes.push(
          'Let op: er is regio-informatie voor dit spel, maar "regio automatisch overnemen" staat uit.'
        );
      }
      return fixed();
    }

    if (sdbUsable) {
      const disallowed = upperList(sdb.disallowed);
      const exclusive = sdb.exclusive == null ? null : upperList(sdb.exclusive);

      if (exclusive && exclusive.length === 0) {
        // Witte lijsten die elkaar uitsluiten: nergens toegestaan. Dat is
        // vrijwel zeker een datafout — dan liever Humble.
        notes.push(
          'De SteamDB-pakketdata spreekt zichzelf tegen (nergens toegestaan) — Humble-gegevens gebruikt.'
        );
      } else if (disallowed.length === 0 && exclusive === null) {
        if (humbleHas) {
          notes.push(
            `SteamDB meldt geen regiobeperking voor dit pakket; Humble noemde er wel (${humbleDisallowed.length + humbleExclusive.length} landen). SteamDB is leidend — restrictie uit.`
          );
        }
        return { mode: 'none', disallowed: [], exclusive: null, notes };
      } else {
        if (!humbleHas) {
          notes.push('Humble meldde géén regiobeperking; SteamDB wel. SteamDB is leidend.');
        } else if (
          JSON.stringify(disallowed.slice().sort()) !==
            JSON.stringify(humbleDisallowed.slice().sort()) ||
          JSON.stringify((exclusive || []).slice().sort()) !==
            JSON.stringify(humbleExclusive.slice().sort())
        ) {
          notes.push('SteamDB en Humble verschillen van mening over de regio; SteamDB is leidend.');
        }
        return { mode: 'steamdb', disallowed, exclusive, notes };
      }
    } else if (settings.steamdbRegion !== false && sdb && sdb.status && sdb.status !== 'ok') {
      const why = {
        pending: 'controle nog niet afgerond',
        stale: 'SteamDB meldt dat de pakketdata verouderd is',
        nosub: 'pakket niet gevonden op SteamDB',
        ambiguous: 'meerdere pakketten mogelijk — geen eensluidend antwoord',
        challenge: 'SteamDB vroeg om een Cloudflare-controle',
        error: 'controle mislukt',
        unparsed: 'pagina niet herkend',
        nodata: 'geen Steam-appid bekend',
      }[sdb.status] || sdb.status;
      notes.push(
        `SteamDB-regiocontrole niet bruikbaar (${why}) — ${humbleHas ? 'Humble-gegevens gebruikt' : 'geen regiodata'}.`
      );
    }

    if (humbleHas) {
      return {
        mode: 'humble',
        disallowed: humbleDisallowed,
        exclusive: humbleExclusive.length > 0 ? humbleExclusive : null,
        notes,
      };
    }
    return fixed();
  };

  /** Korte omschrijving van een SteamDB-uitkomst, voor labels in het paneel. */
  HSG.describeSteamdbStatus = function (sdb) {
    if (!sdb || !sdb.status) return null;
    switch (sdb.status) {
      case 'ok': {
        const exclusive = sdb.exclusive == null ? null : sdb.exclusive;
        if (exclusive && exclusive.length === 0) {
          // Zelfde oordeel als regionPlan: tegenstrijdige data telt niet.
          return 'SteamDB-data tegenstrijdig — Humble-gegevens gebruikt';
        }
        if (exclusive && exclusive.length > 0) {
          return `regio via SteamDB: alleen ${exclusive.length} land${exclusive.length === 1 ? '' : 'en'}`;
        }
        const blocked = (sdb.disallowed || []).length;
        return blocked > 0
          ? `regio via SteamDB: ${blocked} land${blocked === 1 ? '' : 'en'} geblokkeerd`
          : 'regio via SteamDB: geen beperking';
      }
      case 'pending':
        return 'SteamDB-controle bezig…';
      case 'stale':
        return 'SteamDB-data verouderd — Humble-gegevens gebruikt';
      case 'nosub':
        return 'niet op SteamDB gevonden — Humble-gegevens gebruikt';
      case 'ambiguous':
        return 'SteamDB: meerdere pakketten mogelijk — Humble-gegevens gebruikt';
      case 'unparsed':
        return 'SteamDB-pagina niet herkend — Humble-gegevens gebruikt';
      case 'challenge':
        return 'SteamDB vraagt om een controle — zie de wachtrij';
      case 'nodata':
        return null;
      default:
        return `SteamDB-controle mislukt — Humble-gegevens gebruikt`;
    }
  };

  /**
   * Bouwt een unieke, stabiele id voor een wachtrij-item. Stabiel is belangrijk:
   * hij is tevens de sleutel waaronder de key in storage.session staat.
   */
  HSG.itemId = function (gamekey, machineName) {
    return `${gamekey}:${machineName}`;
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = HSG;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
