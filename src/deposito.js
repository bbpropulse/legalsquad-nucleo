// Depósito de conteúdo da máquina: uma cópia dos pacotes sincronizados para
// TODOS os projetos, ligada a cada um por hard link.
//
// O problema (14/09/2026): o sync gravava os pacotes dentro de cada projeto.
// Um escritório com dezenas de pastas preparadas fazia dezenas de syncs e
// guardava dezenas de cópias das mesmas 6.800 skills e 60.000 julgados. O
// princípio "cada pasta é um projeto autocontido, nunca numa casa global" foi
// escrito para DADOS DO CASO (autos, peças, memória, output), que continuam
// por projeto. Skills, best-practices e jurisprudência são conteúdo assinado,
// somente leitura e idêntico em todo projeto: o caso clássico de compartilhar.
// Continua local e offline ("sincroniza, não serve"): nada é buscado em runtime.
//
// Por que hard link e não symlink: o modelo lê `skills/<id>/SKILL.md` e faz
// Grep/Glob em `skills/` e `acervo/` por caminho relativo ao projeto, e
// ferramentas de busca (ripgrep, globs) não atravessam symlink de diretório
// por padrão. Hard link é um arquivo comum para qualquer ferramenta, custa
// zero disco e funciona em APFS, ext4 e NTFS sem privilégio. A limitação (mesmo
// volume) tem saída: quando o volume não aceita link, o projeto recebe cópia,
// e diz isso.
//
// Por que somente leitura: link compartilha o inode. Uma edição no lugar num
// projeto mudaria o conteúdo de todos. Sem o bit de escrita, a edição falha
// alto, e o caminho certo continua sendo o `SKILL.local.md` (user-owned). O
// bit é defesa em profundidade, não a fronteira: a posse é decidida pelo
// REGISTRO de arquivos por pacote (`_arquivos/<pack>.json`, gravado a cada
// aplicação), que é o que diz o que é do curador, o que foi removido e o que
// pode ser ligado. Um projeto nunca recebe arquivo que nenhum pacote vigente
// declara; pacote revogado tem os arquivos apagados do depósito e, pelo hash,
// dos projetos.
//
// O que é ligado (arquivo a arquivo): `skills/`, `_legalsquad/core/best-practices/`,
// `acervo/_packs/`. O que é copiado e passa a ser do projeto: `squads/` e
// `.claude/agents/`, com checagem em três vias nas ligações seguintes (o
// curador mudou e o usuário não tocou: substitui; o usuário mexeu: mantém e
// avisa). O que nunca é tocado: o que o projeto tem e nenhum pacote declara
// (skills do usuário, `.local.md`, `_evals/results/`, índices gerados). O que o
// projeto tem diferente do curador e não é link nem cópia antiga conhecida vai
// para `.bak` antes de ser substituído.

import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { CATALOG_URL_PADRAO } from './acervo-config.js';
import { backupSync, ehCasaLegalSquad, sha256DoArquivo } from './fs-utils.js';
import { casaArea } from './area.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** O indexador do acervo que o init copia para os projetos; aqui roda na origem. */
const INDEXADOR = join(PACKAGE_ROOT, 'templates', 'scripts', 'indexar-acervo.mjs');

/** Subárvores que o projeto recebe por hard link (arquivo a arquivo). */
export const SUBARVORES_LIGADAS = ['skills/', '_legalsquad/core/best-practices/', '_legalsquad/core/authorities/', 'scripts/legal-calculators/', 'acervo/_packs/'];
/** Subárvores que o projeto recebe por cópia (depois são dele, com checagem em três vias). */
export const SUBARVORES_COPIADAS = ['squads/', '.claude/agents/'];
/** Gerados por projeto: nunca viajam do depósito, mesmo que um pacote os traga. */
const NUNCA_VIAJAM = new Set(['_index.yaml', '_catalog-cache.json', '_manifest.json']);
/** Exceção: o índice de um pacote de acervo é gerado AQUI e viaja com ele. */
const INDICE_DE_PACK = /^acervo\/_packs\/[^/]+\/_index\.yaml$/;
/** Marcador no projeto: com o que ele está ligado, e como. */
export const CAMINHO_LIGACAO = join('acervo', '_packs', '_ligado.json');
const PASTA_REGISTROS = join('acervo', '_packs', '_arquivos');
const CAMINHO_REMOVIDOS = join('acervo', '_packs', '_removidos.json');
// Ramos que o curador declara por pacote (`area_ramos` do `_packs.yaml`, no manifesto
// assinado): { "area.direito-civil": ["familia", "sucessoes", …] }. Arquivo à parte
// porque é lido a cada ligação, e os registros de acervo têm dezenas de milhares de entradas.
const CAMINHO_RAMOS = join('acervo', '_packs', '_ramos.json');
const DIAS_DE_MEMORIA_DE_REMOCAO = 365;
const MAX_AVISOS_LISTADOS = 8;

/** O volume não faz hard link: vale para o projeto inteiro (e fica gravado). */
const ERROS_DE_VOLUME_SEM_LINK = new Set(['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL', 'EISDIR']);
/** Erro de UM arquivo (aberto pelo antivírus, indexador, editor): copia só ele. */
const ERROS_DE_ARQUIVO = new Set(['EPERM', 'EACCES', 'EMLINK', 'EBUSY', 'ETXTBSY']);

// ───────────────────────── onde o depósito mora ─────────────────────────

/**
 * Raiz do depósito. Ordem: `LEGALSQUAD_DEPOSITO` (testes, disco externo) ›
 * identidade do catálogo do projeto › `~/.legalsquad/acervo`.
 *
 * Um projeto com catálogo ou chave PRÓPRIOS (curadoria, staging) não pode
 * dividir depósito com os de produção: o estado é um só por depósito, e o sync
 * de um marcaria os packs do outro como despublicados, além de entregar a
 * quem só confia na chave de produção conteúdo verificado por outra chave.
 * Por isso a identidade (URL do catálogo + chave própria) escolhe a pasta.
 */
export function raizDoDeposito({ env = process.env, config = null, argv = process.argv } = {}) {
  if (env.LEGALSQUAD_DEPOSITO) return resolve(env.LEGALSQUAD_DEPOSITO);
  // Um arquivo de teste rodado sem o preload (`node --test tests/x.test.js`,
  // `node tests/x.test.js`, `--test-isolation=none`) cairia no depósito real
  // do desenvolvedor e o sync de fixture zeraria o manifesto dele. O runner
  // marca os filhos com NODE_TEST_CONTEXT; os outros casos aparecem no argv.
  if (env.NODE_TEST_CONTEXT || argv.includes('--test') || argv.some((a) => /\.test\.m?js$/.test(String(a)))) {
    throw new Error('deposito: teste sem LEGALSQUAD_DEPOSITO. Rode pela suíte (`npm test`, que carrega tests/test-setup.js) ou defina a variável para uma pasta temporária.');
  }
  const base = join(homedir(), '.legalsquad');
  // `resolverConfigDeAcervo` sempre preenche `chavePublicaPem` (com a de
  // produção quando não há chave própria): o sinal de chave PRÓPRIA é
  // `chavesPublicas.propria`. Sem chave própria e com o catálogo padrão, é o
  // depósito de produção. A chave própria entra no hash normalizada (o mesmo
  // PEM salvo com CRLF não pode mover o depósito).
  const chavePropria = config?.chavesPublicas?.propria ? String(config.chavesPublicas.propria).replace(/\r/g, '').trim() : '';
  const catalogo = config?.catalogUrl || CATALOG_URL_PADRAO;
  if (!config || (catalogo === CATALOG_URL_PADRAO && !chavePropria)) return join(base, 'acervo');
  const identidade = createHash('sha256').update(`${catalogo}|${chavePropria}`).digest('hex').slice(0, 10);
  return join(base, `acervo-${identidade}`);
}

/** `pack_id` vem do catálogo (rede): só um segmento simples pode virar caminho. */
export function packIdSeguro(packId) {
  return typeof packId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(packId) && !packId.includes('..');
}
function exigirPackId(packId) {
  if (!packIdSeguro(packId)) throw new Error(`deposito: pack_id inválido (${JSON.stringify(packId)}); só letras, dígitos, ponto, hífen e sublinhado`);
}

export const ehProjeto = ehCasaLegalSquad;

// ───────────────────────── registros do depósito ─────────────────────────

// Ausente devolve o padrão; ILEGÍVEL lança ("não sei ler" nunca vira "não
// existe": um registro corrompido que sumisse em silêncio deixaria um pacote
// inteiro fora dos projetos com o `status` dizendo "em dia").
function lerJson(caminho, padrao) {
  let bruto;
  try {
    bruto = readFileSync(caminho, 'utf8');
  } catch (erro) {
    if (erro?.code === 'ENOENT') return padrao;
    throw new Error(`deposito: ${caminho} não pôde ser lido (${erro.code || erro.message})`, { cause: erro });
  }
  try {
    return JSON.parse(bruto);
  } catch (erro) {
    throw new Error(`deposito: ${caminho} está ilegível (${erro.message}); corrija ou apague o arquivo conscientemente`, { cause: erro });
  }
}

function gravarJson(caminho, dados) {
  mkdirSync(dirname(caminho), { recursive: true });
  const temporario = `${caminho}.tmp`;
  try {
    writeFileSync(temporario, `${JSON.stringify(dados, null, 2)}\n`);
    renameSync(temporario, caminho);
  } catch (erro) {
    rmSync(temporario, { force: true });
    throw erro;
  }
}

function nomeDoRegistro(packId) {
  exigirPackId(packId);
  return `${packId}.json`;
}

/** Registro de um pacote: `{ pack_id, versao, arquivos: [{ path, sha256 }] }`, ou null. */
export function lerRegistroDoPack(deposito, packId) {
  return lerJson(join(deposito, PASTA_REGISTROS, nomeDoRegistro(packId)), null);
}

/** Caminhos declarados por TODOS os outros pacotes (posse compartilhada). */
function caminhosDeOutrosPacks(deposito, packId) {
  const pasta = join(deposito, PASTA_REGISTROS);
  const outros = new Set();
  let nomes;
  try {
    nomes = readdirSync(pasta).filter((n) => n.endsWith('.json') && n !== nomeDoRegistro(packId));
  } catch {
    return outros;
  }
  for (const nome of nomes) {
    const registro = lerJson(join(pasta, nome), null);
    for (const a of registro?.arquivos || []) if (typeof a?.path === 'string') outros.add(a.path);
  }
  return outros;
}

/**
 * Todos os arquivos que os pacotes vigentes declaram: `Map<path, { sha256, pack_id }>`.
 * É a lista que `ligarDeposito` percorre: o que não está aqui não é do curador.
 * Devolve null quando o depósito não tem registro nenhum (nunca aplicou pacote).
 */
/**
 * `Map<id da skill, pack_id>` a partir dos registros: de que PACOTE veio cada
 * skill instalada. É a única fonte confiável da área de uma skill — o `grupo`
 * do índice sai da primeira `categories:` que a skill declara, e isso depende
 * do curador: medido em 22/09/2026, 402 das 475 skills criminais declaram
 * `law` e 2.473 do depósito caem em `Law`/`Outras`, o que deixava o bônus de
 * área da busca sem efeito justamente nas áreas que não escreveram o ramo.
 * Custo medido: 0,11 s para as 7.475 skills, contra 1,07 s da busca inteira.
 */
export function skillsDoDeposito(deposito = raizDoDeposito()) {
  const pasta = join(deposito, PASTA_REGISTROS);
  let nomes;
  try { nomes = readdirSync(pasta).filter((n) => n.endsWith('.json')); } catch { return null; }
  const mapa = new Map();
  for (const nome of nomes) {
    const registro = lerJson(join(pasta, nome), null);
    for (const a of registro?.arquivos || []) {
      const m = /^skills\/([^/]+)\/SKILL\.md$/.exec(String(a?.path || ''));
      if (m) mapa.set(m[1], registro.pack_id);
    }
  }
  return mapa;
}

/**
 * Todos os pacotes que trazem cada arquivo do depósito. `arquivosDoDeposito` guarda um só (o
 * último registro lido), o que basta para conferir bytes, mas não para dizer se a área de um
 * modelo recebe o arquivo: a mesma best-practice pode vir no pacote criminal e no trabalhista.
 */
export function pacotesPorArquivoDoDeposito(deposito) {
  const donos = donosPorArquivo(deposito);
  if (!donos) return null;
  return new Map([...donos].map(([path, lista]) => [path, lista.map((d) => d.pack_id)]));
}

/** `Map<path, [{ pack_id, sha256 }]>`: cada pacote que declara o arquivo, com o conteúdo que declara. */
export function donosDosArquivosDoDeposito(deposito) {
  return donosPorArquivo(deposito);
}
function donosPorArquivo(deposito) {
  let nomes;
  try { nomes = readdirSync(join(deposito, PASTA_REGISTROS)).filter((n) => n.endsWith('.json')); } catch { return null; }
  const mapa = new Map();
  for (const nome of nomes) {
    const registro = lerJson(join(deposito, PASTA_REGISTROS, nome), null);
    for (const a of registro?.arquivos || []) {
      if (typeof a?.path !== 'string' || !registro.pack_id) continue;
      if (!mapa.has(a.path)) mapa.set(a.path, []);
      if (!mapa.get(a.path).some((d) => d.pack_id === registro.pack_id)) mapa.get(a.path).push({ pack_id: registro.pack_id, sha256: a.sha256 });
    }
  }
  return mapa;
}

export function arquivosDoDeposito(deposito) {
  const pasta = join(deposito, PASTA_REGISTROS);
  let nomes;
  try {
    nomes = readdirSync(pasta).filter((n) => n.endsWith('.json'));
  } catch {
    return null;
  }
  if (nomes.length === 0) return null;
  const mapa = new Map();
  for (const nome of nomes) {
    const registro = lerJson(join(pasta, nome), null);
    if (!registro || !Array.isArray(registro.arquivos)) continue;
    for (const { path, sha256 } of registro.arquivos) {
      if (typeof path === 'string' && typeof sha256 === 'string') mapa.set(path, { sha256, pack_id: registro.pack_id });
    }
  }
  return mapa;
}

function gravarRamos(deposito, packId, ramos) {
  const caminho = join(deposito, CAMINHO_RAMOS);
  const atuais = lerJson(caminho, {});
  const limpos = Array.isArray(ramos) ? [...new Set(ramos.map(normalizarSlugDeArea).filter(Boolean))] : [];
  if (limpos.length) atuais[packId] = limpos;
  else if (packId in atuais) delete atuais[packId];
  else return;
  gravarJson(caminho, atuais);
}

/**
 * Ramos por slug de área (`direito-civil` → ["familia", …]), para `packLigavel` e o
 * roteador. O pacote de acervo da mesma área herda os ramos do pacote de skills:
 * quem liga "família" quer também a jurisprudência do pacote civil. Sem arquivo (depósito
 * de antes de 0.9.33, ou pacote que não declara ramos) → mapa vazio, e o casamento cai
 * no nome da área, como sempre.
 */
export function ramosDoDeposito(deposito) {
  if (!deposito) return {};
  if (!cacheRamos.has(deposito)) {
    const porSlug = {};
    for (const [packId, ramos] of Object.entries(lerJson(join(deposito, CAMINHO_RAMOS), {}))) {
      const slug = slugDoPack(packId);
      if (!slug || !Array.isArray(ramos)) continue;
      porSlug[slug] = [...new Set([...(porSlug[slug] || []), ...ramos])];
    }
    cacheRamos.set(deposito, porSlug);
  }
  return cacheRamos.get(deposito);
}

function lerRemovidos(deposito) {
  return lerJson(join(deposito, CAMINHO_REMOVIDOS), {});
}

function anotarRemovidos(deposito, entradas) {
  if (entradas.length === 0) return;
  const removidos = lerRemovidos(deposito);
  const agora = new Date().toISOString();
  for (const { path, sha256 } of entradas) removidos[path] = { sha256, em: agora };
  const limite = Date.now() - DIAS_DE_MEMORIA_DE_REMOCAO * 86_400_000;
  for (const [path, info] of Object.entries(removidos)) {
    if (Date.parse(info?.em || '') < limite) delete removidos[path];
  }
  gravarJson(join(deposito, CAMINHO_REMOVIDOS), removidos);
}

function apagarDoDeposito(deposito, path) {
  try {
    unlinkSync(join(deposito, ...path.split('/')));
  } catch (erro) {
    if (erro?.code !== 'ENOENT') throw erro;
  }
}

/**
 * Grava o registro de um pacote aplicado e apaga do depósito o que a versão
 * anterior trazia e esta não traz mais (anotando para os projetos podarem).
 * `arquivos` é a lista decodificada que `aplicarPacote` recebeu (`path`, `sha256`).
 */
export function registrarPack(deposito, packId, versao, arquivos, { ramos } = {}) {
  exigirPackId(packId);
  // Aplicação sem arquivo nenhum (só o catálogo fino, no futuro) não é uma
  // versão nova do conteúdo: registrar uma lista vazia apagaria o pacote.
  if (!Array.isArray(arquivos) || arquivos.length === 0) return { removidos: 0, ignorado: true };
  const anterior = lerRegistroDoPack(deposito, packId);
  const atuais = new Set(arquivos.map((a) => a.path));
  // O que a versão anterior trazia e esta não traz (o índice `gerado` entra
  // aqui e é refeito logo depois; enquanto isso os projetos sabem podá-lo).
  const removidos = (anterior?.arquivos || []).filter((a) => !atuais.has(a.path));
  const deOutros = caminhosDeOutrosPacks(deposito, packId);
  const soDeste = removidos.filter((a) => !deOutros.has(a.path));
  // Dois pacotes declarando o MESMO caminho: o último aplicado sobrescreve o
  // outro, e a posse no mapa do depósito fica com quem o readdir ler por
  // último. Acontece com squad-modelo de áreas diferentes e mesmo id. Não é
  // erro aqui (o arquivo já foi escrito), mas nunca pode passar calado.
  // Gerado por projeto (`skills/_index.yaml` que todo pacote de área traz) não é colisão: nunca
  // viaja do depósito, e o aviso ainda mandava "renomear o id do modelo" em 23 pacotes a cada sync.
  const viaja = (p) => !NUNCA_VIAJAM.has(p.split('/').pop()) || INDICE_DE_PACK.test(p);
  const colisoes = arquivos.map((a) => a.path).filter((p) => viaja(p) && deOutros.has(p) && !(anterior?.arquivos || []).some((a) => a.path === p));
  for (const a of soDeste) apagarDoDeposito(deposito, a.path);
  anotarRemovidos(deposito, soDeste);
  gravarJson(join(deposito, PASTA_REGISTROS, nomeDoRegistro(packId)), {
    pack_id: packId,
    versao,
    aplicado_em: new Date().toISOString(),
    arquivos: arquivos.map((a) => ({ path: a.path, sha256: a.sha256 })),
  });
  gravarRamos(deposito, packId, ramos);
  invalidarCache();
  return { removidos: soDeste.length, colisoes };
}

/**
 * Indexa na origem um pacote de acervo (`acervo/_packs/<pack>/`): gera
 * `_index.yaml` dentro da pasta dele, com caminhos relativos a `acervo/`, e o
 * anexa ao registro do pacote (viaja, é ligado e é podado com ele). Cada
 * projeto deixa de reindexar os julgados: a busca soma o índice do projeto aos
 * índices de pacote. Medido em 14/09/2026: 61.367 julgados, 12,6 s, uma vez
 * por máquina em vez de uma vez por projeto. Pacote sem pasta de acervo
 * devolve null.
 */
/**
 * Identidade do indexador embarcado (hash do script). Vai no registro de cada
 * índice de pacote: quando o motor traz um indexador novo (campo a mais, tema
 * lido de outro jeito), os índices do depósito ficam de um formato anterior e
 * `packsDeAcervoSemIndice` os devolve para refazer, uma vez por máquina.
 */
let versaoDoIndexador = null;
export function versaoDoIndexadorAtual() {
  if (versaoDoIndexador === null) {
    try {
      versaoDoIndexador = sha256DoArquivo(INDEXADOR).slice(0, 12);
    } catch {
      versaoDoIndexador = '';
    }
  }
  return versaoDoIndexador;
}

export function indexarPackNoDeposito(deposito, packId) {
  exigirPackId(packId);
  const pasta = join(deposito, 'acervo', '_packs', packId);
  if (!existsSync(pasta) || !existsSync(INDEXADOR)) return null;
  const saida = join(pasta, '_index.yaml');
  const rel = `acervo/_packs/${packId}/_index.yaml`;
  // O índice anterior é somente leitura e pode estar ligado em projetos: sai
  // (os projetos mantêm o inode antigo até religarem), nunca recebe chmod, e
  // fica anotado pelo hash para os projetos podarem se a geração falhar.
  if (existsSync(saida)) {
    try { anotarRemovidos(deposito, [{ path: rel, sha256: sha256DoArquivo(saida) }]); } catch { /* sem hash: sem poda */ }
    rmSync(saida, { force: true });
  }
  const r = spawnSync(process.execPath, [
    INDEXADOR, '--root', deposito, '--acervo', join(deposito, 'acervo'), '--subarvore', `_packs/${packId}`, '--saida', saida,
  ], { cwd: deposito, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const m = /Indexados (\d+) arquivos/.exec(`${r.stdout || ''}\n${r.stderr || ''}`);
  if (!m || !existsSync(saida)) {
    return { ok: false, erro: r.error?.message || String(r.stderr || r.stdout || '').trim().split('\n').pop() || `exit ${r.status}` };
  }
  try { chmodSync(saida, 0o444); } catch { /* sem modos */ }
  const registro = lerRegistroDoPack(deposito, packId);
  if (registro) {
    const semIndice = (registro.arquivos || []).filter((a) => a.path !== rel);
    gravarJson(join(deposito, PASTA_REGISTROS, nomeDoRegistro(packId)), {
      ...registro,
      arquivos: [...semIndice, { path: rel, sha256: sha256DoArquivo(saida), gerado: true, indexador: versaoDoIndexadorAtual() }],
    });
    invalidarCache();
  }
  return { ok: true, arquivos: Number(m[1]) };
}

/**
 * Pacotes de acervo do depósito sem índice ATUAL: sem `_index.yaml` (depósito
 * anterior a esta versão) ou com índice gerado por outro indexador (motor
 * atualizado). Só pacotes com registro contam: sem registro não há como
 * anexar o índice a nada.
 */
export function packsDeAcervoSemIndice(deposito) {
  const packs = join(deposito, 'acervo', '_packs');
  const atual = versaoDoIndexadorAtual();
  try {
    return readdirSync(packs, { withFileTypes: true })
      .filter((e) => {
        if (!e.isDirectory() || e.name.startsWith('_')) return false;
        const registro = lerRegistroDoPack(deposito, e.name);
        if (!registro) return false;
        if (!existsSync(join(packs, e.name, '_index.yaml'))) return true;
        const indice = (registro.arquivos || []).find((a) => a.path === `acervo/_packs/${e.name}/_index.yaml`);
        return !indice || indice.indexador !== atual;
      })
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Pacote revogado ("este conteúdo está errado, apague"): os arquivos saem do
 * depósito e ficam anotados por hash para cada projeto podar na próxima ligação.
 * Sem registro (pacote aplicado por um motor anterior ao registro) não há como
 * saber o que era dele; devolve `{ arquivos: 0, semRegistro: true }`.
 */
export function removerPack(deposito, packId) {
  exigirPackId(packId);
  const registro = lerRegistroDoPack(deposito, packId);
  if (!registro) return { arquivos: 0, semRegistro: true };
  const outros = caminhosDeOutrosPacks(deposito, packId);
  const soDeste = (registro.arquivos || []).filter((a) => !outros.has(a.path));
  for (const a of soDeste) apagarDoDeposito(deposito, a.path);
  anotarRemovidos(deposito, soDeste);
  rmSync(join(deposito, PASTA_REGISTROS, nomeDoRegistro(packId)), { force: true });
  gravarRamos(deposito, packId, null);
  // A pasta própria de um pacote de acervo fica vazia: sai também.
  rmSync(join(deposito, 'acervo', '_packs', packId), { recursive: true, force: true });
  invalidarCache();
  return { arquivos: soDeste.length, semRegistro: false };
}

// ───────────────────────── marcador do projeto ─────────────────────────

function lerLigacao(projeto) {
  return lerJson(join(projeto, CAMINHO_LIGACAO), null);
}

/** O marcador de ligação do projeto, ou null se nunca foi ligado. */
export function ligacaoDoProjeto(projeto) {
  return lerLigacao(projeto);
}

/**
 * O instante da última ligação (ou do último sync do formato antigo), em ms: arquivo de pacote no
 * projeto que não mudou desde então é a versão do curador de quando a pasta foi ligada, não edição
 * de ninguém. É a régua do `.bak` do `ligarDeposito`, e a do modelo do escritório para não levar
 * como "mudança do escritório" a skill de uma pasta ainda não religada depois do sync.
 */
export function momentoDaLigacao(projeto) {
  let anterior;
  try { anterior = lerLigacao(projeto); } catch { anterior = null; }
  return momentoDeReferencia(projeto, anterior);
}

/**
 * Carimbo do conteúdo do depósito: muda quando o conjunto pack@versão muda OU
 * quando algum registro muda sem mudar versão (índice gerado depois, pacote
 * reaplicado). É o que decide "nada a ligar" e "DEFASADO"; carimbar só a
 * versão deixava projetos já ligados sem o índice gerado pela migração.
 */
export function carimboDoDeposito(deposito, estado) {
  const h = createHash('sha256');
  for (const [id, v] of Object.entries(estado?.packs || {}).sort()) h.update(`${id}@${v}\n`);
  const pasta = join(deposito, PASTA_REGISTROS);
  let nomes = [];
  try { nomes = readdirSync(pasta).filter((n) => n.endsWith('.json')).sort(); } catch { /* sem registros */ }
  for (const nome of nomes) {
    try {
      const st = statSync(join(pasta, nome));
      h.update(`${nome}:${st.size}:${Math.floor(st.mtimeMs)}\n`);
    } catch { /* sumiu no meio */ }
  }
  try { h.update(`removidos:${statSync(join(deposito, CAMINHO_REMOVIDOS)).size}\n`); } catch { /* sem remoções */ }
  return h.digest('hex').slice(0, 16);
}

/** Só as versões (compatibilidade com quem grava o estado; o carimbo real é `carimboDoDeposito`). */
export function carimboDoEstado(estado) {
  const pares = Object.entries(estado?.packs || {}).sort().map(([id, v]) => `${id}@${v}`);
  return createHash('sha256').update(pares.join('\n')).digest('hex').slice(0, 16);
}

// ───────────────────────── áreas ─────────────────────────

/**
 * Pacotes que todo projeto liga, escolha ou não áreas: o transversal (skills
 * de qualquer área), as súmulas (verbete não tem ramo) e o `outros` (julgado
 * que a captura não classificou; esconder seria "não existe").
 */
export const PACKS_SEMPRE_LIGADOS = new Set(['transversal', 'acervo.sumulas', 'acervo.outros']);

/** `area.direito-civil` e `acervo.direito-civil` → `direito-civil`; outro prefixo → null. */
export function slugDoPack(packId) {
  const m = /^(?:area|acervo)\.(.+)$/.exec(String(packId || ''));
  return m ? m[1] : null;
}

/** Aceita "civil", "direito-civil", "Direito Civil", "direito_civil" como o mesmo slug. */
export function normalizarSlugDeArea(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * O pacote entra no projeto? Sem seleção (`areas` null), tudo entra, como
 * sempre. Com seleção: os sempre-ligados, os das áreas escolhidas (o slug
 * escolhido pode ser o nome inteiro, `direito-civil`, ou o final, `civil`) e
 * qualquer pacote de tipo desconhecido (nunca esconder o que não se sabe
 * classificar).
 */
export function packLigavel(packId, areas, ramosPorSlug = {}) {
  if (!areas) return true;
  if (PACKS_SEMPRE_LIGADOS.has(packId)) return true;
  const slug = slugDoPack(packId);
  if (!slug) return true;
  // A mesma regra do roteador (`casaArea`), com os ramos do curador. Até 0.9.32 esta
  // função tinha regra própria, e "trabalhista" ligava só `execucao-trabalhista`
  // (sem o pacote principal nem a jurisprudência), "penal" não ligava o `criminal` e
  // "família" não ligava nada. A regra antiga segue valendo: nada que ligava deixa de ligar.
  return areas.some((a) => {
    const escolhido = normalizarSlugDeArea(a);
    if (escolhido === slug || slug.endsWith(`-${escolhido}`) || slug === `direito-${escolhido}` || slug === `direito-do-${escolhido}` || slug === `direito-da-${escolhido}`) return true;
    // Pedido que é, inteiro, um ramo declarado por algum curador vale só para quem o
    // declarou: palavra por palavra, um ramo de duas palavras casaria também o pacote de
    // outra área que tem uma delas no nome.
    const donos = Object.keys(ramosPorSlug || {}).filter((s) => (ramosPorSlug[s] || []).includes(escolhido));
    if (donos.length) return donos.includes(slug);
    return casaArea(slug, a, ramosPorSlug[slug]);
  });
}

export function mesmasAreas(a, b) {
  const na = a ? [...new Set(a.map(normalizarSlugDeArea))].sort() : null;
  const nb = b ? [...new Set(b.map(normalizarSlugDeArea))].sort() : null;
  return JSON.stringify(na) === JSON.stringify(nb);
}

/**
 * Apaga, de uma vez, as pastas que ficaram vazias entre os arquivos removidos e
 * a raiz de cada subárvore. Uma leitura por pasta, das mais fundas para as
 * mais rasas: quando uma pasta é lida, todas as filhas já foram decididas.
 * (Ler a pasta a cada arquivo removido era quadrático: 17 mil julgados numa
 * pasta viravam 17 mil leituras de 17 mil entradas.)
 */
function podarPastasVazias(arquivosRemovidos) {
  const candidatas = new Set();
  for (const [arquivo, raiz] of arquivosRemovidos) {
    let dir = dirname(arquivo);
    while (dir.length > raiz.length && dir.startsWith(raiz)) {
      candidatas.add(dir);
      dir = dirname(dir);
    }
  }
  const profundidade = (d) => d.split(sep).length;
  for (const dir of [...candidatas].sort((a, b) => profundidade(b) - profundidade(a) || b.length - a.length)) {
    try {
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      // já não existe ou está em uso: fica
    }
  }
}

// ───────────────────────── ligação ─────────────────────────

function statOuNulo(caminho) {
  try {
    return statSync(caminho, { bigint: true });
  } catch {
    return null;
  }
}

/** Mesmo inode (hard link já feito). `bigint` porque o id de arquivo do NTFS passa de 2^53. */
function mesmoInode(a, b) {
  return a.ino === b.ino && a.dev === b.dev && a.ino !== 0n;
}

function subarvoreDe(path) {
  if (SUBARVORES_LIGADAS.some((p) => path.startsWith(p))) return 'ligada';
  if (SUBARVORES_COPIADAS.some((p) => path.startsWith(p))) return 'copiada';
  return null;
}

/** Tira o bit de escrita do arquivo do depósito (vale para todos os links); `modo` vem do stat já feito. */
function apenasLeitura(caminho, modo) {
  try {
    if (modo & 0o222) chmodSync(caminho, modo & 0o555);
  } catch {
    // sistema de arquivos sem modos: melhor esforço
  }
}

function removerSemFalhar(caminho) {
  try {
    unlinkSync(caminho);
    return true;
  } catch (erro) {
    return erro?.code === 'ENOENT';
  }
}

/**
 * Liga um projeto ao depósito. Idempotente e incremental; percorre os arquivos
 * que os pacotes vigentes DECLARAM (registros), nunca a pasta crua.
 *
 * Opções: `deposito`; `link` (injetável, testes); `forcar` (ignora o atalho de
 * "nada mudou"); `estado` (o do depósito, para o carimbo; lido se ausente).
 *
 * Devolve `{ deposito, vazio, pulado, modo, ligados, copiados, atualizados,
 * mantidos, preservados, podados, erros, avisos }`.
 */
/**
 * Instante de referência para distinguir "link/cópia antiga do curador" de
 * "edição de alguém": a última ligação; sem ligação, o último sync do motor
 * anterior (manifesto dentro do projeto), quando os arquivos vieram de lá.
 * Arquivo mais novo que isso foi tocado depois: vai para .bak.
 */
function momentoDeReferencia(projeto, anterior) {
  if (anterior?.ligado_em) return Date.parse(anterior.ligado_em) || null;
  for (const nome of ['_manifest.json', '_manifest.json.legado']) {
    try {
      const legado = JSON.parse(readFileSync(join(projeto, 'acervo', '_packs', nome), 'utf8'));
      const t = Date.parse(legado?.sincronizado_em || '');
      if (t) return t;
    } catch {
      // sem manifesto antigo (ou ilegível): sem referência
    }
  }
  return null;
}

/** Quantas falhas seguidas de link, todas por arquivo, até tratar o volume como sem hard link. */
const FALHAS_SEGUIDAS_ATE_COPIA = 25;

/** Skill → squads do projeto que a declaram no frontmatter de um agente. */
function squadsPorSkill(projeto) {
  const mapa = new Map();
  let squads;
  try { squads = readdirSync(join(projeto, 'squads'), { withFileTypes: true }); } catch { return mapa; }
  for (const sq of squads) {
    if (!sq.isDirectory() || sq.name.startsWith('_') || sq.name.startsWith('.')) continue;
    let agentes;
    try { agentes = readdirSync(join(projeto, 'squads', sq.name, 'agents')).filter((f) => f.endsWith('.agent.md')); } catch { continue; }
    for (const f of agentes) {
      let t;
      try { t = readFileSync(join(projeto, 'squads', sq.name, 'agents', f), 'utf8'); } catch { continue; }
      const m = /^skills:\s*\[([^\]]*)\]/m.exec(t.split('\n---')[0] || '');
      for (const id of m ? m[1].split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : []) {
        if (!mapa.has(id)) mapa.set(id, []);
        if (!mapa.get(id).includes(sq.name)) mapa.get(id).push(sq.name);
      }
    }
  }
  return mapa;
}

/**
 * Arquivos do depósito que não são o que o pacote publicou: alguém deu permissão de escrita a um
 * arquivo ligado e o editou por dentro, e a edição passou a valer para todos os projetos da máquina
 * (revisão v3 do modelo do escritório, M6, 25/09/2026: `acervo status` dizia "em dia"). Só o
 * arquivo modificado depois do registro do pacote é conferido pelo hash, para não ler 80 mil.
 */
export function alteradosNoDeposito(deposito, { limite = 50 } = {}) {
  const pasta = join(deposito, PASTA_REGISTROS);
  let nomes;
  try { nomes = readdirSync(pasta).filter((n) => n.endsWith('.json')); } catch { return []; }
  // Instante de cada registro (o do pacote aplicado por último): o arquivo que vários pacotes
  // declaram é gravado por cada um, e vale o conteúdo de qualquer um deles.
  const registradoEm = new Map();
  for (const nome of nomes) {
    const registro = lerJson(join(pasta, nome), null);
    if (!registro?.pack_id) continue;
    try { registradoEm.set(registro.pack_id, statSync(join(pasta, nome)).mtimeMs); } catch { /* sem data */ }
  }
  const donos = donosPorArquivo(deposito) || new Map();
  const saida = [];
  for (const [path, lista] of donos) {
    // Índice e arquivo com `_` são gerados no depósito, não publicados pelo curador.
    if (!/^(?:skills\/|_legalsquad\/core\/best-practices\/)/.test(path) || /\/_/.test(path)) continue;
    const registrado = Math.max(...lista.map((d) => registradoEm.get(d.pack_id) ?? 0));
    const alvo = join(deposito, ...path.split('/'));
    let st;
    try { st = statSync(alvo); } catch { continue; }
    if (st.mtimeMs <= registrado + 2000) continue;
    let hash;
    try { hash = sha256DoArquivo(alvo); } catch { continue; }
    if (!lista.some((d) => d.sha256 === hash)) saida.push(path);
    if (saida.length >= limite) break;
  }
  return saida;
}

export function ligarDeposito(projeto, { deposito = raizDoDeposito(), link = linkSync, forcar = false, estado = null, areas = null } = {}) {
  const resumo = {
    deposito, vazio: false, pulado: false, modo: 'hardlink', areas: areas ? [...areas] : null,
    ligados: 0, copiados: 0, atualizados: 0, mantidos: 0, preservados: 0, podados: 0, desligados: 0, erros: 0, avisos: [],
    tocados: { 'skills/': 0, '_legalsquad/core/best-practices/': 0, '_legalsquad/core/authorities/': 0, 'scripts/legal-calculators/': 0, 'acervo/_packs/': 0, 'squads/': 0, '.claude/agents/': 0 },
    skills: 0, packs: 0, packsLigados: 0,
  };
  const avisar = (texto) => {
    if (resumo.avisos.length < MAX_AVISOS_LISTADOS) resumo.avisos.push(texto);
    else if (resumo.avisos.length === MAX_AVISOS_LISTADOS) resumo.avisos.push('(mais avisos omitidos; veja o resumo)');
  };
  if (!existsSync(deposito)) return { ...resumo, vazio: true };
  const todosDeclarados = arquivosDoDeposito(deposito) || new Map();
  const removidosDoDeposito = lerRemovidos(deposito);
  // Depósito sem pacote vigente E sem remoção a podar: não há o que fazer.
  if (todosDeclarados.size === 0 && Object.keys(removidosDoDeposito).length === 0) return { ...resumo, vazio: true };
  // Seleção por área: só o que é das áreas escolhidas (e o sempre-ligado)
  // entra; o resto continua no depósito, e o que já estava no projeto sai.
  const declarados = new Map();
  const foraDasAreas = new Map();
  const packsVistos = new Set();
  const ramos = ramosDoDeposito(deposito);
  // Um caminho pode vir em mais de um pacote (a mesma skill ou best-practice publicada em duas
  // áreas). O registro guarda um dono só, o último lido: decidir por ele deixava sem o arquivo
  // quem liga a outra área (medido em 23/09/2026: o projeto só-criminal ficava sem 24
  // best-practices que o pacote trabalhista também traz). Liga quando algum dono é das áreas
  // escolhidas e o conteúdo que está no depósito é o desse dono; conteúdo de outra área, não.
  const donos = donosPorArquivo(deposito) || new Map();
  for (let [path, info] of todosDeclarados) {
    const lista = donos.get(path) || [{ pack_id: info.pack_id, sha256: info.sha256 }];
    for (const d of lista) if (d.pack_id) packsVistos.add(d.pack_id);
    const ligaveis = lista.filter((d) => packLigavel(d.pack_id, areas, ramos));
    let liga = ligaveis.length > 0;
    if (liga && lista.length > 1 && !ligaveis.some((d) => d.pack_id === info.pack_id && d.sha256 === info.sha256)) {
      let noDeposito = null;
      try { noDeposito = sha256DoArquivo(join(deposito, ...path.split('/'))); } catch { noDeposito = null; }
      const dono = ligaveis.find((d) => d.sha256 === noDeposito);
      if (dono) info = { ...info, pack_id: dono.pack_id, sha256: noDeposito };
      else {
        liga = false;
        avisar(`${path}: a versão no depósito é de ${lista.filter((d) => d.sha256 === noDeposito).map((d) => d.pack_id).join(', ') || 'outro pacote'}, que esta pasta não liga; a de ${ligaveis.map((d) => d.pack_id).join(', ')} foi sobrescrita (o curador precisa dar um dono só a este caminho)`);
      }
    }
    if (liga) declarados.set(path, info);
    else foraDasAreas.set(path, info);
  }
  resumo.packs = packsVistos.size;
  resumo.packsLigados = [...packsVistos].filter((id) => packLigavel(id, areas, ramos)).length;
  for (const path of declarados.keys()) if (/^skills\/[^_/][^/]*\/SKILL\.md$/.test(path)) resumo.skills++;

  const estadoDoDeposito = estado || lerJson(join(deposito, 'acervo', '_packs', '_manifest.json'), { packs: {} });
  const carimbo = carimboDoDeposito(deposito, estadoDoDeposito);
  let anterior = null;
  try {
    anterior = lerLigacao(projeto);
  } catch (erro) {
    avisar(`marcador de ligação ilegível, refazendo do zero: ${erro.message}`);
  }
  const trocouDeDeposito = Boolean(anterior?.deposito && anterior.deposito !== deposito);
  if (trocouDeDeposito) avisar(`este projeto estava ligado a outro depósito (${anterior.deposito}); religando a ${deposito}`);
  const registroDeCopias = { ...(anterior?.copiados || {}) };
  // Modo cópia é pegajoso (volume sem hard link) até alguém FORÇAR uma
  // religação: aí o link é tentado de novo (o volume pode ter mudado).
  let usarCopia = !forcar && anterior?.modo === 'copia';
  if (usarCopia) resumo.modo = 'copia';

  // Nada mudou desde a última ligação (mesmo depósito, mesmo carimbo, mesmo
  // modo, raízes no lugar): não vale percorrer 80 mil arquivos. `acervo ligar` força.
  const prefixosDeclarados = SUBARVORES_LIGADAS.filter((p) => { for (const k of declarados.keys()) if (k.startsWith(p)) return true; return false; });
  const raizesNoLugar = prefixosDeclarados.every((p) => existsSync(join(projeto, ...p.split('/').filter(Boolean))));
  const mudouAreas = Boolean(anterior) && !mesmasAreas(anterior.areas || null, areas);
  if (!forcar && anterior && !trocouDeDeposito && !mudouAreas && anterior.carimbo === carimbo && anterior.modo === resumo.modo && raizesNoLugar) {
    return { ...resumo, pulado: true, mantidos: declarados.size };
  }

  // Skill editada no lugar que um squad desta pasta usa: o aviso diz qual squad perde a
  // personalização e como mantê-la (revisão v3 do modelo do escritório, A2: o squad do caso voltava
  // a rodar com a do pacote e a do escritório ficava num `.bak` que nada lê).
  let usoDasSkills = null;
  const quemPerde = (path) => {
    const m = /^skills\/([^/]+)\/SKILL\.md$/.exec(path);
    if (!m) return '';
    usoDasSkills ||= squadsPorSkill(projeto);
    const squads = usoDasSkills.get(m[1]) || [];
    return squads.length ? ` (usada por ${squads.slice(0, 4).join(', ')}${squads.length > 4 ? '…' : ''}: para manter a versão desta pasta, renomeie o .bak para SKILL.local.md, que o pacote não toca)` : '';
  };
  const momentoDaLigacaoAnterior = momentoDeReferencia(projeto, anterior);
  let falhasSeguidasDeLink = 0;
  let codigoDaFalha = null;
  // 80 mil arquivos: cada syscall poupada por arquivo é um segundo a menos.
  const pastasProntas = new Set();
  const garantirPasta = (dir) => {
    if (pastasProntas.has(dir)) return;
    mkdirSync(dir, { recursive: true });
    pastasProntas.add(dir);
  };
  const prefixoDe = (path) => Object.keys(resumo.tocados).find((p) => path.startsWith(p));
  const tocar = (path) => { const p = prefixoDe(path); if (p) resumo.tocados[p]++; };

  for (const [path, { sha256 }] of declarados) {
    const nome = basename(path);
    if ((NUNCA_VIAJAM.has(nome) && !INDICE_DE_PACK.test(path)) || nome.endsWith('.local.md') || nome.endsWith('.legalsquad-tmp')) continue;
    const tipo = subarvoreDe(path);
    if (!tipo) continue;
    const origem = join(deposito, ...path.split('/'));
    const alvo = join(projeto, ...path.split('/'));
    try {
      const so = statOuNulo(origem);
      if (!so || !so.isFile()) continue; // registro à frente do disco: pula
      const sa = statOuNulo(alvo);

      if (tipo === 'copiada') {
        const registrado = registroDeCopias[path];
        if (!sa) {
          garantirPasta(dirname(alvo));
          copyFileSync(origem, alvo);
          chmodSync(alvo, Number(so.mode & 0o777n) | 0o200);
          registroDeCopias[path] = sha256;
          resumo.copiados++;
          tocar(path);
          continue;
        }
        if (!sa.isFile()) { avisar(`${path}: existe no projeto e não é arquivo; mantido`); continue; }
        if (registrado === sha256) { resumo.mantidos++; continue; }
        const hashAtual = sha256DoArquivo(alvo);
        if (!registrado) {
          // Já existia antes do registro: se é igual ao do curador, passa a ser acompanhado; senão é do usuário.
          if (hashAtual === sha256) registroDeCopias[path] = sha256;
          resumo.mantidos++;
          continue;
        }
        if (hashAtual === registrado) {
          // O curador mudou e o usuário não tocou: substitui.
          copyFileSync(origem, alvo);
          chmodSync(alvo, Number(so.mode & 0o777n) | 0o200);
          registroDeCopias[path] = sha256;
          resumo.atualizados++;
          tocar(path);
          continue;
        }
        avisar(`${path}: o pacote trouxe versão nova, mas o arquivo foi alterado neste projeto; mantido o seu`);
        resumo.mantidos++;
        continue;
      }

      // Subárvore ligada.
      if (sa) {
        if (sa.isFile() && mesmoInode(sa, so)) { resumo.mantidos++; continue; }
        if (!sa.isFile()) { avisar(`${path}: existe no projeto e não é arquivo; mantido`); continue; }
        const identico = sa.size === so.size && sha256DoArquivo(alvo) === sha256;
        if (usarCopia && identico) { resumo.mantidos++; continue; }
        // Difere do curador. Cópia antiga idêntica, ou link de uma versão anterior
        // que não foi tocado desde a ligação: substitui sem barulho. Fora disso,
        // é edição de alguém: vai para .bak antes.
        const intocadoDesdeALigacao = momentoDaLigacaoAnterior !== null && Number(sa.mtimeMs) <= momentoDaLigacaoAnterior + 1000;
        if (!identico && !intocadoDesdeALigacao) {
          const bak = backupSync(alvo);
          resumo.preservados++;
          avisar(`${path}: diferia do pacote; a sua versão ficou em ${basename(bak)}${quemPerde(path)}`);
        }
        if (!removerSemFalhar(alvo)) { resumo.erros++; avisar(`${path}: não consegui substituir (arquivo em uso?)`); continue; }
      }
      garantirPasta(dirname(alvo));
      if (!usarCopia) {
        try {
          link(origem, alvo);
          apenasLeitura(origem, Number(so.mode & 0o777n));
          resumo.ligados++;
          tocar(path);
          falhasSeguidasDeLink = 0;
          continue;
        } catch (erro) {
          const codigo = erro?.code;
          if (ERROS_DE_VOLUME_SEM_LINK.has(codigo)) {
            usarCopia = true;
            resumo.modo = 'copia';
            avisar(`hard link indisponível entre ${deposito} e ${projeto} (${codigo}): o projeto recebe cópias`);
          } else if (!ERROS_DE_ARQUIVO.has(codigo)) {
            throw erro;
          } else {
            // Erro de um arquivo: copia só este. Muitos seguidos com o mesmo
            // código não é antivírus, é o volume (vfat no Linux devolve EPERM):
            // vira modo cópia, com aviso, em vez de 80 mil tentativas mudas.
            falhasSeguidasDeLink = codigoDaFalha === codigo ? falhasSeguidasDeLink + 1 : 1;
            codigoDaFalha = codigo;
            if (falhasSeguidasDeLink >= FALHAS_SEGUIDAS_ATE_COPIA) {
              usarCopia = true;
              resumo.modo = 'copia';
              avisar(`hard link falhou ${falhasSeguidasDeLink} vezes seguidas com ${codigo}: o projeto recebe cópias`);
            }
          }
        }
      }
      copyFileSync(origem, alvo);
      resumo.copiados++;
      tocar(path);
    } catch (erro) {
      resumo.erros++;
      // Caminho longo demais (Windows sem LongPathsEnabled dá ENOENT ou EINVAL
      // acima de 260; POSIX dá ENAMETOOLONG): a causa vai nomeada, senão o
      // aluno lê "N com erro" e ninguém sabe que era o nome do arquivo.
      const comprimento = alvo.length;
      const longo = erro?.code === 'ENAMETOOLONG' || (process.platform === 'win32' && comprimento >= 260 && ['ENOENT', 'EINVAL', 'EPERM'].includes(erro?.code));
      if (longo) resumo.caminhosLongos = (resumo.caminhosLongos || 0) + 1;
      avisar(`${path}: ${erro?.code || erro?.message || erro}${longo ? ` (caminho com ${comprimento} caracteres; o limite do Windows é 260 sem LongPathsEnabled)` : ''}`);
    }
  }
  if (resumo.caminhosLongos) avisar(`${resumo.caminhosLongos} arquivo(s) não entraram por caminho longo demais: ative caminhos longos no Windows ou use uma pasta de projeto mais curta (\`npx legalsquad diagnostico\` mede)`);

  // Poda: o que o depósito removeu (pacote revogado ou arquivo que saiu do
  // pacote) sai do projeto quando ainda é o arquivo do curador (mesmo hash).
  for (const [path, info] of Object.entries(removidosDoDeposito)) {
    if (declarados.has(path)) continue;
    const alvo = join(projeto, ...path.split('/'));
    try {
      const sa = statOuNulo(alvo);
      if (!sa || !sa.isFile()) continue;
      if (sha256DoArquivo(alvo) !== info?.sha256) continue;
      if (removerSemFalhar(alvo)) { resumo.podados++; tocar(path); }
    } catch {
      // arquivo em uso: fica; a próxima ligação tenta de novo
    }
  }

  // Fora das áreas escolhidas: o arquivo do curador sai do projeto (mesmo
  // inode ou mesmo hash); o que o usuário alterou fica, com aviso. Pastas
  // que ficam vazias saem junto, senão `skills/` continua "cheia" de cascas.
  const removidosPorArea = [];
  for (const [path, info] of foraDasAreas) {
    const nome = basename(path);
    // Os mesmos que nunca são ligados (índices e cache do projeto, ajustes locais).
    if ((NUNCA_VIAJAM.has(nome) && !INDICE_DE_PACK.test(path)) || nome.endsWith('.local.md') || nome.endsWith('.legalsquad-tmp')) continue;
    const tipo = subarvoreDe(path);
    if (!tipo) continue;
    const alvo = join(projeto, ...path.split('/'));
    const raizDaSubarvore = join(projeto, ...(SUBARVORES_LIGADAS.find((p) => path.startsWith(p)) || SUBARVORES_COPIADAS.find((p) => path.startsWith(p))).split('/').filter(Boolean));
    try {
      const sa = statOuNulo(alvo);
      if (!sa || !sa.isFile()) continue;
      let doCurador = false;
      if (tipo === 'copiada') {
        doCurador = registroDeCopias[path] ? sha256DoArquivo(alvo) === registroDeCopias[path] : false;
        if (!doCurador && registroDeCopias[path]) { avisar(`${path}: fora das áreas escolhidas, mas alterado localmente; mantido`); continue; }
        if (!registroDeCopias[path]) continue; // nunca foi cópia do depósito neste projeto
      } else {
        const so = statOuNulo(join(deposito, ...path.split('/')));
        doCurador = (so && mesmoInode(sa, so)) || sha256DoArquivo(alvo) === info?.sha256;
        if (!doCurador) { avisar(`${path}: fora das áreas escolhidas, mas diferente do depósito; mantido`); continue; }
      }
      if (removerSemFalhar(alvo)) {
        resumo.desligados++;
        tocar(path);
        delete registroDeCopias[path];
        removidosPorArea.push([alvo, raizDaSubarvore]);
      }
    } catch {
      // arquivo em uso: fica; a próxima ligação tenta de novo
    }
  }
  if (removidosPorArea.length) podarPastasVazias(removidosPorArea);

  const agora = new Date().toISOString();
  gravarJson(join(projeto, CAMINHO_LIGACAO), {
    deposito,
    modo: resumo.modo,
    carimbo,
    ligado_em: agora,
    ...(areas ? { areas: [...areas] } : {}),
    copiados: registroDeCopias,
  });
  invalidarCache();
  return resumo;
}

/**
 * O arquivo é do curador (veio do depósito ligado a este projeto)? Verdadeiro
 * quando o depósito declara o caminho e o projeto tem o mesmo inode (link) ou o
 * mesmo conteúdo (modo cópia). É a checagem POSITIVA de posse: quem reescreve
 * skills (contract-skills) pergunta aqui, em vez de descobrir pela falha de
 * escrita, que não acontece como root nem em modo cópia.
 */
// `ehDoDeposito` é chamado uma vez por skill (7 mil num catálogo real); ler os
// registros do depósito (80 mil entradas) a cada chamada seria impraticável.
// Cache por processo: os comandos do motor vivem segundos, e quem altera os
// registros (`registrarPack`, `removerPack`) invalida.
const cacheDeclarados = new Map();
const cacheLigacao = new Map();
const cacheRamos = new Map();
function declaradosEmCache(deposito) {
  if (!cacheDeclarados.has(deposito)) cacheDeclarados.set(deposito, arquivosDoDeposito(deposito));
  return cacheDeclarados.get(deposito);
}
function invalidarCache() {
  cacheDeclarados.clear();
  cacheLigacao.clear();
  cacheRamos.clear();
}

export function ehDoDeposito(caminho) {
  const absoluto = resolve(caminho);
  let dir = dirname(absoluto);
  for (;;) {
    if (existsSync(join(dir, '_legalsquad'))) break;
    const pai = dirname(dir);
    if (pai === dir) return false;
    dir = pai;
  }
  if (!cacheLigacao.has(dir)) cacheLigacao.set(dir, lerLigacao(dir));
  const ligacao = cacheLigacao.get(dir);
  if (!ligacao?.deposito) return false;
  const rel = relative(dir, absoluto).split(sep).join('/');
  const declarados = declaradosEmCache(ligacao.deposito);
  const registro = declarados?.get(rel);
  if (!registro) return false;
  const sa = statOuNulo(absoluto);
  const so = statOuNulo(join(ligacao.deposito, ...rel.split('/')));
  if (!sa || !so) return false;
  if (mesmoInode(sa, so)) return true;
  try {
    return sha256DoArquivo(absoluto) === registro.sha256;
  } catch {
    return false;
  }
}

/** Conta o que o depósito tem, para init/update dizerem ao aluno o que ganhou. */
export function resumoDoDeposito(deposito = raizDoDeposito()) {
  const declarados = existsSync(deposito) ? arquivosDoDeposito(deposito) : null;
  let skills = 0;
  const packsDeAcervo = new Set();
  for (const [path, { pack_id: packId }] of declarados || []) {
    if (/^skills\/[^_/][^/]*\/SKILL\.md$/.test(path)) skills++;
    if (path.startsWith('acervo/_packs/')) packsDeAcervo.add(packId);
  }
  return { deposito, existe: existsSync(deposito), skills, packsDeAcervo: packsDeAcervo.size, arquivos: declarados?.size || 0 };
}

/**
 * Regera `acervo/_index.yaml` do projeto pelo script que o init copia para
 * `scripts/` (é ele que conhece o formato; o motor não duplica). Sem o script
 * (pasta que não passou pelo init), não há o que indexar: devolve null. O
 * indexador grava o índice ANTES de imprimir diagnósticos (wikilinks quebrados,
 * classificação inválida) e pode sair com código 1 por causa deles: a decisão
 * é pela linha "Indexados N arquivos", não pelo código. Medido em 14/09/2026:
 * 61.367 arquivos em 12,6 s.
 */
export function reindexarAcervoDoProjeto(projeto) {
  const script = join(projeto, 'scripts', 'indexar-acervo.mjs');
  if (!existsSync(script)) return null;
  const r = spawnSync(process.execPath, [script], { cwd: projeto, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const saida = `${r.stdout || ''}\n${r.stderr || ''}`;
  const m = /Indexados (\d+) arquivos/.exec(saida);
  if (m) {
    // "(+ M em K índice(s) de pacote do depósito, já prontos)": os julgados dos
    // pacotes não são recontados aqui, mas entram no índice do projeto.
    const p = /\(\+ (\d+) em (\d+) índice/.exec(saida);
    return {
      ok: true,
      arquivos: Number(m[1]),
      pacotes: p ? { arquivos: Number(p[1]), indices: Number(p[2]) } : null,
      avisos: r.status !== 0,
    };
  }
  const ultima = saida.trim().split('\n').filter(Boolean).pop();
  return { ok: false, erro: r.error?.message || ultima || `exit ${r.status}` };
}

/**
 * Uma linha com o que o índice do projeto passou a cobrir. "0 arquivos" sozinho
 * lia como acervo vazio quando 61 mil julgados dos pacotes acabavam de entrar.
 */
export function descreverIndiceDoAcervo(r) {
  if (!r?.ok) return null;
  const locais = `${r.arquivos ?? '?'} arquivo(s) do projeto`;
  const pacotes = r.pacotes ? ` + ${r.pacotes.arquivos} julgado(s) de ${r.pacotes.indices} pacote(s)` : '';
  return `${locais}${pacotes}${r.avisos ? ' (com avisos do indexador)' : ''}`;
}
