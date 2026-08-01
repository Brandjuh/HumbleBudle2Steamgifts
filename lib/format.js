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
