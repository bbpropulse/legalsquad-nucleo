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
import { resolverConfigDeAcervo } from './acervo-config.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { discoverSkillCatalog, gravarIndiceDeSkills } from './skill-catalog.js';

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
        problemas: [`pacote assinado com a chave "${kid}", que esta versão do motor não conhece — atualize o LegalSquad (npm i -g github:bbpropulse/legalsquad-nucleo) e rode o sync de novo`],
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

function imprimirEstado(estado, agora) {
  if (estado.novo) {
    console.log('ACERVO:NUNCA-SINCRONIZADO');
    console.log('  Nenhum pacote instalado por sync. O pacote-base do `main` continua valendo.');
    return;
  }
  const dias = idade(estado.sincronizado_em, agora);
  console.log(`ACERVO:${Object.keys(estado.packs).length}`);
  if (dias !== null) {
    // O selo de frescor do §9.4. Sem ele, cache velho é indistinguível de cache
    // fresco — e num acervo jurídico isso é a diferença entre citar o precedente
    // vigente e citar o superado.
    console.log(`  último sync há ${dias} dia(s)${dias > 30 ? ' — DESATUALIZADO' : ''}`);
  }
  for (const [packId, versao] of Object.entries(estado.packs).sort()) {
    console.log(`  - ${packId}@${versao}`);
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
  for (const { pack_id: packId, motivo } of resultado.recusados) console.error(`  · ${packId} recusado — ${motivo}`);
  for (const packId of resultado.revogados) console.log(`  - ${packId} removido (revogado)`);

  // Despublicado é informação, não ação: os arquivos ficam e o usuário decide.
  // Silenciar faria o pacote sumir do `status` sem explicação — some da lista e
  // ninguém sabe por quê, que é a pior forma de comunicar uma mudança.
  for (const packId of resultado.despublicados || []) {
    console.log(`  - ${packId} saiu do catálogo (despublicado) — o que já estava no disco foi mantido`);
  }
}

export async function acervoCli(sub, targetDir, values = {}, agora = Date.now()) {
  let estado;
  try {
    estado = lerEstado(targetDir);
  } catch (erro) {
    // Estado ilegível para o comando. Seguir com "vazio" mandaria o sync
    // rebaixar tudo e perder o rastro do que está no disco.
    console.error(`ACERVO:BLOQUEADO — ${erro.message}`);
    return { success: false, error: { code: 'estado-ilegivel', message: erro.message } };
  }

  if (sub === 'status' || sub === 'packs') {
    imprimirEstado(estado, agora);
    return { success: true, estado };
  }

  if (sub !== 'sync') {
    console.error(`ACERVO:BLOQUEADO — subcomando desconhecido "${sub}". Use sync, status ou packs.`);
    return { success: false, error: { code: 'subcomando-desconhecido', message: String(sub) } };
  }

  let config;
  try {
    config = resolverConfigDeAcervo(targetDir);
  } catch (erro) {
    console.error(`ACERVO:BLOQUEADO — ${erro.message}`);
    return { success: false, error: { code: 'config-ilegivel', message: erro.message } };
  }

  if (!config.ok) {
    // Fail-closed com o motivo verdadeiro. URL, chave pública e token de acesso
    // vêm embarcados, e o acesso é aberto — então licença NÃO chega mais aqui.
    // O que sobra é a autenticidade: uma chave pública própria que o usuário
    // declarou e está ilegível. Verificar assinatura continua inegociável.
    console.error(`ACERVO:BLOQUEADO — ${config.motivo}`);
    return { success: false, error: { code: 'config-incompleta', message: config.motivo } };
  }

  let anel;
  try {
    anel = new Map(Object.entries(config.chavesPublicas).map(([kid, pem]) => [kid, createPublicKey(pem)]));
  } catch (erro) {
    console.error(`ACERVO:BLOQUEADO — chave pública inválida — ${erro.message}`);
    return { success: false, error: { code: 'chave-publica-invalida', message: erro.message } };
  }

  let catalogo;
  try {
    catalogo = await buscarCatalogo(config.catalogUrl, config.license);
  } catch (erro) {
    console.error(`ACERVO:BLOQUEADO — catálogo inacessível — ${erro.message}`);
    return { success: false, error: { code: 'catalogo-inacessivel', message: erro.message } };
  }

  const plano = planejarSync(catalogo, estado, { incluirConteudo: values.content === true });
  if (!plano.ok) {
    console.error(`ACERVO:BLOQUEADO — ${plano.motivo}`);
    return { success: false, error: { code: 'plano-invalido', message: plano.motivo } };
  }

  const resultado = await executarSync(plano, {
    baixar,
    verificar: (manifesto, entidades) => verificarComAnel(manifesto, entidades, anel),
    aplicar: (pack, manifesto, entidades) => {
      const veredito = aplicarPacote(targetDir, manifesto, arquivosDoConteudo(entidades));
      if (!veredito.ok) throw new Error(veredito.problemas.join('; '));
    },
  }, estado);

  gravarEstado(targetDir, resultado.estado, { sincronizadoEm: new Date(agora).toISOString() });
  imprimirResultadoDoSync(resultado);

  let skillsIndexadas = null;
  if (resultado.aplicados.length > 0) {
    skillsIndexadas = reindexarSkills(targetDir);
    if (skillsIndexadas !== null) console.log(`  índice de skills regerado: ${skillsIndexadas} skills`);
  }

  return { success: true, ...resultado, skillsIndexadas };
}

export { planejarSync, gravarEstado };
