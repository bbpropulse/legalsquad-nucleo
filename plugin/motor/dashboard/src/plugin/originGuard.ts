// O handshake de WebSocket NÃO é submetido à same-origin policy: o navegador
// abre a conexão para qualquer origem e só manda o cabeçalho `Origin` dizendo
// quem pediu. Sem conferir esse cabeçalho, qualquer aba aberta em qualquer site
// conseguiria ler o snapshot do escritório (nomes de squad, agentes, estado dos
// casos) enquanto o dashboard está rodando. Por isso a checagem é fail-closed:
// só passa quem prova ser a própria origem do dev server.
export function isAllowedOrigin(
  origin: string | undefined | null,
  host: string | undefined | null
): boolean {
  if (!origin || !host) return false;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    // Inclui o literal "null" que navegadores mandam de contextos opacos
    // (sandbox, data:, file:) — origem não verificável, então não passa.
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  // `host` já inclui a porta; comparar host+porta é o que separa
  // localhost:5173 (o dashboard) de localhost:4321 (outro app da mesma máquina).
  return parsed.host.toLowerCase() === host.toLowerCase();
}
