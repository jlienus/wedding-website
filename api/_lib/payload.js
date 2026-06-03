'use strict';

// Shared RSVP payload validator + normalizer.
// Used by:
//   - api/rsvp_submit       (public submit; strict — every attending must be true|false)
//   - api/admin_create_invite (starts with empty payload, but if an admin posts one we validate it)
//   - api/admin_update_invite (admin can hand-edit a payload; same rules)
//
// Payload shape (schemaVersion: 1):
//   {
//     "schemaVersion": 1,
//     "primary": {
//       "attending": true | false | null,
//       "entradaChoice": "" | "salpicon" | "hojaldre" | "causa",
//       "sorbetChoice":  "" | "maracuya" | "mandarina",
//       "mealChoice":    "" | "chicken" | "beef",
//       "postreChoice":  "" | "chocolate" | "cheesecake" | "tiramisu",
//       "dietary": "",
//       "songRequest": "",
//       "notes": ""
//     },
//     "additionalGuests": [
//       { "id": "g_<rand>", "name": "Diana Guajan", "isKid": false,
//         "attending": true | false | null,
//         "entradaChoice": "...", "sorbetChoice": "...",
//         "mealChoice": "...",    "postreChoice": "...",
//         "dietary": "...", "songRequest": "" }
//     ]
//   }
//
// Backward compat: responses saved before the 4-course migration only carry
// mealChoice — the three new fields default to "" and are happily accepted.

const SCHEMA_VERSION = 1;
const MAX_ADDITIONAL_GUESTS = 20;
const MAX_PAYLOAD_JSON_BYTES = 32 * 1024;
const MAX_NAME_CHARS = 100;
const MAX_TEXT_CHARS = 500;
const MAX_NOTES_CHARS = 800;

const VALID_ENTRADA_CHOICES = new Set(['', 'salpicon', 'hojaldre', 'causa']);
const VALID_SORBET_CHOICES = new Set(['', 'maracuya', 'mandarina']);
const VALID_MEAL_CHOICES = new Set(['', 'chicken', 'beef']);
const VALID_POSTRE_CHOICES = new Set(['', 'chocolate', 'cheesecake', 'tiramisu']);

const LEGACY_CHOICE_MAX_CHARS = 160;

function normalizeChoiceToken(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function buildChoiceMap(groups) {
  const map = new Map();
  for (const [canonical, labels] of Object.entries(groups)) {
    map.set(normalizeChoiceToken(canonical), canonical);
    for (const label of labels) {
      map.set(normalizeChoiceToken(label), canonical);
    }
  }
  return map;
}

const LEGACY_ATTENDING_CHOICES = new Map([
  ['yes', true],
  ['y', true],
  ['true', true],
  ['si', true],
  ['no', false],
  ['n', false],
  ['false', false]
]);

const LEGACY_ENTRADA_CHOICES = buildChoiceMap({
  '': ['choose one', 'elige una opcion'],
  salpicon: ['seafood salpicon delights of the sea', 'salpicon de mariscos delicias del mar', 'salpicon'],
  hojaldre: ['beef puff pastry in basil sauce', 'hojaldre de res en salsa de albahaca', 'hojaldre'],
  causa: ['causa limena peruvian potato terrine', 'causa limena terrina peruana de papa', 'causa']
});
const LEGACY_SORBET_CHOICES = buildChoiceMap({
  '': ['choose one', 'elige una opcion'],
  maracuya: ['passion fruit with ecuadorian spirit', 'maracuya y espiritu del ecuador', 'maracuya'],
  mandarina: ['mandarin and fresh mint', 'mandarina y menta fresca', 'mandarina']
});
const LEGACY_MEAL_CHOICES = buildChoiceMap({
  '': ['choose one', 'elige una opcion'],
  chicken: ['chicken cordon bleu in fine herbs sauce', 'cordon bleu de pollo en salsa a las finas hierbas', 'pollo'],
  beef: ['beef tenderloin in red wine sauce', 'lomo fino en salsa de vino tinto', 'res']
});
const LEGACY_POSTRE_CHOICES = buildChoiceMap({
  '': ['choose one', 'elige una opcion'],
  chocolate: ['chocolate dome', 'domo de chocolate'],
  cheesecake: ['red berry cheesecake', 'cheesecake de frutos rojos'],
  tiramisu: ['classic tiramisu', 'tiramisu clasico']
});

function clip(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function normalizeAttending(raw) {
  if (raw === null || raw === true || raw === false) return { ok: true, value: raw };
  if (raw === undefined) return { ok: true, value: null };
  if (typeof raw === 'string') {
    const token = normalizeChoiceToken(raw);
    if (!token) return { ok: true, value: null };
    if (LEGACY_ATTENDING_CHOICES.has(token)) {
      return { ok: true, value: LEGACY_ATTENDING_CHOICES.get(token) };
    }
  }
  return { ok: false, error: 'attending_invalid' };
}

function normalizeChoice(raw, legacyMap) {
  const value = clip(raw, LEGACY_CHOICE_MAX_CHARS);
  if (!value) return '';
  const canonical = legacyMap.get(normalizeChoiceToken(value));
  if (canonical !== undefined) return canonical;
  return value.toLowerCase();
}

function emptyPayload() {
  return {
    schemaVersion: SCHEMA_VERSION,
    primary: emptyPrimary(),
    additionalGuests: []
  };
}

function emptyPrimary() {
  return {
    attending: null,
    entradaChoice: '',
    sorbetChoice: '',
    mealChoice: '',
    postreChoice: '',
    dietary: '',
    songRequest: '',
    notes: ''
  };
}

function newGuestId() {
  // Short opaque id used to identify a card client-side. Not security-sensitive.
  return 'g_' + Math.random().toString(36).slice(2, 10);
}

// Returns { ok: true, payload: normalized } or { ok: false, error: 'code', detail?: '...' }.
//
// Options:
//   requireAttending: true     -> every attending (primary + each guest) must be true|false.
//                                Used for public submit. Admin edits may keep null.
//   requireGuestName: true     -> each additionalGuests[].name must be non-empty.
//                                Always enforced (an unnamed guest is useless).
function validatePayload(input, opts = {}) {
  const requireAttending = !!opts.requireAttending;

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'payload_not_object' };
  }

  const out = emptyPayload();

  // primary
  const rawPrimary = input.primary;
  if (rawPrimary !== undefined) {
    if (!rawPrimary || typeof rawPrimary !== 'object' || Array.isArray(rawPrimary)) {
      return { ok: false, error: 'primary_not_object' };
    }
    const p = normalizeAttendee(rawPrimary, { isPrimary: true });
    if (!p.ok) return p;
    out.primary = p.value;
  }

  if (requireAttending && out.primary.attending === null) {
    return { ok: false, error: 'primary_attending_required' };
  }

  // additionalGuests
  const rawList = input.additionalGuests;
  if (rawList !== undefined) {
    if (!Array.isArray(rawList)) {
      return { ok: false, error: 'additional_guests_not_array' };
    }
    if (rawList.length > MAX_ADDITIONAL_GUESTS) {
      return { ok: false, error: 'too_many_guests', detail: `max=${MAX_ADDITIONAL_GUESTS}` };
    }
    const seenIds = new Set();
    for (let i = 0; i < rawList.length; i += 1) {
      const raw = rawList[i];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: 'guest_not_object', detail: `index=${i}` };
      }
      const g = normalizeAttendee(raw, { isPrimary: false, index: i });
      if (!g.ok) return g;
      const guest = g.value;
      if (!guest.name) {
        return { ok: false, error: 'guest_name_required', detail: `index=${i}` };
      }
      if (requireAttending && guest.attending === null) {
        return { ok: false, error: 'guest_attending_required', detail: `index=${i}` };
      }
      // Ensure ids are unique within this payload. If duplicate or missing, regenerate.
      let id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 40) : '';
      if (!/^g_[A-Za-z0-9_-]{1,40}$/.test(id) || seenIds.has(id)) {
        id = newGuestId();
        while (seenIds.has(id)) id = newGuestId();
      }
      seenIds.add(id);
      guest.id = id;
      out.additionalGuests.push(guest);
    }
  }

  // Hard cap on serialized size — defense against pathological inputs that
  // pass shape validation but bloat the row.
  const json = JSON.stringify(out);
  if (Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_JSON_BYTES) {
    return { ok: false, error: 'payload_too_large', detail: `max=${MAX_PAYLOAD_JSON_BYTES}b` };
  }

  return { ok: true, payload: out, json };
}

function normalizeAttendee(raw, opts) {
  const isPrimary = !!opts.isPrimary;

  // attending: canonical tri-state — true | false | null. Accept old
  // display-string submissions defensively, but only persist booleans/null.
  const attendingResult = normalizeAttending(raw.attending);
  if (!attendingResult.ok) return attendingResult;
  const attending = attendingResult.value;

  // Per-course choices — each must be in its own canonical English-key enum.
  // If an old/stale client sends a translated display label, map it back to
  // the English key before validating and storing.
  const entrada = normalizeChoice(raw.entradaChoice, LEGACY_ENTRADA_CHOICES);
  if (!VALID_ENTRADA_CHOICES.has(entrada)) {
    return { ok: false, error: 'bad_entrada_choice', detail: entrada };
  }
  const sorbet = normalizeChoice(raw.sorbetChoice, LEGACY_SORBET_CHOICES);
  if (!VALID_SORBET_CHOICES.has(sorbet)) {
    return { ok: false, error: 'bad_sorbet_choice', detail: sorbet };
  }
  const meal = normalizeChoice(raw.mealChoice, LEGACY_MEAL_CHOICES);
  if (!VALID_MEAL_CHOICES.has(meal)) {
    return { ok: false, error: 'bad_meal_choice', detail: meal };
  }
  const postre = normalizeChoice(raw.postreChoice, LEGACY_POSTRE_CHOICES);
  if (!VALID_POSTRE_CHOICES.has(postre)) {
    return { ok: false, error: 'bad_postre_choice', detail: postre };
  }

  const out = {
    attending,
    entradaChoice: entrada,
    sorbetChoice: sorbet,
    mealChoice: meal,
    postreChoice: postre,
    dietary: clip(raw.dietary, MAX_TEXT_CHARS),
    songRequest: clip(raw.songRequest, MAX_TEXT_CHARS)
  };

  if (isPrimary) {
    out.notes = clip(raw.notes, MAX_NOTES_CHARS);
  } else {
    out.name = clip(raw.name, MAX_NAME_CHARS);
    out.isKid = !!raw.isKid;
  }

  // Defensive: if not attending (false or null), discard all course picks +
  // dietary + song so we don't accidentally pay for a meal for a guest who
  // isn't coming. Notes are kept either way (e.g. "regrets, sends well-wishes").
  if (attending !== true) {
    out.entradaChoice = '';
    out.sorbetChoice = '';
    out.mealChoice = '';
    out.postreChoice = '';
    out.dietary = '';
    out.songRequest = '';
  }

  return { ok: true, value: out };
}

// True if the payload represents a complete RSVP — i.e. primary AND every
// additional guest have answered yes/no. Used to flag invite.responded.
function isComplete(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (!payload.primary || (payload.primary.attending !== true && payload.primary.attending !== false)) {
    return false;
  }
  const list = Array.isArray(payload.additionalGuests) ? payload.additionalGuests : [];
  return list.every((g) => g && (g.attending === true || g.attending === false));
}

// Headcount summary for admin/cron rendering. Cheap; no validation.
function summarize(payload) {
  const out = { yes: 0, no: 0, pending: 0, adults: 0, kids: 0 };
  if (!payload || typeof payload !== 'object') return out;
  const all = [];
  if (payload.primary) all.push({ ...payload.primary, isKid: false });
  if (Array.isArray(payload.additionalGuests)) {
    for (const g of payload.additionalGuests) all.push(g);
  }
  for (const a of all) {
    if (!a) continue;
    if (a.attending === true) {
      out.yes += 1;
      if (a.isKid) out.kids += 1; else out.adults += 1;
    } else if (a.attending === false) {
      out.no += 1;
    } else {
      out.pending += 1;
    }
  }
  return out;
}

module.exports = {
  SCHEMA_VERSION,
  MAX_ADDITIONAL_GUESTS,
  MAX_PAYLOAD_JSON_BYTES,
  VALID_ENTRADA_CHOICES,
  VALID_SORBET_CHOICES,
  VALID_MEAL_CHOICES,
  VALID_POSTRE_CHOICES,
  emptyPayload,
  emptyPrimary,
  newGuestId,
  validatePayload,
  isComplete,
  summarize
};
