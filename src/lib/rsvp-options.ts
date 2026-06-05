// Single source of truth for the RSVP payload's enumerated choice fields.
// Imported by:
//   - src/components/RsvpForm.astro  (public RSVP form, bilingual EN/ES)
//   - src/pages/admin/index.astro    (admin edit modal, English only)
//
// The canonical value (the `value` field) is what gets persisted in the
// payload + validated by api/_lib/payload.js. The `labelKey` is a dotted
// i18n key — render with t(locale, labelKey) when bilingual, or just look
// up the EN bundle directly when admin-only.
//
// Keep these arrays in sync with api/_lib/payload.js VALID_* sets. If you
// add a new choice, you MUST add it to both files.

export interface RsvpOption {
  value: string;
  labelKey: string;
}

export const mealOptions: RsvpOption[] = [
  { value: '', labelKey: 'rsvp.mealNone' },
  { value: 'chicken', labelKey: 'rsvp.mealChicken' },
  { value: 'beef', labelKey: 'rsvp.mealBeef' }
];

export const entradaOptions: RsvpOption[] = [
  { value: '', labelKey: 'rsvp.entradaNone' },
  { value: 'salpicon', labelKey: 'rsvp.entradaSalpicon' },
  { value: 'hojaldre', labelKey: 'rsvp.entradaHojaldre' },
  { value: 'causa', labelKey: 'rsvp.entradaCausa' }
];

export const sorbetOptions: RsvpOption[] = [
  { value: '', labelKey: 'rsvp.sorbetNone' },
  { value: 'maracuya', labelKey: 'rsvp.sorbetMaracuya' },
  { value: 'mandarina', labelKey: 'rsvp.sorbetMandarina' }
];

export const postreOptions: RsvpOption[] = [
  { value: '', labelKey: 'rsvp.postreNone' },
  { value: 'chocolate', labelKey: 'rsvp.postreChocolate' },
  { value: 'cheesecake', labelKey: 'rsvp.postreCheesecake' },
  { value: 'tiramisu', labelKey: 'rsvp.postreTiramisu' }
];

export const guestTypeOptions: RsvpOption[] = [
  { value: '', labelKey: 'rsvp.guestTypeNone' },
  { value: 'adult', labelKey: 'rsvp.guestTypeAdult' },
  { value: 'child', labelKey: 'rsvp.guestTypeChild' }
];

// Convenience: the four meal-course payload field names in canonical order.
// Used for iteration in form rendering + validation. Kept in sync with the
// payload schema (api/_lib/payload.js).
export const mealCourseFields = ['entradaChoice', 'sorbetChoice', 'mealChoice', 'postreChoice'] as const;
export type MealCourseField = typeof mealCourseFields[number];

// Maps a course field name to its option array. Helpful when iterating.
export const optionsForCourse: Record<MealCourseField, RsvpOption[]> = {
  entradaChoice: entradaOptions,
  sorbetChoice: sorbetOptions,
  mealChoice: mealOptions,
  postreChoice: postreOptions
};
