// Squads-modelo: um squad pronto, curado, que se cria em segundos.
//
// Um modelo é `design.yaml` (decisões) + `prosa.yaml` (o texto de cada marcador)
// + `modelo.yaml` (identidade e provas). Ele NÃO carrega os arquivos do squad:
// na criação, `compilar-squad` gera tudo com a versão corrente do motor e a
// prosa entra nos marcadores. Squad congelado envelhece a cada release do
// runner (os seis squads criminais precisaram de migração); modelo compilável
// nasce sempre no formato de hoje. `{code}` é substituído pelo code escolhido.
//
// Onde moram: `squads/_modelos/<id>/` do projeto (um pacote de área os leva na
// subárvore `squads/`, que o depósito copia para o projeto). `_modelos` começa
// com `_` para nenhum listador de squads o tratar como squad.
//
// O caminho de curadoria é o inverso: um squad construído e medido vira modelo
// com `extrairModelo` (prosa recuperada por alinhamento com o compilado; o que
// não se recupera é listado, nunca inventado).

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { emitirYaml, parseYamlSubconjunto } from './yaml-subconjunto.js';
import { ErroDeCompilacaoDeSquad, despersonalizar, documentosDoCliente, emitirProsa, extrairProsa, relatorioDaExtracao } from './squad-compile.js';
import { checkSquad } from './squad-check.js';
import { mesclarGitignore } from './gitignore-semente.js';
import { achadosNaExtracao, cliDoEscritorio, ehDoEscritorio, materializar } from './modelo-escritorio.js';
export { apagarModeloDoEscritorio, exportarModelosDoEscritorio, importarModelosDoEscritorio, listarDoEscritorio, procurarNasPastasIrmas, renomearModeloDoEscritorio, salvarModeloDoEscritorio } from './modelo-escritorio.js';
export { achadosDeCaso } from './sigilo-caso.js';
import { casaArea, ramosDaArea } from './area.js';
import { ligacaoDoProjeto, packLigavel, pacotesPorArquivoDoDeposito, ramosDoDeposito, skillsDoDeposito, slugDoPack } from './deposito.js';
import { searchSkillCatalog } from './skill-search.js';
import { defaultBestPracticesDir, parseBestPracticesCatalogDir } from './best-practices-catalog.js';

export class ErroDeModelo extends Error {}
const falha = (m) => { throw new ErroDeModelo(m); };

export const PASTA_DE_MODELOS = join('squads', '_modelos');
const RE_ID = /^[a-z0-9][a-z0-9-]*$/;

function lerYaml(caminho, rotulo) {
  return parseYamlSubconjunto(readFileSync(caminho, 'utf8'), rotulo, { falha });
}

/** Modelos disponíveis no projeto. */
export function listarModelos(cwd) {
  const raiz = join(cwd, PASTA_DE_MODELOS);
  if (!existsSync(raiz)) return [];
  const modelos = [];
  for (const e of readdirSync(raiz, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = join(raiz, e.name);
    const meta = existsSync(join(dir, 'modelo.yaml')) ? lerYaml(join(dir, 'modelo.yaml'), `${e.name}/modelo.yaml`) : {};
    const completo = existsSync(join(dir, 'design.yaml')) && existsSync(join(dir, 'prosa.yaml'));
    modelos.push({ id: e.name, dir, completo, meta: meta || {} });
  }
  return herdarDoModeloDaArea(modelos.sort((a, b) => a.id.localeCompare(b.id)));
}

const chaveDeFrase = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
const semRepetir = (frases) => {
  const vistos = new Set();
  return frases.map(String).filter((f) => { const k = chaveDeFrase(f); if (!k || vistos.has(k)) return false; vistos.add(k); return true; });
};

/**
 * O modelo do escritório escolhe e se filtra como o modelo da área de onde nasceu (ou, sem origem,
 * como o modelo da área da mesma peça): herda a área (D16), os gatilhos, o que afasta e os pedidos
 * de fora NA VERSÃO DE HOJE, sem repetir frase pela forma sem acento (D15: "peticao inicial" ao lado
 * de "petição inicial" dava 12 pontos a mais). Os pedidos de exemplo do modelo da área continuam
 * dele: a régua os testa aceitando o do escritório que o substitui.
 */
export function herdarDoModeloDaArea(modelos) {
  const daArea = modelos.filter((m) => m.meta?.origem?.tipo !== 'escritorio');
  for (const m of modelos) {
    if (m.meta?.origem?.tipo !== 'escritorio') continue;
    const temDiferenca = existsSync(join(m.dir, 'diferenca.json'));
    // 0.9.42 guardava arquivos inteiros em `sobreposicoes/`: sem diferença, não se recria com fidelidade.
    m.antigo = !temDiferenca && existsSync(join(m.dir, 'sobreposicoes'));
    m.formato = temDiferenca && !existsSync(join(m.dir, 'design.yaml')) ? 'diferenca' : 'inteiro';
    const idOrigem = m.meta.origem?.modelo ? String(m.meta.origem.modelo) : null;
    const base = (idOrigem && daArea.find((p) => p.id === idOrigem)) || (!idOrigem && m.meta.peca ? daArea.find((p) => String(p.meta?.peca || '') === String(m.meta.peca)) : null) || null;
    m.base = base ? base.id : null;
    if (m.formato === 'diferenca') m.completo = Boolean(base && base.id === idOrigem && base.completo);
    if (m.antigo) m.completo = false;
    const b = base?.meta || {};
    m.meta = {
      ...m.meta,
      // A área é sempre a do modelo da área da mesma peça, também no modelo inteiro: com a do desenho
      // (`direito-civil`), o do escritório ficava fora da área do caso que o de pacote cobre (D16, N13).
      area: b.area || m.meta.area || null,
      descricao: m.meta.descricao || b.descricao || '',
      ...(base ? { nome_da_area: b.nome ?? null } : {}),
      // Os do modelo da área vão como estão (o placar fica igual ao dele); os do escritório só entram
      // se ainda não estiverem lá pela forma sem acento.
      gatilhos: [...lista(b.gatilhos).map(String), ...semRepetir([...lista(m.meta.gatilhos), ...lista(m.meta.gatilhos_proprios), ...(base ? [] : [String(m.meta.peca || '').replace(/[-_]+/g, ' ')])]).filter((g) => !lista(b.gatilhos).some((x) => chaveDeFrase(x) === chaveDeFrase(g)))],
      nao_use_para: semRepetir([...lista(b.nao_use_para), ...lista(m.meta.nao_use_para)]),
      pedidos_fora: semRepetir([...lista(b.pedidos_fora), ...lista(m.meta.pedidos_fora)]),
      pedidos_exemplo: semRepetir(lista(m.meta.pedidos_proprios)),
    };
  }
  return modelos;
}

/**
 * A identificação da peça que o chefe fez pelo pedido e pelos documentos, antes de escolher o
 * modelo (revisão de 23/09/2026): o seletor recebe só o nome técnico da peça, sem dado do caso;
 * o que liga o squad ao caso (polo, fase, último ato com prazo e a folha) fica gravado no squad,
 * para o intake mostrar e a fase zero conferir contra os autos.
 */
const CAMPOS_DA_IDENTIFICACAO = ['peca', 'polo', 'fase', 'ultimo_ato', 'fontes'];
/**
 * Sem processo (`processo: nenhum` no design do modelo: contrato, escritura, requerimento ao
 * registro), não há último ato com prazo nem folha: a identificação pelos documentos fixa peça,
 * polo e fase, e o último ato, quando houver (a minuta recebida, a nota devolutiva), vai pelo
 * documento do cliente, nunca pela folha (onda extrajudicial de 25/09/2026).
 */
export function validarIdentificacao(bruta, { semProcesso = false } = {}) {
  let ident;
  try { ident = typeof bruta === 'string' ? JSON.parse(bruta) : bruta; } catch (e) { falha(`--identificacao não é JSON válido: ${e.message}`); }
  if (!ident || typeof ident !== 'object' || Array.isArray(ident)) falha('--identificacao precisa ser um objeto JSON');
  for (const c of ['peca', 'polo', 'fase']) if (!String(ident[c] || '').trim()) falha(`--identificacao sem «${c}»: o chefe fixa peça, polo e fase antes de criar`);
  const fontes = Array.isArray(ident.fontes) ? ident.fontes.map(String) : [];
  if (!fontes.length || fontes.some((f) => !['pedido', 'documentos'].includes(f))) falha('--identificacao.fontes: "pedido", "documentos" ou os dois (de onde saiu a identificação)');
  const desconhecidos = Object.keys(ident).filter((k) => !CAMPOS_DA_IDENTIFICACAO.includes(k));
  if (desconhecidos.length) falha(`--identificacao com campo desconhecido: ${desconhecidos.join(', ')} (campos: ${CAMPOS_DA_IDENTIFICACAO.join(', ')})`);
  if (semProcesso) {
    if (ident.ultimo_ato !== undefined && ident.ultimo_ato !== null) {
      if (typeof ident.ultimo_ato !== 'object' || Array.isArray(ident.ultimo_ato) || !String(ident.ultimo_ato.ato || '').trim()) falha('--identificacao: ultimo_ato, quando houver, é um objeto com ato (e, havendo, data e arquivo, o documento do cliente onde está)');
      if (String(ident.ultimo_ato.folha || '').trim()) falha('--identificacao: sem processo não há folha; o último ato vai pelo documento do cliente (ultimo_ato.arquivo) e, se quiser, pela página');
    }
    return { ...ident, fontes };
  }
  if (fontes.includes('documentos') && !(ident.ultimo_ato && String(ident.ultimo_ato.ato || '').trim())) falha('--identificacao pelos documentos precisa de ultimo_ato.ato (e, havendo, data e folha)');
  // A folha em texto livre não localiza o ato: "documento 10" era a numeração interna do PJe, e o
  // arquivo nos autos tinha o prefixo 18 (medido em 24/09/2026, despejo). O nome do arquivo é a
  // âncora que a fase zero confere; a folha fica como complemento.
  if (fontes.includes('documentos') && !String(ident.ultimo_ato.arquivo || '').trim()) {
    falha('--identificacao pelos documentos precisa de ultimo_ato.arquivo: o nome do arquivo dos autos onde está o ato (ex.: "18-sentenca.pdf"). A numeração interna do documento ("documento 10") não é o nome do arquivo e não serve de âncora.');
  }
  return { ...ident, fontes };
}

/**
 * O `processo` que o design do modelo declara (`judicial`, `administrativo`, `nenhum`), ou null. O
 * modelo do escritório guarda só a diferença: vale o do modelo da área de que ele nasceu.
 */
export function processoDoModelo(todos, id) {
  const modelo = todos.find((m) => m.id === id);
  if (!modelo) return null;
  const base = existsSync(join(modelo.dir, 'design.yaml')) ? modelo : todos.find((m) => m.id === String(modelo.meta?.origem?.modelo || '') && existsSync(join(m.dir, 'design.yaml')));
  if (!base) return null;
  try {
    const design = lerYaml(join(base.dir, 'design.yaml'), `${base.id}/design.yaml`);
    const p = String(design?.squad?.processo || '').trim();
    return p || (String(design?.squad?.reader || '').trim() === 'autoridade' ? 'administrativo' : null);
  } catch { return null; }
}

/**
 * Com `--caso`, os autos já estão no disco: o arquivo do último ato tem de existir lá (em
 * `autos/` ou na pasta do caso, pelo caminho ou pelo nome em qualquer subpasta). Devolve null
 * quando acha e a mensagem de erro quando não acha.
 */
export function conferirArquivoDoUltimoAto(ident, pastaDoCaso) {
  const arquivo = String(ident?.ultimo_ato?.arquivo || '').trim();
  if (!arquivo || !pastaDoCaso || !existsSync(pastaDoCaso)) return null;
  for (const base of [join(pastaDoCaso, 'autos'), pastaDoCaso]) if (existsSync(join(base, arquivo))) return null;
  const nome = basename(arquivo);
  const pilha = [pastaDoCaso];
  let vistos = 0;
  while (pilha.length && vistos < 5000) {
    const dir = pilha.pop();
    let entradas;
    try { entradas = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entradas) {
      vistos += 1;
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) pilha.push(join(dir, e.name));
      else if (e.name === nome) return null;
    }
  }
  return `--identificacao: ultimo_ato.arquivo «${arquivo}» não está na pasta do caso. Use o nome do arquivo como está nos autos (a numeração interna do documento pode não bater com o prefixo do arquivo).`;
}

/**
 * O próximo passo depois de criar o squad, pelo design que ele recebeu. Com processo, os autos vão
 * para `autos/`; sem processo (contrato, escritura, requerimento ao registro), o que existe são os
 * documentos do cliente, e o squad que não os lê na fase zero parte do intake. Medido na onda
 * extrajudicial (26/09/2026): todo `--criar` mandava copiar os autos, também no contrato social.
 */
export function proximoPasso(dir, { caso = null } = {}) {
  const code = basename(dir);
  let squad = {};
  try { squad = lerYaml(join(dir, '_build', 'design.yaml'), 'design.yaml')?.squad || {}; } catch { /* sem design: o passo de sempre */ }
  const texto = (v) => String(v ?? '').trim();
  const processo = texto(squad.processo) || (texto(squad.reader) === 'autoridade' ? 'administrativo' : null);
  const leAutos = !(squad.le_autos === false || squad.le_autos === 'false');
  const documentos = documentosDoCliente({ processo, semContraparte: squad.contraparte === false || squad.contraparte === 'false', destinatario: texto(squad.destinatario) || null, leAutos });
  const rodar = `/legalsquad run ${code}`;
  if (caso) return documentos
    ? `indexe os documentos do cliente da pasta do caso com \`node scripts/indexar-autos.mjs squads/${code}\` (segue o caso.json); depois ${rodar}.`
    : `indexe os autos da pasta do caso com \`node scripts/indexar-autos.mjs squads/${code}\` (segue o caso.json); depois ${rodar}.`;
  if (documentos && leAutos) return `copie os documentos do cliente para squads/${code}/autos/ (é a pasta que a fase zero lê, também sem processo) e rode \`npm run autos:md\`; depois ${rodar}.`;
  if (documentos) return `${rodar}: a fase zero parte do intake, que pergunta onde estão os documentos do cliente.`;
  return `copie os autos para squads/${code}/autos/ e rode \`npm run autos:md\`; depois ${rodar}.`;
}

/**
 * Cria `squads/<code>/` a partir do modelo: grava o design e a prosa (com o
 * code) em `_build/`, compila com a prosa e valida. Recusa code inválido ou
 * pasta existente: um modelo nunca sobrescreve trabalho.
 */
export function instanciarModelo(id, { cwd, code, hoje, identificacao = null, caso = null } = {}) {
  const todos = listarModelos(cwd);
  const modelo = todos.find((m) => m.id === id);
  if (!modelo) falha(`modelo «${id}» não existe em ${PASTA_DE_MODELOS}/ (disponíveis: ${todos.map((m) => m.id).join(', ') || 'nenhum'})`);
  if (modelo.antigo) falha(`o modelo do escritório «${modelo.meta?.nome || id}» está no formato antigo (0.9.42), que guardava arquivos inteiros: guarde de novo o squad de origem com esta versão`);
  // O do escritório feito sobre um modelo da área que não está nesta pasta: `planoDoModelo` recusa com a mensagem certa.
  if (!modelo.completo && !(modelo.formato === 'diferenca')) falha(`modelo «${id}» está incompleto: precisa de design.yaml e prosa.yaml`);
  const codeFinal = String(code || id).trim();
  if (!RE_ID.test(codeFinal)) falha(`code «${codeFinal}» inválido: minúsculas, dígitos e hífen`);
  if (codeFinal.startsWith('_')) falha('code não pode começar com _');
  const squadsDir = join(cwd, 'squads');
  const dir = join(squadsDir, codeFinal);
  if (existsSync(dir)) falha(`squads/${codeFinal}/ já existe: escolha outro code (o modelo nunca sobrescreve um squad)`);
  // `--caso` liga os autos por referência (`caso.json`), relativo à raiz do projeto; pasta que
  // não existe é recusada antes de criar, para o squad não nascer apontando para o nada.
  if (caso && !existsSync(resolve(cwd, String(caso)))) falha(`--caso «${caso}» não existe (caminho relativo à raiz do projeto)`);
  if (caso && identificacao) {
    const erro = conferirArquivoDoUltimoAto(identificacao, resolve(cwd, String(caso)));
    if (erro) falha(erro);
  }
  mkdirSync(join(dir, '_build'), { recursive: true });
  try {
    // Modelo de pacote: compila como está. Do escritório: o modelo da área de HOJE com a diferença
    // do escritório reaplicada, e o que não reaplicou volta em `conflitos` (nunca às cegas).
    const r = materializar(cwd, modelo, { squadsDir, code: codeFinal, hoje, todos, identificacao, caso });
    if (caso) {
      // Sigilo (G13, medição de 24/09/2026): os autos do caso não podem ir para o git do
      // escritório. Só acrescenta num .gitignore que já existe; quem o cria é o init.
      try { mesclarGitignore(cwd, { criar: false }); } catch { /* .gitignore ilegível: fica como está */ }
    }
    const check = checkSquad(codeFinal, { squadsDir });
    return { id, code: codeFinal, dir, manifesto: r.manifesto, check, conflitos: r.conflitos, avisos_do_escritorio: r.avisos, escritorio: ehDoEscritorio(modelo) };
  } catch (erro) {
    rmSync(dir, { recursive: true, force: true });
    if (erro instanceof ErroDeCompilacaoDeSquad) falha(`o modelo «${id}» não compila com este motor: ${erro.message}`);
    throw erro;
  }
}

/**
 * O caminho do curador: um squad construído (e, de preferência, medido) vira
 * modelo em `squads/_modelos/<id>/`. A prosa é recuperada por alinhamento com
 * o compilado; o que não se recupera fica listado em `modelo.yaml` (provas),
 * para o curador escrever, nunca para o motor inventar.
 */
export function extrairModelo(codeOrigem, { cwd, id, nome, descricao, area, peca, polo, hoje, forcar = false, provas = {}, pastaDestino = null, semDiscovery = false, origemExtra = null } = {}) {
  const idFinal = String(id || codeOrigem).trim();
  if (!RE_ID.test(idFinal)) falha(`id de modelo «${idFinal}» inválido: minúsculas, dígitos e hífen`);
  const squadsDir = join(cwd, 'squads');
  const origem = join(squadsDir, codeOrigem);
  if (!existsSync(join(origem, '_build', 'design.yaml'))) falha(`squads/${codeOrigem}/_build/design.yaml não existe: só um squad desenhado pelo Arquiteto (ou criado de modelo) vira modelo`);
  const destino = pastaDestino || join(cwd, PASTA_DE_MODELOS, idFinal);
  if (existsSync(join(destino, 'modelo.yaml')) && !forcar) falha(`${PASTA_DE_MODELOS}/${idFinal}/ já existe; use --forcar para regravar`);
  const ex = extrairProsa(codeOrigem, { squadsDir, hoje });
  const check = checkSquad(codeOrigem, { squadsDir });
  // Com `--forcar`, o que a extração NÃO produz é do curador e fica: gatilhos, pedidos,
  // `ouro`, `provas.run`, nome e descrição. A primeira versão montava o modelo.yaml do
  // zero e apagava tudo isso em silêncio (revisão de 20/09/2026).
  const anterior = forcar && existsSync(join(destino, 'modelo.yaml')) ? lerYaml(join(destino, 'modelo.yaml'), 'modelo.yaml') : null;
  const limpo = (v) => (v === undefined || v === null || v === '' || v === 'null' || v === '~' ? null : v);
  const herdado = (chave, valor) => (limpo(valor) !== null ? valor : limpo(anterior?.[chave]));
  mkdirSync(destino, { recursive: true });
  const despers = (t) => despersonalizar(t, codeOrigem);
  // `peca:` nunca vira `{code}`: quando o code do squad de origem é igual ao nome da peça
  // (`divorcio-litigioso`), a troca fazia a peça seguir o code de quem cria o squad, e o
  // arquivo que o compilador nomeia pela peça (o caso-ouro de `_evals/`) mudava de nome e
  // ficava sem prosa. Medido em 22/09/2026 na prova de recriação do modelo de divórcio.
  const despersDesign = despers;
  writeFileSync(join(destino, 'design.yaml'), despersDesign(readFileSync(join(origem, '_build', 'design.yaml'), 'utf8')), 'utf8');
  writeFileSync(join(destino, 'prosa.yaml'), emitirProsa({ origem: `${codeOrigem} (extraído)`, arquivos: ex.arquivos }), 'utf8');
  if (!semDiscovery && existsSync(join(origem, '_build', 'discovery.yaml'))) writeFileSync(join(destino, 'discovery.yaml'), despers(readFileSync(join(origem, '_build', 'discovery.yaml'), 'utf8')), 'utf8');
  const semanticos = {};
  for (const chave of ['gatilhos', 'nao_use_para', 'pedidos_exemplo', 'pedidos_fora', 'ouro']) {
    if (anterior && anterior[chave] !== undefined) semanticos[chave] = anterior[chave];
  }
  const meta = {
    id: idFinal,
    nome: herdado('nome', nome) || idFinal,
    descricao: herdado('descricao', descricao) || '',
    area: herdado('area', area),
    peca: herdado('peca', peca),
    polo: herdado('polo', polo),
    versao: hoje || new Date().toISOString().slice(0, 10),
    origem: { squad: codeOrigem, extraido_em: hoje || new Date().toISOString().slice(0, 10), ...(origemExtra || {}) },
    ...semanticos,
    provas: {
      check_squad: { erros: check.issues.filter((i) => i.severity === 'error').length, avisos: check.issues.filter((i) => i.severity === 'warn').length },
      prosa: { marcadores: ex.total, recuperados: ex.recuperados, faltantes: ex.faltantes.map((f) => `${f.arquivo}: ${f.id} (${f.motivo})`), parciais: ex.parciais.map((f) => `${f.arquivo}: ${f.id}`) },
      run: limpo(provas.run) ?? limpo(anterior?.provas?.run),
      revisao_do_curador: limpo(provas.revisao_do_curador) ?? limpo(anterior?.provas?.revisao_do_curador),
    },
  };
  // O que o extrator não gera é da curadoria e fica, como está: `derivado_de` (a derivação de outra
  // área), provas que o curador acrescentou (`ouro`, a régua) e qualquer chave nova. Medido na onda
  // extrajudicial (26/09/2026): a locação e a promessa perderam `derivado_de` no `--extrair --forcar`,
  // e o curador o recolocou à mão.
  if (anterior && typeof anterior === 'object') {
    const provasAnteriores = anterior.provas && typeof anterior.provas === 'object' && !Array.isArray(anterior.provas) ? anterior.provas : {};
    for (const [k, v] of Object.entries(provasAnteriores)) if (!(k in meta.provas)) meta.provas[k] = v;
    const provasGeradas = meta.provas;
    delete meta.provas;
    for (const [k, v] of Object.entries(anterior)) if (!(k in meta) && k !== 'provas') meta[k] = v;
    meta.provas = provasGeradas;
  }
  writeFileSync(join(destino, 'modelo.yaml'), `# Squad-modelo: identidade e provas. Um modelo é "ouro" quando check_squad sai limpo, um run medido\n# passa a régua da meta e o curador revisou a prosa; até lá é modelo, não ouro.\n# Escolha semântica (o chefe decide pelo pedido do usuário): acrescente \`gatilhos\` (frases; \`a + b\` exige as duas,\n# \`prefix*\` casa o começo), \`nao_use_para\` (frases que afastam), \`pedidos_exemplo\` (pedidos que DEVEM escolher\n# este modelo) e \`pedidos_fora\` (pedidos que NÃO podem); \`npx legalsquad squad-modelo --testar\` confere os dois últimos.\n${emitirYaml(meta)}\n`, 'utf8');
  return { id: idFinal, dir: destino, extracao: ex, check };
}

// ───────────────────────── escolha semântica ─────────────────────────
//
// O usuário pede a peça em linguagem natural e o chefe escolhe o modelo: nada
// de terminal para ele. O que decide é o `modelo.yaml`: `gatilhos` (frases que
// o pedido contém: "réplica", "manifestar sobre a contestação"), `nao_use_para`
// (frases que afastam: "contestar", "trabalhista") e as palavras de nome, peça
// e descrição. Ranking determinístico e explicado (`casou_por`, `bloqueado_por`),
// para o chefe repassar o motivo em uma linha; empate ou nada acima do piso
// volta como `ambiguo`/`nenhum`, e aí ele pergunta ou propõe o Arquiteto.

const normalizar = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
const PALAVRAS_VAZIAS = new Set(['a', 'o', 'as', 'os', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'um', 'uma', 'e', 'ou', 'que', 'para', 'por', 'com', 'sem', 'ao', 'aos', 'se', 'ser', 'sobre', 'como', 'preciso', 'quero', 'fazer', 'faz', 'me', 'minha', 'meu', 'nossa', 'nosso', 'cliente', 'peca', 'processo', 'caso']);
const tokens = (t) => normalizar(t).split(' ').filter((x) => x.length > 2 && !PALAVRAS_VAZIAS.has(x));
/**
 * Frase contida no pedido. `a + b` exige as duas partes, em qualquer ordem
 * ("manifestar + contestação"); `respond*` casa qualquer palavra com esse começo
 * (respondo, responder, respondemos).
 */
const contemFrase = (pedido, frase) => {
  const partes = String(frase).split(' + ').map((f) => f.trim()).filter(Boolean);
  return partes.length > 0 && partes.every((f) => {
    const prefixo = f.endsWith('*');
    const n = normalizar(prefixo ? f.slice(0, -1) : f);
    return n.length > 0 && (prefixo ? ` ${pedido} `.includes(` ${n}`) : ` ${pedido} `.includes(` ${n} `));
  });
};

export const PISO_DE_ESCOLHA = 10;
export const FOLGA_DE_ESCOLHA = 5;

/** Pontua cada modelo contra o pedido. Devolve a lista ordenada, com os motivos. */
export function rankearModelos(pedido, modelos) {
  const p = normalizar(pedido);
  const toks = new Set(tokens(pedido));
  return modelos.map((m) => {
    const meta = m.meta || {};
    const casou = [];
    const bloqueado = [];
    let score = 0;
    for (const g of lista(meta.gatilhos)) if (contemFrase(p, g)) { score += 10 + Math.min(5, normalizar(String(g).replace(/ \+ /g, ' ')).split(' ').length - 1) * 2; casou.push(String(g)); }
    for (const n of lista(meta.nao_use_para)) if (contemFrase(p, n)) bloqueado.push(String(n));
    // O do escritório pontua pelas palavras do modelo da área de onde nasceu, não pelo nome que o
    // escritório lhe deu: com o rótulo, a cópia pontuava menos que o original e perdia para a peça vizinha.
    // Do escritório sem modelo da área (peça nova): as palavras do nome técnico da peça também contam,
    // para o seletor apontá-lo quando o pedido chega perto (revisão v2, N10).
    const pecaSemModelo = meta.origem?.tipo === 'escritorio' && !m.base ? String(meta.peca || '').replace(/[-_]+/g, ' ') : '';
    const vocab = new Set(tokens(`${meta.nome_da_area ?? meta.nome ?? ''} ${meta.peca || ''} ${pecaSemModelo} ${meta.descricao || ''}`));
    const comuns = [...toks].filter((t) => vocab.has(t));
    if (comuns.length) { score += Math.min(9, comuns.length * 3); casou.push(`palavras: ${comuns.join(', ')}`); }
    const escritorio = meta.origem?.tipo === 'escritorio';
    // Nota de run trazida de outra pasta é só o que aquele arquivo diz: vai marcada como informada.
    const run = escritorio ? (meta.provas?.run && typeof meta.provas.run === 'object' ? meta.provas.run : meta.provas?.run_informado && typeof meta.provas.run_informado === 'object' ? { ...meta.provas.run_informado, informada: true } : null) : null;
    return { id: m.id, nome: meta.nome || m.id, area: meta.area ? String(meta.area) : null, peca: meta.peca ? String(meta.peca) : null, modelo_de_origem: m.base || (meta.origem?.modelo ? String(meta.origem.modelo) : null), score, casou_por: casou, bloqueado_por: bloqueado, completo: m.completo, ouro: meta.provas?.ouro === true || meta.provas?.ouro === 'true', escritorio, ...(escritorio ? { run: run ? { nota: run.nota === undefined || run.nota === null || run.nota === '' ? null : Number(run.nota), data: run.data || null, informada: run.informada === true } : null } : {}) };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

const lista = (v) => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]);

/**
 * Decide: `escolha` (um modelo claramente acima do piso e dos outros), `ambiguo`
 * (dois ou mais perto demais) ou `nenhum`. Nunca escolhe modelo bloqueado.
 */
export function escolherModelo(pedido, modelos) {
  const ranking = rankearModelos(pedido, modelos);
  let elegiveis = ranking.filter((r) => r.completo && !r.bloqueado_por.length && r.score >= PISO_DE_ESCOLHA);
  // O modelo do escritório substitui só o modelo de pacote da MESMA peça (o de onde nasceu, ou o que
  // declara a mesma peça); nunca tira da disputa as outras peças. A primeira versão (0.9.42) tirava
  // todos os de pacote sempre que um do escritório passava do piso, e um modelo de petição inicial
  // salvo pelo escritório passou a responder por alimentos, JEC e notificação (revisão de 24/09/2026).
  const substituidos = new Set();
  const pecasDoEscritorio = new Set();
  for (const r of elegiveis.filter((x) => x.escritorio)) {
    if (r.modelo_de_origem) substituidos.add(r.modelo_de_origem);
    if (r.peca) pecasDoEscritorio.add(r.peca);
  }
  if (substituidos.size || pecasDoEscritorio.size) elegiveis = elegiveis.filter((r) => r.escritorio || (!substituidos.has(r.id) && !(r.peca && pecasDoEscritorio.has(r.peca))));
  if (!elegiveis.length) {
    const bloq = ranking.filter((r) => r.bloqueado_por.length && r.score >= PISO_DE_ESCOLHA);
    // O do escritório que chegou perto, ou que casou mas está sem o modelo da área nesta pasta: o
    // chefe pergunta se é ele antes de cair no Arquiteto, que duplicaria o que o escritório já tem
    // (revisão v2, N10 e N16).
    const doEscritorio = ranking.filter((r) => r.escritorio && !r.bloqueado_por.length && r.score > 0 && (r.score >= PISO_DE_ESCOLHA || r.casou_por.some((c) => c.startsWith('palavras:')))).slice(0, 3)
      .map((r) => ({ id: r.id, nome: r.nome, completo: r.completo, motivo: r.completo ? 'casou em parte com o pedido' : 'o modelo da área de onde ele nasceu não está nesta pasta' }));
    return { decisao: 'nenhum', ranking, do_escritorio: doEscritorio, motivo: bloq.length ? `${bloq[0].nome} casou pelo pedido mas foi afastado (${bloq[0].bloqueado_por.join('; ')})` : doEscritorio.length ? `nenhum modelo cobre o pedido com folga; do escritório, perto: ${doEscritorio.map((d) => d.nome).join(' · ')}` : 'nenhum modelo cobre o pedido' };
  }
  if (elegiveis.length > 1 && elegiveis[0].score - elegiveis[1].score < FOLGA_DE_ESCOLHA) {
    // Todos os empatados vão na pergunta: com quatro variantes do escritório, só três apareciam.
    const empatados = elegiveis.filter((x) => elegiveis[0].score - x.score < FOLGA_DE_ESCOLHA);
    const candidatos = empatados.length > 3 && empatados.every((x) => x.escritorio) ? empatados : elegiveis.slice(0, 3);
    return { decisao: 'ambiguo', ranking, candidatos, motivo: `mais de um modelo cobre o pedido: ${candidatos.map((e) => e.nome).join(' · ')}` };
  }
  const e = elegiveis[0];
  const doEscritorio = e.escritorio ? `; modelo do escritório${e.run?.nota !== null && e.run?.nota !== undefined ? `, nota ${e.run.nota} no run que o originou (${e.run.data || 'sem data'}${e.run.informada ? ', informada pela pasta de onde veio' : ''})` : ', sem nota de run registrada'}` : '';
  return { decisao: 'escolha', ranking, escolha: e, motivo: `${e.nome} (casou por ${e.casou_por.join('; ')})${doEscritorio || (e.ouro ? '' : '; modelo sem run medido acima da régua, ainda não é ouro')}` };
}

/**
 * Régua da curadoria: cada modelo declara `pedidos_exemplo` (pedidos que DEVEM
 * escolhê-lo) e, se quiser, `pedidos_fora` (pedidos que NÃO podem escolhê-lo,
 * como o pedido do modelo vizinho). Roda a escolha real, com todos os modelos
 * instalados, e devolve as falhas com o ranking, para o curador ajustar
 * `gatilhos`/`nao_use_para` sem adivinhar. Um modelo sem exemplos é avisado,
 * não aprovado em silêncio.
 */
/**
 * Skills de um modelo que vêm de pacote de OUTRA área (nem da área do modelo, pelos ramos do
 * curador, nem transversal). Elas compilam e passam no check-squad, mas o escritório que liga só
 * a área do modelo não recebe aquele pacote: o agente roda sem a skill que o design lhe deu.
 * Medido em 22/09/2026 no primeiro modelo criminal publicado (4 skills de 4 pacotes alheios).
 * Skill que o depósito não conhece não entra aqui: pode ser do usuário.
 */
export function skillsForaDaArea(modelo, { pacoteDe, ramosPorSlug = {}, pacoteDoModelo = null, pacoteDaBestPractice = null } = {}) {
  const area = modelo?.meta?.area;
  if ((!area && !pacoteDoModelo) || !modelo?.dir || !existsSync(join(modelo.dir, 'design.yaml'))) return [];
  let design;
  try { design = lerYaml(join(modelo.dir, 'design.yaml'), `${modelo.id}/design.yaml`); } catch { return []; }
  const achados = [];
  // Best-practice segue a mesma ligação (a pasta `_legalsquad/core/best-practices/` é ligada
  // pacote a pacote), então a mesma régua vale para ela; volta marcada com `best_practice`.
  const itens = [];
  for (const agente of lista(design?.agents)) {
    for (const skill of lista(agente?.skills).map(String)) itens.push({ agente: agente.id, skill, pacoteDe });
    if (pacoteDaBestPractice) for (const bp of lista(agente?.best_practices).map(String)) itens.push({ agente: agente.id, skill: bp, pacoteDe: pacoteDaBestPractice, best_practice: true });
  }
  if (pacoteDaBestPractice) for (const bp of lista(design?.squad?.best_practices).map(String)) itens.push({ agente: null, skill: bp, pacoteDe: pacoteDaBestPractice, best_practice: true });
  const vistos = new Set();
  for (const { agente, skill, pacoteDe: origem, best_practice } of itens) {
    // A origem pode dar mais de um pacote (a mesma skill ou best-practice publicada em dois):
    // basta um que a área do modelo receba.
    const packs = [].concat(origem(skill) || []);
    if (!packs.length || packs.includes('transversal')) continue;
    const falhas = packs.filter((pack) => !recebe(pack));
    if (falhas.length === packs.length) registrar(agente, skill, packs.join(' / '), best_practice);
  }
  return achados;
  function recebe(pack) {
    // O pacote que traz o modelo decide, quando se sabe qual é: a skill tem de vir num pacote que
    // a ligação LIGA quando o escritório escolhe a área desse pacote (trabalhista liga os cinco
    // pacotes trabalhistas; civil não liga o do consumidor). O texto da área ("direito civil e do
    // consumidor") é mais largo que o pacote, e deixava passar skill do consumidor num modelo
    // que viaja no pacote civil.
    if (pacoteDoModelo) {
      const areaDoPacote = slugDoPack(pacoteDoModelo);
      return pack === pacoteDoModelo || Boolean(areaDoPacote && packLigavel(pack, [areaDoPacote], ramosPorSlug));
    }
    const slug = slugDoPack(pack);
    return !slug || casaArea(slug, String(area), ramosPorSlug[slug]);
  }
  function registrar(agente, skill, pacote, bp) {
    const chave = `${bp ? 'bp' : 'sk'}|${agente}|${skill}`;
    if (vistos.has(chave)) return;
    vistos.add(chave);
    achados.push(bp ? { agente, skill, pacote, best_practice: true } : { agente, skill, pacote });
  }
}

export function testarModelos(modelos) {
  const casos = [];
  const semExemplos = [];
  for (const m of modelos) {
    const ex = lista(m.meta?.pedidos_exemplo);
    // O do escritório responde pelos pedidos do modelo da área que substitui (testados lá); só os
    // pedidos próprios, quando o escritório os deu, são dele.
    if (!ex.length && !(m.meta?.origem?.tipo === 'escritorio' && m.base)) semExemplos.push(m.id);
    for (const p of ex) casos.push({ modelo: m.id, pedido: String(p), esperado: 'escolha' });
    for (const p of lista(m.meta?.pedidos_fora)) casos.push({ modelo: m.id, pedido: String(p), esperado: 'fora' });
  }
  const falhas = [];
  // Os exemplos de um modelo de pacote se testam entre os modelos de pacote: num escritório que
  // salvou o seu próprio para a mesma peça, o pedido vai para o do escritório, e isso é o desejado.
  // Com os modelos do escritório na disputa: o pedido de um modelo de pacote pode ir ao modelo do
  // escritório que o substitui (mesma peça, ou nascido dele), e a nenhum outro. A 0.9.42 testava os
  // pedidos de pacote sem os modelos do escritório e escondia o sequestro de outras peças.
  const porId = new Map(modelos.map((m) => [m.id, m]));
  const substitui = (idEscritorio, idPacote) => {
    const em = porId.get(idEscritorio);
    const e = em?.meta || {};
    const p = porId.get(idPacote)?.meta || {};
    if (e.origem?.tipo !== 'escritorio') return false;
    if (e.origem?.modelo === idPacote || em.base === idPacote || (e.peca && p.peca && String(e.peca) === String(p.peca))) return true;
    // Dois do escritório da mesma peça: um responde pelo pedido do outro (o chefe mostra os dois).
    return p.origem?.tipo === 'escritorio' && Boolean(e.peca) && String(e.peca) === String(p.peca || '');
  };
  for (const c of casos) {
    const r = escolherModelo(c.pedido, modelos);
    const obtido = r.decisao === 'escolha' ? r.escolha.id : r.decisao;
    // Empate só entre modelos do escritório da mesma peça é o desejado: o chefe mostra as opções.
    const empateDoEscritorio = r.decisao === 'ambiguo' && r.candidatos.filter((x) => r.candidatos[0].score - x.score < FOLGA_DE_ESCOLHA).every((x) => x.id === c.modelo || substitui(x.id, c.modelo));
    const ok = c.esperado === 'escolha' ? obtido === c.modelo || substitui(obtido, c.modelo) || empateDoEscritorio : obtido !== c.modelo;
    if (!ok) falhas.push({ ...c, obtido, motivo: r.motivo, ranking: r.ranking.slice(0, 3).map((x) => `${x.id}:${x.score}${x.bloqueado_por.length ? ' (afastado)' : ''}`) });
  }
  return { total: casos.length, ok: casos.length - falhas.length, falhas, sem_exemplos: semExemplos };
}

/**
 * Squads deste projeto criados a partir de um modelo (`_build/modelo-origem.json`),
 * do mais recente ao mais antigo. É o passo REUSAR antes de CRIAR: a rotina de prazos
 * do dia rodava `--criar` a cada pedido e nascia um `prazos-intimacoes-N` novo por dia,
 * com memória, evals e ledger próprios (revisão de 20/09/2026).
 */
export function squadsDoModelo(cwd, id) {
  const squadsDir = join(cwd, 'squads');
  if (!existsSync(squadsDir)) return [];
  const achados = [];
  for (const e of readdirSync(squadsDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const origem = join(squadsDir, e.name, '_build', 'modelo-origem.json');
    if (!existsSync(origem)) continue;
    try {
      const o = JSON.parse(readFileSync(origem, 'utf8'));
      if (o && o.modelo === id) achados.push({ code: e.name, criado_em: o.criado_em || null, versao: o.versao ?? null });
    } catch { /* origem ilegível: não é deste modelo */ }
  }
  return achados.sort((a, b) => String(b.criado_em || '').localeCompare(String(a.criado_em || '')) || b.code.localeCompare(a.code));
}

/** Code livre para um modelo: o id, ou id-2, id-3… quando já existe. */
export function codeLivre(cwd, base) {
  const squadsDir = join(cwd, 'squads');
  if (!existsSync(join(squadsDir, base))) return base;
  for (let n = 2; n < 100; n++) if (!existsSync(join(squadsDir, `${base}-${n}`))) return `${base}-${n}`;
  falha(`não há code livre para ${base}`);
}

/** Copia um modelo para outra raiz (o curador leva o modelo do projeto para a área). */
export function copiarModelo(id, { cwd, destino }) {
  const modelo = listarModelos(cwd).find((m) => m.id === id);
  if (!modelo) falha(`modelo «${id}» não existe`);
  const alvo = isAbsolute(destino) ? destino : resolve(cwd, destino);
  mkdirSync(alvo, { recursive: true });
  cpSync(modelo.dir, join(alvo, basename(modelo.dir)), { recursive: true });
  return join(alvo, basename(modelo.dir));
}

/** CLI: `npx legalsquad squad-modelo [<id> --code <code>] [--para "<pedido>" [--criar] [--reusar]] [--extrair <squad> --id <id>] [--testar] [--json]`. */
export function squadModeloCli(positional, cwd, values = {}) {
  const json = values.json === true;
  try {
    if (values.testar === true) {
      const modelos = listarModelos(cwd);
      const t = testarModelos(modelos);
      const deposito = ligacaoDoProjeto(cwd)?.deposito;
      const mapa = deposito ? skillsDoDeposito(deposito) : null;
      const ramos = ramosDoDeposito(deposito);
      const registros = deposito ? pacotesPorArquivoDoDeposito(deposito) : null;
      const pacoteDoModelo = (id) => registros?.get(`squads/_modelos/${id}/modelo.yaml`)?.[0] || null;
      const pacoteDaBestPractice = (bp) => registros?.get(`_legalsquad/core/best-practices/${bp}.md`) || null;
      const achados = mapa ? modelos.flatMap((m) => skillsForaDaArea(m, { pacoteDe: (sk) => registros?.get(`skills/${sk}/SKILL.md`) || mapa.get(sk) || null, ramosPorSlug: ramos, pacoteDoModelo: pacoteDoModelo(m.id), pacoteDaBestPractice }).map((x) => ({ modelo: m.id, ...x }))) : [];
      const foraDaArea = achados.filter((x) => !x.best_practice);
      // Best-practice de outro pacote é aviso, não reprovação: as genéricas (revisão jurídica,
      // ética e sigilo) só viajam hoje nos pacotes criminal e trabalhista, e levá-las ao
      // transversal é decisão de curadoria (as cópias dos dois pacotes divergem).
      const bpsForaDaArea = achados.filter((x) => x.best_practice);
      const ok = t.falhas.length === 0 && foraDaArea.length === 0;
      if (json) { console.log(JSON.stringify({ success: ok, ...t, skills_fora_da_area: foraDaArea, best_practices_fora_da_area: bpsForaDaArea }, null, 2)); return { success: ok }; }
      console.log(`  ${t.ok}/${t.total} pedido(s) de exemplo escolhem o modelo certo (${modelos.length} modelo(s) em ${PASTA_DE_MODELOS}/)`);
      for (const f of t.falhas) {
        console.log(`  ✖ ${f.modelo}: "${f.pedido}"`);
        console.log(`      ${f.esperado === 'escolha' ? 'devia escolher este modelo' : 'não podia escolher este modelo'}, obteve ${f.obtido} (${f.motivo})`);
        console.log(`      ranking: ${f.ranking.join(' · ')}`);
      }
      for (const id of t.sem_exemplos) console.log(`  ⚠ ${id}: sem pedidos_exemplo no modelo.yaml, nada a testar`);
      if (!mapa) console.log('  ⚠ projeto sem depósito ligado: a origem das skills não foi conferida');
      for (const x of foraDaArea) console.log(`  ✖ ${x.modelo}: o agente ${x.agente} usa ${x.skill}, do pacote ${x.pacote}, que não é da área do modelo (quem liga só a área não recebe a skill)`);
      if (bpsForaDaArea.length) {
        const porBp = new Map();
        for (const x of bpsForaDaArea) {
          const k = `${x.skill} (${x.pacote})`;
          if (!porBp.has(k)) porBp.set(k, new Set());
          porBp.get(k).add(x.modelo);
        }
        console.log(`  ⚠ ${porBp.size} best-practice(s) de outro pacote em ${new Set(bpsForaDaArea.map((x) => x.modelo)).size} modelo(s); quem liga só a área do modelo não as recebe:`);
        for (const [k, mods] of porBp) console.log(`      ${k}: ${[...mods].join(', ')}`);
      }
      return { success: ok };
    }
    if (values.para) {
      const pedido = String(values.para);
      // A área do caso é filtro (revisão de 22/09/2026): modelo de outra área não concorre,
      // mesmo com o mesmo nome de peça; modelo sem área declarada continua concorrendo.
      const todos = listarModelos(cwd);
      const areaPedida = values.area ? String(values.area) : null;
      const ramos = ramosDoDeposito(ligacaoDoProjeto(cwd)?.deposito);
      const foraDaArea = areaPedida ? todos.filter((m) => m.meta?.area && !casaArea(m.meta.area, areaPedida, ramosDaArea(m.meta.area, ramos))).map((m) => m.id) : [];
      const d = escolherModelo(pedido, areaPedida ? todos.filter((m) => !foraDaArea.includes(m.id)) : todos);
      d.area_pedida = areaPedida;
      d.fora_da_area = foraDaArea;
      let criado = null;
      // O que já existe deste modelo vai sempre na resposta (o chefe decide REUSAR ou CRIAR:
      // outra réplica de outro caso é um squad novo; a rotina de prazos do dia é a mesma).
      // Com `--reusar`, o mais recente é devolvido e nada é criado.
      const existentes = d.decisao === 'escolha' ? squadsDoModelo(cwd, d.escolha.id) : [];
      const reusado = d.decisao === 'escolha' && values.reusar === true && existentes.length ? existentes[0].code : null;
      if (d.decisao === 'escolha' && values.criar === true && !reusado) {
        const identificacao = values.identificacao ? validarIdentificacao(values.identificacao, { semProcesso: processoDoModelo(todos, d.escolha.id) === 'nenhum' }) : null;
        // Do modelo do escritório, o squad leva o nome da peça (`replica`), não o id técnico (`esc-…`).
        const r = instanciarModelo(d.escolha.id, { cwd, code: values.code ? String(values.code) : codeLivre(cwd, d.escolha.id.replace(/^esc-/, '')), identificacao, caso: values.caso || null });
        criado = { code: r.code, dir: r.dir, proximo: proximoPasso(r.dir, { caso: values.caso || null }), marcadores_restantes: r.manifesto.marcadores, avisos: [...r.manifesto.avisos, ...(r.avisos_do_escritorio || [])], conflitos: r.conflitos || [], check: { erros: r.check.issues.filter((i) => i.severity === 'error').length, avisos: r.check.issues.filter((i) => i.severity === 'warn').length }, skills_sem_contrato: r.check.issues.filter((i) => i.code === 'skill-sem-contrato').map((i) => i.detail) };
      }
      if (json) { console.log(JSON.stringify({ success: true, decisao: d.decisao, motivo: d.motivo, area_pedida: d.area_pedida, fora_da_area: d.fora_da_area, escolha: d.escolha || null, candidatos: d.candidatos || null, do_escritorio: d.do_escritorio || null, ranking: d.ranking.slice(0, 5), existentes: existentes.map((e) => e.code), reusado, criado }, null, 2)); return { success: true }; }
      console.log(`  Pedido: "${pedido}"${d.area_pedida ? ` · área ${d.area_pedida}` : ''}`);
      if (d.fora_da_area.length) console.log(`  Fora da área do caso (não concorrem): ${d.fora_da_area.join(', ')}`);
      console.log(`  Decisão: ${d.decisao}${d.escolha ? ` → ${d.escolha.id}` : ''} (${d.motivo})`);
      for (const x of d.do_escritorio || []) console.log(`  · do escritório: ${x.nome} [${x.id}] (${x.motivo})`);
      for (const r of d.ranking.slice(0, 5)) console.log(`    ${r.id}: ${r.score}${r.bloqueado_por.length ? ` (bloqueado: ${r.bloqueado_por.join('; ')})` : ''}${r.casou_por.length ? ` · ${r.casou_por.join('; ')}` : ''}`);
      if (existentes.length) console.log(`  ${reusado ? '✓ reusado' : 'já existe deste modelo:'} ${existentes.map((e) => `squads/${e.code}/`).join(', ')}${reusado ? '' : ' (o chefe decide: reusar, ou --criar para outro caso)'}`);
      if (criado) console.log(`  ✓ criado squads/${criado.code}/ (${criado.check.erros} erro(s), ${criado.check.avisos} aviso(s) no check-squad)${criado.avisos.length ? `\n  ⚠ ${criado.avisos.join('\n  ⚠ ')}` : ''}\n  Próximo: ${criado.proximo}`);
      for (const x of criado?.skills_sem_contrato || []) console.log(`  ⚠ ${x}`);
      if (criado?.conflitos.length) console.log(`  ⚠ ${criado.conflitos.length} mudança(s) do escritório ficaram de fora (o modelo da área mudou naqueles pontos): ${criado.conflitos.slice(0, 6).map((c) => c.arquivo).join(', ')}`);
      return { success: true };
    }
    if (values.derivar) {
      const r = derivarModelo(String(values.derivar), { cwd, id: values.id ? String(values.id) : undefined, area: values.area, peca: values.peca, nome: values.nome, descricao: values.descricao, polo: values.polo, forcar: values.forcar === true });
      if (json) { console.log(JSON.stringify({ success: true, ...r }, null, 2)); return { success: true }; }
      console.log(`Modelo derivado: ${r.id}`);
      console.log(`  \u2713 esqueleto de \u00ab${r.origem}\u00bb gravado em ${PASTA_DE_MODELOS}/${r.id}/`);
      console.log(`  \u2192 \u00e1rea: ${r.area}${r.peca ? ` \u00b7 pe\u00e7a: ${r.peca}` : ''}`);
      console.log(`  \u2192 ${r.skills_da_origem} skill(s) da origem viraram marca\u00e7\u00f5es "A CONFERIR"; candidatas por agente:`);
      for (const s of r.sugestoes) {
        const daArea = s.candidatas.filter((c) => c.area_casou);
        const fora = s.candidatas.filter((c) => !c.area_casou);
        console.log(`      ${s.agente}: ${daArea.length ? daArea.map((c) => c.id).join(', ') : '(nenhuma da \u00e1rea)'}${fora.length ? ` \u00b7 fora da \u00e1rea: ${fora.map((c) => c.id).join(', ')}` : ''}`);
      }
      if (r.best_practices_trocadas.length) console.log(`  \u2192 best-practice de outra \u00e1rea marcada: ${r.best_practices_trocadas.join(', ')} \u2192 ${r.best_practices_da_area.length ? r.best_practices_da_area.join(', ') : 'a \u00e1rea n\u00e3o declara best-practice de mat\u00e9ria (s\u00f3 as transversais)'}`);
      console.log(`  \u2192 ${r.campos_a_reescrever} campo(s) de texto do design marcados [REESCREVER PARA A \u00c1REA]: goal, success_criteria, t\u00edtulos e briefs vieram da pe\u00e7a de origem`);
      console.log('  \u26a0 sem prosa.yaml: o modelo est\u00e1 INCOMPLETO de prop\u00f3sito (o chefe n\u00e3o o escolhe). O Build escreve a prosa da mat\u00e9ria sobre este design.');
      console.log('  Pr\u00f3ximos passos (o ciclo que fecha o modelo):');
      console.log(`    1. escolha as skills marcadas "A CONFERIR" no design (${PASTA_DE_MODELOS}/${r.id}/design.yaml)`);
      console.log(`    2. mkdir -p squads/<code>/_build && cp ${PASTA_DE_MODELOS}/${r.id}/design.yaml squads/<code>/_build/`);
      console.log('    3. npx legalsquad compilar-squad <code>   (gera os arquivos com os marcadores LEGALSQUAD:PREENCHER)');
      console.log('    4. o Build escreve a prosa da mat\u00e9ria em cada marcador; npx legalsquad check-squad <code> fecha limpo');
      console.log(`    5. npx legalsquad squad-modelo --extrair <code> --id ${r.id} --forcar   (a prosa volta para o modelo)`);
      return { success: true };
    }
    const escritorio = cliDoEscritorio(positional, cwd, values);
    if (escritorio) return escritorio;
    if (values.extrair) {
      const r = extrairModelo(String(values.extrair), { cwd, id: values.id ? String(values.id) : undefined, nome: values.nome, descricao: values.descricao, area: values.area, peca: values.peca, polo: values.polo, forcar: values.forcar === true });
      // A curadoria extrai de squad de caso real também: a mesma varredura do modelo do escritório,
      // aqui como aviso (quem cura revisa a prosa antes de publicar), nunca em silêncio.
      const achados = achadosNaExtracao(cwd, String(values.extrair), r);
      if (json) { console.log(JSON.stringify({ success: true, id: r.id, dir: r.dir, recuperados: r.extracao.recuperados, total: r.extracao.total, faltantes: r.extracao.faltantes, parciais: r.extracao.parciais, achados }, null, 2)); return { success: true }; }
      console.log(`Modelo: ${r.id}`);
      console.log(`  ✓ gravado em ${PASTA_DE_MODELOS}/${r.id}/ (design.yaml, prosa.yaml, modelo.yaml)`);
      for (const linha of relatorioDaExtracao(r.extracao)) console.log(linha);
      if (achados.length) { console.log(`  ⚠ ${achados.length} trecho(s) parecem dado do caso; revise antes de publicar:`); for (const a of achados.slice(0, 20)) console.log(`      ${a.arquivo}: «${a.trecho}» (${a.motivo})`); }
      console.log(`  check-squad da origem: ${r.check.issues.filter((i) => i.severity === 'error').length} erro(s), ${r.check.issues.filter((i) => i.severity === 'warn').length} aviso(s)`);
      return { success: true };
    }
    if (!positional) {
      const modelos = listarModelos(cwd);
      if (json) { console.log(JSON.stringify({ success: true, modelos: modelos.map((m) => ({ id: m.id, completo: m.completo, ...m.meta })) }, null, 2)); return { success: true }; }
      if (!modelos.length) { console.log(`  Nenhum squad-modelo em ${PASTA_DE_MODELOS}/. Um pacote de área pode trazê-los; \`squad-modelo --extrair <squad>\` cria um a partir de um squad construído.`); return { success: true }; }
      console.log('  Squads-modelo disponíveis:');
      for (const m of modelos) {
        const p = m.meta?.provas || {};
        const run = p.run && typeof p.run === 'object' ? ` · run ${p.run.nota ?? '?'}/100 (${p.run.ritmo ?? '?'}, ${p.run.data ?? '?'})` : ' · sem run medido';
        const doEsc = ehDoEscritorio(m) ? ` [do escritório${m.base ? `, sobre ${m.base}` : ''}${m.antigo ? ', formato antigo' : ''}]` : '';
        console.log(`    ${m.id}${m.completo ? '' : ' (incompleto)'}${doEsc}  ${m.meta?.nome || ''}${m.meta?.descricao && !ehDoEscritorio(m) ? ': ' + m.meta.descricao : ''}`);
        console.log(`      ${m.meta?.area ? `área ${m.meta.area} · ` : ''}${m.meta?.peca ? `peça ${m.meta.peca} · ` : ''}${m.meta?.polo ? `polo ${m.meta.polo} · ` : ''}check-squad ${p.check_squad ? `${p.check_squad.erros} erro(s), ${p.check_squad.avisos} aviso(s)` : '?'}${run}`);
      }
      console.log('  Criar: `npx legalsquad squad-modelo <id> --code <code>`');
      return { success: true };
    }
    // Mesmo contrato do caminho pelo seletor: identificação e autos por referência não se perdem
    // quando o modelo é criado pelo nome (medido em 23/09/2026: os dois eram ignorados em silêncio).
    const identificacao = values.identificacao ? validarIdentificacao(values.identificacao, { semProcesso: processoDoModelo(listarModelos(cwd), String(positional)) === 'nenhum' }) : null;
    const r = instanciarModelo(String(positional), { cwd, code: values.code ? String(values.code) : undefined, identificacao, caso: values.caso || null });
    const erros = r.check.issues.filter((i) => i.severity === 'error');
    const avisos = r.check.issues.filter((i) => i.severity === 'warn');
    const proximo = proximoPasso(r.dir, { caso: values.caso || null });
    if (json) { console.log(JSON.stringify({ success: erros.length === 0, code: r.code, dir: r.dir, proximo, manifesto: r.manifesto, check: r.check.issues, conflitos: r.conflitos, avisos_do_escritorio: r.avisos_do_escritorio }, null, 2)); return { success: erros.length === 0 }; }
    console.log(`Squad: ${r.code} (do modelo ${r.id})`);
    console.log(`  ✓ ${r.manifesto.arquivos} arquivo(s) compilados, ${r.manifesto.prosa?.preenchidos ?? 0} marcador(es) preenchidos pela prosa do modelo, ${r.manifesto.marcadores} restante(s)`);
    for (const a of r.manifesto.avisos) console.log(`  ⚠ ${a}`);
    for (const a of r.avisos_do_escritorio || []) console.log(`  ⚠ ${a}`);
    if (r.conflitos?.length) {
      console.log(`  ⚠ ${r.conflitos.length} mudança(s) do escritório não couberam no modelo da área de hoje e ficaram de fora (o squad foi criado sem elas):`);
      for (const c of r.conflitos.slice(0, 12)) console.log(`      ${c.arquivo}: ${c.motivo}${c.trecho ? ` («${String(c.trecho).split('\n')[0].slice(0, 100)}»)` : ''}`);
    }
    for (const i of erros) console.log(`  ✖ [${i.code}] ${i.detail}`);
    for (const i of avisos) console.log(`  ⚠ [${i.code}] ${i.detail}`);
    console.log(erros.length ? `  ${erros.length} erro(s) no check-squad` : `  ✓ check-squad: estrutura íntegra${avisos.length ? ` (${avisos.length} aviso(s))` : ''}`);
    console.log(`  Próximo: ${proximo}`);
    return { success: erros.length === 0 };
  } catch (erro) {
    if (!(erro instanceof ErroDeModelo) && !(erro instanceof ErroDeCompilacaoDeSquad)) throw erro;
    if (json) console.log(JSON.stringify({ success: false, error: erro.message }, null, 2));
    else console.error(`  ✖ ${erro.message}`);
    return { success: false };
  }
}

/**
 * Deriva um modelo de outra ÁREA a partir de um modelo já curado.
 *
 * O que se reaproveita é o ESQUELETO — paradas, fase zero em paralelo, loop de
 * revisão com `on_reject`, conferência com voting, knobs por agente —, que é de
 * RITO, não de matéria. O que NÃO viaja é a prosa: medido em 22/09/2026, 144 dos
 * 161 marcadores da apelação cível carregam dispositivo, nome de peça ou o caso
 * fictício do squad. Copiá-la daria um modelo trabalhista falando de CPC 1.009 —
 * pior que um modelo vazio, porque parece pronto.
 *
 * Por isso o derivado nasce SEM `prosa.yaml`: fica `completo: false`, o chefe não
 * o escolhe, e é o Build que escreve a prosa da matéria. As skills da origem são
 * trocadas por marcações "A CONFERIR" com candidatas da área nova, buscadas no
 * catálogo instalado pelo PAPEL de cada agente — o motor não adivinha qual skill
 * trabalhista faz o papel de `apelacao-civel`, só mostra as que existem.
 */
export function derivarModelo(idOrigem, { cwd, id, area, peca, nome, descricao, polo, hoje, forcar = false, buscar = null, catalogoDeBestPractices = null, pacoteDaSkill = null, ramosPorSlug = null } = {}) {
  const idFinal = String(id || '').trim();
  if (!RE_ID.test(idFinal)) falha(`id de modelo «${idFinal}» inválido: minúsculas, dígitos e hífen (ex.: trab-recurso-ordinario)`);
  if (!area) falha('--derivar exige --area (a área do modelo novo): é o que decide as skills e o filtro do chefe');
  const origem = listarModelos(cwd).find((m) => m.id === idOrigem);
  if (!origem) falha(`modelo de origem «${idOrigem}» não existe em ${PASTA_DE_MODELOS}/ (disponíveis: ${listarModelos(cwd).map((m) => m.id).join(', ') || 'nenhum'})`);
  // O do escritório guarda só o que mudou sobre o modelo da área: derivar dele perderia essa
  // diferença em silêncio (revisão de desenho de 24/09/2026, G). Deriva-se do modelo da área.
  if (ehDoEscritorio(origem)) falha(`«${idOrigem}» é modelo do escritório: derive do modelo da área${origem.base ? ` «${origem.base}»` : ''}`);
  if (!existsSync(join(origem.dir, 'design.yaml'))) falha(`o modelo «${idOrigem}» não tem design.yaml: nada a derivar`);
  const destino = join(cwd, PASTA_DE_MODELOS, idFinal);
  if (existsSync(destino) && !forcar) falha(`${PASTA_DE_MODELOS}/${idFinal}/ já existe; use --forcar para regravar`);

  const designBruto = readFileSync(join(origem.dir, 'design.yaml'), 'utf8');
  const design = lerYaml(join(origem.dir, 'design.yaml'), `${idOrigem}/design.yaml`);
  const pecaFinal = String(peca || design?.squad?.peca || '').trim();
  const pecaOrigem = String(design?.squad?.peca || '').trim();

  // A consulta é o PAPEL do agente mais a peça nova — nunca o nome da skill antiga,
  // que carrega o ramo de origem ("calculadora-prazo-civel") e traz de volta as
  // civis. Candidata que casa com a área vem primeiro; a que não casa fica marcada.
  const achar = buscar || ((consulta) => searchSkillCatalog(consulta, cwd, { area, limit: 6 }));
  // Skill do PACOTE da área nova fica: derivar dentro da mesma área (memoriais da resposta à
  // acusação, execução de alimentos da inicial cível) marcava como "de outra área" skills do
  // próprio pacote, só porque o texto da área mudou ("direito civil e do consumidor" ×
  // "direito civil (família)"). Medido em 22/09/2026 em três derivações. O que decide é o
  // pacote que trouxe a skill, casado com a área nova pelos ramos do curador; sem depósito
  // (ou skill do usuário), a skill é marcada, como antes.
  const deposito = ligacaoDoProjeto(cwd)?.deposito;
  const ramos = ramosPorSlug ?? ramosDoDeposito(deposito);
  const mapaDePacotes = pacoteDaSkill || !deposito ? null : skillsDoDeposito(deposito);
  const pacoteDe = pacoteDaSkill || ((skill) => mapaDePacotes?.get(skill) || null);
  const daAreaNova = (skill) => {
    const pack = pacoteDe(skill);
    if (!pack) return false;
    if (pack === 'transversal') return true;
    const slug = slugDoPack(pack);
    return Boolean(slug && casaArea(slug, area, ramos[slug]));
  };
  const termosDaPeca = pecaFinal.replace(/-/g, ' ');
  const sugestoes = [];
  let skillsDaOrigem = 0;
  for (const agente of lista(design?.agents)) {
    const skills = lista(agente?.skills).map(String).filter((s) => !daAreaNova(s));
    if (!skills.length) continue;
    skillsDaOrigem += skills.length;
    const papel = [agente?.role_summary, agente?.role, agente?.title, agente?.brief].map((x) => String(x || '').trim()).filter(Boolean).join(' ').slice(0, 240);
    const consulta = `${papel} ${termosDaPeca}`.trim() || termosDaPeca;
    let achado;
    try { achado = achar(consulta); } catch { achado = null; }
    const candidatas = (achado?.results || []).filter((x) => !skills.includes(x.id));
    const ordenadas = [...candidatas.filter((x) => x.area_casou === true), ...candidatas.filter((x) => x.area_casou !== true)]
      .slice(0, 4)
      .map((x) => ({ id: x.id, score: Math.round(x.score * 10) / 10, area_casou: x.area_casou === true, lifecycle: x.lifecycle }));
    sugestoes.push({ agente: agente.id, papel: papel.slice(0, 80), da_origem: skills, candidatas: ordenadas });
  }
  const porSkill = new Map();
  for (const sug of sugestoes) for (const skill of sug.da_origem) porSkill.set(skill, sug);

  // As best-practices do design também são de ÁREA (`protocolo-operacional-direito-civil`):
  // trocar as skills e deixá-las passar entregaria um squad trabalhista operando pelo
  // protocolo civil. Aqui cada uma é conferida contra os catálogos INSTALADOS: a que
  // existe na área nova (ou é transversal, e vale em qualquer área) fica; a que só existe
  // na área de origem vira marcação, com as candidatas do catálogo da área nova.
  const catalogoDaArea = catalogoDeBestPractices || (() => {
    const todas = parseBestPracticesCatalogDir(defaultBestPracticesDir(cwd));
    return new Set(todas.map((e) => e.id));
  })();
  const bpsInstaladas = catalogoDaArea instanceof Set ? catalogoDaArea : new Set(catalogoDaArea);
  const slugDaArea = String(area).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const casaBp = (id) => { const m = /^protocolo-operacional-(.+)$/.exec(id); return Boolean(m && m[1] !== '_transversal' && casaArea(m[1], area, ramos[m[1]])); };
  const bpDaAreaNova = [...bpsInstaladas].filter((id) => id.includes(slugDaArea) || casaBp(id) || /^protocolo-operacional-_transversal$/.test(id));
  const bpsTrocadas = [];

  mkdirSync(destino, { recursive: true });
  // Skill de outra área num design COMPILA e passa no check-squad: o erro só
  // apareceria no run. Por isso cada uma vira comentário com o id de origem à
  // vista, e o design derivado não roda até alguém escolher.
  const saida = [];
  for (const linha of designBruto.split('\n')) {
    const mArea = /^(\s*)area:\s*.*$/.exec(linha);
    const mPeca = /^(\s*)peca:\s*.*$/.exec(linha);
    const mSkill = /^(\s*)-\s*"?([a-z0-9][a-z0-9_.-]*)"?\s*$/.exec(linha);
    if (mArea) { saida.push(`${mArea[1]}area: "${area}"`); continue; }
    if (mPeca && pecaFinal) { saida.push(`${mPeca[1]}peca: "${pecaFinal}"`); continue; }
    // O arquivo de saída leva o nome da peça (`output/apelacao-minuta.md`): derivado sem a
    // troca, o redator grava `apelacao-final.md` e a prosa nova lê `recurso-inominado-final.md`.
    // Achado duas vezes em 22/09/2026 (resposta à acusação com `contestacao-*`, recurso inominado).
    const mSaida = /^(\s*output_file:\s*"?output\/)([a-z0-9-]+)(-(?:minuta|final)\.md"?\s*)$/.exec(linha);
    if (mSaida && pecaOrigem && pecaFinal && mSaida[2] === pecaOrigem) { saida.push(`${mSaida[1]}${pecaFinal}${mSaida[3]}`); continue; }
    // `- "protocolo-operacional-direito-civil"` dentro de um bloco best_practices:
    // a linha é igual à de skill, então o que distingue é o bloco em que estamos.
    const mBp = /^(\s*)-\s*"?([a-z0-9][a-z0-9_.-]*)"?\s*$/.exec(linha);
    const emBloco = (() => {
      for (let i = saida.length - 1; i >= 0; i--) {
        const m = /^(\s*)([a-z_]+):\s*$/.exec(saida[i]);
        if (m) return m[2];
        if (/^\s*-\s/.test(saida[i]) || /^\s*#/.test(saida[i])) continue;
        if (/^\s*[a-z_]+:/.test(saida[i])) return null;
      }
      return null;
    })();
    if (mBp && emBloco === 'best_practices' && !bpsInstaladas.has(mBp[2])) {
      bpsTrocadas.push(mBp[2]);
      const props = bpDaAreaNova.length ? bpDaAreaNova.join(' | ') : 'a área não declara best-practice de matéria; só as transversais do catálogo';
      saida.push(`${mBp[1]}# A CONFERIR (era ${mBp[2]}, de outra área): ${props}`);
      continue;
    }
    if (mBp && emBloco === 'best_practices' && bpsInstaladas.has(mBp[2]) && !bpDaAreaNova.includes(mBp[2]) && /-(civel|civil|consumidor|penal|criminal|trabalho|previdenciario|tributario|administrativo|eleitoral)$/.test(mBp[2])) {
      bpsTrocadas.push(mBp[2]);
      const props = bpDaAreaNova.length ? bpDaAreaNova.join(' | ') : 'a área não declara best-practice de matéria';
      saida.push(`${mBp[1]}# A CONFERIR (era ${mBp[2]}, de outra área): ${props}`);
      continue;
    }
    const sug = mSkill && porSkill.get(mSkill[2]);
    if (sug) {
      const props = sug.candidatas.length
        ? sug.candidatas.map((c) => `${c.id}${c.area_casou ? '' : '?'}`).join(' | ')
        : 'nenhuma candidata na área: o Build escolhe, ou a skill precisa ser escrita';
      saida.push(`${mSkill[1]}# A CONFERIR (era ${mSkill[2]}, de outra área): ${props}`);
      continue;
    }
    saida.push(linha);
  }
  // O texto do design é MATÉRIA e não viaja: `goal`, `success_criteria`, `name`,
  // `description`, `title`, `role_summary` e `brief` da origem falam da peça de lá
  // (medido em 22/09/2026: o derivado criminal nascia com meta de contestação cível,
  // CPC 337 e CPC 341 nos critérios). O `check-squad` não reclama — é prosa válida —,
  // então o squad sairia pronto e errado. Cada campo recebe a marca, que é feia de
  // propósito: quem a vir na peça sabe que o Build não passou por ali.
  const MARCA = '[REESCREVER PARA A ÁREA]';
  // `research_brief` é bloco literal (`|`) e o mais denso de matéria do design inteiro:
  // 57 linhas com dispositivo, skill de área e framework do ramo de origem (medido no
  // primeiro derivado criminal, que virou `research-brief.md` falando de CPC 337 dentro
  // de um squad de resposta à acusação). Marca na PRIMEIRA linha do bloco, que é onde
  // quem abre o arquivo lê.
  const RE_BLOCO_LITERAL = /^(\s*)(research_brief|domain_framework):\s*\|\s*$/;
  // `- name:` de item de lista (as tasks de um agente) também é matéria, e vira NOME DE
  // ARQUIVO no squad compilado: `preliminares-337.md` dentro de um squad criminal (medido
  // ao derivar a resposta à acusação). O `- ` opcional cobre os dois casos.
  const CAMPOS_DE_MATERIA = /^(\s*)(?:- )?(name|description|goal|title|role_summary|brief):\s*("?)(.*?)("?)\s*$/;
  let camposMarcados = 0;
  const comTexto = [];
  let emCriterios = false;
  let blocoLiteral = null;
  for (const linha of saida) {
    const mBloco = RE_BLOCO_LITERAL.exec(linha);
    if (mBloco) { blocoLiteral = mBloco[1].length; comTexto.push(linha); continue; }
    if (blocoLiteral !== null) {
      const indent = /^(\s*)\S/.exec(linha);
      if (linha.trim() && indent && indent[1].length > blocoLiteral) {
        // primeira linha do miolo: leva a marca; o resto do bloco fica como está
        camposMarcados++;
        comTexto.push(`${indent[1]}${MARCA} ${linha.trim()}`);
        blocoLiteral = null;
        continue;
      }
      if (linha.trim()) blocoLiteral = null;
    }
    const mCrit = /^(\s*)success_criteria:\s*$/.exec(linha);
    if (mCrit) { emCriterios = true; comTexto.push(linha); continue; }
    if (emCriterios) {
      const mItem = /^(\s*)-\s+"(.*)"\s*$/.exec(linha);
      if (mItem) { camposMarcados++; comTexto.push(`${mItem[1]}- "${MARCA} ${mItem[2]}"`); continue; }
      if (!/^\s*(-|#)/.test(linha)) emCriterios = false;
    }
    const m = CAMPOS_DE_MATERIA.exec(linha);
    // `code` e ids não são texto; `name` de agente é nome próprio e o Build o troca junto.
    if (m && m[4] && !m[4].startsWith(MARCA) && !/^\{code\}$/.test(m[4])) {
      camposMarcados++;
      const prefixo = /^\s*- /.test(linha) ? '- ' : '';
      comTexto.push(`${m[1]}${prefixo}${m[2]}: "${MARCA} ${m[4].replace(/^"|"$/g, '')}"`);
      continue;
    }
    comTexto.push(linha);
  }
  // Registros da Discovery e do Design da ORIGEM: `catalog_decisions` justifica, uma
  // a uma, as escolhas de skill que acabaram de ser trocadas ("calculadora-prazo-civel:
  // motor determinístico em dias úteis, CPC 219"); `lexico_sugerido`, `gaps_declarados`
  // e `best_practices_consulted` registram o que aquela área consultou. Mantê-los faz o
  // design derivado AFIRMAR algo falso sobre si. Saem zerados, com o motivo escrito.
  const DESCARTADOS = ['catalog_decisions', 'lexico_sugerido', 'gaps_declarados', 'best_practices_consulted'];
  const semRegistrosDaOrigem = [];
  let pulando = null;
  for (const linha of comTexto) {
    const mChave = /^([a-z_]+):/.exec(linha);
    if (mChave) pulando = DESCARTADOS.includes(mChave[1]) ? mChave[1] : null;
    if (pulando) {
      if (mChave) {
        semRegistrosDaOrigem.push(`# ${pulando}: descartado na derivação (era da área de origem; a Discovery desta área o reescreve)`);
        semRegistrosDaOrigem.push(`${pulando}: []`);
      }
      continue;
    }
    semRegistrosDaOrigem.push(linha);
  }
  writeFileSync(join(destino, 'design.yaml'), `${semRegistrosDaOrigem.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
  // O `discovery.yaml` NÃO é copiado, pela mesma razão que a prosa não é: ele é matéria da área de
  // origem inteira (propósito, contexto, consultas de pesquisa, vocabulário), sem um único campo
  // aproveitável na área nova. Copiado intacto, entrava mudo no modelo derivado e ainda valia como
  // fonte de especialistas para o `squad-check` — matéria da área errada atravessando a fronteira
  // em silêncio, que é o defeito que a derivação existe para não cometer. Quem deriva roda a
  // Discovery da área nova, ou escreve o brief no `research_brief` do design.

  const meta = {
    id: idFinal,
    nome: nome || `${origem.meta?.nome || idOrigem} (${area})`,
    descricao: descricao || '',
    area: String(area),
    peca: pecaFinal || null,
    polo: polo || origem.meta?.polo || null,
    versao: hoje || new Date().toISOString().slice(0, 10),
    derivado_de: { modelo: idOrigem, area: origem.meta?.area || null, em: hoje || new Date().toISOString().slice(0, 10) },
    provas: { check_squad: null, prosa: null, run: null, revisao_do_curador: null },
  };
  const cabecalho = `# Squad-modelo DERIVADO: o esqueleto veio de «${idOrigem}»; a matéria é desta área.\n`
    + '# FALTA, antes de publicar: (1) prosa.yaml, escrito pelo Build sobre este design;\n'
    + '# (2) as skills marcadas "A CONFERIR" no design.yaml; (3) gatilhos, nao_use_para,\n'
    + '# pedidos_exemplo e pedidos_fora; (4) um run medido para provas.run.\n'
    + '# Sem prosa.yaml o modelo fica incompleto de propósito e o chefe não o escolhe.\n';
  writeFileSync(join(destino, 'modelo.yaml'), `${cabecalho}${emitirYaml(meta)}\n`, 'utf8');
  return { id: idFinal, dir: destino, origem: idOrigem, area: String(area), peca: pecaFinal || null, sugestoes, skills_da_origem: skillsDaOrigem, best_practices_trocadas: [...new Set(bpsTrocadas)], best_practices_da_area: bpDaAreaNova, campos_a_reescrever: camposMarcados };
}
