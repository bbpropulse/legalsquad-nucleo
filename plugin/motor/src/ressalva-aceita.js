// A ressalva da persuasão que o profissional já aceitou vale para as versões seguintes do run.
// Bloco copiado VERBATIM em scripts/squad-state.mjs e templates/scripts/squad-state.mjs (sync-blocos).

// >>> ressalva-aceita:begin
/**
 * A persuasão que escala de novo pelas mesmas perdas que o profissional já aceitou ("Seguir") numa
 * versão anterior deste run: a decisão dele vale, e o código a registra, sem nova pergunta. Medido em
 * 07/11/2026 (memoriais cíveis): depois do "Seguir" na v4, a v7 e a v8 escalaram com as mesmas três
 * perdas e o profissional respondeu "Seguir" mais duas vezes. Só a persuasão (é ressalva de
 * apresentação, não de mérito nem de citação) e só quando TODA pendência de agora casa com uma
 * aceita antes (palavras em comum de pelo menos 60%).
 */
/** Toda pendência de `agora` casa com uma já aceita (palavras em comum de pelo menos 60%)? */
function ressalvaCobre(aceitas, agora) {
  if (!Array.isArray(agora) || !agora.length || !Array.isArray(aceitas) || !aceitas.length) return false;
  const palavras = (t) => new Set(String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/^(?:critica|alta|media|baixa)\s*:\s*/, '').split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const antes = aceitas.map(palavras);
  const casa = (t) => { const a = palavras(t); return a.size > 0 && antes.some((b) => { let n = 0; for (const w of a) if (b.has(w)) n += 1; return n / Math.min(a.size, b.size || a.size) >= 0.6; }); };
  return agora.every(casa);
}

/** As pendências que o profissional aceitou como ressalva neste run, num gate ("Seguir" na escalada). */
// eslint-disable-next-line no-unused-vars -- usada pelo squad-state, onde o bloco é copiado
function ressalvasAceitas(ctx, gate) {
  // O laço aceito ainda em cena (só sai para o histórico no próximo gate-open) também vale.
  const atual = ctx.bruto.loops && ctx.bruto.loops[gate] ? [ctx.bruto.loops[gate]] : [];
  const aceitos = [...(ctx.bruto.historico && Array.isArray(ctx.bruto.historico[gate]) ? ctx.bruto.historico[gate] : []), ...atual]
    .filter((l) => l && l.resolucao && l.resolucao.decisao === 'seguir' && /^profissional/.test(String(l.resolucao.por || '')));
  return aceitos.flatMap((l) => [...(Array.isArray(l.resolucao.pendentes) ? l.resolucao.pendentes : []), ...(Array.isArray(l.cycles) ? l.cycles : []).flatMap((c) => (Array.isArray(c.verdicts) ? c.verdicts : []).flatMap((v) => [...(v.fixes || []), ...(v.ajustes || [])]))]);
}

function proximoRessalvaJaAceita(ctx, gate, laco) {
  // 0.9.146: também o Redação Gate e a consistência de contrato (forma e estrutura da peça); a ressalva
  // aceita no "Seguir" só valia para a versão em que foi dada, e a versão seguinte reprovava o mesmo
  // problema num laço novo, com a mesma pergunta ao profissional. Citação nunca: ela não se aceita.
  if (!['persuasao', 'redacao', 'contrato'].includes(gate)) return null;
  const aceitos = (ctx.bruto.historico && Array.isArray(ctx.bruto.historico[gate]) ? ctx.bruto.historico[gate] : [])
    .filter((l) => l && l.resolucao && l.resolucao.decisao === 'seguir' && /^profissional/.test(String(l.resolucao.por || '')));
  if (!aceitos.length) return null;
  const itensDe = (l) => (Array.isArray(l.cycles) ? l.cycles : []).flatMap((c) => (Array.isArray(c.verdicts) ? c.verdicts : []).flatMap((v) => [...(v.fixes || []), ...(v.ajustes || [])]));
  const ultima = Array.isArray(laco.cycles) && laco.cycles.length ? laco.cycles[laco.cycles.length - 1] : null;
  const agora = ultima ? (Array.isArray(ultima.verdicts) ? ultima.verdicts : []).flatMap((v) => [...(v.fixes || []), ...(v.ajustes || [])]) : [];
  if (!agora.length) return null;
  if (!ressalvaCobre(aceitos.flatMap(itensDe), agora)) return null;
  const quando = aceitos[aceitos.length - 1].resolucao.em || 'antes neste run';
  return {
    acao: 'registrar', passo: { id: `escalada-${gate}`, nome: `escalada do gate ${gate}` },
    motivo: `o gate ${gate} escalou pelos mesmos problemas que o profissional aceitou como ressalva em ${quando}: a decisão dele vale para esta versão, sem nova pergunta`,
    comandos: [ctx.st('gate-decisao', '--gate', gate, '--decisao', 'seguir', '--por', `"codigo: mesma ressalva aceita pelo profissional em ${quando}"`)],
    depois_diga: gate === 'persuasao'
      ? `${ctx.chefe.icon} A síntese ainda deixa de fora o que você já tinha aceitado como ressalva; segui sem perguntar de novo.`
      : `${ctx.chefe.icon} O mesmo ponto que você já tinha aceitado como ressalva voltou; segui sem perguntar de novo.`,
  };
}
// <<< ressalva-aceita:end

export { proximoRessalvaJaAceita };
