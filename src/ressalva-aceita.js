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
function proximoRessalvaJaAceita(ctx, gate, laco) {
  if (gate !== 'persuasao') return null;
  const aceitos = (ctx.bruto.historico && Array.isArray(ctx.bruto.historico.persuasao) ? ctx.bruto.historico.persuasao : [])
    .filter((l) => l && l.resolucao && l.resolucao.decisao === 'seguir' && /^profissional/.test(String(l.resolucao.por || '')));
  if (!aceitos.length) return null;
  const itensDe = (l) => (Array.isArray(l.cycles) ? l.cycles : []).flatMap((c) => (Array.isArray(c.verdicts) ? c.verdicts : []).flatMap((v) => [...(v.fixes || []), ...(v.ajustes || [])]));
  const ultima = Array.isArray(laco.cycles) && laco.cycles.length ? laco.cycles[laco.cycles.length - 1] : null;
  const agora = ultima ? (Array.isArray(ultima.verdicts) ? ultima.verdicts : []).flatMap((v) => [...(v.fixes || []), ...(v.ajustes || [])]) : [];
  if (!agora.length) return null;
  const palavras = (t) => new Set(String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/^(?:critica|alta|media|baixa)\s*:\s*/, '').split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const antes = aceitos.flatMap(itensDe).map(palavras);
  const casa = (t) => { const a = palavras(t); return a.size > 0 && antes.some((b) => { let n = 0; for (const w of a) if (b.has(w)) n += 1; return n / Math.min(a.size, b.size || a.size) >= 0.6; }); };
  if (!agora.every(casa)) return null;
  const quando = aceitos[aceitos.length - 1].resolucao.em || 'antes neste run';
  return {
    acao: 'registrar', passo: { id: 'escalada-persuasao', nome: 'escalada do gate persuasao' },
    motivo: `a persuasão escalou pelas mesmas perdas que o profissional aceitou como ressalva em ${quando}: a decisão dele vale para esta versão, sem nova pergunta`,
    comandos: [ctx.st('gate-decisao', '--gate', 'persuasao', '--decisao', 'seguir', '--por', `"codigo: mesma ressalva aceita pelo profissional em ${quando}"`)],
    depois_diga: `${ctx.chefe.icon} A síntese ainda deixa de fora o que você já tinha aceitado como ressalva; segui sem perguntar de novo.`,
  };
}
// <<< ressalva-aceita:end

export { proximoRessalvaJaAceita };
