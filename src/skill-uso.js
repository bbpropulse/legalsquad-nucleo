// Registro de USO das skills — o elo que fecha o circuito entre execução e
// seleção.
//
// O harness já media comportamento em dois lugares e jogava a medida fora nos
// dois: o Redação Gate confere a peça contra o contrato da skill, o Review
// Loop persiste vereditos no ledger do squad — e nada disso voltava para a
// PRÓXIMA escolha do Arquiteto. Peça rejeitada três vezes com a mesma skill e
// peça aprovada de primeira eram, para a fase de Design, a mesma skill.
//
// Este módulo grava um evento por ciclo FECHADO de revisão/gate, por skill
// carregada pelo squad, em `skills/_evals/uso/<skill>.jsonl` — o mesmo bairro
// user-owned da evidência comportamental (`skills/_evals/results/`), que o
// empacotador já não distribui (SPEC §6.5): uso é desta instalação, nunca
// viaja no pacote.
//
// **Telemetria é fail-safe, nunca fail-closed.** Gates travam peça errada;
// registro de uso não trava nada — um defeito aqui não pode custar a peça de
// um advogado. Quem chama decide engolir o erro (ver squad-state.mjs).
//
// A ATRIBUIÇÃO é honesta e grosseira de propósito: o evento é creditado às
// skills que o squad declara (squad.yaml + agentes), porque é ISSO que o
// runner injeta. Não afirmamos "a skill X causou o REJECT" — afirmamos "a
// skill X estava carregada num ciclo que terminou em REJECT". É sinal de
// cobertura, não veredito de culpa; o Arquiteto pondera, não sentencia.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// >>> skill-uso:begin
const DIR_USO = ['_evals', 'uso'];

/** `skills/` é irmão de `squads/` — mesma convenção do squad-check. */
export function skillsDirDoSquad(squadDir) {
  return join(dirname(resolve(squadDir)), '..', 'skills');
}

/**
 * Ids de skill declarados pelo squad (squad.yaml + frontmatter dos agentes).
 * Parser local mínimo — as duas formas que o motor gera (lista de bloco e
 * inline), mesmas regexes do squad-check.
 */
export function skillsDeclaradasDoSquad(squadDir) {
  const ids = new Set();
  const fontes = [join(squadDir, 'squad.yaml')];
  const agentsDir = join(squadDir, 'agents');
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) {
      if (f.endsWith('.md')) fontes.push(join(agentsDir, f));
    }
  }
  for (const arquivo of fontes) {
    if (!existsSync(arquivo)) continue;
    const texto = readFileSync(arquivo, 'utf8');
    const inline = texto.match(/^\s*skills:\s*\[([^\]]*)\]\s*$/m);
    if (inline) {
      for (const s of inline[1].split(',')) {
        const id = s.trim().replace(/^["']|["']$/g, '');
        if (id) ids.add(id);
      }
      continue;
    }
    const bloco = texto.match(/^skills:\s*\n((?:\s+-\s+.+\n?)+)/m);
    if (!bloco) continue;
    for (const linha of bloco[1].split('\n')) {
      const id = linha.match(/^\s*-\s+(.+?)\s*$/)?.[1]?.replace(/^["']|["']$/g, '');
      if (id) ids.add(id);
    }
  }
  return [...ids].sort();
}

/**
 * Grava UM evento de ciclo fechado para cada skill do squad.
 * `evento = { squad, gate, verdict, reviewer?, data? }`.
 * Sem skills declaradas ou sem `skills/` no disco → no-op silencioso: área
 * não instalada é estado normal deste motor.
 */
export function registrarUsoDeSkills(squadDir, evento) {
  const skills = skillsDeclaradasDoSquad(squadDir);
  if (!skills.length) return { gravados: 0 };
  const skillsDir = skillsDirDoSquad(squadDir);
  if (!existsSync(skillsDir)) return { gravados: 0 };

  const usoDir = join(skillsDir, ...DIR_USO);
  mkdirSync(usoDir, { recursive: true });
  const linha = `${JSON.stringify({
    data: evento.data || new Date().toISOString().slice(0, 10),
    squad: String(evento.squad || ''),
    gate: String(evento.gate || 'review'),
    verdict: String(evento.verdict || ''),
    ...(evento.reviewer ? { reviewer: String(evento.reviewer) } : {}),
  })}\n`;

  let gravados = 0;
  for (const id of skills) {
    // Id vindo de YAML do usuário NUNCA vira caminho sem o mesmo gate do
    // detail-skill: barra ou `..` atravessaria para fora de _evals/uso via
    // appendFileSync. Telemetria pula o id torto em silêncio — fail-safe.
    if (/[\\/]|\.\./.test(id)) continue;
    // Um arquivo por skill: a leitura na hora da decisão é O(1) — abre o
    // arquivo da finalista, nunca varre um log global.
    appendFileSync(join(usoDir, `${id}.jsonl`), linha);
    gravados++;
  }
  return { gravados, skills };
}

/**
 * Agregado de uso de UMA skill, para o digest do `detail-skill` e para a
 * Phase D.5 do Design. Ausência de arquivo → `null` ("nunca medida"), que é
 * diferente de zero — a mesma semântica de ausência do resto do motor.
 */
export function lerUsoDeSkill(rootDir, skillId) {
  if (/[\\/]|\.\./.test(String(skillId || ''))) return null;
  const caminho = join(rootDir, 'skills', ...DIR_USO, `${skillId}.jsonl`);
  if (!existsSync(caminho)) return null;

  const eventos = readFileSync(caminho, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
  if (!eventos.length) return null;

  const rejeicoes = eventos.filter((e) => e.verdict === 'REJECT');
  const squads = new Set(eventos.map((e) => e.squad).filter(Boolean));
  return {
    ciclos: eventos.length,
    aprovacoes: eventos.filter((e) => e.verdict === 'APPROVE').length,
    rejeicoes: rejeicoes.length,
    squads_distintos: squads.size,
    ultimo_uso: eventos[eventos.length - 1].data || null,
    ultima_rejeicao: rejeicoes.length ? rejeicoes[rejeicoes.length - 1].data || null : null,
  };
}
// <<< skill-uso:end
