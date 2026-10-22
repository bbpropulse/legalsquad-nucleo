// Léxico de sinônimos da busca — a alternativa a embeddings que a própria
// spec sanciona (DESCOBERTA.md §3.1: "léxico curado, distribuído no pacote —
// auditável e depurável").
//
// O ranking é lexical por decisão (busca jurídica é exata/numérica; vetorial
// por "Súmula 443" devolve a 444). O preço dessa decisão é o recall: quem
// busca "retomada de imóvel" não acha a skill que o curador nomeou "despejo".
// O remédio da spec é este arquivo: o CURADOR declara as equivalências da
// área, o pacote as distribui assinadas como tudo mais, e a busca expande a
// consulta em VARIANTES — cada uma rankeada normalmente, o melhor score
// vence. Nada é inferido, nada é vetorial, tudo é auditável num YAML.
//
// Formato (um por área instalada, mesmo padrão do `_catalog*.yaml`):
//
//   # skills/_lexico.direito-civil.yaml
//   sinonimos:
//     despejo: [acao de despejo, retomada de imovel]
//     locacao: [aluguel, arrendamento]
//
// A relação é SIMÉTRICA por construção: cada termo do grupo expande para os
// demais — quem busca por qualquer um acha o que o curador nomeou por outro.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalize } from './skill-rank.js';

const MAX_VARIANTES = 4;

/**
 * Lê e funde todos os `skills/_lexico*.yaml`. Parsing por regex sobre formato
 * que nós mesmos geramos — mesma escolha do resto do motor. Ausência → mapa
 * vazio, nunca erro: léxico é enriquecimento, não dependência.
 *
 * Devolve `Map<termo normalizado, Set<termos do grupo, normalizados>>`.
 */
export function lerLexicos(skillsDir) {
  const grupos = new Map();
  if (!existsSync(skillsDir)) return grupos;

  const arquivos = readdirSync(skillsDir)
    .filter((f) => /^_lexico.*\.ya?ml$/.test(f))
    .sort();

  for (const arquivo of arquivos) {
    const texto = readFileSync(join(skillsDir, arquivo), 'utf8');
    for (const linha of texto.split('\n')) {
      // `  termo: [sin a, sin b]` — só a forma inline; é o formato gerado.
      const m = linha.match(/^ {2}([^:#\n]+):\s*\[([^\]]*)\]\s*$/);
      if (!m) continue;
      const grupo = [m[1], ...m[2].split(',')]
        .map((t) => normalize(t))
        .filter((t) => t.length >= 2);
      if (grupo.length < 2) continue;
      // Simetria: todo termo do grupo conhece os demais. Grupos de arquivos
      // diferentes que compartilham um termo se FUNDEM — duas áreas podem
      // declarar o mesmo instituto com vizinhos distintos.
      const uniao = new Set(grupo);
      for (const termo of grupo) {
        for (const vizinho of grupos.get(termo) || []) uniao.add(vizinho);
      }
      for (const termo of uniao) grupos.set(termo, uniao);
    }
  }
  return grupos;
}

/**
 * Variantes da consulta pelo léxico: a original primeiro, depois substituições
 * de FRASE ou termo — no máximo `MAX_VARIANTES`, para o custo de rank ficar
 * limitado (o rank é em memória; o caro é a descoberta em disco, que roda uma
 * vez só para todas as variantes).
 */
export function variantesDeConsulta(query, grupos) {
  const original = normalize(query);
  if (!original || !grupos.size) return [query];

  const variantes = [query];
  const vistas = new Set([original]);

  const adicionar = (texto) => {
    const chave = normalize(texto);
    if (!chave || vistas.has(chave) || variantes.length >= MAX_VARIANTES) return;
    vistas.add(chave);
    variantes.push(texto);
  };

  // 1º a frase inteira (mais específico), depois termo a termo.
  for (const vizinho of grupos.get(original) || []) adicionar(vizinho);
  // Substituição por PALAVRA INTEIRA (padding de espaço — `normalize` garante
  // tokens separados por espaço único). Substring crua era exatamente a classe
  // de bug corrigida no rank: "juri" dentro de "jurisprudencia" gerava
  // variante-lixo que puxava skill de outro domínio com a tag via-lexico.
  for (const [termo, grupo] of grupos) {
    if (variantes.length >= MAX_VARIANTES) break;
    if (termo === original) continue;
    if (!` ${original} `.includes(` ${termo} `)) continue;
    for (const vizinho of grupo) {
      if (vizinho === termo) continue;
      adicionar(` ${original} `.replace(` ${termo} `, ` ${vizinho} `).trim());
    }
  }
  return variantes;
}
