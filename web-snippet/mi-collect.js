/* Marketing Intelligence — event-collector
 * ---------------------------------------------------------------------------
 * Dit bestand VERVANGT NIETS. Het bestaande conversions.js / tracking.js blijft
 * ongewijzigd draaien en blijft naar GA4 en Google Ads sturen. Hier komt er één
 * bestemming bij: onze eigen database, zodat we per lead een tijdlijn hebben.
 * Uit GA4 is die tijdlijn principieel niet terug te halen.
 *
 * INBOUWEN — twee regels per site.
 *
 *   1. Laad dit bestand VOOR het bestaande tracking-bestand:
 *        <script src="/js/mi-collect.js" defer></script>
 *        <script src="/js/conversions.js" defer></script>
 *
 *   2. Hang het aan het bestaande choke point. Beide sites sturen elk event
 *      door precies één functie, dus dit is genoeg:
 *
 *      Boers & Breuer (conversions.js), onderaan:
 *          var _send = send;
 *          send = function (n, e) { _send(n, e); MI.event(n, e); };
 *          var _lead = lead;
 *          lead = function (ev, l, g, c, e) { _lead(ev, l, g, c, e); MI.event(ev, e); };
 *
 *      Rotterdamse Bouwbedrijf (tracking.js), na window.rbbTrack = track:
 *          window.rbbTrack = function (n, p) { track(n, p); MI.event(n, p); };
 *
 *   3. Bij het versturen van een formulier, vlak voor de bestaande fetch:
 *          MI.lead({ name: ..., email: ..., phone: ..., subject: ...,
 *                    browser_lead_id: pending });
 *
 * MI.lead gebruikt sendBeacon en blokkeert dus niets. De verzending naar
 * Formspree loopt onveranderd en gaat voor. Gaat onze kant stuk, dan komt de
 * lead nog steeds gewoon binnen -- dat is het belangrijkste uitgangspunt.
 */
(function (window, document) {
  'use strict';

  /* ===== INVULLEN PER SITE ===== */
  var KEY = 'VUL-COLLECTOR-KEY-IN';   // uit mi.website.collector_key
  /* ============================= */

  var ENDPOINT = '/api/collect';   // api/collect.mjs op Vercel
  var VID_KEY = 'mi_vid';
  var SID_KEY = 'mi_sid';
  var SID_TS = 'mi_sid_ts';
  var CLICK_KEY = 'mi_click';
  var SESSIE_MINUTEN = 30;
  var CLICK_TTL = 90 * 24 * 60 * 60 * 1000;   // zelfde 90 dagen als Google

  /* ---------- opslag die nooit mag klappen ---------- */
  function ls(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v);
      return v;
    } catch (e) { return null; }
  }
  function ss(k, v) {
    try {
      if (v === undefined) return sessionStorage.getItem(k);
      sessionStorage.setItem(k, v);
      return v;
    } catch (e) { return null; }
  }

  function uuid() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
      var b = new Uint8Array(16);
      crypto.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      var h = [].map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' +
             h.slice(16, 20) + '-' + h.slice(20);
    } catch (e) {
      // Zonder crypto is dit geen sterke id, maar wel goed genoeg om een sessie
      // aan elkaar te knopen. Hij wordt nergens voor beveiliging gebruikt.
      return 'x' + Date.now().toString(16) + Math.random().toString(16).slice(2, 14);
    }
  }

  function param(naam) {
    var m = new RegExp('[?&]' + naam + '=([^&#]*)').exec(location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }

  function cookie(naam) {
    try {
      var m = document.cookie.match(new RegExp('(?:^|; *)' + naam + '=([^;]+)'));
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }

  /* ---------- bezoeker: 180 dagen, ons eigen pseudonieme nummer ---------- */
  function visitorId() {
    var v = ls(VID_KEY);
    if (v) return v;
    // Cookie als vangnet: localStorage overleeft niet elke privacy-instelling.
    v = cookie(VID_KEY) || uuid();
    ls(VID_KEY, v);
    try {
      document.cookie = 'mi_vid=' + encodeURIComponent(v) +
        ';path=/;max-age=' + (180 * 24 * 3600) + ';SameSite=Lax' +
        (location.protocol === 'https:' ? ';Secure' : '');
    } catch (e) {}
    return v;
  }

  /* ---------- sessie: 30 minuten inactief, of een nieuwe advertentieklik ---- */
  function sessionId(nieuweKlik) {
    var nu = Date.now();
    var id = ss(SID_KEY);
    var ts = parseInt(ss(SID_TS) || '0', 10);
    if (!id || nieuweKlik || (nu - ts) > SESSIE_MINUTEN * 60000) {
      id = uuid();
      ss(SID_KEY, id);
    }
    ss(SID_TS, String(nu));
    return id;
  }

  /* ---------- advertentieklik vasthouden ----------
   * Zelfde model als het bestaande bb_click in conversions.js: bewaar de
   * click-ID en de campagne 90 dagen, want een lead die drie dagen later
   * terugkomt hoort nog steeds bij die advertentie.
   */
  var nieuweKlik = false;
  var klik = (function () {
    var soorten = ['gclid', 'wbraid', 'gbraid', 'msclkid', 'fbclid'];
    for (var i = 0; i < soorten.length; i++) {
      var v = param(soorten[i]);
      if (v) {
        nieuweKlik = true;
        var vers = {
          id: v, type: soorten[i], t: Date.now(),
          src: param('utm_source'), med: param('utm_medium'),
          cmp: param('utm_campaign'), term: param('utm_term'),
          cnt: param('utm_content'),
          // mi_cid/mi_agid zetten we zelf via de URL-suffix; gad_campaignid
          // plakt Google er uit zichzelf aan. Allebei meenemen: een ID blijft
          // kloppen als je een campagne hernoemt, een slug niet.
          cid: param('mi_cid') || param('gad_campaignid'),
          agid: param('mi_agid')
        };
        ls(CLICK_KEY, JSON.stringify(vers));
        return vers;
      }
    }
    // Geen click-ID maar wel utm's? Dan is het een gewone campagne.
    if (param('utm_source')) {
      nieuweKlik = true;
      return {
        id: '', type: '', t: Date.now(),
        src: param('utm_source'), med: param('utm_medium'),
        cmp: param('utm_campaign'), term: param('utm_term'),
        cnt: param('utm_content'),
        cid: param('mi_cid') || param('gad_campaignid'),
        agid: param('mi_agid')
      };
    }
    // Geen nieuwe klik: de bewaarde. Eerst localStorage, dan het cookie dat
    // ons endpoint server-side zet. Safari wist door scripts gezette opslag na
    // zeven dagen zonder bezoek; een cookie uit een HTTP-antwoord laat het
    // staan. Zo blijven de 90 dagen ook op een iPhone 90 dagen.
    try {
      var oud = JSON.parse(ls(CLICK_KEY) || cookie(CLICK_KEY) || 'null');
      if (!oud || !oud.t || (Date.now() - oud.t) > CLICK_TTL) return null;
      ls(CLICK_KEY, JSON.stringify(oud));   // terug in localStorage
      return oud;
    } catch (e) { return null; }
  })();

  /* ---------- GA4-brug ----------
   * Het _ga-cookie ziet eruit als GA1.1.<random>.<timestamp>. Dat laatste stuk
   * is de client_id van GA4. Daarmee kunnen we onze cijfers naast die van GA4
   * leggen en verschillen verklaren. Er gaat GEEN persoonsgegeven naar GA4;
   * dit is alleen de andere kant op.
   */
  function gaClientId() {
    var m = document.cookie.match(/_ga=GA\d\.\d\.(\d+\.\d+)/);
    return m ? m[1] : '';
  }

  function device() {
    var ua = navigator.userAgent || '';
    if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(ua)) return 'tablet';
    if (/Mobile|iPhone|iPod|Android|Windows Phone/i.test(ua)) return 'mobile';
    return 'desktop';
  }

  /* Elke site bewaart de cookiekeuze anders. Boers & Breuer: de tekst
   * 'accepted' onder 'cookie-consent'. Rotterdamse Bouwbedrijf: JSON
   * {analytics, ads} onder 'rbb_consent'. We kijken naar beide, zodat het
   * snippet op elke site hetzelfde blijft. Wat telt is de advertentiekeuze:
   * die bepaalt of een lead met gegevens naar Google Ads mag. */
  function consent() {
    try {
      var c = localStorage.getItem('cookie-consent');
      if (c) return c === 'accepted' ? 'accepted' : 'denied';
      var r = localStorage.getItem('rbb_consent');
      if (r) {
        var j = JSON.parse(r);
        return (j && (j.ads || j.analytics)) ? 'accepted' : 'denied';
      }
      return 'unknown';
    } catch (e) { return 'unknown'; }
  }

  var VID = visitorId();
  var SID = sessionId(nieuweKlik);

  /* ---------- ontdubbelen ----------
   * Twee keer hetzelfde event vanaf dezelfde plek binnen twee seconden telt
   * één keer. Dat vangt een snelle verversing, een dubbel afgevuurde
   * touch/click op mobiel, en een preview-bot die de pagina twee keer laadt.
   * Zonder deze rem lopen de paginacijfers stil op, en dan gaan mensen de
   * cijfers wantrouwen -- terecht.
   *
   * De sleutel bevat het pad en de belangrijkste metadata, zodat twee
   * verschillende knoppen op dezelfde pagina wél allebei tellen.
   */
  var laatst = {};
  function tweeKeer(type, meta) {
    var sleutel = type + '|' + location.pathname + '|' +
      ((meta && (meta.cta_location || meta.form_id || meta.service)) || '');
    var nu = Date.now();
    if (laatst[sleutel] && nu - laatst[sleutel] < 2000) return true;
    laatst[sleutel] = nu;
    return false;
  }

  /* ---------- versturen ---------- */
  function stuur(payload) {
    if (KEY.indexOf('VUL-') === 0) return;   // nog niet ingesteld: niets doen
    var body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon) {
        // type text/plain: voorkomt een CORS-preflight, die bij het verlaten
        // van de pagina vaak niet meer afgemaakt wordt.
        var blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
        if (navigator.sendBeacon(ENDPOINT, blob)) return;
      }
      fetch(ENDPOINT, {
        method: 'POST', body: body, keepalive: true,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
      })['catch'](function () {});
    } catch (e) { /* meten mag de site nooit stukmaken */ }
  }

  function basis(type, meta) {
    var p = {
      k: KEY, vid: VID, sid: SID, uid: uuid(),
      t: type, ts: Date.now(),
      // Volledige URL inclusief parameters: de landingspagina met zijn
      // utm-waarden is informatie. Het kale pad wordt er in de database uit
      // gehaald, zodat de tijdlijn leesbaar blijft.
      url: location.href.split('#')[0],
      ttl: (document.title || '').slice(0, 200),
      ref: document.referrer || '',
      dev: device(), cs: consent(),
      utm: klik ? {
        source: klik.src || '', medium: klik.med || '',
        campaign: klik.cmp || '', term: klik.term || '', content: klik.cnt || ''
      } : {},
      cid: klik && klik.id ? { id: klik.id, type: klik.type } : {},
      gac: gaClientId(),
      meta: {}
    };
    if (klik && klik.cid) p.meta.mi_cid = klik.cid;
    if (klik && klik.agid) p.meta.mi_agid = klik.agid;
    // De bewaarde klik in zijn geheel, zodat het endpoint hem als HTTP-cookie
    // kan terugzetten (zie de opmerking bij CLICK_KEY).
    if (klik && klik.id) p.klk = klik;
    if (meta) {
      for (var k in meta) {
        if (Object.prototype.hasOwnProperty.call(meta, k) &&
            meta[k] !== '' && meta[k] != null &&
            // GA4-interne velden horen niet in onze metadata
            k !== 'event_callback' && k !== 'event_timeout' && k !== 'send_to') {
          p.meta[k] = meta[k];
        }
      }
    }
    return p;
  }

  /* Vertaaltabel: de twee sites gebruiken verschillende namen voor hetzelfde.
   * We trekken dat hier gelijk in plaats van in de sites, zodat de historie in
   * GA4 intact blijft. */
  var HERNOEM = {
    contact_phone: 'phone_click',
    contact_whatsapp: 'whatsapp_click',
    contact_email: 'email_click',
    phone_click_desktop: 'phone_click',
    generate_lead: 'form_submit',
    quote_request: 'quote_request',
    conversion: null            // Google Ads-conversie: niet ons event
  };

  var MI = {
    /** Eén event. Wordt aangeroepen vanuit het bestaande tracking-bestand. */
    event: function (naam, meta) {
      if (Object.prototype.hasOwnProperty.call(HERNOEM, naam)) {
        naam = HERNOEM[naam];
        if (!naam) return;
      }
      if (tweeKeer(naam, meta)) return;
      stuur(basis(naam, meta));
    },

    /** Een formulierinzending, met persoonsgegevens.
     *  Alleen naar ons eigen endpoint, nooit naar GA4. */
    lead: function (gegevens, meta) {
      var p = basis('form_submit', meta);
      p.lead = {
        name: (gegevens.name || '').slice(0, 200),
        email: (gegevens.email || '').slice(0, 200),
        phone: (gegevens.phone || '').slice(0, 60),
        subject: (gegevens.subject || '').slice(0, 200),
        lead_type: gegevens.lead_type || 'form',
        browser_lead_id: gegevens.browser_lead_id || ''
      };
      stuur(p);
    },

    /** Voor debuggen: wat weten we op dit moment? */
    debug: function () {
      return { vid: VID, sid: SID, klik: klik, ga: gaClientId(), consent: consent() };
    }
  };

  window.MI = MI;

  /* Sessiestart en paginaweergave meteen, zodat de tijdlijn compleet is en niet
   * pas begint bij de eerste klik.
   *
   * Behalve tijdens prerendering: Chrome laadt een pagina soms alvast terwijl
   * de bezoeker nog in de adresbalk typt. Die telt pas als hij hem echt te
   * zien krijgt. */
  function openen() {
    if (!ss('mi_sessie_gemeld')) {
      ss('mi_sessie_gemeld', '1');
      MI.event('session_start');
    }
    MI.event('page_view', { page_type: (window.rbbCtx && window.rbbCtx.page_type) || '' });
  }
  if (document.prerendering) {
    document.addEventListener('prerenderingchange', openen, { once: true });
  } else {
    openen();
  }

  /* Scrolldiepte: goedkoop signaal voor betrokkenheid, en het maakt het verschil
   * zichtbaar tussen "even gekeken" en "helemaal gelezen". */
  (function () {
    var gemeld = {};
    function kijk() {
      var h = document.documentElement;
      var hoogte = Math.max(h.scrollHeight - h.clientHeight, 1);
      var pct = Math.round((h.scrollTop || window.pageYOffset || 0) / hoogte * 100);
      [50, 90].forEach(function (grens) {
        if (pct >= grens && !gemeld[grens]) {
          gemeld[grens] = true;
          MI.event('scroll_depth', { diepte: grens });
        }
      });
      if (gemeld[90]) window.removeEventListener('scroll', gepland);
    }
    var wacht = null;
    function gepland() {
      if (wacht) return;
      wacht = setTimeout(function () { wacht = null; kijk(); }, 400);
    }
    window.addEventListener('scroll', gepland, { passive: true });
  })();

})(window, document);
