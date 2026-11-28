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
 * Servidor de referência (plano do servidor de referência, seção 3.7): a API que confere citações em
 * lote (`/v1/ref/*`) e serve o índice assinado (`/v1/indice/*`). É outro serviço que o catálogo de
 * pacotes: skills e squads continuam vindo do `catalog_url`. HTTPS obrigatório pelo mesmo motivo (a
 * licença vai no header); `http://` só para máquina local (servidor de teste).
 */
export const SERVIDOR_URL_PADRAO = 'https://ref-server-production.up.railway.app';

/** As 27 UFs, em maiúsculas: as camadas `uf-<UF>` do índice. */
export const UFS_DO_BRASIL = Object.freeze(['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SE', 'SP', 'TO']);

/**
 * Órgãos reguladores que o onboarding oferece (camadas `reg-<órgão>` do índice, com o nome que o
 * servidor publica: a pasta do órgão na Legis). A lista é sugestão: o `acervo.json` aceita qualquer
 * nome curto, porque o servidor é quem diz que camadas publica (`ref camadas` lista todas).
 */
export const REGULADORES_SUGERIDOS = Object.freeze(['rfb', 'anvisa', 'ms', 'bcb', 'cvm', 'susep', 'ans', 'aneel', 'anatel', 'anac', 'antt', 'antaq', 'anp', 'ancine', 'cade', 'carf', 'inss', 'mte', 'conama', 'contran', 'confaz']);
/** Como o profissional chama o órgão × o nome da camada no servidor. */
export const APELIDOS_DE_REGULADOR = Object.freeze({ receita: 'rfb', 'receita-federal': 'rfb', bacen: 'bcb', 'banco-central': 'bcb', bc: 'bcb', 'ministerio-da-saude': 'ms' });
const RE_REGULADOR = /^[a-z0-9][a-z0-9-]{1,59}$/;

/** O nome da camada do regulador (`receita` vira `rfb`); o resto passa como veio, em minúsculas. */
export function camadaDoRegulador(nome) {
  const n = String(nome || '').trim().toLowerCase();
  return APELIDOS_DE_REGULADOR[n] || n;
}

/**
 * A URL do servidor de referência, validada, sem barra no fim; lança com a causa quando não serve.
 * `https://` sempre; `http://` só para localhost, 127.0.0.1 ou [::1] (o servidor falso dos testes).
 */
export function validarServidorUrl(valor, origem = 'servidor_url') {
  if (typeof valor !== 'string' || !valor.trim()) throw new Error(`${origem} inválido: esperava uma URL (ex.: ${SERVIDOR_URL_PADRAO})`);
  let url;
  try {
    url = new URL(valor.trim());
  } catch {
    throw new Error(`${origem} inválido: "${valor}" não é uma URL`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`${origem} inválido: "${valor}" precisa ser https:// (a licença vai no header de toda chamada)`);
  }
  if (url.search || url.hash) throw new Error(`${origem} inválido: "${valor}" não pode ter query string nem fragmento`);
  return url.toString().replace(/\/+$/, '');
}

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
/**
 * Anel de chaves de ARTIGO, SEPARADO do anel de produção acima (plano de arquitetura da Legis, 04/11/2026):
 * a chave `srv-2026-11` mora no servidor e assina só as respostas de `POST /v1/ref/artigos`. O motor a aceita
 * SOMENTE para conferir artigo (`src/ref-artigos.js`) e REJEITA qualquer manifesto de índice, diferença ou
 * pacote assinado por ela: `verificarManifesto` e `verificarAssinaturaDoManifesto` só enxergam o anel de produção.
 */
export { ANEL_ARTIGOS } from './ref-leitor/artigo-assinado.js';
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
      throw new Error(`acervo-config: ${caminho} ilegível: ${erro.message}`, { cause: erro });
    }
  }

  const catalogUrl = bruto.catalog_url || CATALOG_URL_PADRAO;

  // Áreas que este projeto liga do depósito (`"areas": ["direito-civil", …]`).
  // Ausente = todas, como sempre foi. Declarada e malformada é engano que o
  // usuário precisa ver, não um "todas" em silêncio.
  let areas = null;
  if (bruto.areas !== undefined && bruto.areas !== null) {
    if (!Array.isArray(bruto.areas) || !bruto.areas.every((a) => typeof a === 'string' && a.trim())) {
      throw new Error(`acervo-config: ${caminho} tem "areas" inválido; esperava uma lista de nomes de área (ex.: ["direito-civil"])`);
    }
    areas = bruto.areas.length ? bruto.areas.map((a) => a.trim()) : null;
  }

  // Tribunais regionais que este projeto liga (`"tribunais": ["tjpe", "trf5"]` ou `"todos"`, 0.9.104).
  // Ausente = o escritório ainda não respondeu, e nenhum regional entra; `[]` = respondeu "nenhum".
  // Declarada e malformada é engano que o usuário precisa ver, como as áreas.
  let tribunais = null;
  const tribunaisRespondidos = bruto.tribunais !== undefined && bruto.tribunais !== null;
  if (tribunaisRespondidos) {
    if (bruto.tribunais === 'todos') tribunais = 'todos';
    else if (Array.isArray(bruto.tribunais) && bruto.tribunais.every((t) => typeof t === 'string' && t.trim())) tribunais = bruto.tribunais.map((t) => t.trim().toLowerCase());
    else throw new Error(`acervo-config: ${caminho} tem "tribunais" inválido; esperava "todos" ou uma lista de siglas (ex.: ["tjpe", "trf5"])`);
  }

  // UFs cujas camadas do índice o projeto quer (`"ufs": ["PE", "MG"]` ou `"todas"`). Ausente = o
  // escritório ainda não respondeu, e nenhuma camada estadual entra; `[]` = respondeu "nenhuma".
  let ufs = null;
  const ufsRespondidas = bruto.ufs !== undefined && bruto.ufs !== null;
  if (ufsRespondidas) {
    if (bruto.ufs === 'todas') ufs = 'todas';
    else if (Array.isArray(bruto.ufs) && bruto.ufs.every((u) => typeof u === 'string' && UFS_DO_BRASIL.includes(u.trim().toUpperCase()))) ufs = [...new Set(bruto.ufs.map((u) => u.trim().toUpperCase()))].sort();
    else throw new Error(`acervo-config: ${caminho} tem "ufs" inválido; esperava "todas" ou uma lista de UFs (ex.: ["PE", "MG"])`);
  }

  // Órgãos reguladores cujas normas entram no índice local (`"reguladores": ["receita", "anvisa"]` ou
  // `"todos"`). Mesma regra: ausente = não respondeu (nenhum), `[]` = nenhum, malformado bloqueia.
  let reguladores = null;
  const reguladoresRespondidos = bruto.reguladores !== undefined && bruto.reguladores !== null;
  if (reguladoresRespondidos) {
    if (bruto.reguladores === 'todos') reguladores = 'todos';
    else if (Array.isArray(bruto.reguladores) && bruto.reguladores.every((r) => typeof r === 'string' && RE_REGULADOR.test(r.trim().toLowerCase()))) reguladores = [...new Set(bruto.reguladores.map((r) => r.trim().toLowerCase()))].sort();
    else throw new Error(`acervo-config: ${caminho} tem "reguladores" inválido; esperava "todos" ou uma lista de siglas curtas (ex.: ["receita", "anvisa"])`);
  }

  // Servidor de referência: config do projeto > ambiente (`LEGALSQUAD_SERVIDOR_URL`) > embarcado,
  // como a licença. Declarado e malformado bloqueia, como as áreas: cair no padrão em silêncio
  // trocaria o servidor que o usuário escolheu por outro.
  let servidorUrl;
  let origemDoServidor;
  if (bruto.servidor_url !== undefined && bruto.servidor_url !== null) {
    try {
      servidorUrl = validarServidorUrl(bruto.servidor_url);
    } catch (erro) {
      throw new Error(`acervo-config: ${caminho}: ${erro.message}`, { cause: erro });
    }
    origemDoServidor = 'config';
  } else if (typeof process.env.LEGALSQUAD_SERVIDOR_URL === 'string' && process.env.LEGALSQUAD_SERVIDOR_URL.trim()) {
    servidorUrl = validarServidorUrl(process.env.LEGALSQUAD_SERVIDOR_URL, 'LEGALSQUAD_SERVIDOR_URL');
    origemDoServidor = 'ambiente';
  } else {
    servidorUrl = SERVIDOR_URL_PADRAO;
    origemDoServidor = 'embarcado';
  }
  const daReferencia = { servidorUrl, origemDoServidor, ufs, ufsRespondidas, reguladores, reguladoresRespondidos };

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
        motivo: `chave pública declarada em ${bruto.signing_public_key_path} está ilegível: ${erro.message}`,
        license,
        origemDaLicenca,
        catalogUrl,
        areas,
        tribunais,
        tribunaisRespondidos,
        ...daReferencia,
        chavePublicaPem: null,
        chavesPublicas: null,
      };
    }
  }

  // Licença ausente não bloqueia mais: o acesso é aberto por padrão. Só a
  // autenticidade do pacote (assinatura) segue sendo condição para instalar.
  return { ok: true, motivo: null, license, origemDaLicenca, catalogUrl, areas, tribunais, tribunaisRespondidos, ...daReferencia, chavePublicaPem, chavesPublicas };
}

function lerConfigBruta(rootDir) {
  const caminho = join(rootDir, CAMINHO_CONFIG);
  if (!existsSync(caminho)) return { caminho, bruto: {} };
  try {
    const bruto = JSON.parse(readFileSync(caminho, 'utf8'));
    return { caminho, bruto: bruto && typeof bruto === 'object' && !Array.isArray(bruto) ? bruto : {} };
  } catch (erro) {
    throw new Error(`acervo-config: ${caminho} ilegível: ${erro.message}`, { cause: erro });
  }
}

/** Grava a config de ativação. Só a licença — URL e chave vêm dos padrões. O resto do arquivo (`areas`) fica. */
export function gravarConfigDeAcervo(rootDir, { license, catalogUrl }) {
  const { caminho, bruto } = lerConfigBruta(rootDir);
  const resto = Object.fromEntries(Object.entries(bruto).filter(([k]) => k !== 'catalog_url' && k !== 'license'));
  const conteudo = { ...resto, license, ...(catalogUrl && catalogUrl !== CATALOG_URL_PADRAO ? { catalog_url: catalogUrl } : {}) };
  return { caminho, conteudo: `${JSON.stringify(conteudo, null, 2)}\n` };
}

/**
 * Grava (ou apaga, com `null`) a seleção de áreas do projeto, preservando o
 * resto de `acervo.json`. Devolve `{caminho, conteudo}` como a irmã acima: quem
 * chama escreve.
 */
export function gravarAreasDeAcervo(rootDir, areas) {
  const { caminho, bruto } = lerConfigBruta(rootDir);
  const resto = Object.fromEntries(Object.entries(bruto).filter(([k]) => k !== 'areas'));
  const conteudo = areas && areas.length ? { ...resto, areas: [...areas] } : resto;
  return { caminho, conteudo: `${JSON.stringify(conteudo, null, 2)}\n` };
}

/**
 * Grava a escolha de tribunais regionais do projeto (`"todos"`, uma lista de siglas, ou `[]` para
 * nenhum), preservando o resto de `acervo.json`. `null` apaga a chave (volta a "não respondeu").
 */
export function gravarTribunaisDeAcervo(rootDir, tribunais) {
  const { caminho, bruto } = lerConfigBruta(rootDir);
  const resto = Object.fromEntries(Object.entries(bruto).filter(([k]) => k !== 'tribunais'));
  const conteudo = tribunais === null || tribunais === undefined ? resto : { ...resto, tribunais: tribunais === 'todos' ? 'todos' : [...tribunais] };
  return { caminho, conteudo: `${JSON.stringify(conteudo, null, 2)}\n` };
}

/**
 * Grava a escolha de UFs do projeto (`"todas"`, uma lista de UFs ou `[]` para nenhuma), preservando o
 * resto de `acervo.json`. `null` apaga a chave (volta a "não respondeu"). UF desconhecida lança: quem
 * chama valida antes e mostra a lista.
 */
export function gravarUfsDeAcervo(rootDir, ufs) {
  const { caminho, bruto } = lerConfigBruta(rootDir);
  const resto = Object.fromEntries(Object.entries(bruto).filter(([k]) => k !== 'ufs'));
  if (ufs === null || ufs === undefined) return { caminho, conteudo: `${JSON.stringify(resto, null, 2)}\n` };
  if (ufs !== 'todas') {
    const invalidas = (Array.isArray(ufs) ? ufs : [ufs]).filter((u) => !UFS_DO_BRASIL.includes(String(u).trim().toUpperCase()));
    if (!Array.isArray(ufs) || invalidas.length) throw new Error(`UF desconhecida: ${invalidas.join(', ') || String(ufs)}`);
  }
  const valor = ufs === 'todas' ? 'todas' : [...new Set(ufs.map((u) => String(u).trim().toUpperCase()))].sort();
  return { caminho, conteudo: `${JSON.stringify({ ...resto, ufs: valor }, null, 2)}\n` };
}

/** Grava os órgãos reguladores do projeto (`"todos"`, lista de siglas ou `[]`); `null` apaga a chave. */
export function gravarReguladoresDeAcervo(rootDir, reguladores) {
  const { caminho, bruto } = lerConfigBruta(rootDir);
  const resto = Object.fromEntries(Object.entries(bruto).filter(([k]) => k !== 'reguladores'));
  if (reguladores === null || reguladores === undefined) return { caminho, conteudo: `${JSON.stringify(resto, null, 2)}\n` };
  if (reguladores !== 'todos') {
    const invalidos = (Array.isArray(reguladores) ? reguladores : [reguladores]).filter((r) => !RE_REGULADOR.test(String(r).trim().toLowerCase()));
    if (!Array.isArray(reguladores) || invalidos.length) throw new Error(`sigla de regulador inválida: ${invalidos.join(', ') || String(reguladores)} (letras minúsculas, números e hífen)`);
  }
  const valor = reguladores === 'todos' ? 'todos' : [...new Set(reguladores.map(camadaDoRegulador))].sort();
  return { caminho, conteudo: `${JSON.stringify({ ...resto, reguladores: valor }, null, 2)}\n` };
}

/**
 * Grava (ou apaga, com `null`) o servidor de referência do projeto. O padrão embarcado não é gravado:
 * quem não mudou o servidor acompanha o padrão da versão do motor.
 */
export function gravarServidorUrlDeAcervo(rootDir, url) {
  const { caminho, bruto } = lerConfigBruta(rootDir);
  const resto = Object.fromEntries(Object.entries(bruto).filter(([k]) => k !== 'servidor_url'));
  if (url === null || url === undefined) return { caminho, conteudo: `${JSON.stringify(resto, null, 2)}\n` };
  const valida = validarServidorUrl(url);
  const conteudo = valida === SERVIDOR_URL_PADRAO ? resto : { ...resto, servidor_url: valida };
  return { caminho, conteudo: `${JSON.stringify(conteudo, null, 2)}\n` };
}

/**
 * O servidor de referência está ligado neste projeto? Desligado só por escolha explícita:
 * `LEGALSQUAD_SERVIDOR_REF=0` no ambiente ou `"servidor_referencia": false` no `acervo.json`.
 * Desligado, a pesquisa e o Citation Gate vão à fonte oficial na web (não há modo offline nem
 * acervo local de lei e jurisprudência), o `ref` avisa e o sync não baixa o índice. É a mesma
 * regra de `servidorDeReferenciaLigado` em `scripts/squad-state.mjs`.
 */
export function servidorDeReferenciaLigado(rootDir, env = process.env) {
  if (env.LEGALSQUAD_SERVIDOR_REF === '0') return false;
  try {
    const bruto = JSON.parse(readFileSync(join(rootDir, CAMINHO_CONFIG), 'utf8'));
    return !(bruto && bruto.servidor_referencia === false);
  } catch {
    return true;
  }
}

/** O aviso de servidor desligado (o `ref`, o sync e o despacho de pesquisa dizem o mesmo). */
export const AVISO_SERVIDOR_DESLIGADO = 'o servidor de referência está desligado neste projeto (LEGALSQUAD_SERVIDOR_REF=0 ou "servidor_referencia": false no _legalsquad/config/acervo.json): lei e jurisprudência vão à fonte oficial na web, por `node scripts/fonte-oficial.mjs`; para religar, tire a variável ou a chave';
