/** Split a 13-digit Thai juristic ID for DBD /v1/fin and /v1/company-profiles paths. */
export function splitJuristicId(id: string): [string, string] {
  const clean = id.replace(/\D/g, '');
  if (clean.length < 4) throw new Error(`invalid juristic id: ${id}`);
  return [clean[3]!, clean];
}

/** Convert CE year to Buddhist era (พ.ศ.); pass-through if already >= 2400. */
export function toBuddhistYear(year: number): number {
  return year < 2400 ? year + 543 : year;
}
