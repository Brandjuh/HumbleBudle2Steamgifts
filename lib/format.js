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

  /** Start- en eindtijd afleiden uit de instellingen. */
  HSG.computeSchedule = function (settings, now) {
    const base = now instanceof Date ? now.getTime() : Date.now();
    const start = new Date(base + (settings.startOffsetMinutes || 0) * 60000);
    const end = new Date(start.getTime() + (settings.durationDays || 7) * 86400000);
    return {
      start,
      end,
      startText: HSG.formatSteamGiftsDate(start),
      endText: HSG.formatSteamGiftsDate(end),
    };
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
