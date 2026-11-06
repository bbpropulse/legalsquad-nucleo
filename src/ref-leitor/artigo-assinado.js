// Prova assinada de artigo: ANEL DE ARTIGOS e verificação, em um arquivo só.
//
// ESTE ARQUIVO É COPIADO PELO MOTOR (byte a byte, como `src/ref-leitor/`). Depende apenas de
// `node:crypto` e de `./normalizar.js` (`jsonCanonico`, `sha256`), que o motor já tem. Não importa o
// anel de produção, de propósito: quem confere artigo nunca enxerga as chaves que assinam índice,
// diferença e pacote.
//
// POR QUE UM ANEL SEPARADO (segurança): o servidor precisa guardar uma chave privada para assinar as
// respostas de `POST /v1/ref/artigos`. Se essa chave fosse do anel de produção (a que assina índice,
// diferença e pacote), quem invadisse o servidor ou lesse a variável poderia assinar um índice
// adulterado e o motor o aceitaria. A chave dos artigos (`srv-2026-11`) vive só neste anel:
//   - o motor confere MANIFESTO (índice, diferença, pacote) só contra o anel de produção, que NÃO
//     tem `srv-2026-11`: um manifesto assinado por ela é recusado ("kid desconhecido");
//   - o motor confere ARTIGO só contra `ANEL_ARTIGOS`, que NÃO tem as chaves de produção: um artigo
//     assinado por `prod-2026-09` é recusado.
// O que o servidor consegue provar com a chave dos artigos é, no máximo, "este artigo é o que eu
// guardo": o índice assinado pela curadoria (`sha256_texto` do diploma) continua sendo a âncora.
//
// PAYLOAD CANÔNICO DA ASSINATURA (Ed25519, bytes UTF-8, assinatura em base64):
//   jsonCanonico({ formato: 'legalsquad-artigo/1', id, sha256, sha256_texto, versao, signing_kid })
// - `jsonCanonico`: objeto com chaves em ordem alfabética, sem espaços, valores por `JSON.stringify`
//   (a chave com valor `undefined` sai; `versao: null` entra como `null`).
// - `id`: id do dispositivo (`<id do documento>#<caminho>`, ex.: `fed:dl:3689:1941#art-312`).
// - `sha256`: sha256 hexadecimal do `texto` devolvido (o artigo com os filhos, em ordem, separados
//   por `\n`, em UTF-8).
// - `sha256_texto`: sha256 hexadecimal do texto do DIPLOMA, o mesmo que o índice assinado traz em
//   `doc.sha256_texto` para o documento.
// - `versao`: versão vigente do índice da camada do documento (`2026.11.17`) ou null.
// - `signing_kid`: kid de quem assinou; tem de estar em `ANEL_ARTIGOS`.
// Ordem de conferência no motor (`verificarArtigoAssinado` faz as quatro):
//   (1) forma e kid conhecido; (2) sha256(texto) igual a `sha256`; (3) assinatura pelo anel de
//   artigos; (4) `sha256_texto` igual ao do índice local do documento (se não, índice ou servidor
//   defasado: sincronizar; nunca aceitar). Só então o artigo vale como texto conferido.
import { createPublicKey, verify } from 'node:crypto';
import { jsonCanonico, sha256 } from './normalizar.js';

export const FORMATO_ARTIGO = 'legalsquad-artigo/1';

/** Chaves públicas que podem assinar artigo. Só estas. Chave pública não é segredo. */
export const ANEL_ARTIGOS = Object.freeze({
  'srv-2026-11': `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAt+pHPI2UTOwz3ZXkMmzPbn83USejXSU6XPc9zKiZB2I=
-----END PUBLIC KEY-----
`,
});

const RE_HEX64 = /^[0-9a-f]{64}$/;

/** O objeto que a assinatura cobre: refeito a partir dos campos da resposta, nunca recebido pronto. */
export function cargaAssinada(r) {
  return { formato: FORMATO_ARTIGO, id: r.id, sha256: r.sha256, sha256_texto: r.sha256_texto, versao: r.versao ?? null, signing_kid: r.signing_kid };
}

/**
 * Confere um artigo recebido de `POST /v1/ref/artigos`.
 *
 *   artigo  um item de `resultados` com `status: 'encontrado'`
 *   opcoes.anel          anel de chaves de artigo (padrão `ANEL_ARTIGOS`; só teste passa outro)
 *   opcoes.sha256Diploma sha256 do diploma no índice LOCAL do motor (`doc.sha256_texto`); se vier e
 *                        não bater, o artigo é recusado (índice ou servidor defasado)
 *   opcoes.docId         id do documento que o motor pediu; se vier, o `id` do artigo tem de ser
 *                        desse documento (o servidor não pode devolver outro diploma no lugar)
 *
 * Devolve `{ ok: true, kid }` ou `{ ok: false, etapa, motivo }`, com `etapa` em `forma`, `kid`,
 * `texto`, `assinatura`, `documento` ou `indice`.
 */
export function verificarArtigoAssinado(artigo, { anel = ANEL_ARTIGOS, sha256Diploma = null, docId = null } = {}) {
  const a = artigo;
  if (!a || typeof a !== 'object' || a.status !== 'encontrado') return { ok: false, etapa: 'forma', motivo: 'artigo não encontrado' };
  if (typeof a.id !== 'string' || typeof a.texto !== 'string' || typeof a.assinatura !== 'string' || !RE_HEX64.test(String(a.sha256)) || !RE_HEX64.test(String(a.sha256_texto))) {
    return { ok: false, etapa: 'forma', motivo: 'resposta sem id, texto, sha256, sha256_texto ou assinatura válidos' };
  }
  if (typeof a.signing_kid !== 'string' || !Object.hasOwn(anel, a.signing_kid)) {
    return { ok: false, etapa: 'kid', motivo: `kid desconhecido pelo anel de artigos: ${String(a.signing_kid || '(ausente)').slice(0, 40)}; atualize o motor` };
  }
  if (sha256(a.texto) !== a.sha256) return { ok: false, etapa: 'texto', motivo: 'o texto recebido não confere com o sha256 declarado' };
  let ok = false;
  try {
    ok = verify(null, Buffer.from(jsonCanonico(cargaAssinada(a)), 'utf8'), createPublicKey(anel[a.signing_kid]), Buffer.from(a.assinatura, 'base64'));
  } catch {
    ok = false;
  }
  if (!ok) return { ok: false, etapa: 'assinatura', motivo: 'assinatura não confere' };
  if (docId && !a.id.startsWith(`${docId}#`)) return { ok: false, etapa: 'documento', motivo: 'o artigo devolvido é de outro documento' };
  if (sha256Diploma && a.sha256_texto !== sha256Diploma) {
    return { ok: false, etapa: 'indice', motivo: 'o sha256 do diploma não é o do índice local: índice ou servidor defasado; sincronize' };
  }
  return { ok: true, kid: a.signing_kid };
}
