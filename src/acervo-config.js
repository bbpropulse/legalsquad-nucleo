// Configuração do acervo: o que o cliente precisa saber para sincronizar.
//
// Fecha a pendência da SPEC §7.2 — "verificação nunca depende de rede, chave
// já embarcada". O aluno recebe UMA coisa: a licença. A URL do catálogo e a
// chave pública de verificação vêm embarcadas aqui.
//
// **A chave pública não é segredo.** Ela já é servida em `/v1/signing-keys`;
// embarcá-la num repositório público é o esperado. O que embarcar resolve é
// confiança sem rede: o cliente verifica a assinatura do pacote sem perguntar
// a ninguém qual é a chave — e é exatamente isso que impede um servidor
// comprometido de entregar chave própria junto com pacote próprio.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Servidor de distribuição oficial. HTTPS obrigatório: a licença vai no header. */
export const CATALOG_URL_PADRAO = 'https://acervo-server-production.up.railway.app/v1/catalog';

/**
 * Token de acesso aberto embarcado — o acervo baixa sem passo de ativação.
 *
 * **Não é segredo, e é assim de propósito.** Ele vive num repositório público:
 * quem lê o código o tem. Chamá-lo de "chave" seria mentir sobre o que ele
 * protege — ele não protege, ele identifica. O que ele dá é um ponto de corte:
 * trocar o valor aceito no servidor fecha o acesso de todo mundo que usa o
 * embarcado, sem republicar o pacote; e `LEGALSQUAD_LICENSE` deixa uma
 * instalação apontar para outra credencial sem editar arquivo nenhum.
 *
 * O que **não** foi afrouxado: a verificação de assinatura Ed25519 do pacote.
 * Acesso aberto responde "quem pode baixar"; a assinatura responde "isto veio
 * mesmo de quem diz que veio". Qualquer um baixa — ninguém entrega adulterado.
 */
export const TOKEN_ACESSO_ABERTO = 'LS-OPEN-ACCESS-2026';

/**
 * Anel de chaves públicas de produção, por `kid` (o `signing_kid` do manifesto).
 *
 * Por que um ANEL e não uma chave: a privada `prod-2026-07` foi perdida numa
 * formatação de máquina (03/09/2026). Os 35 pacotes já publicados continuam
 * assinados por ela e continuam verificáveis — a pública não se perde —, mas
 * nada NOVO pode ser assinado com ela. A rotação entra aqui: a antiga fica
 * para o que está no ar, a nova (`prod-2026-09`) assina o que vem. Retirar a
 * antiga do anel só quando todo pacote no servidor tiver sido reassinado.
 *
 * Pacote SEM `signing_kid` (os de 2026.08.14 foram construídos sem `--kid`) é
 * verificado contra cada chave do anel. Pacote com kid que o anel NÃO conhece
 * é recusado com a causa certa — "atualize o motor" —, e não como adulteração.
 */
export const CHAVES_PUBLICAS_PRODUCAO = Object.freeze({
  'prod-2026-07': `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEABCuD8oG9/vEXU0NRKwZzHJu/9sfZAKxFz5wkWrs+/E4=
-----END PUBLIC KEY-----
`,
  'prod-2026-09': `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAea8+f+59tq0p1biSpS34klUXtof20HbW4aqizkMjw18=
-----END PUBLIC KEY-----
`,
});
/** A chave que assina hoje — o `kid` que o `build-area` deve receber em `--kid`. */
export const KID_DE_ASSINATURA_ATUAL = 'prod-2026-09';
/** Compatibilidade: a chave original, `kid: prod-2026-07`. Prefira o anel. */
export const CHAVE_PUBLICA_PRODUCAO = CHAVES_PUBLICAS_PRODUCAO['prod-2026-07'];

const CAMINHO_CONFIG = join('_legalsquad', 'config', 'acervo.json');

/**
 * Resolve a configuração efetiva. Devolve `{ok, motivo, license, catalogUrl,
 * chavePublicaPem}` — `ok: false` traz o motivo em linguagem de gente, para o
 * chamador decidir se bloqueia ou orienta.
 *
 * Config ausente ≠ config ilegível: a primeira é o estado normal de quem
 * ainda não ativou (devolve `ok:false`); a segunda é um engano do usuário que
 * ele precisa ver (lança).
 */
export function resolverConfigDeAcervo(rootDir) {
  const caminho = join(rootDir, CAMINHO_CONFIG);

  let bruto = {};
  if (existsSync(caminho)) {
    try {
      bruto = JSON.parse(readFileSync(caminho, 'utf8'));
    } catch (erro) {
      throw new Error(`acervo-config: ${caminho} ilegível — ${erro.message}`, { cause: erro });
    }
  }

  const catalogUrl = bruto.catalog_url || CATALOG_URL_PADRAO;

  // Precedência: o que o projeto configurou > o ambiente > o embarcado. Assim
  // quem tem credencial própria nunca é sobreposto pelo padrão aberto.
  const doAmbiente =
    typeof process.env.LEGALSQUAD_LICENSE === 'string' && process.env.LEGALSQUAD_LICENSE.trim()
      ? process.env.LEGALSQUAD_LICENSE.trim()
      : null;
  const license = bruto.license || doAmbiente || TOKEN_ACESSO_ABERTO;
  const origemDaLicenca = bruto.license ? 'config' : doAmbiente ? 'ambiente' : 'embarcado';

  // Chave declarada e ilegível BLOQUEIA. Cair na embarcada em silêncio
  // trocaria a autoridade que o usuário escolheu por outra, sem avisar.
  // `chavesPublicas` é o anel {kid: pem} que o sync usa. Chave própria por
  // arquivo substitui o anel INTEIRO (quem publica área própria assina com a
  // sua, e só a sua); `chavePublicaPem` continua exposto para compatibilidade.
  let chavePublicaPem = CHAVE_PUBLICA_PRODUCAO;
  let chavesPublicas = { ...CHAVES_PUBLICAS_PRODUCAO };
  if (bruto.signing_public_key_path) {
    try {
      chavePublicaPem = readFileSync(bruto.signing_public_key_path, 'utf8');
      chavesPublicas = { propria: chavePublicaPem };
    } catch (erro) {
      return {
        ok: false,
        motivo: `chave pública declarada em ${bruto.signing_public_key_path} está ilegível — ${erro.message}`,
        license,
        origemDaLicenca,
        catalogUrl,
        chavePublicaPem: null,
        chavesPublicas: null,
      };
    }
  }

  // Licença ausente não bloqueia mais: o acesso é aberto por padrão. Só a
  // autenticidade do pacote (assinatura) segue sendo condição para instalar.
  return { ok: true, motivo: null, license, origemDaLicenca, catalogUrl, chavePublicaPem, chavesPublicas };
}

/** Grava a config de ativação. Só a licença — URL e chave vêm dos padrões. */
export function gravarConfigDeAcervo(rootDir, { license, catalogUrl }) {
  const caminho = join(rootDir, CAMINHO_CONFIG);
  const conteudo = { license, ...(catalogUrl && catalogUrl !== CATALOG_URL_PADRAO ? { catalog_url: catalogUrl } : {}) };
  return { caminho, conteudo: `${JSON.stringify(conteudo, null, 2)}\n` };
}
