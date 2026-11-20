/** Depois deste silêncio, uma execução "running" passa a ser suspeita de morta. */
export const STALE_AFTER_MS = 2 * 60 * 1000;

/**
 * Idade do estado em ms quando ele passou do limite de frescor; `null` enquanto
 * está fresco — ou quando não dá para saber.
 *
 * O runner grava `updatedAt` a cada passo. Se a sessão cai no meio, o arquivo
 * congela: o dashboard continuaria mostrando "running" com o cronômetro subindo
 * para sempre. Comparar `updatedAt` com o relógio local é o que permite avisar
 * "sem atualização há N min" em vez de fingir que a execução está viva.
 *
 * Devolve `null` para `updatedAt` ausente/ilegível — "não sei ler" não é
 * "está morto" — e também para carimbo no futuro (relógio adiantado no escritor).
 */
export function staleFor(
  updatedAt: string | undefined | null,
  nowMs: number,
  thresholdMs: number = STALE_AFTER_MS
): number | null {
  if (!updatedAt) return null;
  const at = Date.parse(updatedAt);
  if (Number.isNaN(at)) return null;
  const age = nowMs - at;
  if (age <= thresholdMs) return null;
  return age;
}

/** Rótulo curto e humano para a idade devolvida por `staleFor`. */
export function formatStaleAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}
