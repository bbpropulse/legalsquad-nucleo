// O registro das perguntas da Discovery (`perguntas_feitas` no `_build/discovery.yaml`).
//
// Premissa B1 do dono (revisoes/PREMISSAS-MOTOR-2026-10.md): a Discovery pergunta só o que o
// relato e os documentos não respondem, e poucas vezes. Sem o registro, o auditor das premissas
// não tinha o que contar (teste de ponta a ponta de 30/09/2026: B1 sem dado). A Discovery grava o
// bloco; o `check-squad` o valida quando existe e o auditor o lê.
//
// SINCRONIA: o bloco entre os marcadores é copiado VERBATIM para `scripts/auditar-run.mjs` e
// `templates/scripts/auditar-run.mjs` (o script do usuário não tem `src/`); `npm run check:blocos`
// falha se divergirem.

// >>> discovery-perguntas:begin
/** Teto de perguntas da Discovery (a regra "NEVER ask more than 8 questions total" do prompt). */
const TETO_DE_PERGUNTAS_DA_DISCOVERY = 8;

/**
 * Lê o bloco `perguntas_feitas` do discovery.yaml:
 *
 *   perguntas_feitas:
 *     total: 2
 *     perguntas:
 *       - "polo de atuação"
 *       - "red-team"
 *     respondidas_pelo_relato:
 *       - "prazo: o relato diz 09/10"
 *
 * Devolve `null` sem o bloco, ou `{ total, perguntas, respondidas_pelo_relato, erros }`; `erros`
 * vazio quando o bloco está no formato.
 */
function lerPerguntasFeitas(texto) {
  const linhas = String(texto || '').replace(/\r\n?/g, '\n').split('\n');
  const i = linhas.findIndex((l) => /^perguntas_feitas:\s*(?:#.*)?$/.test(l));
  if (i < 0) {
    const inline = linhas.find((l) => /^perguntas_feitas:\s*\S/.test(l));
    return inline ? { total: null, perguntas: [], respondidas_pelo_relato: [], erros: ['perguntas_feitas tem de ser um bloco com total e perguntas, não um valor solto'] } : null;
  }
  const out = { total: null, perguntas: [], respondidas_pelo_relato: [], erros: [] };
  let lista = null;
  for (const l of linhas.slice(i + 1)) {
    if (/^\S/.test(l)) break;
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const kv = l.match(/^\s{2}([a-z_]+):\s*(.*?)\s*$/);
    if (kv) {
      lista = null;
      if (kv[1] === 'total') out.total = /^\d+$/.test(kv[2]) ? Number(kv[2]) : NaN;
      else if (kv[1] === 'perguntas' || kv[1] === 'respondidas_pelo_relato') {
        lista = kv[1];
        if (kv[2] === '[]') lista = null;
        else if (kv[2]) out.erros.push(`${kv[1]} tem de ser lista em bloco`);
      }
      continue;
    }
    const item = l.match(/^\s{4}-\s+(.+?)\s*$/);
    if (item && lista) out[lista].push(item[1].replace(/^["']|["']$/g, ''));
  }
  if (!Number.isInteger(out.total)) out.erros.push('perguntas_feitas.total ausente ou não é número inteiro');
  else if (out.total !== out.perguntas.length) out.erros.push(`perguntas_feitas.total é ${out.total} e a lista perguntas tem ${out.perguntas.length}`);
  return out;
}
// <<< discovery-perguntas:end

export { TETO_DE_PERGUNTAS_DA_DISCOVERY, lerPerguntasFeitas };
