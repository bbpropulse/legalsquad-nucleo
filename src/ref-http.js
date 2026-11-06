// Chamadas ao servidor de referência (plano do servidor de referência, seções 3.5 e 3.7).
//
// Um lugar só para o que toda chamada leva e para o que fazer quando o servidor falha:
// - a licença vai no `Authorization: Bearer` (nunca na URL: URL entra em log de proxy), e o id
//   pseudônimo da instalação no `X-Legalsquad-Instalacao` (o limite diário do servidor é por ele);
// - servidor fora do ar é falha a tratar, não modo de uso (decisão do dono, 30/10/2026): erro de
//   rede, 5xx e 429 esperam e tentam de novo, respeitando o `Retry-After` até um teto; o que não
//   fechar volta como `indisponivel`, e quem chama nunca trata isso como "conferido";
// - 4xx que não seja 429 é resposta (licença recusada, rota que o servidor não tem): sem nova
//   tentativa, com o status para quem chama decidir.
//
// Só caminhos sob `/v1/` e `/saude` do próprio servidor configurado: um manifesto que apontasse o
// arquivo para outro host não leva a licença para lá.

const ESPERA_PADRAO_MS = [1000, 3000, 9000];
const TETO_DO_RETRY_AFTER_MS = 30000;
const TEMPO_PADRAO_MS = 60000;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** O caminho é do servidor (relativo, sob /v1/ ou /saude)? */
export function caminhoDoServidor(caminho) {
  // `..` só como segmento é subida de pasta; dentro de um segmento é a rota da diferença (`2026.11.1..2026.11.2`).
  return typeof caminho === 'string' && /^\/(?:v1\/|saude$)/.test(caminho) && !/^\/\//.test(caminho) && !caminho.split(/[?#]/)[0].split('/').some((s) => s === '..' || s === '.');
}

function esperaDoRetryAfter(resposta) {
  const bruto = resposta?.headers?.get?.('retry-after');
  const s = Number(bruto);
  return Number.isFinite(s) && s >= 0 ? Math.min(s * 1000, TETO_DO_RETRY_AFTER_MS) : null;
}

/**
 * Chama o servidor. Devolve `{ ok, status, resposta, json, tentativas }` quando houve resposta HTTP
 * (2xx ou 4xx definitivo), ou `{ ok: false, indisponivel: true, motivo, tentativas }` quando o
 * servidor não respondeu depois das tentativas. Com `binario: true`, a `resposta` vem sem ler o
 * corpo (para baixar em fluxo); sem ele, o corpo é lido como JSON quando dá.
 */
export async function chamarServidor(servidorUrl, caminho, {
  method = 'GET', body = null, license = null, instalacao = null, headers = {}, binario = false,
  fetchImpl = globalThis.fetch, esperas = ESPERA_PADRAO_MS, esperar = dormir, tempoMs = TEMPO_PADRAO_MS,
} = {}) {
  if (!caminhoDoServidor(caminho)) return { ok: false, recusado: true, motivo: `caminho fora do servidor de referência: ${String(caminho).slice(0, 80)}` };
  const url = `${String(servidorUrl).replace(/\/+$/, '')}${caminho}`;
  const cabecalhos = {
    accept: binario ? 'application/octet-stream' : 'application/json',
    ...(license ? { authorization: `Bearer ${license}` } : {}),
    ...(instalacao ? { 'x-legalsquad-instalacao': instalacao } : {}),
    ...(body !== null ? { 'content-type': 'application/json' } : {}),
    ...headers,
  };
  let ultimo = null;
  const total = esperas.length + 1;
  for (let tentativa = 1; tentativa <= total; tentativa++) {
    let resposta;
    try {
      resposta = await fetchImpl(url, { method, headers: cabecalhos, body: body === null ? undefined : typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(tempoMs) });
    } catch (erro) {
      ultimo = `sem resposta (${erro?.cause?.code || erro?.name || 'erro de rede'})`;
      if (tentativa < total) await esperar(esperas[tentativa - 1]);
      continue;
    }
    if (resposta.status >= 500 || resposta.status === 429) {
      ultimo = `HTTP ${resposta.status}`;
      const pedida = esperaDoRetryAfter(resposta);
      try { await resposta.arrayBuffer(); } catch { /* corpo descartado */ }
      if (tentativa < total) await esperar(pedida ?? esperas[tentativa - 1]);
      continue;
    }
    if (binario && resposta.ok) return { ok: true, status: resposta.status, resposta, tentativas: tentativa };
    let json;
    try { json = await resposta.json(); } catch { json = null; }
    return { ok: resposta.ok, status: resposta.status, resposta, json, tentativas: tentativa };
  }
  return { ok: false, indisponivel: true, motivo: `servidor de referência indisponível depois de ${total} tentativa(s): ${ultimo}`, tentativas: total };
}
