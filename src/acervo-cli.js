// CLI do acervo (SPEC §9.1): `sync`, `status`, `packs`.
//
// Camada fina de propósito — a decisão está em `acervo-sync.js` (puro), o
// estado em `acervo-estado.js`, e a verificação/aplicação em `pack-format.js`/
// `pack-apply.js` (já prontos e testados antes de existir servidor nenhum).
// Aqui só ficam a rede, a impressão e o wiring.
import { createPublicKey } from 'node:crypto';
import { lerEstado, gravarEstado } from './acervo-estado.js';
import { planejarSync, executarSync } from './acervo-sync.js';
import { baixar } from './acervo-transport.js';
import { decodeEntity, verificarPacote } from './pack-format.js';
import { aplicarPacote } from './pack-apply.js';
import { gravarAreasDeAcervo, resolverConfigDeAcervo } from './acervo-config.js';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname as dirnameDe, join } from 'node:path';
import { discoverSkillCatalog, gravarIndiceDeSkills } from './skill-catalog.js';
import {
  ehProjeto, ligacaoDoProjeto, ligarDeposito, raizDoDeposito, reindexarAcervoDoProjeto, descreverIndiceDoAcervo,
  packLigavel, slugDoPack, normalizarSlugDeArea, mesmasAreas, PACKS_SEMPRE_LIGADOS, ramosDoDeposito,
  registrarPack, removerPack, carimboDoDeposito, indexarPackNoDeposito, packsDeAcervoSemIndice, packIdSeguro, arquivosDoDeposito, alteradosNoDeposito,
} from './deposito.js';

/**
 * Reindexa `skills/_index.yaml` depois de um sync que instalou pacote.
 *
 * O índice é a fonte de verdade do Arquiteto, do Sherlock e do catalog-scout
 * (é o que o cabeçalho dele diz), e `update` o regenera — mas `sync`, que é
 * quem de fato muda o conjunto de skills numa instalação de aluno, não
 * regenerava nada. Medido numa instalação limpa (03/09/2026): 6.584 skills em
 * disco e "Última indexação determinística: 0 skills" no índice. A busca
 * revarre os SKILL.md a cada consulta e por isso funciona, mas perde a
 * substância medida (que só existe no índice) e o Arquiteto parte de um
 * catálogo que diz "zero".
 *
 * Só o índice: a validação do catálogo (`check-skills`) continua um comando à
 * parte — ela acusa referência quebrada de conteúdo de curador, e isso não é
 * motivo para o sync falar mais alto do que "instalei".
 */
function reindexarSkills(targetDir) {
  const skillsDir = join(targetDir, 'skills');
  if (!existsSync(skillsDir)) return null;
  const catalog = discoverSkillCatalog(skillsDir);
  gravarIndiceDeSkills(skillsDir, catalog);
  return catalog.entries.length;
}

/**
 * Verifica um pacote contra o anel de chaves públicas, escolhendo pelo
 * `signing_kid` do manifesto. Sem kid, tenta cada chave — os pacotes de
 * 2026.08.14 foram construídos sem `--kid`. Kid desconhecido é recusa com a
 * causa certa: o motor está atrasado, não o pacote adulterado.
 */
export function verificarComAnel(manifesto, entidades, anel) {
  const kid = manifesto?.signing_kid ?? null;
  if (kid !== null) {
    const chave = anel.get(kid);
    if (!chave) {
      return {
        ok: false,
        problemas: [`pacote assinado com a chave "${kid}", que esta versão do motor não conhece; atualize o LegalSquad (npm i -g github:bbpropulse/legalsquad-nucleo) e rode o sync de novo`],
      };
    }
    return verificarPacote(manifesto, entidades, chave);
  }
  let ultimo = { ok: false, problemas: ['anel de chaves vazio'] };
  for (const chave of anel.values()) {
    ultimo = verificarPacote(manifesto, entidades, chave);
    if (ultimo.ok) return ultimo;
  }
  return ultimo;
}

function idade(sincronizadoEm, agora) {
  if (!sincronizadoEm) return null;
  const dias = Math.floor((agora - Date.parse(sincronizadoEm)) / 86_400_000);
  return Number.isFinite(dias) ? dias : null;
}

/**
 * Projeto sincronizado por um motor anterior ao depósito guarda o próprio
 * `acervo/_packs/_manifest.json`, com os pacotes dentro do projeto. Isso não é
 * "nunca sincronizado": é conteúdo instalado no formato antigo, e a migração
 * (um `acervo sync` nesta máquina) o leva ao depósito e liga o projeto.
 */
function estadoLegadoDoProjeto(targetDir, deposito) {
  if (!ehProjeto(targetDir) || targetDir === deposito) return null;
  try {
    const legado = lerEstado(targetDir);
    return !legado.novo && Object.keys(legado.packs).length > 0 ? legado : null;
  } catch (erro) {
    // "Não sei ler" nunca vira "não existe": quem chama mostra o motivo.
    return { ilegivel: true, erro: erro.message, packs: {} };
  }
}

function imprimirEstado(estado, agora, deposito, targetDir, areas = null) {
  const legado = estadoLegadoDoProjeto(targetDir, deposito);
  if (legado?.ilegivel) console.error(`  ⚠️  manifesto antigo deste projeto ilegível: ${legado.erro}`);
  if (estado.novo) {
    if (legado && !legado.ilegivel) {
      console.log(`ACERVO:LEGADO ${Object.keys(legado.packs).length}`);
      console.log(`  Este projeto tem ${Object.keys(legado.packs).length} pacote(s) instalados no formato antigo (dentro do projeto), sincronizados em ${legado.sincronizado_em || 'data desconhecida'}.`);
      console.log(`  O depósito desta máquina (${deposito}) ainda está vazio: rode \`acervo sync\` uma vez para levá-los ao depósito e ligar este projeto.`);
      for (const [packId, versao] of Object.entries(legado.packs).sort()) console.log(`  - ${packId}@${versao} (no projeto)`);
      return;
    }
    console.log('ACERVO:NUNCA-SINCRONIZADO');
    console.log(`  Nenhum pacote no depósito desta máquina (${deposito}). Rode \`acervo sync\` uma vez; todo projeto é ligado a ele.`);
    return;
  }
  const dias = idade(estado.sincronizado_em, agora);
  console.log(`ACERVO:${Object.keys(estado.packs).length}`);
  console.log(`  depósito da máquina: ${deposito}`);
  if (ehProjeto(targetDir)) {
    const ligacao = ligacaoDoProjeto(targetDir);
    if (!ligacao) {
      console.log(legado && !legado.ilegivel
        ? '  este projeto: AINDA NÃO LIGADO (tem pacotes no formato antigo): rode `acervo ligar` para trocá-los pelo depósito'
        : '  este projeto: AINDA NÃO LIGADO: rode `acervo ligar` (ou `legalsquad update`)');
    } else if (ligacao.carimbo !== carimboDoDeposito(deposito, estado)) {
      console.log(`  este projeto: DEFASADO: ligado em ${ligacao.ligado_em}, mas o depósito mudou desde então; rode \`acervo ligar\``);
    } else if (!mesmasAreas(ligacao.areas || null, areas)) {
      console.log(`  este projeto: DEFASADO: as áreas escolhidas mudaram desde a ligação; rode \`acervo ligar\``);
    } else {
      console.log(`  este projeto: ligado em ${ligacao.ligado_em} (${ligacao.modo}), em dia com o depósito`);
    }
    console.log(`  áreas ligadas: ${descreverAreas(areas, estado, ramosDoDeposito(deposito))}`);
  }
  if (dias !== null) {
    // O selo de frescor do §9.4. Sem ele, cache velho é indistinguível de cache
    // fresco — e num acervo jurídico isso é a diferença entre citar o precedente
    // vigente e citar o superado.
    console.log(`  último sync há ${dias} dia(s)${dias > 30 ? ', DESATUALIZADO' : ''}`);
  }
  for (const [packId, versao] of Object.entries(estado.packs).sort()) {
    console.log(`  - ${packId}@${versao}`);
  }
  const alterados = alteradosNoDeposito(deposito);
  if (alterados.length) {
    console.log(`  ⚠️  DEPÓSITO ALTERADO POR DENTRO: ${alterados.length} arquivo(s) não são o que o pacote publicou (alguém editou o arquivo ligado, e a edição vale para todos os projetos desta máquina):`);
    for (const p of alterados.slice(0, 10)) console.log(`     ${p}`);
    console.log('     Personalização de skill vai em SKILL.local.md (nunca dê permissão de escrita a arquivo de skills/). Para restaurar o do pacote, rode `acervo sync`.');
  }
}

/**
 * A licença vai no header `Authorization`, NUNCA na query string: query
 * string entra em log de acesso, de proxy e de CDN, e um identificador de
 * assinante nesses logs é rastreamento gratuito de quem paga.
 */
async function buscarCatalogo(url, license) {
  const resposta = await fetch(url, {
    headers: license ? { authorization: `Bearer ${license}` } : {},
  });
  if (!resposta.ok) {
    throw new Error(`GET ${url} devolveu HTTP ${resposta.status}`);
  }
  return resposta.json();
}

/** `arquivos` que `aplicarPacote` espera: os registros DECODIFICADOS das entidades de conteúdo. */
function arquivosDoConteudo(entidades) {
  return entidades
    .filter((entidade) => entidade.role === 'content')
    .flatMap((entidade) => decodeEntity(entidade.buffer));
}

function imprimirResultadoDoSync(resultado) {
  console.log(`ACERVO:SYNC ${resultado.aplicados.length} aplicado(s), ${resultado.recusados.length} recusado(s)`);
  for (const packId of resultado.aplicados) console.log(`  - ${packId} instalado`);
  for (const { pack_id: packId, motivo } of resultado.recusados) console.error(`  · ${packId} recusado: ${motivo}`);
  for (const packId of resultado.revogados) console.log(`  - ${packId} removido (revogado)`);

  // Despublicado é informação, não ação: os arquivos ficam e o usuário decide.
  // Silenciar faria o pacote sumir do `status` sem explicação — some da lista e
  // ninguém sabe por quê, que é a pior forma de comunicar uma mudança.
  for (const packId of resultado.despublicados || []) {
    console.log(`  - ${packId} saiu do catálogo (despublicado); o que já estava no disco foi mantido`);
  }
}

/**
 * Liga o projeto ao depósito e regera o índice de skills DELE (o índice é por
 * projeto: cobre o que veio do depósito mais o que o usuário criou ali).
 */
function ligarEIndexar(targetDir, deposito, { forcar = false, estado = null, areas = null } = {}) {
  const ligacao = ligarDeposito(targetDir, { deposito, forcar, estado, areas });
  for (const aviso of ligacao.avisos) console.error(`  ⚠️  ${aviso}`);
  if (ligacao.vazio) {
    console.error(`  ⚠️  o depósito (${deposito}) não tem registro de arquivos: nada foi ligado. Rode \`acervo sync\` (ele refaz os registros).`);
    return { ligacao, skillsIndexadas: null, acervoIndexado: null };
  }
  console.log(ligacao.pulado ? '  projeto já em dia com o depósito (nada a ligar)' : `  projeto ligado ao depósito: ${descreverLigacao(ligacao)}`);
  let skillsIndexadas = null;
  let acervoIndexado = null;
  // Cada índice só é refeito quando a SUA subárvore mudou: 7 mil SKILL.md não
  // são reparseados por causa de um pacote de julgados.
  if (ligacao.tocados['skills/'] > 0) {
    skillsIndexadas = reindexarSkills(targetDir);
    if (skillsIndexadas !== null) console.log(`  índice de skills regerado: ${skillsIndexadas} skills`);
  }
  if (ligacao.tocados['acervo/_packs/'] > 0) {
    acervoIndexado = reindexarAcervoDoProjeto(targetDir);
    if (acervoIndexado?.ok) console.log(`  índice do acervo regerado: ${descreverIndiceDoAcervo(acervoIndexado)}`);
    else if (acervoIndexado) console.error(`  ⚠️  índice do acervo não regerado: ${acervoIndexado.erro}. Rode \`npm run indexar-acervo\`.`);
  }
  return { ligacao, skillsIndexadas, acervoIndexado };
}

/**
 * Refaz no depósito os índices de pacote ausentes ou gerados por outro
 * indexador (`packsDeAcervoSemIndice`), uma vez por máquina, sob a trava do
 * sync (`travar: false` quando quem chama já a tem). Trava ocupada não é erro
 * de quem liga: devolve `erro` e a ligação segue com o índice que existe.
 */
export function regerarIndicesDefasados(deposito, { travar = true } = {}) {
  const pendentes = packsDeAcervoSemIndice(deposito);
  if (pendentes.length === 0) return { refeitos: 0, pendentes: 0 };
  let trava = null;
  if (travar) {
    trava = travarSync(deposito);
    if (!trava.ok) return { refeitos: 0, pendentes: pendentes.length, erro: trava.motivo };
  }
  let refeitos = 0;
  try {
    for (const packId of pendentes) {
      const indice = indexarPackNoDeposito(deposito, packId);
      if (indice?.ok) {
        refeitos++;
        console.log(`  - ${packId}: ${indice.arquivos} julgado(s) indexados no depósito`);
      } else if (indice) {
        console.error(`  ⚠️  ${packId}: índice não gerado (${indice.erro}); a busca cai no índice do projeto`);
      }
    }
  } finally {
    trava?.soltar();
  }
  return { refeitos, pendentes: pendentes.length };
}

/** Uma linha com o que a ligação fez (init/update e o CLI imprimem a mesma). */
export function descreverLigacao(ligacao) {
  const partes = [`${ligacao.ligados} link(s)`, `${ligacao.copiados} cópia(s)`, `${ligacao.mantidos} já em dia`];
  if (ligacao.atualizados) partes.push(`${ligacao.atualizados} atualizado(s)`);
  if (ligacao.preservados) partes.push(`${ligacao.preservados} preservado(s) em .bak`);
  if (ligacao.podados) partes.push(`${ligacao.podados} removido(s) (saíram dos pacotes ou pacote revogado)`);
  if (ligacao.desligados) partes.push(`${ligacao.desligados} desligado(s) (fora das áreas escolhidas)`);
  if (ligacao.erros) partes.push(`${ligacao.erros} com erro`);
  if (ligacao.areas) partes.push(`áreas: ${ligacao.areas.join(', ')} (${ligacao.packsLigados} de ${ligacao.packs} pacotes)`);
  return partes.join(', ');
}

/** Como o `status` descreve a seleção de áreas do projeto. */
export function descreverAreas(areas, estado, ramos = {}) {
  const ids = Object.keys(estado?.packs || {});
  if (!areas) return `todas as áreas (${ids.length} pacote(s))`;
  const ligados = ids.filter((id) => packLigavel(id, areas, ramos));
  return `${areas.join(', ')} (${ligados.length} de ${ids.length} pacote(s); sempre: ${[...PACKS_SEMPRE_LIGADOS].filter((id) => ids.includes(id)).join(', ') || 'nenhum'})`;
}

/** Áreas disponíveis no depósito, com o que cada uma traz, para o `acervo areas` listar. */
export function areasDoDeposito(estado, registros) {
  const porSlug = new Map();
  for (const packId of Object.keys(estado?.packs || {})) {
    const slug = slugDoPack(packId);
    if (!slug || PACKS_SEMPRE_LIGADOS.has(packId)) continue;
    if (!porSlug.has(slug)) porSlug.set(slug, { slug, packs: [], skills: 0, julgados: 0 });
    porSlug.get(slug).packs.push(packId);
  }
  if (registros) {
    for (const [path, info] of registros) {
      const slug = slugDoPack(info.pack_id);
      const area = slug && porSlug.get(slug);
      if (!area) continue;
      if (/^skills\/[^_/][^/]*\/SKILL\.md$/.test(path)) area.skills++;
      else if (/^acervo\/_packs\/[^/]+\/jurisprudencia\/.*\.md$/.test(path)) area.julgados++;
    }
  }
  return [...porSlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Trava do sync no depósito: dois syncs ao mesmo tempo (duas sessões, dois
 * projetos) escreveriam os mesmos temporários e derrubariam um ao outro. Trava
 * com mais de duas horas é resto de processo morto e é quebrada.
 */
const IDADE_MAXIMA_DA_TRAVA_MS = 2 * 60 * 60 * 1000;
function processoVivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (erro) {
    return erro?.code === 'EPERM'; // existe, mas é de outro usuário
  }
}
export function travarSync(deposito, { processoVivoFn = processoVivo } = {}) {
  const caminho = join(deposito, 'acervo', '_packs', '.sync.lock');
  mkdirSync(join(deposito, 'acervo', '_packs'), { recursive: true });
  const soltar = () => rmSync(caminho, { force: true });
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      const fd = openSync(caminho, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, em: new Date().toISOString() }));
      closeSync(fd);
      // Ctrl+C (ou kill da IDE) não passa pelo `finally`: a trava sairia com
      // o processo morto e bloquearia a máquina por duas horas.
      const aoSinal = (sinal) => { soltar(); process.exit(sinal === 'SIGINT' ? 130 : 143); };
      process.once('SIGINT', aoSinal);
      process.once('SIGTERM', aoSinal);
      return {
        ok: true,
        soltar: () => { process.off('SIGINT', aoSinal); process.off('SIGTERM', aoSinal); soltar(); },
      };
    } catch (erro) {
      if (erro?.code !== 'EEXIST') throw erro;
      let dono = null;
      let idade = 0;
      try {
        idade = Date.now() - statSync(caminho).mtimeMs;
        dono = JSON.parse(readFileSync(caminho, 'utf8'));
      } catch { /* trava sem dono legível: decide pela idade */ }
      // Trava de processo morto ou velha demais é resto, não sync em andamento.
      if ((dono?.pid && !processoVivoFn(dono.pid)) || idade > IDADE_MAXIMA_DA_TRAVA_MS) { soltar(); continue; }
      return { ok: false, motivo: `outro sync está em andamento neste depósito há ${Math.round(idade / 60000)} min (pid ${dono?.pid ?? '?'}, ${caminho}); aguarde` };
    }
  }
  return { ok: false, motivo: 'não consegui obter a trava do sync' };
}

export async function acervoCli(sub, targetDir, values = {}, agora = Date.now()) {
  // O sync grava no depósito da máquina; o projeto atual é ligado a ele em
  // seguida. `values.deposito` (testes) e LEGALSQUAD_DEPOSITO sobrepõem o
  // padrão; sem eles, a identidade do catálogo do projeto escolhe a pasta.
  let config = null;
  try {
    config = resolverConfigDeAcervo(targetDir);
  } catch (erro) {
    if (sub === 'sync') {
      console.error(`ACERVO:BLOQUEADO: ${erro.message}`);
      return { success: false, error: { code: 'config-ilegivel', message: erro.message } };
    }
    // status/ligar não dependem da config: avisam e seguem com o depósito padrão.
    console.error(`  ⚠️  acervo.json ilegível (${erro.message}); usando o depósito padrão`);
  }
  const deposito = values.deposito || raizDoDeposito({ config: config?.ok ? config : null });
  let estado;
  try {
    estado = lerEstado(deposito);
  } catch (erro) {
    // Estado ilegível para o comando. Seguir com "vazio" mandaria o sync
    // rebaixar tudo e perder o rastro do que está no disco.
    console.error(`ACERVO:BLOQUEADO: ${erro.message}`);
    return { success: false, error: { code: 'estado-ilegivel', message: erro.message } };
  }

  const areas = config?.ok ? config.areas : null;

  if (sub === 'status' || sub === 'packs') {
    imprimirEstado(estado, agora, deposito, targetDir, areas);
    return { success: true, estado, deposito, areas };
  }

  if (sub === 'areas') {
    if (!ehProjeto(targetDir)) {
      console.error('ACERVO:BLOQUEADO: esta pasta não é um projeto LegalSquad (sem `_legalsquad/`).');
      return { success: false, error: { code: 'fora-de-projeto', message: targetDir } };
    }
    const pedidas = (values.positionais || []).map(String).filter(Boolean);
    if (pedidas.length === 0 && !values.todas) {
      // Listar: o que há no depósito, o que este projeto liga.
      const registros = arquivosDoDeposito(deposito);
      const lista = areasDoDeposito(estado, registros);
      console.log(`ACERVO:AREAS ${lista.length}`);
      console.log(`  este projeto liga: ${descreverAreas(areas, estado, ramosDoDeposito(deposito))}`);
      for (const a of lista) {
        const ligada = packLigavel(a.packs[0], areas, ramosDoDeposito(deposito));
        console.log(`  ${ligada ? '●' : '○'} ${a.slug}: ${a.skills} skill(s), ${a.julgados} julgado(s) [${a.packs.join(', ')}]`);
      }
      console.log('  `acervo areas <área> [<área>…]` escolhe (e religa sem rede); `acervo areas --todas` volta a ligar tudo.');
      return { success: true, areas, disponiveis: lista };
    }
    if (estado.novo) {
      console.error(`ACERVO:BLOQUEADO: o depósito desta máquina está vazio (${deposito}). Rode \`acervo sync\` primeiro.`);
      return { success: false, error: { code: 'deposito-vazio', message: deposito } };
    }
    let escolhidas = null;
    if (!values.todas) {
      const disponiveis = areasDoDeposito(estado, null).map((a) => a.slug);
      const ramos = ramosDoDeposito(deposito);
      const desconhecidas = pedidas.filter((p) => !disponiveis.some((slug) => packLigavel(`area.${slug}`, [p], ramos)));
      if (desconhecidas.length) {
        console.error(`ACERVO:BLOQUEADO: área(s) desconhecida(s) no depósito: ${desconhecidas.join(', ')}. Disponíveis: ${disponiveis.join(', ')}`);
        return { success: false, error: { code: 'area-desconhecida', message: desconhecidas.join(', ') } };
      }
      escolhidas = [...new Set(pedidas.map(normalizarSlugDeArea))];
    }
    const { caminho, conteudo } = gravarAreasDeAcervo(targetDir, escolhidas);
    mkdirSync(dirnameDe(caminho), { recursive: true });
    writeFileSync(caminho, conteudo, 'utf8');
    console.log(`  áreas deste projeto: ${descreverAreas(escolhidas, estado, ramosDoDeposito(deposito))}`);
    const { ligacao, skillsIndexadas, acervoIndexado } = ligarEIndexar(targetDir, deposito, { forcar: true, estado, areas: escolhidas });
    return { success: true, areas: escolhidas, ligacao, skillsIndexadas, acervoIndexado };
  }

  if (sub === 'ligar') {
    if (!ehProjeto(targetDir)) {
      console.error('ACERVO:BLOQUEADO: esta pasta não é um projeto LegalSquad (sem `_legalsquad/`).');
      return { success: false, error: { code: 'fora-de-projeto', message: targetDir } };
    }
    if (estado.novo) {
      const legado = estadoLegadoDoProjeto(targetDir, deposito);
      console.error(legado
        ? `ACERVO:BLOQUEADO: este projeto tem ${Object.keys(legado.packs).length} pacote(s) no formato antigo e o depósito desta máquina ainda está vazio (${deposito}). Rode \`acervo sync\` uma vez para migrá-los.`
        : `ACERVO:BLOQUEADO: o depósito desta máquina está vazio (${deposito}). Rode \`acervo sync\` primeiro.`);
      return { success: false, error: { code: legado ? 'deposito-vazio-com-legado' : 'deposito-vazio', message: deposito } };
    }
    // Índices de pacote de um indexador anterior são refeitos antes de ligar,
    // para o projeto receber o formato que a busca deste motor lê.
    const indices = regerarIndicesDefasados(deposito);
    if (indices.erro) console.error(`  ⚠️  índices do depósito não atualizados: ${indices.erro}`);
    const { ligacao, skillsIndexadas, acervoIndexado } = ligarEIndexar(targetDir, deposito, { forcar: true, estado, areas });
    return { success: true, deposito, ligacao, skillsIndexadas, acervoIndexado };
  }

  if (sub !== 'sync') {
    console.error(`ACERVO:BLOQUEADO: subcomando desconhecido "${sub}". Use sync, ligar, status ou packs.`);
    return { success: false, error: { code: 'subcomando-desconhecido', message: String(sub) } };
  }

  if (!config.ok) {
    // Fail-closed com o motivo verdadeiro. URL, chave pública e token de acesso
    // vêm embarcados, e o acesso é aberto — então licença NÃO chega mais aqui.
    // O que sobra é a autenticidade: uma chave pública própria que o usuário
    // declarou e está ilegível. Verificar assinatura continua inegociável.
    console.error(`ACERVO:BLOQUEADO: ${config.motivo}`);
    return { success: false, error: { code: 'config-incompleta', message: config.motivo } };
  }

  let anel;
  try {
    anel = new Map(Object.entries(config.chavesPublicas).map(([kid, pem]) => [kid, createPublicKey(pem)]));
  } catch (erro) {
    console.error(`ACERVO:BLOQUEADO: chave pública inválida: ${erro.message}`);
    return { success: false, error: { code: 'chave-publica-invalida', message: erro.message } };
  }

  let catalogo;
  try {
    catalogo = await buscarCatalogo(config.catalogUrl, config.license);
  } catch (erro) {
    console.error(`ACERVO:BLOQUEADO: catálogo inacessível: ${erro.message}`);
    return { success: false, error: { code: 'catalogo-inacessivel', message: erro.message } };
  }

  // `pack_id` vira caminho no depósito (registro, pasta do pacote, remoção):
  // só um segmento simples passa. O resto é recusado com nome, não ignorado.
  const idsRecusados = [];
  const soSeguros = (lista) => (lista || []).filter((p) => { const id = typeof p === 'string' ? p : p?.pack_id; if (packIdSeguro(id)) return true; idsRecusados.push(id); return false; });
  catalogo = { ...catalogo, packs: soSeguros(catalogo.packs), revoked: soSeguros(catalogo.revoked) };
  for (const id of idsRecusados) console.error(`  · pacote recusado: pack_id inválido no catálogo: ${JSON.stringify(id)}`);

  // A trava vem ANTES de ler o estado e planejar: um sync que planejasse sobre
  // o estado velho e só depois travasse reaplicaria tudo o que o anterior fez.
  const trava = travarSync(deposito);
  if (!trava.ok) {
    console.error(`ACERVO:BLOQUEADO: ${trava.motivo}`);
    return { success: false, error: { code: 'sync-em-andamento', message: trava.motivo } };
  }
  try {
    estado = lerEstado(deposito);
  } catch (erro) {
    trava.soltar();
    console.error(`ACERVO:BLOQUEADO: ${erro.message}`);
    return { success: false, error: { code: 'estado-ilegivel', message: erro.message } };
  }
  // Depósito com estado mas sem registro de arquivos (versão anterior a esta):
  // os projetos não conseguem ligar nada dele. Reaplicar tudo refaz os registros.
  let semRegistros = false;
  if (!estado.novo && !arquivosDoDeposito(deposito)) {
    semRegistros = true;
    console.log('  depósito sem registro de arquivos (formato anterior): reaplicando todos os pacotes para refazer os registros');
    estado = { packs: {}, sincronizado_em: null, novo: true };
  }

  // Migração: o projeto tinha os pacotes dentro de si (motor anterior) e o
  // depósito está vazio. O plano parte do depósito (vazio: baixa tudo), mas o
  // conteúdo é pedido por inteiro, porque o projeto o tinha; depois da ligação
  // o manifesto antigo é arquivado para o `status` parar de vê-lo como legado.
  const legado = estado.novo ? estadoLegadoDoProjeto(targetDir, deposito) : null;
  if (legado?.ilegivel) console.error(`  ⚠️  manifesto antigo deste projeto ilegível: ${legado.erro}; a migração não pode contar com ele`);
  else if (legado) console.log(`  migrando ${Object.keys(legado.packs).length} pacote(s) do formato antigo (dentro do projeto) para o depósito da máquina`);

  const plano = planejarSync(catalogo, estado, { incluirConteudo: values.content === true || Boolean(legado && !legado.ilegivel) || semRegistros });
  if (!plano.ok) {
    trava.soltar();
    console.error(`ACERVO:BLOQUEADO: ${plano.motivo}`);
    return { success: false, error: { code: 'plano-invalido', message: plano.motivo } };
  }

  let resultado;
  try {
    resultado = await executarSync(plano, {
      baixar,
      verificar: (manifesto, entidades) => verificarComAnel(manifesto, entidades, anel),
      aplicar: (pack, manifesto, entidades) => {
        const arquivos = arquivosDoConteudo(entidades);
        const veredito = aplicarPacote(deposito, manifesto, arquivos, { somenteLeitura: true });
        if (!veredito.ok) throw new Error(veredito.problemas.join('; '));
        // O registro é o que diz aos projetos o que é do curador (e o que saiu).
        const reg = registrarPack(deposito, pack.pack_id, pack.latest, arquivos, { ramos: manifesto?.area?.ramos });
        // Dois pacotes com o mesmo caminho (squad-modelo de áreas diferentes com
        // o mesmo id, p.ex.): quem aplicou por último venceu. O arquivo já está
        // no disco; o que não pode é isso passar calado.
        for (const c of (reg.colisoes || []).slice(0, 5)) console.error(`  ⚠️  ${pack.pack_id}: «${c}» também é declarado por outro pacote; o último aplicado vence (${c.startsWith('squads/_modelos/') ? 'renomeie o id do modelo na área' : c.startsWith('skills/') ? 'o mesmo id de skill em dois pacotes: o curador renomeia um deles' : 'o curador decide qual pacote é o dono do caminho'})`);
        if ((reg.colisoes || []).length > 5) console.error(`  ⚠️  ${pack.pack_id}: … e mais ${reg.colisoes.length - 5} caminho(s) em colisão`);
        // Julgados são indexados uma vez, aqui; os projetos só ligam o índice.
        const indice = indexarPackNoDeposito(deposito, pack.pack_id);
        if (indice?.ok) console.log(`  - ${pack.pack_id}: ${indice.arquivos} julgado(s) indexados no depósito`);
        else if (indice) console.error(`  ⚠️  ${pack.pack_id}: índice não gerado (${indice.erro}); a busca cai no índice do projeto`);
      },
    }, estado);
    // Depósito de uma versão anterior (sem índice de pacote) ou de um
    // indexador anterior (índice noutro formato): refaz aqui, já sob a trava.
    regerarIndicesDefasados(deposito, { travar: false });
    // Revogado sai do disco do depósito; os projetos podam pelo hash ao ligar.
    for (const packId of resultado.revogados || []) {
      const r = removerPack(deposito, packId);
      if (r.semRegistro) console.error(`  ⚠️  ${packId} revogado, mas sem registro de arquivos neste depósito: apague à mão o que restou dele`);
    }
    gravarEstado(deposito, resultado.estado, { sincronizadoEm: new Date(agora).toISOString() });
  } finally {
    trava.soltar();
  }
  imprimirResultadoDoSync(resultado);
  console.log(`  depósito da máquina: ${deposito}`);

  // Fora de um projeto (pasta qualquer), o sync só abastece o depósito.
  if (!ehProjeto(targetDir)) {
    console.log('  esta pasta não é um projeto: nada foi ligado. Nos projetos, `legalsquad update` ou `acervo ligar`.');
    return { success: true, ...resultado, deposito, ligacao: null, skillsIndexadas: null, acervoIndexado: null };
  }
  const { ligacao, skillsIndexadas, acervoIndexado } = ligarEIndexar(targetDir, deposito, { estado: resultado.estado, areas });
  if (legado && !legado.ilegivel && !ligacao.vazio) {
    const antigo = join(targetDir, 'acervo', '_packs', '_manifest.json');
    try { renameSync(antigo, `${antigo}.legado`); console.log('  manifesto antigo do projeto arquivado como _manifest.json.legado'); } catch { /* já não existe */ }
  }
  return { success: true, ...resultado, deposito, ligacao, skillsIndexadas, acervoIndexado, migrado: Boolean(legado && !legado.ilegivel) };
}

export { planejarSync, gravarEstado };
