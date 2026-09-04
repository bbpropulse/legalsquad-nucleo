// Ritual matinal do chefe: `legalsquad chefe [--briefing] [--json]`.
//
// O comando NÃO produz dado jurídico novo. Ele encadeia os três scripts
// "orchestra" que o init instala NO PROJETO (prazos de hoje, intimações
// recentes, consolidação da carteira), lê o JSON que cada um emite e o
// REAPRESENTA na voz do chefe. Toda linha do briefing é re-apresentação de
// dado emitido pelos scripts, nunca inferência do motor — num produto de
// prazo processual, o chefe repetir o que o cache diz é honestidade; o chefe
// "completar" o que o cache não diz seria inventar prazo.
//
// Por que rodar os scripts DO PROJETO (e não uma cópia embarcada no motor):
// o tracker do DJEN e a carteira vivem na casa do usuário, e a versão dos
// scripts instalada lá é exatamente a que o resto do projeto usa via
// `npm run prazos:hoje` etc. Rodar outra cópia poderia divergir do que o
// próprio usuário vê ao rodar o script à mão.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadLocale, t } from './i18n.js';

const execFileAsync = promisify(execFile);

// Persona padrão do runner (ver _legalsquad/core/runner.pipeline.md): todo
// squad tem chefe e o padrão é Mike (🎩). Um squad.yaml pode declarar `chefe:`
// para TROCAR a voz DAQUELE squad — mas o briefing é do ESCRITÓRIO,
// transversal a todos os squads, então usa sempre o default. Resolver "qual
// squad empresta a voz do briefing" exigiria uma regra de desempate (primeiro
// squad? último usado? config nova?) que o produto ainda não definiu; até lá,
// escolher aqui seria inventar produto. Decisão registrada, não esquecida.
export const CHEFE_PADRAO = { nome: 'Mike', icon: '🎩' };

// As três fontes do ritual, na ordem em que o briefing as apresenta.
// `chave` é o nome no agregado JSON (contrato com a rotina agendada que o
// consome); `script` é o caminho dentro da casa do projeto.
const FONTES = [
  { chave: 'prazos_hoje', script: 'prazos-hoje.mjs' },
  { chave: 'intimacoes', script: 'intimacoes-recentes.mjs' },
  { chave: 'carteira', script: 'carteira-consolidar.mjs' },
];

// "Hoje" é o dia no fuso do FORO, não o da máquina — contêiner e cron rodam em
// UTC e comparar `fatal` com a data local classificaria errado no próprio dia
// do vencimento. A régua vem de scripts/orchestra/_lib.mjs (`today`), a MESMA
// que os scripts do projeto usam: o pacote publica `scripts/` junto de `src/`
// (package.json `files`) e o import é livre de efeito colateral. Uma fonte de
// verdade para o cálculo — os DADOS continuam vindo dos scripts DO PROJETO
// (ver cabeçalho); só a régua de datas é compartilhada.
import { today as hojeNoForo } from '../scripts/orchestra/_lib.mjs';

/** Data de hoje (AAAA-MM-DD) no fuso do foro. `agora` é injetável para teste. */
export { hojeNoForo };

/**
 * A pasta é uma casa LegalSquad? O marcador é o mesmo do roteador: `_legalsquad/`.
 *
 * 4ª encarnação do mesmo predicado — os vizinhos checam `join(dir, '_legalsquad')`
 * via `stat` em src/init.js (detecta re-init), src/update.js (gate do update) e
 * src/resource-cli.js (gate de skills/agents). Unificar os 4 sites num helper
 * único é refactor futuro; por ora este comando ao menos compartilha a MENSAGEM
 * com os vizinhos via i18n (chave `chefeNotInitialized`).
 */
export function ehCasaLegalSquad(dir) {
  return existsSync(join(dir, '_legalsquad'));
}

// Encurta texto re-apresentado (teor de intimação pode ter parágrafos). O
// briefing é radar, não leitura dos autos: quem precisar do inteiro roda o
// script correspondente ou abre o tracker.
function trunc(valor, n = 80) {
  const s = valor == null ? '' : String(valor).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Roda UM script orchestra do projeto em modo --json e devolve
 * `{ ok: true, dados }` ou `{ ok: false, motivo }`.
 *
 * Tolerância deliberada: script ausente, exit != 0, JSON ilegível e timeout
 * são todos "seção indisponível com motivo", nunca exceção — um escritório
 * sem carteira consolidada ainda merece os prazos do dia. O motivo é uma
 * linha porque vai direto para o corpo do briefing.
 */
export async function coletarFonte(root, script) {
  const rel = join('scripts', 'orchestra', script);
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    return { ok: false, motivo: `script não encontrado (${rel})` };
  }
  // 60s de teto POR FONTE: os scripts leem cache local e respondem em
  // milissegundos; um travamento aqui seria bug no projeto, e o briefing
  // agendado não pode pendurar a rotina inteira por causa de uma fonte.
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [abs, '--json'], {
      cwd: root, encoding: 'utf8', timeout: 60_000,
    }));
  } catch (err) {
    // Timeout mata com SIGTERM e cai aqui como sinal — mesma "seção
    // indisponível" dos demais defeitos, nunca exceção.
    if (err.signal) {
      return { ok: false, motivo: `${rel} interrompido (${err.signal})` };
    }
    if (typeof err.code === 'number') {
      // O stderr dos scripts já explica em uma linha (ex.: a carteira avisa que
      // diretório ausente NÃO significa carteira vazia) — re-apresenta a
      // primeira linha em vez de resumir por conta própria.
      const primeiraLinha = String(err.stderr || '').trim().split('\n')[0];
      return { ok: false, motivo: primeiraLinha || `${rel} saiu com código ${err.code}` };
    }
    // Falha de spawn (código string tipo ENOENT) ou estouro de buffer.
    return { ok: false, motivo: `falha ao executar ${rel}: ${err.message}` };
  }
  try {
    const dados = JSON.parse(String(stdout || ''));
    if (!dados || typeof dados !== 'object') {
      return { ok: false, motivo: `${rel} não emitiu um objeto JSON` };
    }
    return { ok: true, dados };
  } catch {
    return { ok: false, motivo: `${rel} não emitiu JSON válido` };
  }
}

/**
 * Roda as três fontes EM PARALELO e devolve o agregado cru — o mesmo objeto
 * que o modo --json imprime para a desktop task/rotina agendada consumir.
 * As fontes são independentes (entradas disjuntas), então o pior caso cai de
 * 3×60s somados para 60s; a falha de uma continua isolada (cada uma resolve
 * seu próprio `{ok, ...}`) e a ORDEM das chaves no agregado — e das seções no
 * briefing — segue FONTES, nunca a ordem de término.
 * As chaves `prazos_hoje`, `intimacoes`, `carteira` e `varredura` existem SEMPRE (ok ou
 * não): consumidor de rotina não pode precisar de `in` para saber se a fonte
 * rodou.
 */
export async function coletarBriefing(root) {
  const agregado = { gerado_em: new Date().toISOString() };
  // Varredura do DJEN ANTES das três fontes (elas leem o cache que ela grava),
  // só quando o escritório configurou a OAB em `_legalsquad/_memory/djen.json`.
  // Sem configuração não é erro nem seção: o briefing segue como sempre, e o
  // aviso de frescor diz como ligar.
  const varredura = existsSync(join(root, '_legalsquad', '_memory', 'djen.json'))
    ? { configurada: true, ...(await coletarFonte(root, 'djen-varredura.mjs')) }
    : { configurada: false, ok: false, motivo: 'OAB não configurada' };
  const resultados = await Promise.all(
    FONTES.map(({ script }) => coletarFonte(root, script)),
  );
  FONTES.forEach(({ chave }, i) => {
    agregado[chave] = resultados[i];
  });
  // Última chave, aditiva: consumidor antigo do agregado continua lendo as três.
  agregado.varredura = varredura;
  return agregado;
}

// --- formatação na voz do chefe ---------------------------------------------
// Tom do runner: direto, profissional, zero floreio. Regra de produto para
// texto ao usuário final: sem travessão em prosa nova (por isso as linhas
// abaixo usam ponto, dois-pontos e parênteses).

// Linhas de uma seção do tracker (prazos ou intimações) quando a fonte veio
// em formato inesperado: mesmo tratamento de indisponível, para o leitor não
// confundir "não sei ler" com "não há nada" (princípio da degradação graciosa).
function registrosDe(dados) {
  return Array.isArray(dados?.registros) ? dados.registros : null;
}

function linhaRegistro(r, prefixo) {
  const partes = [r.processo, r.tipo, r.cliente, trunc(r.teor)]
    .map((v) => (v == null ? '' : String(v).trim()))
    .filter(Boolean);
  return `  ${prefixo} ${partes.join(' · ')}`;
}

function secaoIndisponivel(titulo, motivo) {
  return [titulo, `  Indisponível: ${motivo}`];
}

/**
 * Andaime comum às duas seções que re-apresentam o tracker (Prazos e
 * Intimações): fonte indisponível com motivo, resposta em formato inesperado,
 * título, corpo e aviso de linhas ilegíveis saem daqui — só a renderização
 * dos registros e a linha de total variam por seção, injetadas via
 * `renderLinhas(registros)` (que devolve as linhas do corpo, total incluso,
 * porque a ordem dos registros e o texto do total são decisão da seção).
 * Devolve `{ linhas, registros }`; `registros` é null quando a fonte não
 * respondeu em formato legível, para o fecho distinguir "fonte ok" de muda.
 */
function secaoDoTracker(titulo, fonte, renderLinhas) {
  if (!fonte?.ok) {
    return { linhas: secaoIndisponivel(titulo, fonte?.motivo || 'sem resposta'), registros: null };
  }
  const registros = registrosDe(fonte.dados);
  if (!registros) {
    return { linhas: secaoIndisponivel(titulo, 'resposta em formato inesperado (sem `registros`)'), registros: null };
  }
  const linhas = [titulo, ...renderLinhas(registros)];
  if (fonte.dados.ilegiveis > 0) {
    linhas.push(`  ⚠️ ${fonte.dados.ilegiveis} linha(s) ilegível(is) no cache: o total pode estar incompleto.`);
  }
  return { linhas, registros };
}

/**
 * Formata o agregado como o briefing falado do chefe. Puro (sem I/O): `hoje`
 * e `chefe` são injetáveis para teste. Devolve a string completa.
 */
export function formatarBriefing(agregado, { hoje = hojeNoForo(), chefe = CHEFE_PADRAO } = {}) {
  const linhas = [];
  const { prazos_hoje: prazos, intimacoes, carteira } = agregado;

  linhas.push(`${chefe.icon} Aqui é o ${chefe.nome}. Briefing do dia ${hoje}.`);

  // Frescor do monitoramento: qualifica prazos E intimações (mesmo cache),
  // então sobe para o topo em vez de repetir em cada seção. Cache velho
  // respondendo silêncio é falsa tranquilidade; o aviso vem antes dos dados.
  const freshness = (prazos?.ok && prazos.dados.freshness)
    || (intimacoes?.ok && intimacoes.dados.freshness) || null;
  const stale = Boolean(freshness && freshness.stale);
  if (stale) {
    const quando = freshness.age_hours == null
      ? 'nenhuma varredura registrada'
      : `última varredura há ${freshness.age_hours} h`;
    const dica = agregado.varredura?.configurada === false
      ? ' Varredura automática: grave _legalsquad/_memory/djen.json com {"oab":"…","uf":"…"}.'
      : '';
    linhas.push(`⚠️ Monitoramento do DJEN desatualizado (${quando}). Acione a varredura antes de confiar nos prazos e intimações abaixo.${dica}`);
  }
  const varredura = agregado.varredura;
  if (varredura?.configurada) {
    linhas.push(varredura.ok
      ? `${chefe.icon} Varredura do DJEN: ${varredura.dados?.novas ?? '?'} nova(s) comunicação(ões) em ${varredura.dados?.total ?? '?'} (${varredura.dados?.desde ?? '?'} a ${varredura.dados?.ate ?? '?'}).`
      : `⚠️ Varredura do DJEN falhou: ${varredura.motivo}.`);
  }
  linhas.push('');

  // --- Prazos: os de hoje em destaque, vencidos gritando. O script do
  // projeto só emite `fatal` de hoje, mas o formatador classifica pelo campo
  // `fatal` de cada registro emitido: se uma versão futura (ou um cache
  // atrasado) trouxer data passada, ela precisa GRITAR, não passar por prazo
  // comum. Comparação de string funciona porque `fatal` é AAAA-MM-DD.
  let vencidos = [];
  let prazosDeHoje = [];
  const secaoPrazos = secaoDoTracker('Prazos de hoje', prazos, (registros) => {
    vencidos = registros.filter((r) => typeof r.fatal === 'string' && r.fatal < hoje);
    prazosDeHoje = registros.filter((r) => r.fatal === hoje);
    const demais = registros.filter((r) => !vencidos.includes(r) && !prazosDeHoje.includes(r));
    const corpo = [
      ...vencidos.map((r) => linhaRegistro(r, `🔴 VENCIDO (${r.fatal}):`)),
      ...prazosDeHoje.map((r) => linhaRegistro(r, '⏰ HOJE:')),
      ...demais.map((r) => linhaRegistro(r, `• ${trunc(r.fatal, 12) || 'sem data'}:`)),
    ];
    if (!registros.length) {
      corpo.push('  Nenhum prazo com data fatal hoje.');
    } else {
      const resumo = [];
      if (prazosDeHoje.length) resumo.push(`${prazosDeHoje.length} vence(m) hoje`);
      if (vencidos.length) resumo.push(`${vencidos.length} já venceu(ram)`);
      if (resumo.length) corpo.push(`  Total: ${resumo.join('; ')}.`);
    }
    return corpo;
  });
  const prazosOk = secaoPrazos.registros !== null;
  linhas.push(...secaoPrazos.linhas, '');

  // --- Intimações recentes (o script filtra as últimas 24 h por padrão).
  const secaoIntimacoes = secaoDoTracker('Intimações (últimas 24 h)', intimacoes, (registros) => {
    const corpo = registros.map((r) => {
      // `capturado_em` é ISO com offset; "AAAA-MM-DD hh:mm" basta no radar.
      // Corte seco (sem reticências): timestamp truncado com "…" leria como
      // hora mutilada, não como resumo.
      const quando = String(r.capturado_em || '').replace('T', ' ').slice(0, 16);
      return linhaRegistro(r, `• ${quando || 'sem data'}:`);
    });
    corpo.push(registros.length
      ? `  Total: ${registros.length} intimação(ões) nova(s).`
      : '  Nenhuma intimação nova no período.');
    return corpo;
  });
  const intimacoesOk = secaoIntimacoes.registros !== null;
  const novasIntimacoes = secaoIntimacoes.registros || [];
  linhas.push(...secaoIntimacoes.linhas, '');

  // --- Carteira: resumo do consolidador (total + pulados + onde ficou o
  // dataset). Números vêm do script; o chefe não recontabiliza nada.
  if (!carteira?.ok) {
    linhas.push(...secaoIndisponivel('Carteira', carteira?.motivo || 'sem resposta'));
  } else {
    const d = carteira.dados;
    linhas.push('Carteira');
    if (typeof d.total === 'number') {
      linhas.push(`  ${d.total} caso(s) consolidados.${d.outDir ? ` Dataset em ${d.outDir}.` : ''}`);
    } else {
      linhas.push('  Consolidação respondeu sem total; confira o dataset manualmente.');
    }
    const pulados = Array.isArray(d.skipped) ? d.skipped.length : 0;
    if (pulados > 0) {
      linhas.push(`  ⚠️ ${pulados} caso(s) pulado(s) por linha malformada.`);
    }
  }
  linhas.push('');

  // --- Fecho: a ação mais urgente do dia, uma linha. Ordem de prioridade:
  // vencido (dano já correndo) > prazo de hoje (dano à meia-noite) > cache
  // velho (nenhum número acima é confiável) > intimação nova (pode esconder
  // prazo ainda não calculado) > nada. Deriva só do que as fontes emitiram.
  if (vencidos.length) {
    linhas.push(`${chefe.icon} Ação mais urgente: prazo VENCIDO no processo ${vencidos[0].processo || 'sem número'}. Trate disso antes de qualquer outra coisa.`);
  } else if (prazosDeHoje.length) {
    const alvo = prazosDeHoje[0].processo || 'sem número';
    linhas.push(prazosDeHoje.length === 1
      ? `${chefe.icon} Ação mais urgente: cumprir o prazo de hoje no processo ${alvo}.`
      : `${chefe.icon} Ação mais urgente: cumprir os ${prazosDeHoje.length} prazos de hoje. Comece pelo processo ${alvo}.`);
  } else if (stale) {
    linhas.push(`${chefe.icon} Ação mais urgente: acionar a varredura do DJEN. Sem ela, os números acima não são confiáveis.`);
  } else if (novasIntimacoes.length) {
    linhas.push(`${chefe.icon} Ação mais urgente: triar ${novasIntimacoes.length} intimação(ões) nova(s) e calcular os prazos que elas abrem.`);
  } else if (prazosOk || intimacoesOk) {
    linhas.push(`${chefe.icon} Nenhuma urgência no radar. Siga o planejado.`);
  } else {
    linhas.push(`${chefe.icon} Não consegui montar o radar de hoje: nenhuma fonte de prazos respondeu.`);
  }

  return linhas.join('\n');
}

/**
 * Entrada do subcomando `legalsquad chefe`. `--briefing` é o único modo hoje
 * e portanto o default; o flag vive no bin (aceito no parse e no usage, para
 * a linha agendada ser explícita num cron/desktop task) e não chega até aqui,
 * porque hoje é redundante. Devolve { success } no padrão do bin.
 */
export async function chefeCli(cwd, opts = {}) {
  const { json = false } = opts;

  if (!ehCasaLegalSquad(cwd)) {
    // Fora de uma casa não há preferência de idioma salva para ler — o
    // fallback é inglês, o mesmo mecanismo dos vizinhos (update/resource-cli).
    await loadLocale('English');
    console.error(t('chefeNotInitialized'));
    return { success: false };
  }

  const agregado = await coletarBriefing(cwd);
  const fontes = FONTES.map(({ chave }) => agregado[chave]);
  const todasFalharam = fontes.every((f) => !f.ok);

  if (json) {
    // Modo máquina (rotina agendada): o agregado cru, sem voz. As três chaves
    // saem SEMPRE, mesmo em falha total, para o consumidor ver os motivos.
    console.log(JSON.stringify(agregado, null, 2));
  } else {
    console.log(formatarBriefing(agregado));
  }

  if (todasFalharam) {
    // Saída honesta: briefing sem NENHUMA fonte não é briefing. O porquê de
    // cada uma vai no stderr para o agendador registrar.
    const motivos = FONTES
      .map(({ chave }) => `${chave}: ${agregado[chave].motivo}`)
      .join('; ');
    console.error(`chefe: nenhuma das três fontes respondeu. Motivos: ${motivos}`);
    return { success: false };
  }
  return { success: true };
}
