#!/usr/bin/env node
/**
 * Citation Gate v3 — sentinela determinística para artefatos jurídicos finais.
 *
 * FAZ (fail-closed no escopo):
 * - identifica arquivos jurídicos finais em squads/<squad>/output/ pelo NOME (vocabulário de
 *   peças levantado das skills em produção) ou pela FORMA (fórmulas de peça, ato judicial,
 *   parecer, contrato, notificação — duas distintas no mesmo texto);
 * - bloqueia marcadores de pendência;
 * - exige um manifesto <artefato>.citation-gate.json aprovado;
 * - confere a estrutura do manifesto e seu vínculo SHA-256 com o arquivo exato;
 * - exige que CADA citação material do texto (lei + artigo, súmula, tema, acórdão) tenha entrada
 *   correspondente em citations[] — mesma classe, mesmo número.
 *
 * NÃO FAZ (verificação material):
 * - não acessa tribunais, diários ou bases oficiais;
 * - não confirma existência, vigência, teor, pertinência ou oficialidade da fonte;
 * - não substitui o verificador de citações nem a revisão humana.
 *
 * O manifesto é uma ATESTAÇÃO do trabalho material já realizado, não prova de que
 * a fonte existe. URL bem-formada e status "verificada" são apenas dados locais.
 * Entrada inesperada fora do escopo é ignorada; depois que um artefato final é
 * identificado, erro de leitura, manifesto ausente/inválido ou hash divergente
 * sempre bloqueia (exit 2).
 */
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const EXIT_BLOCKED = 2;
const MANIFEST_SUFFIX = '.citation-gate.json';
const FINAL_MARKER = /<!--\s*LEGALSQUAD:CITATION-GATE:FINAL\s*-->/i;
// Frontmatter é só o bloco `---` que ABRE o arquivo. Testar `^---` com flag m no arquivo inteiro
// era quadrático em peça cheia de réguas `---` (6 s em 3 MB); agora só o cabeçalho é lido.
function frontmatterDe(text) {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(text || '').slice(0, 8192));
  return m ? m[1] : '';
}
const FINAL_FRONTMATTER = { test: (text) => /^citation_gate:\s*["']?final["']?\s*$/im.test(frontmatterDe(text)) };
const DRAFT_FRONTMATTER = { test: (text) => /^citation_gate:\s*["']?(?:draft|internal|rascunho)["']?\s*$/im.test(frontmatterDe(text)) };
// Carga opcional depois do marcador (`[NÃO VERIFICADO: acórdão X]`, `[CONFERIR a portaria]`): sem ela o gate
// deixava passar a final com a pendência escrita por extenso (ensaio de 19/09/2026).
const PENDING_MARKER = /\[(?:N[ÃA]O[ _]VERIFICAD[OA]|DIVERGENTE|CONFERIR|A[ _]CONFERIR|VERIFICAR|HIP[ÓO]TESE|CITA[ÇC][ÃA]O[ _]PENDENTE|FONTE[ _]PENDENTE|PENDENTE[ _]DE[ _]VERIFICA[ÇC][ÃA]O)(?:(?:\s+|\s*[:—–-])[^\]]*)?\]/gi;
const FINAL_NAME = /(?:^|[-_.])final(?:[-_.]|$)/i;
const SUPPORTED_EXT = /\.(?:md|markdown|txt|rtf|doc|docx|odt|pdf)$/i;

// ── Vocabulário e forma de peça ─────────────────────────────────────────────────────────────────
// Bloco IDÊNTICO em verifica-citacoes.mjs e verifica-redacao.mjs; tests/templates-paridade confere.
// Nomes de peça, ato e instrumento jurídico, como TOKENS canônicos de nome de arquivo (sem acento,
// sem preposição: `resposta-acusacao`, `agravo-instrumento`). Casam em QUALQUER posição do nome:
// `0001234-56.2024.8.26.0100-sentenca.md` e `cliente-x-contestacao.md` são peça. Levantados das 6.999
// skills em produção, família a família (cível, recursal, penal, trabalhista e previdenciária,
// tributária, administrativa, eleitoral, constitucional, extrajudicial, gabinete e MP) e verificados
// contra 600+ nomes de ataque. O que protege o artefato interno não é a posição do token, é o
// PREFIXO interno (`analise-da-contestacao`, `fichamento-do-hc`: ver PREFIXOS_INTERNOS). Palavras
// que sozinhas nomeiam tanto peça quanto coisa interna (`ata`, `termo`, `carta`, `memorando`,
// `informacoes`, `consulta`, `decisao`, `voto`) entram só compostas (`ata-assembleia`, `termo-acordo`,
// `informacoes-ms`, `decisao-interlocutoria`); o ato judicial solto (`decisao.md`) é pego pela FORMA.
const NOMES_DE_PECA = [
  'absolvicao-sumaria', 'acao', 'acao-civil-publica', 'acao-coletiva', 'acao-cumprimento',
  'acao-improbidade', 'acao-investigacao-judicial-eleitoral', 'acao-penal', 'acao-popular',
  'acao-previdenciaria', 'acao-rescisoria', 'acao-revisao', 'acordao', 'acordo', 'acordo-nao-persecucao',
  'acp', 'act', 'adc', 'adi', 'aditamento', 'aditamento-denuncia', 'aditivo', 'adjudicacao',
  'adjudicacao-compulsoria', 'ado', 'adocao', 'adpf', 'advertencia', 'afastamento-sigilo', 'agint',
  'agravo', 'agravo-execucao', 'agravo-instrumento', 'agravo-interno', 'agravo-peticao',
  'agravo-regimental', 'agrg', 'aije', 'aime', 'airc', 'airr', 'alegacoes', 'alegacoes-finais',
  'alienacao-parental', 'alimentos', 'alteracao-contratual', 'alvara', 'alvara-soltura', 'amicus',
  'amicus-curiae', 'anpc', 'anpp', 'antecipacao-garantia', 'antecipacao-tutela', 'anulacao', 'anulatoria',
  'apelacao', 'apelacao-criminal', 'aposentadoria', 'apuracao-haveres', 'arbitramento-honorarios', 'are',
  'aresp', 'arguicao', 'arguicao-inconstitucionalidade', 'arquivamento', 'arrazoado', 'arrematacao',
  'arresto', 'arrolamento', 'assistencia', 'assistente-acusacao', 'ata-age', 'ata-ago', 'ata-agoe',
  'ata-assembleia', 'ata-assembleia-geral', 'ata-audiencia', 'ata-notarial', 'ata-rca',
  'ata-reuniao-acionistas', 'ata-reuniao-condominio', 'ata-reuniao-conselho', 'ata-reuniao-diretoria',
  'ata-reuniao-quotistas', 'ata-reuniao-socios', 'ato-ordinatorio', 'audiencia-custodia',
  'auditoria-interna', 'auto-infracao', 'autofalencia', 'auxilio', 'averbacao', 'averbacao-tempo',
  'aviso-previo', 'beneficio', 'bpc', 'busca-apreensao', 'carta-anuencia', 'carta-cobranca',
  'carta-dispensa', 'carta-intencoes', 'carta-justa-causa', 'carta-ordem', 'carta-precatoria',
  'carta-preposicao', 'carta-preposto', 'carta-rogatoria', 'carta-testemunhavel', 'cautelar', 'cct',
  'certidao', 'cessao', 'chamamento-processo', 'cobranca', 'cobranca-extrajudicial', 'codicilo',
  'codigo-conduta', 'colaboracao-premiada', 'comodato', 'compensacao', 'composicao-civil', 'compra-venda',
  'compromisso', 'compromisso-ajustamento', 'comunicacao-dispensa', 'comunicado-fato-relevante',
  'comunicado-mercado', 'comutacao', 'concessao', 'confissao-divida', 'conflito-atribuicoes',
  'conflito-competencia', 'conflito-jurisdicao', 'consignacao', 'consignacao-pagamento', 'consignatoria',
  'constituicao-mora', 'consulta-fiscal', 'consulta-tributaria', 'contestacao', 'contestacao-fazenda',
  'contra-minuta', 'contradita', 'contramandado', 'contraminuta', 'contranotificacao', 'contraproposta',
  'contrarrazoes', 'contrarrazoes-recurso', 'contrato', 'contrato-honorarios', 'contrato-social',
  'contrato-trabalho', 'convencao', 'convencao-condominio', 'correicao-parcial', 'cota', 'cota-ministerial',
  'crps', 'cumprimento', 'cumprimento-exigencia', 'cumprimento-sentenca', 'curatela',
  'decisao-interlocutoria', 'decisao-liminar', 'decisao-monocratica', 'decisao-saneadora', 'declaracao',
  'declaracao-voto', 'declaratoria', 'decreto', 'defesa', 'defesa-escrita', 'defesa-preliminar',
  'defesa-previa', 'demarcacao', 'demolitoria', 'denuncia', 'denunciacao-lide', 'desaforamento',
  'desaposentacao', 'desapropriacao', 'desconsideracao', 'desentranhamento', 'desinternacao', 'desistencia',
  'despacho', 'despejo', 'destituicao-poder-familiar', 'detracao', 'direito-resposta',
  'dispensa-justa-causa', 'dissidio', 'dissolucao', 'dissolucao-uniao-estavel', 'distrato', 'divisao',
  'divorcio', 'dpa', 'due-diligence', 'duvida-registral', 'edcl', 'edital', 'edital-convocacao',
  'efeito-suspensivo', 'emancipacao', 'embargos', 'embargos-declaracao', 'embargos-declaratorios',
  'embargos-divergencia', 'embargos-execucao', 'embargos-execucao-fiscal', 'embargos-infringentes',
  'embargos-monitorios', 'embargos-sdi', 'embargos-terceiro', 'emenda', 'emenda-inicial', 'eresp',
  'esboco-partilha', 'esclarecimento', 'esclarecimentos', 'escritura', 'especificacao-condominio',
  'especificacao-provas', 'estatuto', 'estatuto-social', 'excecao', 'excecao-incompetencia',
  'excecao-pre-executividade', 'exclusao-socio', 'execucao', 'execucao-fiscal', 'execucao-penal',
  'exequatur', 'exibicao', 'exibicao-documentos', 'exigir-contas', 'exoneracao', 'exoneracao-alimentos',
  'exordial', 'exposicao-motivos', 'extincao', 'extincao-punibilidade', 'falencia', 'falta-grave',
  'fato-relevante', 'fianca', 'formal-partilha', 'gratuidade-justica', 'guarda', 'guia-execucao',
  'guia-recolhimento', 'habeas-corpus', 'habeas-data', 'habilitacao', 'hc', 'homologacao',
  'homologacao-acordo', 'iac', 'idpj', 'imissao-posse', 'impedimento', 'improbidade', 'impronuncia',
  'impugnacao', 'impugnacao-auto-infracao', 'impugnacao-cumprimento-sentenca', 'impugnacao-edital',
  'impugnacao-sentenca-liquidacao', 'incidente', 'incidente-assuncao-competencia',
  'incidente-desconsideracao', 'incidente-insanidade', 'incidente-resolucao-demandas-repetitivas',
  'incidente-uniformizacao', 'indebito', 'indenizacao', 'indenizatoria', 'indulto', 'inexistencia-debito',
  'informacoes-autoridade-coatora', 'informacoes-hc', 'informacoes-ms', 'informacoes-prestadas', 'inicial',
  'inquerito', 'inquerito-civil', 'inquerito-judicial', 'instituicao-condominio', 'instrucao-normativa',
  'instrumento-particular', 'interdicao', 'interdito', 'interdito-proibitorio', 'internacao-compulsoria',
  'interpelacao', 'intervencao-federal', 'inventario', 'investigacao-paternidade', 'irdr',
  'juizo-admissibilidade', 'juizo-retratacao', 'julgamento-antecipado', 'juntada', 'justica-gratuita',
  'justificacao', 'justificacao-administrativa', 'legal-opinion', 'libelo', 'liberdade-provisoria',
  'liminar', 'liquidacao', 'livramento', 'loas', 'locacao', 'loi', 'mandado', 'mandado-busca-apreensao',
  'mandado-citacao', 'mandado-injuncao', 'mandado-prisao', 'mandado-seguranca', 'manifestacao',
  'manifestacao-inconformidade', 'manifestacao-ministerial', 'manutencao-posse', 'mediacao',
  'medida-cautelar', 'medida-protetiva', 'medidas-cautelares', 'medidas-protetivas',
  'memorando-entendimento', 'memorando-entendimentos', 'memoriais', 'memorial', 'memorial-incorporacao',
  'mocao', 'monitoracao-eletronica', 'monitoria', 'mou', 'ms', 'nda', 'negatoria', 'nota-devolutiva',
  'nota-tecnica', 'noticia-crime', 'noticia-fato', 'noticia-inelegibilidade', 'notificacao',
  'notificacao-extrajudicial', 'notificacao-recomendatoria', 'notitia-criminis', 'nunciacao', 'objecao',
  'obrigacao-fazer', 'obrigacao-nao-fazer', 'oferecimento-garantia', 'oferta-alimentos', 'oficio',
  'oficio-requisitorio', 'opiniao-juridica', 'opiniao-legal', 'oposicao', 'pacto-antenupcial', 'pad',
  'parcelamento', 'parecer', 'parecer-ministerial', 'parecer-procuradoria', 'partilha', 'paternidade',
  'pauliana', 'peca', 'pedido', 'pedido-contraposto', 'pedido-efeito-suspensivo', 'pedido-informacoes',
  'pedido-providencias', 'pedido-reconsideracao', 'pedido-revisao', 'pedido-suspensao',
  'pedido-uniformizacao', 'penhora', 'pensao-morte', 'peticao', 'peticao-inicial', 'plano-partilha',
  'plano-recuperacao', 'plano-recuperacao-judicial', 'politica', 'politica-interna', 'politica-privacidade',
  'portaria', 'possessoria', 'pre-executividade', 'precatorio', 'preliminar-repercussao-geral',
  'prestacao-contas', 'prestacao-informacoes', 'primeiras-declaracoes', 'prisao-domiciliar',
  'prisao-preventiva', 'procedimento-controle-administrativo', 'procedimento-investigatorio-criminal',
  'procedimento-preparatorio', 'procuracao', 'producao-antecipada', 'progressao-regime', 'projeto-decreto',
  'projeto-emenda', 'projeto-lei', 'projeto-resolucao', 'projeto-sentenca', 'promessa-compra-venda',
  'promocao', 'promocao-arquivamento', 'promocao-ministerial', 'pronuncia', 'proposta-acordo', 'protesto',
  'protesto-interruptivo', 'puil', 'quanti-minoris', 'quebra-sigilo', 'queixa', 'queixa-crime', 'querela',
  'querela-nullitatis', 'quesitos', 'questao-ordem', 'quitacao', 'razoes', 'razoes-apelacao',
  'razoes-finais', 'rced', 'rcl', 'reabilitacao-criminal', 'reafirmacao-der', 'recibo', 'reclamacao',
  'reclamacao-constitucional', 'reclamacao-correicional', 'reclamacao-disciplinar',
  'reclamacao-previdenciaria', 'reclamacao-trabalhista', 'reclamatoria', 'recomendacao',
  'recomendacao-ministerial', 'reconhecimento-paternidade', 'reconhecimento-tempo-especial',
  'reconhecimento-uniao-estavel', 'reconhecimento-vinculo', 'reconsideracao', 'reconvencao',
  'recuperacao-judicial', 'recurso', 'recurso-adesivo', 'recurso-administrativo', 'recurso-especial',
  'recurso-extraordinario', 'recurso-hierarquico', 'recurso-inominado', 'recurso-interno',
  'recurso-ordinario', 'recurso-revisao', 'recurso-revista', 'recurso-sentido-estrito',
  'recurso-voluntario', 'redibitoria', 'reequilibrio', 'reexame', 'regimento', 'regimento-interno',
  'registro-candidatura', 'regressao-regime', 'regulamentacao-guarda', 'regulamentacao-visitas',
  'regulamento', 'regulamento-interno', 'reintegracao-posse', 'reivindicatoria', 'relatorio-auditoria',
  'relatorio-due-diligence', 'relatorio-voto', 'relaxamento', 'remicao', 'renovatoria', 'renuncia',
  'repercussao-geral', 'repeticao-indebito', 'replica', 'representacao', 'representacao-criminal',
  'representacao-interventiva', 'requerimento', 'requerimento-administrativo', 'requisicao', 'rescisao',
  'rescisoria', 'rese', 'resolucao', 'resp', 'respe', 'responsabilidade-civil', 'resposta',
  'resposta-acusacao', 'resposta-consulta', 'resposta-oficio', 'restabelecimento', 'restauracao-autos',
  'restituicao', 'restituicao-coisas', 'retificacao', 'revisao-alimentos', 'revisao-aposentadoria',
  'revisao-beneficio', 'revisao-contratual', 'revisao-criminal', 'revisao-vida-toda', 'revisional',
  'revocatoria', 'revogacao', 'rhc', 'ripd', 'rms', 'roc', 'rol-testemunhas', 'rrc', 'rse', 'rvcr',
  'saida-temporaria', 'salario-maternidade', 'salvo-conduto', 'saneamento', 'sentenca', 'sequestro',
  'sindicancia', 'sindicancia-interna', 'sobrepartilha', 'substabelecimento', 'substituicao-pena',
  'suprimento', 'sursis', 'suscitacao-duvida', 'suspeicao', 'suspensao', 'suspensao-condicional',
  'suspensao-liminar', 'suspensao-seguranca', 'suspensao-tutela', 'sustacao', 'sustentacao',
  'sustentacao-oral', 'tac', 'tce', 'tempo-especial', 'term-sheet', 'termo-acordo', 'termo-adesao',
  'termo-aditivo', 'termo-ajustamento', 'termo-ajustamento-conduta', 'termo-audiencia', 'termo-compromisso',
  'termo-conciliacao', 'termo-consentimento', 'termo-mediacao', 'termo-quitacao', 'termo-referencia',
  'termo-responsabilidade', 'termos-uso', 'testamento', 'testemunhavel', 'tomada-decisao-apoiada',
  'trabalho-externo', 'trancamento', 'transacao', 'transacao-extrajudicial', 'transacao-penal',
  'transferencia-preso', 'treplica', 'tutela', 'tutela-antecedente', 'tutela-antecipada', 'tutela-cautelar',
  'tutela-evidencia', 'tutela-provisoria', 'tutela-recursal', 'tutela-urgencia', 'ultimas-declaracoes',
  'uniao-estavel', 'unificacao-penas', 'uniformizacao', 'usucapiao', 'usucapiao-extrajudicial',
  'vinculo-empregaticio', 'voto', 'voto-divergente', 'voto-vista',
];

// Preposições que o nome do arquivo pode trazer ou omitir (`resposta-a-acusacao` ou
// `resposta-acusacao`, `agravo-de-instrumento` ou `agravo-instrumento`): saem dos dois lados.
const PREPOSICOES_NO_NOME = new Set([
  'de', 'da', 'do', 'das', 'dos', 'a', 'ao', 'aos', 'as', 'em', 'no', 'na', 'nos', 'nas', 'e', 'o', 'os',
  'um', 'uma', 'para', 'por', 'com',
]);

/** `Contestação_Cliente X.v2.md`, `PeticaoInicial.docx` → `contestacao-cliente-x-v2`, `peticao-inicial`:
 * sem extensão, sem acento, camelCase e letra↔dígito separados, sem preposição. */
function nomeCanonico(name, { separarCamelCase = true } = {}) {
  const semExtensao = String(name || '').replace(/\.[a-z0-9]+$/i, '');
  const separado = !separarCamelCase ? semExtensao : semExtensao
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Za-z])(\d)/g, '$1-$2')
    .replace(/(\d)([A-Za-z])/g, '$1-$2');
  const ascii = separado.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return ascii.split(/[^a-z0-9]+/).filter((s) => s && !PREPOSICOES_NO_NOME.has(s)).join('-');
}
/** As duas leituras do nome: com camelCase separado (`PeticaoInicial` → `peticao-inicial`) e sem
 * (`RvCr`, `AgRg` são siglas, não camelCase). */
function leiturasDoNome(name) {
  const com = nomeCanonico(name);
  const sem = nomeCanonico(name, { separarCamelCase: false });
  return com === sem ? [com] : [com, sem];
}

// O que começa assim é trabalho SOBRE a peça, não a peça: análise, fichamento, mapa, plano, notas,
// resumo, pesquisa, revisão, relatório… Um prefixo interno vence o nome de peça que vier depois
// (`analise-da-contestacao`, `03-fichamento-do-acordao`, `resumo-da-sentenca`), com uma exceção: o
// nome que COMEÇA por um token composto do vocabulário é peça (`relatorio-e-voto`, `nota-tecnica`,
// `revisao-de-beneficio`, `plano-de-partilha`), porque o composto é mais específico que o prefixo.
// Palavra que também nomeia peça ou ato (`decisao`, `informacoes`, `consulta`, `ata`, `memorando`)
// NÃO está aqui: esses nomes ficam neutros e a forma decide.
const PREFIXOS_INTERNOS = [
  'revisao', 'aprovacao', 'checklist', 'relatorio', 'pesquisa', 'resumo', 'diagnostico', 'bloqueio',
  'precedentes', 'precedente', 'julgado', 'julgados', 'jurisprudencia', 'ementa', 'cabimento', 'fatos',
  'teses', 'tese', 'estrategia', 'calculo', 'intake', 'onboarding', 'triagem', 'publish-report', 'foco',
  'temas', 'contradicoes', 'pre-mortem', 'contraditor', 'prazos', 'prazo', 'carteira', 'comunicacao',
  'analise', 'analises', 'fichamento', 'mapa', 'mapas', 'esqueleto', 'estrutura', 'outline', 'notas', 'nota',
  'anotacoes', 'anotacao', 'plano', 'planejamento', 'roteiro', 'briefing', 'cronograma', 'cronologia',
  'agenda', 'tabela', 'lista', 'matriz', 'comparativo', 'comparacao', 'memoria', 'reuniao', 'email',
  'mail', 'mensagem', 'entrevista', 'perguntas', 'pendencias', 'pendencia', 'pontos', 'ponto', 'glossario',
  'dossie', 'sintese', 'sumario', 'transcricao', 'linha', 'viabilidade', 'requisitos', 'recomendacoes',
  'riscos', 'risco', 'duvidas', 'duvida', 'historico', 'cenarios', 'cenario', 'observacoes', 'observacao',
  'diff', 'comentarios', 'comentario', 'sugestoes', 'sugestao', 'apontamentos', 'criticas', 'critica',
  'avaliacao', 'andamento', 'anexos', 'bens', 'clausulas', 'conferencia', 'dispositivo', 'feedback',
  'fontes', 'indice', 'lacunas', 'leitura', 'licoes', 'metricas', 'pauta', 'planilha', 'preparacao',
  'provas', 'quadro', 'referencias', 'research', 'simulacao', 'sobrevivencia', 'status', 'tendencia',
  'trechos', 'validacao', 'verificacao', 'log', 'logs', 'review', 'gate', 'flags', 'tarefas', 'tarefa',
  'research-focus', 'summary', 'notes', 'analysis', 'timeline', 'todo', 'changelog', 'report', 'brief', 'memo',
  'itens', 'proxima', 'proximo', 'proximos', 'curso', 'auto-avaliacao', 'red-team',
];
// Último segmento que denuncia trabalho SOBRE a peça (`contrato-analise`, `hc-fichamento`,
// `contestacao-revisao-a`). O composto de peça sai antes (`pedido-revisao` é a peça).
const SUFIXOS_INTERNOS = [
  'notas', 'checklist', 'analise', 'fichamento', 'mapa', 'pesquisa', 'resumo', 'revisao', 'briefing', 'outline',
  'esqueleto', 'comparativo', 'cronograma', 'log', 'todo', 'notes', 'summary', 'analysis', 'review',
];
// Segmentos que, em QUALQUER posição, denunciam gestão do run ou comunicação interna.
// (`acervo`, `log` e `run` ficaram de fora: "partilha-do-acervo-hereditario" e a razão social
// "log-in-logistica" são peça.)
const SEGMENTOS_INTERNOS = [
  'tarefas', 'tarefa', 'pendencias', 'pendencia', 'reuniao', 'equipe', 'versoes', 'interno', 'interna',
  'estrategia', 'estrategica', 'estrategico', 'prazos', 'autos',
];
// Segmentos de ordem ou de versão que o agente põe na frente do nome (`03-`, `2026-09-11-`, `step-03-`,
// `v2-`, `nova-`, `ultima-`, `re-`, `pre-`): saem antes de olhar o prefixo.
const SEGMENTO_DE_ORDEM = /^(?:\d+|step|etapa|passo|v\d+|run|nov[oa]s?|ultim[oa]s?|primeir[oa]s?|segund[oa]s?|terceir[oa]s?|pre|re)(?:-|$)/;

const NOME_DE_PECA = new RegExp(`(?:^|-)(?:${NOMES_DE_PECA.join('|')})(?:-|$)`);
const COMPOSTOS_DE_PECA = NOMES_DE_PECA.filter((t) => t.includes('-'));
const NOME_DE_PECA_COMPOSTO_NO_INICIO = new RegExp(`^(?:${COMPOSTOS_DE_PECA.join('|')})(?:-|$)`);
const NOME_DE_PECA_COMPOSTO = new RegExp(`(?:^|-)(?:${COMPOSTOS_DE_PECA.join('|')})(?=-|$)`, 'g');
const PREFIXO_INTERNO = new RegExp(`^(?:${PREFIXOS_INTERNOS.join('|')})(?:-|$)`);
const SEGMENTO_INTERNO = new RegExp(`(?:^|-)(?:${SEGMENTOS_INTERNOS.join('|')})(?:-|$)`);
const SUFIXO_INTERNO = new RegExp(`(?:^|-)(?:${SUFIXOS_INTERNOS.join('|')})(?:-[a-z0-9]{1,2})?$`);
const SEGMENTO_DE_RASCUNHO = /(?:^|-)(?:minuta|rascunho|draft|intern[oa])(?:-|$)/;

function semSegmentosDeOrdem(canonico) {
  let nome = canonico;
  while (SEGMENTO_DE_ORDEM.test(nome)) nome = nome.replace(SEGMENTO_DE_ORDEM, '');
  return nome;
}

/** Rascunho pelo nome: `minuta`, `rascunho`, `draft`, `interno`. O composto de peça não conta:
 * `agravo-interno` é o recurso, não um rascunho. */
function nomeRascunho(name) {
  return leiturasDoNome(name).every((canonico) => SEGMENTO_DE_RASCUNHO.test(canonico.replace(NOME_DE_PECA_COMPOSTO, '')));
}

/** Nome de artefato interno: prefixo interno (salvo composto de peça no início) ou segmento interno. */
function nomeInterno(name) {
  return leiturasDoNome(name).every((leitura) => {
    const canonico = semSegmentosDeOrdem(leitura);
    const semCompostos = canonico.replace(NOME_DE_PECA_COMPOSTO, '');
    if (SEGMENTO_INTERNO.test(semCompostos) || SUFIXO_INTERNO.test(semCompostos)) return true;
    return PREFIXO_INTERNO.test(canonico) && !NOME_DE_PECA_COMPOSTO_NO_INICIO.test(canonico);
  });
}

function nomeDePeca(name) {
  return leiturasDoNome(name).some((canonico) => NOME_DE_PECA.test(canonico));
}

// Subpastas de output/ que guardam material de trabalho, não entrega. Só o trecho DEPOIS de
// `/output/` conta: uma pasta ancestral chamada `autos/` ou `Pesquisa/` não desliga o gate.
const SUBPASTA_INTERNA = /^(?:_[^/]*|drafts?|rascunhos?|internal|intern[oa]s?|revis(?:ao|ão)[^/]*|pesquisas?|precedentes|diagn[óo]stico|autos|fontes|refer[êe]ncias|anexos|notas|an[áa]lises?|fichamentos|resumos|c[áa]lculos|prazos|briefing|checklists|logs|e-?mails|mapas|mem[óo]ria|reuni[õo]es|trabalho|transcri[çc][õo]es|tmp|temp)$/i;
function emSubpastaInterna(filePath) {
  const caminho = String(filePath || '').replace(/\\/g, '/');
  const i = caminho.search(/\/output\//i);
  if (i < 0) return false;
  const dentro = caminho.slice(i + '/output/'.length).split('/');
  dentro.pop(); // o arquivo
  return dentro.some((pasta) => SUBPASTA_INTERNA.test(pasta));
}

// Fórmulas que só existem em artefato FINAL: endereçamento e fecho de peça, dispositivo de ato
// judicial, fecho de parecer, abertura de contrato, notificação, procuração, ata. Uma transcrição
// traz uma; a peça traz várias. Por isso a forma só conta com DUAS fórmulas em trechos DISTINTOS do
// texto (duas regexes casando a mesma frase valem uma). Sem flag `m` com `\s` que atravesse linhas:
// isso é quadrático em arquivo cheio de linhas em branco.
const FORMAS_DE_PECA = [
  // endereçamento
  /(?:excelent[íi]ssim[oa]s?|exm[oa]s?|ilustr[íi]ssim[oa]s?|ilm[oa]s?|merit[íi]ssim[oa]s?|mm)\.?(?:\s*\([ao]s?\))?\s+(?:senhor(?:a|es|as)?|sr(?:a|s|as)?|ju[íi]z[oa]?|ju[íi]za|doutor|dr)\b/iu,
  /^[ \t#*_>]*(?:ao|à|a)\s+(?:(?:mm\.?|dd\.?|douto|egr[ée]gi[oa]|colend[oa]|excelent[íi]ssim[oa]|d\.|r\.)\s+)?(?:ju[íi]zo|tribunal|turma|c[âa]mara|se[çc][ãa]o|plen[áa]rio|vara|junta|conselho)\b/imu,
  /\b(?:egr[ée]gi[oa]|colend[oa])\s+(?:tribunal|turma|c[âa]mara|se[çc][ãa]o|plen[áa]rio|corte|conselho)\b/iu,
  // corpo e fecho de peça de parte
  /\bv[êe]m,?\s+(?:respeitosamente,?\s+)?(?:por\s+(?:seus?|suas?)\s+(?:advogad|procurador|patron|defensor)[^\n]{0,80}?,?\s+)?(?:[àa]\s+(?:honrosa\s+)?presen[çc]a\s+de\s+v(?:ossa|\.)\s*ex(?:cel[êe]ncia|a\.?)|perante\s+(?:este|esse|vossa|v\.)|propor|ajuizar|opor|oferecer|apresentar|interpor|requerer|impetrar|promover|expor|manifestar)\b/iu,
  /\b(?:propor|ajuizar|opor|oferecer|apresentar|interpor|impetrar|promover|manejar)\s+(?:a|o|os|as)\s+presentes?\s+/iu,
  /\bpor\s+(?:seus?|suas?)\s+(?:advogad[oa]s?|procurador(?:a|es|as)?|patron[oa]s?|defensor(?:a|es|as)?|promotor(?:a|es|as)?|membro)\b[^\n]{0,60}?\b(?:que\s+esta\s+subscreve|infra[- ]?assinad[oa]s?|abaixo[- ]?assinad[oa]s?|ao\s+final\s+assinad[oa]s?|que\s+ao\s+final\s+subscreve)/iu,
  /\bno\s+uso\s+de\s+suas\s+atribui[çc][õo]es\b|\bincurs[oa]s?\s+nas?\s+(?:penas|san[çc][õo]es)\s+do\s+art/iu,
  /^[ \t#*_>]*rol\s+de\s+testemunhas\b/imu,
  /\bj[áa]\s+(?:devidamente\s+)?qualificad[oa]s?(?:\s*\([ao]s?\))?\s+nos\s+autos\b/iu,
  /\b(?:d[áa]|atribui)(?:-se|o-se)?\s+[àa]\s+(?:presente\s+)?causa\s+o\s+valor\b|\bvalor\s+da\s+causa\s*:/iu,
  /\bprotesta(?:ndo|m|-se)?\b[^\n]{0,40}?\bprovar\s+o\s+alegado\b/iu,
  /^[ \t#*_>]*(?:nestes|nesses)\s+termos\b|\btermos\s+em\s+que\b/imu,
  /\bpede(?:m|-se)?\s+(?:e\s+espera(?:m)?\s+)?deferimento\b|\b[ée]\s+o\s+que\s+se\s+requer\b/iu,
  /\b(?:ante\s+o|diante\s+d[oe]|pelo|por\s+todo\s+o|em\s+face\s+d[oe]|isto\s+posto|isso\s+posto|posto\s+isso|posto\s+isto)\s*(?:exposto)?,?\s+(?:requer|requerem|requer-se|pede|pedem)\b/iu,
  // ato judicial
  /^[ \t#*_>]*vistos(?:[.,]|\s+etc|\s*,?\s+relatados\s+e\s+discutidos|\s+os\s+autos|\s+e\s+examinados)/imu,
  /(?<!\p{L})[é]\s+o\s+(?:breve\s+)?relat(?:[óo]rio|o)\b|(?<!\p{L})[é]\s+a\s+s[íi]ntese\s+do\s+necess[áa]rio\b/iu,
  /^[ \t#*_>]*(?:decido|passo\s+a\s+decidir|fundamento\s+e\s+decido)[.:]?\s*$|(?<!\p{L})[é]\s+(?:o\s+voto|como\s+voto)\b/imu,
  /\b(?:ante\s+o|diante\s+d[oe]|pelo|por\s+todo\s+o|em\s+face\s+d[oe]|isto\s+posto|isso\s+posto|posto\s+isso|posto\s+isto)\s*(?:exposto)?,?\s+(?:julgo|defiro|indefiro|concedo|denego|absolvo|condeno|pronuncio|impronuncio|nego|dou|conhe[çc]o|homologo|decreto|rejeito|recebo|acolho|extingo|declaro|determino|nega-se|d[áa]-se|conhece-se|acolhe-se|rejeita-se|defere-se|indefere-se|nego-lhe|dou-lhe)\b/iu,
  /\bjulgo\s+(?:parcialmente\s+)?(?:procedentes?|improcedentes?|extint[oa]s?|prejudicad[oa]s?)\b/iu,
  /\b(?:publique-se|registre-se|intime(?:m)?-se|cumpra-se|arquive(?:m)?-se|cite-se|citem-se)[.,;]?\s*(?:publique-se|registre-se|intime(?:m)?-se|cumpra-se|arquive(?:m)?-se|cite-se|citem-se)\b|\bp\.\s*r\.\s*i\./iu,
  /\bacordam,?\s+(?:os|as|em|na|no)\b|\bproferir\s+a\s+seguinte\s+decis[ãa]o\b|\bv\.\s*u\.|\bvota[çc][ãa]o\s+un[âa]nime\b|\b(?:por|[àa])\s+unanimidade\b|\brelat[óo]rio\s+se\s+adota\b/iu,
  // parecer e Ministério Público
  /(?<!\p{L})[é]\s+o\s+(?:nosso\s+)?parecer\b/iu,
  /\bs\.\s*m\.\s*j\.|\bsalvo\s+melhor\s+ju[íi]zo\b/iu,
  /\b(?:consulta-nos|consulente\s*:|formula\s+a\s+presente\s+consulta|trata-se\s+de\s+consulta)/iu,
  /\b(?:ante\s+o|diante\s+d[oe]|pelo)\s+exposto,?\s+(?:conclui-se|conclu[íi]mos|opina-se|opinamos|respond(?:e-se|emos))\b/iu,
  /\b(?:opina|manifesta-se|requer|promove)\s+o\s+(?:minist[ée]rio\s+p[úu]blico|parquet)\b|\bo\s+minist[ée]rio\s+p[úu]blico\b[^\n]{0,60}?\b(?:requer|promove|oferece|denuncia|manifesta-se|opina)\b/iu,
  /\bvem\s+oferecer\s+(?:den[úu]ncia|queixa-crime)\b|\b(?:promove|requer)\s+o\s+arquivamento\s+do\s+inqu[ée]rito\b/iu,
  // contrato e instrumento
  /\bcl[áa]usula\s+(?:primeira|1[ªa°º.]?)\b|^[ \t#*_>]*(?:1|primeira)\s*[.º°ªa-]?\s*(?:d[oa]\s+)?objeto\b/imu,
  /\bpelo\s+presente\s+instrumento\b/iu,
  /\bt[êe]m\s+entre\s+si\s+just[oa]s?\s+e\s+(?:contratad[oa]s?|acordad[oa]s?|aven[çc]ad[oa]s?)\b|\bpor\s+estarem\s+(?:assim\s+)?just[oa]s\s+e\s+(?:contratad[oa]s|acordad[oa]s)\b/iu,
  /\bresolvem,?\s+de\s+comum\s+acordo,?\s+(?:celebrar|rescindir|distratar|firmar)\b|\b(?:assinam|firmam)\s+o\s+presente\b/iu,
  /\bem\s+(?:duas|2|tr[êe]s|3)\s+vias\s+de\s+igual\s+teor\b|\b(?:elegem|elege-se|fica\s+eleito)\s+o\s+foro\b/iu,
  /\b(?:contratante|contratad[ao]|locador|locat[áa]ri[oa]|outorgante|outorgad[oa]|notificante|notificad[oa]|interpelante|interpelad[oa]|comprador|vendedor|cedente|cession[áa]ri[oa]|mutuante|mutu[áa]ri[oa]|comodante|comodat[áa]ri[oa]|empregador|empregad[oa])\s*(?:\([^)\n]{0,30}\))?\s*:/iu,
  // notificação, procuração, escritura, ata, declaração
  /\bfica\s+v\.?\s*s(?:a|\.)?\.?\s+notificad[oa]\b|\bserve\s+a\s+presente\s+para\s+(?:notificar|interpelar|constituir)\b|\bvem,?\s+pela\s+presente,?\s+(?:notificar|interpelar)\b|\bnotific(?:o|amos)\s+v(?:\.|ossa)\s*s(?:\.|enhoria)/iu,
  /\bmedidas\s+(?:judiciais|legais)\s+cab[íi]veis\b|\bsob\s+pena\s+de\s+(?:ado[çc][ãa]o|ajuizamento|protesto)\b/iu,
  /\bnomeia\s+e\s+constitui\s+(?:seu|sua|seus|suas)\s+bastante|\bconstitu(?:i|em)\b[^\n]{0,60}?\bprocurador(?:es|a|as)?\b|\bad\s+judicia\b/iu,
  /\bsaibam\s+quantos\s+este\s+p[úu]blico\s+instrumento\b|\bnada\s+mais\s+havendo\s+a\s+tratar\b/iu,
  /\bdeclaro,?\s+(?:para\s+os\s+devidos\s+fins|sob\s+as\s+penas\s+da\s+lei)\b/iu,
];

/** Forma de peça: duas fórmulas em trechos DISTINTOS. Uma frase transcrita, ainda que case duas
 * regexes ("Ante o exposto, JULGO PROCEDENTE"), vale uma. */
function formaDePeca(text) {
  if (!text) return false;
  const trechos = [];
  for (const formula of FORMAS_DE_PECA) {
    const m = formula.exec(text);
    if (!m) continue;
    const inicio = m.index;
    const fim = inicio + m[0].length;
    if (trechos.some(([a, b]) => inicio < b && fim > a)) continue;
    trechos.push([inicio, fim]);
    if (trechos.length >= 2) return true;
  }
  return false;
}
// ── fim do bloco compartilhado ─────────────────────────────────────────────────────────────────

// ── Citações materiais: extração com chave normalizada ─────────────────────────────────────────
// O manifesto tem de cobrir CADA citação do texto, não "ao menos uma". Cada citação sai com uma
// chave (classe + número, mais tribunal e diploma quando o texto os traz) que se compara ao `title`
// de cada entrada do manifesto. O texto é lido em NFC e desacentuado preservando posições, para as
// regexes serem ASCII e "Súmula", "Sumula" e "SÚMULA" caírem no mesmo padrão.
// Guardas herdadas do src/citacao-gate.js, nascidas de falso positivo medido: sigla de código exige
// fronteira à direita ("CE" não casa em "CESSAÇÃO"); "lei" só é diploma com número ("previsto em
// lei. Inteligência do art. 96" não é citação).

/** Sem acento, mesma quantidade de caracteres: `é`→`e`, `ç`→`c`. Índices continuam válidos. */
function desacentuarPreservandoPosicoes(text) {
  return text.replace(/[À-ɏ]/g, (c) => {
    const base = c.normalize('NFD')[0];
    return base && base.length === 1 ? base : c;
  });
}

const SIGLA_DE_CODIGO = 'cf|crfb|cr\\/\\d{2,4}|ncpc|cpc|cpp|clt|cdc|ctn|ctb|cpb|cp|ccb|cc|ce|lep|eca|lindb';
const ALIAS_DE_SIGLA = { crfb: 'cf', cr: 'cf', ncpc: 'cpc', cpb: 'cp', ccb: 'cc' };
const DIPLOMA_POR_EXTENSO = [
  ['cf', 'constituicao(?:\\s+(?:federal|da\\s+republica(?:\\s+federativa(?:\\s+do\\s+brasil)?)?))?(?:\\s+de\\s+1988)?|carta\\s+magna|lei\\s+maior'],
  ['cpc', 'codigo\\s+de\\s+processo\\s+civil'],
  ['cpp', 'codigo\\s+de\\s+processo\\s+penal'],
  ['cc', 'codigo\\s+civil'],
  ['cp', 'codigo\\s+penal'],
  ['cdc', 'codigo\\s+de\\s+defesa\\s+do\\s+consumidor'],
  ['clt', 'consolidacao\\s+das\\s+leis\\s+do\\s+trabalho'],
  ['ctn', 'codigo\\s+tributario\\s+nacional'],
  ['ctb', 'codigo\\s+de\\s+transito(?:\\s+brasileiro)?'],
  ['ce', 'codigo\\s+eleitoral'],
  ['lep', 'lei\\s+de\\s+execucao\\s+penal'],
  ['eca', 'estatuto\\s+da\\s+crianca(?:\\s+e\\s+do\\s+adolescente)?'],
  ['lindb', 'lei\\s+de\\s+introducao(?:\\s+as\\s+normas\\s+do\\s+direito\\s+brasileiro)?'],
];
const EXTENSO = DIPLOMA_POR_EXTENSO.map(([, rx]) => rx).join('|');
// Lei numerada ↔ sigla do código: "Lei 13.105/2015, art. 300" cobre "art. 300 do CPC" e vice-versa.
const LEI_DO_CODIGO = { 13105: 'cpc', 10406: 'cc', 5452: 'clt', 8078: 'cdc', 5172: 'ctn', 3689: 'cpp', 2848: 'cp', 7210: 'lep', 8069: 'eca', 4737: 'ce', 9503: 'ctb', 4657: 'lindb', 1988: 'cf' };
// Lei conhecida pelo apelido: "art. 33 da Lei de Drogas", "Lei Maria da Penha, art. 22".
const APELIDOS_DE_LEI = [
  ['11343', 'drogas|antidrogas'], ['11340', 'maria\\s+da\\s+penha'], ['8429', 'improbidade(?:\\s+administrativa)?'],
  ['12846', 'anticorrupcao'], ['8245', 'inquilinato|locacoes'], ['13709', 'lgpd|geral\\s+de\\s+protecao\\s+de\\s+dados'],
  ['6830', 'execuc(?:ao|oes)\\s+fisca(?:l|is)'], ['9099', 'juizados\\s+especiais'], ['12016', 'mandado\\s+de\\s+seguranca'],
  ['7347', 'acao\\s+civil\\s+publica'], ['9307', 'arbitragem'], ['11101', 'falencias?|recuperacao\\s+judicial'],
  ['9656', 'planos\\s+de\\s+saude'], ['8213', 'beneficios\\s+da\\s+previdencia(?:\\s+social)?|planos\\s+de\\s+beneficios'],
  ['8212', 'custeio(?:\\s+da\\s+seguridade)?'], ['10741', 'estatuto\\s+d[oa]\\s+(?:pessoa\\s+)?idos[oa]'],
  ['8906', 'estatuto\\s+da\\s+(?:oab|advocacia)'], ['8072', 'crimes\\s+hediondos'], ['13869', 'abuso\\s+de\\s+autoridade'],
  ['9613', 'lavagem(?:\\s+de\\s+dinheiro)?'], ['10826', 'estatuto\\s+do\\s+desarmamento'], ['13964', 'pacote\\s+anticrime'],
  ['13467', 'reforma\\s+trabalhista'], ['12965', 'marco\\s+civil(?:\\s+da\\s+internet)?'], ['12651', 'codigo\\s+florestal'],
  ['10257', 'estatuto\\s+da\\s+cidade'], ['14133', 'licitacoes(?:\\s+e\\s+contratos)?'],
];
const APELIDO = APELIDOS_DE_LEI.map(([, rx]) => rx).join('|');
function leiDoApelido(trecho) {
  const t = trecho.toLowerCase();
  for (const [numero, rx] of APELIDOS_DE_LEI) if (new RegExp(`(?:^|[^a-z])(?:${rx})(?![a-z])`).test(t)) return numero;
  return '';
}
const CODIGO_DA_LEI = Object.fromEntries(Object.entries(LEI_DO_CODIGO).map(([n, s]) => [s, n]));

const DIPLOMA_NUMERADO = '(?:lei\\s+complementar|lc|lei|decreto-lei|dl|decreto|dec\\.?|resolucao|res\\.?|portaria|port\\.?|instrucao\\s+normativa|in|medida\\s+provisoria|mp|emenda\\s+constitucional|ec)';
// Órgão entre o nome e o número ("IN RFB 2.110", "Portaria MTE 671", "Resolução CNJ 455"): até
// dois tokens curtos que não sejam preposição.
const ORGAO_DO_DIPLOMA = '(?:\\s+(?!d[eao]s?\\b|n[o°º.]*(?:\\s|$))[a-z]{2,12}\\.?){0,2}';
const NUMERO_DE_LEI = '(?:n[o°º.]*\\s*)?(\\d[\\d.]*(?:\\/\\d{2,4})?)';
const ORGAO_JULGADOR = '(?:\\s*(?:do|da|de|\\/|-)\\s*(stf|stj|tst|tse|stm|tnu|carf|crps|tcu|trf\\d?|trt\\d{0,2}|tj[a-z]{2}))?';
// Enumeração de artigos: "arts. 5º e 6º", "arts. 186, 187 e 927", "art. 5º e art. 6º". Um número
// seguido de "ª", "parte", "inciso" ou "%" não é outro artigo.
const NUMERO_DE_ARTIGO = '\\d+(?:\\.\\d{3})*(?:\\.?\\s*[o°º])?(?:-[a-z])?';
const ENUMERACAO_DE_ARTIGOS = `${NUMERO_DE_ARTIGO}(?:(?:,\\s*[IVXLC]+(?:,\\s*[a-z](?![a-z]))?)*\\s*(?:,\\s*(?:e|ou)?|e|ou)\\s*(?:[oa]s?\\s+)?(?:art(?:igo)?s?\\.?\\s*)?(?!\\d+\\s*(?:[ªa](?![a-z])|parte|inciso|incisos|paragrafo|§|%))${NUMERO_DE_ARTIGO})*`;
const ARTIGO = `\\bart(?:igo)?s?\\.?\\s*(${ENUMERACAO_DE_ARTIGOS})`;
const ENUMERACAO_SIMPLES = '\\d+(?:\\s*(?:,|e|ou)\\s*(?:n[o°º.]*\\s*)?\\d+)*';
// Cada elemento admite o sufixo de letra do artigo ("396-A e 401"): sem ele a enumeração parava
// em "396" e o título "CPP, arts. 396-A e 401" não cobria o art. 401 (run de 16/09/2026).
const ENUMERACAO_COM_PONTO = '\\d[\\d.]*(?:-[a-z])?(?:\\s*(?:,|e|ou)\\s*(?:n[o°º.]*\\s*)?\\d[\\d.]*(?:-[a-z])?)*';

function numerosDe(enumeracao) {
  return (enumeracao.match(/\d+(?:\.\d{3})*/g) || []).map((n) => n.replace(/\./g, ''));
}
function siglaCanonica(bruta) {
  const s = bruta.toLowerCase().replace(/\/\d+$/, '');
  return ALIAS_DE_SIGLA[s] || s;
}
function siglaDoExtenso(trecho) {
  const t = trecho.toLowerCase();
  for (const [sigla, rx] of DIPLOMA_POR_EXTENSO) if (new RegExp(`^(?:${rx})$`).test(t)) return sigla;
  return '';
}

// Classes de acórdão sem ambiguidade com abreviatura corrente ("AP 1201" é apartamento, "SL 1201"
// é sala, "RO" é UF). As constitucionais aceitam número curto ("ADPF 130", "ADC 16").
const CLASSE_CURTA = 'ADIn|ADI|ADC|ADPF|ADO|Rcl|STA|IRDR|IAC|Pet|Inq';
const CLASSE_LONGA = 'REsp|AREsp|EREsp|RHC|HC|RE|ARE|RMS|MS|RR|AIRR|ROT|REspe|RvCr?';
const PREFIXO_DE_ACORDAO = '(?:(?:AgRg|AgInt|AgR|EDcl|ED|EI|EDv)\\s+(?:no|nos|na|nas|em)\\s+)?';
const SUFIXO_DE_CLASSE = '(?:-[A-Za-z]{1,5})*';
const CLASSE_POR_EXTENSO = [['resp','recursos?[\\s-]+especia(?:l|is)(?![\\s-]+eleitora)'],['aresp','agravos?[\\s-]+em[\\s-]+recursos?[\\s-]+especia(?:l|is)'],['re','recursos?[\\s-]+extraordinari[oa]s?'],['are','agravos?[\\s-]+em[\\s-]+recursos?[\\s-]+extraordinari[oa]s?'],['hc','habeas[\\s-]+corpus'],['rhc','recursos?[\\s-]+(?:ordinarios?[\\s-]+)?em[\\s-]+habeas[\\s-]+corpus'],['ms','mandados?[\\s-]+de[\\s-]+seguranca'],['rms','recursos?[\\s-]+(?:ordinarios?[\\s-]+)?em[\\s-]+mandados?[\\s-]+de[\\s-]+seguranca'],['adi','ac(?:ao|oes)[\\s-]+diretas?[\\s-]+de[\\s-]+inconstitucionalidade(?![\\s-]+por)'],['ado','ac(?:ao|oes)[\\s-]+diretas?[\\s-]+de[\\s-]+inconstitucionalidade[\\s-]+por[\\s-]+omissao'],['adc','ac(?:ao|oes)[\\s-]+declaratorias?[\\s-]+de[\\s-]+constitucionalidade'],['adpf','arguic(?:ao|oes)[\\s-]+de[\\s-]+descumprimento(?:[\\s-]+de[\\s-]+preceito[\\s-]+fundamental)?'],['rcl','reclamac(?:ao|oes)[\\s-]+constitucionais?'],['rr','recursos?[\\s-]+de[\\s-]+revista'],['airr','agravos?[\\s-]+de[\\s-]+instrumento[\\s-]+em[\\s-]+recursos?[\\s-]+de[\\s-]+revista'],['respe','recursos?[\\s-]+especia(?:l|is)[\\s-]+eleitora(?:l|is)'],['irdr','incidentes?[\\s-]+de[\\s-]+resolucao[\\s-]+de[\\s-]+demandas[\\s-]+repetitivas'],['iac','incidentes?[\\s-]+de[\\s-]+assuncao[\\s-]+de[\\s-]+competencia'],['rvcr','revis(?:ao|oes)[\\s-]+crimina(?:l|is)']];
const CLASSE_EXTENSO = CLASSE_POR_EXTENSO.map(([, rx]) => rx).join('|');
function classeDoExtenso(trecho) {
  const t = trecho.toLowerCase();
  for (const [classe, rx] of CLASSE_POR_EXTENSO) if (new RegExp(`^(?:${rx})$`).test(t)) return classe;
  return '';
}
const NUMERO_DE_ACORDAO = '(\\d(?:[\\d.]|-(?=\\d))*)(?:\\s*[-/]\\s*([A-Z]{2})\\b)?';

// Classes de tribunal local, só com a numeração única do CNJ ("Apelação Criminal nº
// 1517288-67.2019.8.26.0050"): "apelação" e "agravo" em prosa são palavras comuns, e o número
// antigo de apelação é curto e ambíguo. Medido no run de 16/09/2026: duas apelações do TJSP
// citadas na peça passavam fora da rede, e um acórdão inventado com esse formato passaria junto.
const CLASSE_TJ_POR_EXTENSO = [['apelacao', 'apelac(?:ao|oes)(?:[\\s-]+(?:criminal|criminais|civel|civeis))?'], ['agravo-de-instrumento', 'agravos?[\\s-]+de[\\s-]+instrumento(?![\\s-]+em)'], ['agravo-em-execucao', 'agravos?[\\s-]+em[\\s-]+execucao(?:[\\s-]+penal)?'], ['rese', 'recursos?[\\s-]+em[\\s-]+sentido[\\s-]+estrito'], ['embargos-infringentes', 'embargos[\\s-]+infringentes(?:[\\s-]+e[\\s-]+de[\\s-]+nulidade)?']];
const CLASSE_TJ = CLASSE_TJ_POR_EXTENSO.map(([, rx]) => rx).join('|');
const NUMERO_CNJ = '(\\d{7}-\\d{2}\\.\\d{4}\\.\\d\\.\\d{2}\\.\\d{4})';
function classeTj(trecho) {
  const t = trecho.toLowerCase();
  for (const [classe, rx] of CLASSE_TJ_POR_EXTENSO) if (new RegExp(`^(?:${rx})$`).test(t)) return classe;
  return '';
}

const PADROES_DE_CITACAO = [
  { // "Súmula 7/STJ", "Súmula Vinculante 11", "SV 11", "Enunciado 331 do TST", "Súmulas 5 e 7 do STJ"
    regex: new RegExp(`\\b(sumulas?(?:\\s+vinculantes?)?|sum\\.?|sv|enunciados?|verbetes?)\\s*(?:n[o°º.]*\\s*)?(${ENUMERACAO_SIMPLES})(?:\\s+da\\s+sumula)?${ORGAO_JULGADOR}`, 'gi'),
    chaves: (m) => numerosDe(m[2]).map((numero) => ({ classe: 'sumula', numero, vinculante: /vinculante|^sv$/i.test(m[1]), orgao: (m[3] || '').toLowerCase() })),
  },
  { // "OJ 394 da SDI-1", "Orientação Jurisprudencial nº 394"
    regex: new RegExp(`\\b(?:oj|orientac(?:ao|oes)\\s+jurisprudenciais?|orientacao\\s+jurisprudencial)\\s*(?:n[o°º.]*\\s*)?(${ENUMERACAO_SIMPLES})`, 'gi'),
    chaves: (m) => numerosDe(m[1]).map((numero) => ({ classe: 'oj', numero })),
  },
  { // "Precedente Normativo 120", "PN 120"
    regex: new RegExp(`\\b(?:pn|precedentes?\\s+normativos?)\\s*(?:n[o°º.]*\\s*)?(${ENUMERACAO_SIMPLES})`, 'gi'),
    chaves: (m) => numerosDe(m[1]).map((numero) => ({ classe: 'pn', numero })),
  },
  { // "Tema 1.234 do STJ", "Tema repetitivo 988", "Tema RG 1.075", "Temas 988 e 1.234"
    regex: new RegExp(`\\btemas?(?:\\s+(?:rg|repetitivos?|de\\s+rg|de\\s+repercussao\\s+geral))?\\s*(?:n[o°º.]*\\s*)?(${ENUMERACAO_COM_PONTO})(?:\\s*(?:\\/rg|rg))?${ORGAO_JULGADOR}`, 'gi'),
    chaves: (m, plano) => {
      const antes = plano.slice(Math.max(0, m.index - 40), m.index);
      const depois = plano.slice(m.index + m[0].length, m.index + m[0].length + 3);
      const titulo = /(?:^|\n)[ \t#*_>]*$/.test(antes) && /^\s*(?::|-|–|—|$|\r?\n)/.test(depois);
      const qualificado = /rg|repetitiv|repercussao/i.test(m[0]) || !!m[2];
      return numerosDe(m[1]).filter((n) => !titulo && (n.length >= 2 || qualificado)).map((numero) => ({ classe: 'tema', numero, orgao: (m[2] || '').toLowerCase() }));
    },
  },
  { // "Apelação Criminal nº 1517288-67.2019.8.26.0050", "Agravo em Execução Penal 0001234-56.2024.8.26.0000"
    regex: new RegExp(`\\b(${CLASSE_TJ})(?![a-z])\\s*(?:n[o°º.]*\\s*)?${NUMERO_CNJ}${ORGAO_JULGADOR}`, 'gi'),
    chaves: (m) => [{ classe: classeTj(m[1]), numero: m[2].replace(/\D/g, ''), corridas: m[2].split(/\D+/).filter(Boolean), uf: '', orgao: (m[3] || '').toLowerCase() }],
  },
  { // "REsp 1.234.567/SP", "AgRg no HC 654.321/MG", "ADPF 130", "ADIn 4.277", "AIRR-10553-79.2013.5.15.0090"
    regex: new RegExp(`\\b${PREFIXO_DE_ACORDAO}(?:(${CLASSE_CURTA})|(${CLASSE_LONGA}))${SUFIXO_DE_CLASSE}(?![a-z])[\\s-]*(?:n[o°º.]*\\s*)?${NUMERO_DE_ACORDAO}${ORGAO_JULGADOR}`, 'gi'),
    chaves: (m, plano) => {
      const digitos = m[3].replace(/\D/g, '');
      if (digitos.length < (m[1] ? 2 : 3)) return [];
      const antes = plano.slice(Math.max(0, m.index - 1), m.index);
      if (antes === '/' || /^\d{5}-\d{3}$/.test(m[3])) return []; // "Campo Grande/MS 79002-000" é endereço, não MS
      const classe = (m[1] || m[2]).toLowerCase().replace(/^adin$/, 'adi').replace(/^rvc$/, 'rvcr');
      return [{ classe, numero: digitos, corridas: m[3].split(/\D+/).filter(Boolean), uf: m[4] || '', orgao: (m[5] || '').toLowerCase() }];
    },
  },
  { // classe por extenso: "Recurso Especial nº 1.234.567/SP", "Habeas Corpus 123.456", "Ação Direta de Inconstitucionalidade 4.277"
    regex: new RegExp(`\\b(${CLASSE_EXTENSO})(?![a-z])\\s*(?:n[o°º.]*\\s*)?${NUMERO_DE_ACORDAO}${ORGAO_JULGADOR}`, 'gi'),
    chaves: (m) => {
      const digitos = m[2].replace(/\D/g, '');
      return digitos.length < 2 ? [] : [{ classe: classeDoExtenso(m[1]), numero: digitos, corridas: m[2].split(/\D+/).filter(Boolean), uf: m[3] || '', orgao: (m[4] || '').toLowerCase() }];
    },
  },
  { // diploma antes do artigo: "CPC, art. 300", "Lei 9.504/1997, art. 41", "IN RFB 2.110/2022, art. 10", "Código Civil, art. 186"
    regex: new RegExp(`\\b(?:(${DIPLOMA_NUMERADO})(?![a-z])${ORGAO_DO_DIPLOMA}\\s*${NUMERO_DE_LEI}|(${SIGLA_DE_CODIGO})(?![a-z])|(${EXTENSO})(?![a-z])|lei\\s+(?:d[eao]s?\\s+)?(${APELIDO})(?![a-z]))(?:[^\\n;.]|\\.(?!\\s)){0,45}?${ARTIGO}`, 'gi'),
    // Sigla de código só em maiúsculas: "cf." é "conforme", não a Constituição.
    chaves: (m) => (m[3] && m[3] !== m[3].toUpperCase() ? [] : numerosDe(m[6]).map((artigo) => ({ classe: 'lei', artigo, diploma: m[3] ? siglaCanonica(m[3]) : m[4] ? siglaDoExtenso(m[4]) : 'lei', numeroLei: m[5] ? leiDoApelido(m[5]) : (m[2] || '') }))),
  },
  { // artigo antes do diploma: "art. 373, I, do CPC", "arts. 5º e 6º da CF", "art. 927 do Código Civil", "art. 41 da Lei nº 8.213/91"
    regex: new RegExp(`${ARTIGO}(?:(?!\\bart)(?:[^\\n;.]|\\.(?!\\s))){0,60}?\\b(?:d[oa]s?\\s+)?(?:(${SIGLA_DE_CODIGO})(?![a-z])|(${EXTENSO})(?![a-z])|(${DIPLOMA_NUMERADO})(?![a-z])${ORGAO_DO_DIPLOMA}\\s*${NUMERO_DE_LEI}|lei\\s+(?:d[eao]s?\\s+)?(${APELIDO})(?![a-z]))`, 'gi'),
    chaves: (m) => (m[2] && m[2] !== m[2].toUpperCase() ? [] : numerosDe(m[1]).map((artigo) => ({ classe: 'lei', artigo, diploma: m[2] ? siglaCanonica(m[2]) : m[3] ? siglaDoExtenso(m[3]) : 'lei', numeroLei: m[6] ? leiDoApelido(m[6]) : (m[5] || '') }))),
  },
];

/** Cada citação material do texto, com posição, linha e chave. Sobreposições ficam com a primeira. */
function extrairCitacoesMateriais(text) {
  const plano = desacentuarPreservandoPosicoes(text);
  const achados = [];
  for (const padrao of PADROES_DE_CITACAO) {
    padrao.regex.lastIndex = 0;
    let m;
    while ((m = padrao.regex.exec(plano))) {
      for (const chave of padrao.chaves(m, plano)) {
        achados.push({ bruto: text.slice(m.index, m.index + m[0].length).replace(/\s+/g, ' ').trim(), inicio: m.index, fim: m.index + m[0].length, ...chave });
      }
    }
  }
  achados.sort((a, b) => a.inicio - b.inicio || b.fim - a.fim);
  const unicos = [];
  let linha = 1;
  let cursor = 0;
  for (const c of achados) {
    const ultimo = unicos[unicos.length - 1];
    // Enumeração ("arts. 5º e 6º") gera várias chaves no MESMO trecho; padrões diferentes no mesmo
    // trecho ("CPC, art. 300" e "art. 300 ... do CPP") não.
    if (ultimo && c.inicio < ultimo.fim && !(c.inicio === ultimo.inicio && c.fim === ultimo.fim)) continue;
    for (; cursor < c.inicio; cursor += 1) if (text.charCodeAt(cursor) === 10) linha += 1;
    c.linha = linha;
    unicos.push(c);
  }
  return unicos;
}

// O título do manifesto pode vir em sigla ou por extenso, no singular ou no plural; os dois lados valem.
const SINONIMOS_DE_CLASSE = {
  resp: ['recursos?[\\s-]+especia(?:l|is)'], aresp: ['agravos?[\\s-]+em[\\s-]+recursos?[\\s-]+especia(?:l|is)', 'agravos?[\\s-]+em[\\s-]+resp'],
  eresp: ['embargos[\\s-]+de[\\s-]+divergencia'], re: ['recursos?[\\s-]+extraordinari[oa]s?'],
  are: ['agravos?[\\s-]+em[\\s-]+recursos?[\\s-]+extraordinari[oa]s?', 'agravos?[\\s-]+em[\\s-]+re'], hc: ['habeas[\\s-]+corpus'],
  rhc: ['recursos?[\\s-]+(?:ordinarios?[\\s-]+)?em[\\s-]+habeas[\\s-]+corpus'], ms: ['mandados?[\\s-]+de[\\s-]+seguranca'],
  rms: ['recursos?[\\s-]+(?:ordinarios?[\\s-]+)?em[\\s-]+mandados?[\\s-]+de[\\s-]+seguranca'],
  adi: ['adin', 'ac(?:ao|oes)[\\s-]+diretas?[\\s-]+de[\\s-]+inconstitucionalidade'], adc: ['ac(?:ao|oes)[\\s-]+declaratorias?[\\s-]+de[\\s-]+constitucionalidade'],
  adpf: ['arguic(?:ao|oes)[\\s-]+de[\\s-]+descumprimento'], ado: ['ac(?:ao|oes)[\\s-]+diretas?[\\s-]+de[\\s-]+inconstitucionalidade[\\s-]+por[\\s-]+omissao'],
  rcl: ['reclamac(?:ao|oes)(?:[\\s-]+constitucionais?)?'], rr: ['recursos?[\\s-]+de[\\s-]+revista'],
  airr: ['agravos?[\\s-]+de[\\s-]+instrumento[\\s-]+em[\\s-]+recursos?[\\s-]+de[\\s-]+revista'], rot: ['recursos?[\\s-]+ordinarios?(?:[\\s-]+trabalhistas?)?'],
  irdr: ['incidentes?[\\s-]+de[\\s-]+resolucao[\\s-]+de[\\s-]+demandas[\\s-]+repetitivas'], iac: ['incidentes?[\\s-]+de[\\s-]+assuncao[\\s-]+de[\\s-]+competencia'],
  respe: ['recursos?[\\s-]+especia(?:l|is)[\\s-]+eleitora(?:l|is)', 'resp[\\s-]+eleitoral'], rvcr: ['rvc', 'revis(?:ao|oes)[\\s-]+crimina(?:l|is)'],
  sta: ['suspens(?:ao|oes)[\\s-]+de[\\s-]+tutela'], pet: ['petic(?:ao|oes)'], inq: ['inqueritos?'],
  apelacao: ['apelac(?:ao|oes)', 'apr', 'apl', 'apc'], 'agravo-de-instrumento': ['agravos?[\\s-]+de[\\s-]+instrumento', 'ai'],
  'agravo-em-execucao': ['agravos?[\\s-]+em[\\s-]+execucao', 'agepn', 'agex'], rese: ['recursos?[\\s-]+em[\\s-]+sentido[\\s-]+estrito'],
  'embargos-infringentes': ['embargos[\\s-]+infringentes'],
  sumula: ['sumulas?', 'sum', 'sv', 'enunciados?', 'verbetes?'], tema: ['temas?'],
  oj: ['oj', 'orientac(?:ao|oes)[\\s-]+jurisprudenciais?', 'orientacao[\\s-]+jurisprudencial'], pn: ['pn', 'precedentes?[\\s-]+normativos?'],
};

function semAcento(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Números que vêm DEPOIS de um token de classe no título: "Súmulas 5 e 7" → ['5', '7']. */
function numerosApos(texto, tokens) {
  const rx = new RegExp(`(?:^|[^a-z])(?:${tokens.join('|')})\\.?\\s*(?:(?:vinculantes?|repetitivos?|rg|de\\s+rg|de\\s+repercussao\\s+geral)\\s+)?(?:n[o°º.]*\\s*)?(${ENUMERACAO_COM_PONTO})`, 'g');
  const numeros = [];
  let m;
  while ((m = rx.exec(texto))) numeros.push(...numerosDe(m[1]));
  return numeros;
}
const semZeros = (n) => n.replace(/^0+(?=\d)/, '');
function temNumeroApos(texto, tokens, numero) {
  return numerosApos(texto, tokens).some((n) => semZeros(n) === semZeros(numero));
}
/** Acórdão: as corridas de dígitos do título têm de conter as da citação, em sequência
 * ("1.234.567" ↔ "1234567"; "10553-79.2013" ↔ "0010553-79.2013"). */
function temNumeroDeAcordao(texto, citacao) {
  const alvo = (citacao.corridas || [citacao.numero]).map(semZeros).join('');
  const corridas = (texto.match(/\d+/g) || []).map(semZeros);
  for (let i = 0; i < corridas.length; i += 1) {
    let junto = '';
    for (let j = i; j < corridas.length && junto.length < alvo.length; j += 1) {
      junto += corridas[j];
      if (junto === alvo) return true;
    }
  }
  return false;
}
const TRIBUNAL_NO_TITULO = /(?:^|[^a-z])(stf|supremo|stj|superior\s+tribunal\s+de\s+justica|tst|tse|stm|tnu|carf|crps|tcu|trf\d?|trt\d{0,2}|tj[a-z]{2})(?![a-z])/g;
function tribunaisDo(texto) {
  const achados = new Set();
  let m;
  TRIBUNAL_NO_TITULO.lastIndex = 0;
  while ((m = TRIBUNAL_NO_TITULO.exec(texto))) achados.add(m[1] === 'supremo' ? 'stf' : m[1].startsWith('superior') ? 'stj' : m[1]);
  return achados;
}
function tribunalCompativel(texto, orgao) {
  if (!orgao) return true;
  const doTitulo = tribunaisDo(texto);
  return doTitulo.size === 0 || doTitulo.has(orgao);
}
/** "13.105" no título são as corridas 13|105: o número procurado é uma corrida ou a junção de vizinhas. */
function temNumeroCorrido(texto, digitos) {
  const alvo = semZeros(digitos);
  const corridas = (texto.match(/\d+/g) || []);
  for (let i = 0; i < corridas.length; i += 1) {
    let junto = '';
    for (let j = i; j < corridas.length && junto.length < alvo.length; j += 1) {
      junto += j === i ? semZeros(corridas[j]) : corridas[j];
      if (junto === alvo) return true;
    }
  }
  return false;
}
function temDiploma(texto, citacao) {
  const numero = (citacao.numeroLei || '').split('/')[0].replace(/\D/g, '');
  if (numero) {
    // Diploma numerado: é o NÚMERO que identifica; "lei" sozinha não distingue. A lei que É um
    // código também é coberta pela sigla ou pelo nome do código; a lei com apelido, pelo apelido.
    if (temNumeroCorrido(texto, numero)) return true;
    if (leiDoApelido(texto) === numero) return true;
    const sigla = LEI_DO_CODIGO[numero];
    return !!sigla && (new RegExp(`(?:^|[^a-z])(?:${sigla}|${Object.keys(ALIAS_DE_SIGLA).filter((a) => ALIAS_DE_SIGLA[a] === sigla).join('|')})(?:\\/\\d{2,4})?(?![a-z])`).test(texto)
      || new RegExp(`(?:^|[^a-z])(?:${DIPLOMA_POR_EXTENSO.find(([s]) => s === sigla)[1]})(?![a-z])`).test(texto));
  }
  const sigla = citacao.diploma;
  const aliases = [sigla, ...Object.keys(ALIAS_DE_SIGLA).filter((a) => ALIAS_DE_SIGLA[a] === sigla)];
  if (new RegExp(`(?:^|[^a-z])(?:${aliases.join('|')})(?:\\/\\d{2,4})?(?![a-z])`).test(texto)) return true;
  const extenso = DIPLOMA_POR_EXTENSO.find(([s]) => s === sigla);
  if (extenso && new RegExp(`(?:^|[^a-z])(?:${extenso[1]})(?![a-z])`).test(texto)) return true;
  const lei = CODIGO_DA_LEI[sigla];
  return !!lei && temNumeroCorrido(texto, lei);
}

/** Uma citação está coberta quando alguma entrada do manifesto nomeia a MESMA classe e o MESMO
 * número (e o mesmo tribunal, quando os dois lados o dizem). `titulos` já vem desacentuado. */
function citacaoCoberta(citacao, titulos) {
  return titulos.some((texto) => {
    if (citacao.classe === 'lei') return temDiploma(texto, citacao) && temNumeroApos(texto, ['arts?', 'artigos?'], citacao.artigo);
    if (citacao.classe === 'sumula') {
      const vinculanteNoTitulo = /vinculante|(?:^|[^a-z])sv(?![a-z])/.test(texto);
      if (!!citacao.vinculante !== vinculanteNoTitulo) return false;
      return temNumeroApos(texto, SINONIMOS_DE_CLASSE.sumula, citacao.numero) && tribunalCompativel(texto, citacao.orgao);
    }
    if (citacao.classe === 'tema') return temNumeroApos(texto, SINONIMOS_DE_CLASSE.tema, citacao.numero) && tribunalCompativel(texto, citacao.orgao);
    if (citacao.classe === 'oj' || citacao.classe === 'pn') return temNumeroApos(texto, SINONIMOS_DE_CLASSE[citacao.classe], citacao.numero);
    const nomes = [citacao.classe, ...(SINONIMOS_DE_CLASSE[citacao.classe] || [])];
    const temClasse = new RegExp(`(?:^|[^a-z])(?:${nomes.join('|')})(?![a-z])`).test(texto);
    return temClasse && temNumeroDeAcordao(texto, citacao) && tribunalCompativel(texto, citacao.orgao);
  });
}
/** As citações do texto sem entrada no manifesto, cada chave julgada uma vez (uma peça de 3 MB
 * repete a mesma citação milhares de vezes) e cada citação distinta relatada uma vez. */
function citacoesDescobertas(citacoes, titulos) {
  return coberturaDasCitacoes(citacoes, titulos).descobertas;
}

/** A chave de identidade de uma citação: classe, número, artigo, diploma, tribunal. */
function chaveDaCitacao(c) {
  return [c.classe, c.numero, c.artigo, c.diploma, c.numeroLei, c.orgao, c.vinculante ? 'sv' : '', (c.corridas || []).join('.')].join('|');
}

/**
 * Cobertura completa: cada citação DISTINTA do texto, julgada uma vez, com o índice do título que
 * a cobre (quando há). É o que o modo `--citacoes` imprime e o que `squad-state citacoes-pendentes`
 * usa para dizer ao verificador o que ainda falta conferir e o que já foi conferido neste run.
 */
function coberturaDasCitacoes(citacoes, titulos) {
  const vistas = new Set();
  const cobertas = [];
  const descobertas = [];
  for (const c of citacoes) {
    const chave = chaveDaCitacao(c);
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    const indice = titulos.findIndex((t) => citacaoCoberta(c, [t]));
    if (indice >= 0) cobertas.push({ ...c, chave, titulo: indice });
    else descobertas.push({ ...c, chave });
  }
  return { cobertas, descobertas };
}

/**
 * Modo de listagem para o cartório do run (`squad-state citacoes-pendentes`): imprime em JSON as
 * citações materiais do artefato e, dado um manifesto (ou qualquer JSON com `citations[].title`),
 * quais delas ele cobre. Não bloqueia nada e não grava nada: é leitura, a serviço da verificação
 * incremental — no ciclo N o verificador confere só o que mudou desde o ciclo anterior.
 */
function listarCitacoes(artefato, manifestoPath) {
  const { text } = readArtifact(artefato);
  let titulos = [];
  if (manifestoPath) {
    let manifesto;
    try {
      manifesto = JSON.parse(readFileSync(manifestoPath, 'utf8'));
    } catch (error) {
      block(`manifesto ilegível em ${manifestoPath}: ${error.message}`);
    }
    const entradas = Array.isArray(manifesto) ? manifesto : Array.isArray(manifesto && manifesto.citations) ? manifesto.citations : [];
    titulos = entradas.map((c) => semAcento(c && typeof c === 'object' ? String(c.title || '') : ''));
  }
  const citacoes = extrairCitacoesMateriais(text);
  const { cobertas, descobertas } = coberturaDasCitacoes(citacoes, titulos);
  const enxuta = (c) => ({ bruto: c.bruto, linha: c.linha, classe: c.classe, numero: c.numero || '', artigo: c.artigo || '', diploma: c.diploma || '', orgao: c.orgao || '', chave: c.chave });
  process.stdout.write(`${JSON.stringify({
    artefato,
    total: cobertas.length + descobertas.length,
    cobertas: cobertas.map((c) => ({ ...enxuta(c), titulo: c.titulo })),
    descobertas: descobertas.map(enxuta),
  }, null, 2)}\n`);
}
// ── fim das citações materiais ─────────────────────────────────────────────────────────────────


function normalizePath(value = '') {
  return String(value).replace(/\\/g, '/');
}

function inSquadOutput(filePath) {
  return /(?:^|\/)squads\/[^/]+\/output\//i.test(normalizePath(filePath));
}

/** Rascunho declarado: `minuta`/`rascunho`/`draft`/`interno` no nome, `citation_gate: draft`, nome
 * começando por `_` ou `.`. Nenhum sinal de "final" desfaz isso. */
function isDeclaredDraft(name, text) {
  return name.startsWith('_') || name.startsWith('.') || nomeRascunho(name) || DRAFT_FRONTMATTER.test(text);
}

/** Interno pela convenção de nome ou de pasta (`analise-da-contestacao`, `output/diagnostico/`).
 * O sinal EXPLÍCITO de final (`output/final/`, marcador, frontmatter) vence esta convenção. */
function isInternalByConvention(normalizedPath, name) {
  return emSubpastaInterna(normalizedPath) || nomeInterno(name);
}

function isInternalDraft(filePath, text) {
  const normalizedPath = normalizePath(filePath);
  const name = basename(normalizedPath);
  return isDeclaredDraft(name, text) || isInternalByConvention(normalizedPath, name);
}

function isFinalLegalArtifact(filePath, text) {
  const normalizedPath = normalizePath(filePath);
  const name = basename(normalizedPath);
  if (!inSquadOutput(normalizedPath) || name.endsWith(MANIFEST_SUFFIX)) return false;
  if (!SUPPORTED_EXT.test(name) || isDeclaredDraft(name, text)) return false;
  const explicito = /\/output\/final\//i.test(normalizedPath) || FINAL_MARKER.test(text) || FINAL_FRONTMATTER.test(text);
  if (explicito) return true;
  if (isInternalByConvention(normalizedPath, name)) return false;
  return FINAL_NAME.test(name) || nomeDePeca(name) || formaDePeca(text);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function block(message) {
  process.stderr.write(`CITATION GATE — BLOQUEADO: ${message}\n`);
  process.stderr.write(
    'Esta sentinela só valida pendências, manifesto e integridade local. '
      + 'Ela NÃO consulta nem confirma fontes. Faça a verificação material em fonte primária, '
      + 'registre-a no manifesto e mantenha a revisão humana obrigatória.\n',
  );
  process.exit(EXIT_BLOCKED);
}

function cleanHash(value) {
  return String(value || '').trim().toLowerCase().replace(/^sha256:/, '');
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(String(value || ''))) return false;
  return !Number.isNaN(Date.parse(value));
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

// `evidence` é opcional — citação conferida só por leitura continua válida —, mas
// quando vem tem de ser prova de acesso de verdade: hash hexadecimal de 64, trecho
// com texto, caminho com caminho. Evidência malformada aceita em silêncio seria
// pior que evidência ausente: a reabertura por código a trataria como comparável.
const CAMPOS_DE_EVIDENCIA = new Set(['sha256_texto', 'sha256_bytes', 'trecho', 'fonte_local', 'registro', 'dt_publicacao']);

function errosDeEvidencia(evidence, index) {
  if (evidence === undefined) return [];
  const onde = `citations[${index}].evidence`;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return [`${onde} deve ser objeto`];
  const erros = [];
  for (const [chave, valor] of Object.entries(evidence)) {
    if (!CAMPOS_DE_EVIDENCIA.has(chave)) { erros.push(`${onde}.${chave} não é campo de evidência (aceitos: ${[...CAMPOS_DE_EVIDENCIA].join(', ')})`); continue; }
    if (typeof valor !== 'string' || !valor.trim()) { erros.push(`${onde}.${chave} deve ser texto não vazio`); continue; }
    if (chave.startsWith('sha256_') && !/^[a-f0-9]{64}$/.test(valor)) erros.push(`${onde}.${chave} deve ser SHA-256 hexadecimal minúsculo`);
    if (chave === 'trecho' && valor.trim().length < 8) erros.push(`${onde}.trecho é curto demais para provar acesso (mínimo 8 caracteres)`);
  }
  return erros;
}

function validateManifest(manifest, artifactPath, artifactBuffer, artifactText) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['manifesto deve ser objeto JSON'];
  if (manifest.schema_version !== '1') errors.push('schema_version deve ser "1"');
  if (manifest.kind !== 'legalsquad.citation-gate-attestation') errors.push('kind inválido');
  if (manifest.artifact !== basename(artifactPath)) errors.push(`artifact deve ser "${basename(artifactPath)}"`);
  if (!/^[a-f0-9]{64}$/.test(cleanHash(manifest.artifact_sha256))) errors.push('artifact_sha256 deve ser SHA-256 hexadecimal');
  if (cleanHash(manifest.artifact_sha256) !== sha256(artifactBuffer)) errors.push('artifact_sha256 não corresponde ao artefato atual');
  if (manifest.gate_status !== 'aprovado') errors.push('gate_status deve ser "aprovado"');
  if (manifest.verification_type !== 'material') errors.push('verification_type deve ser "material"');
  if (!['citacoes_materiais', 'sem_citacoes_materiais'].includes(manifest.scope)) errors.push('scope inválido');
  if (typeof manifest.verified_by !== 'string' || !manifest.verified_by.trim()) errors.push('verified_by é obrigatório');
  if (!isIsoDate(manifest.verified_at)) errors.push('verified_at deve ser data/hora ISO 8601 válida');
  if (!Array.isArray(manifest.citations)) errors.push('citations deve ser array');

  const citations = Array.isArray(manifest.citations) ? manifest.citations : [];
  if (manifest.scope === 'citacoes_materiais' && citations.length === 0) errors.push('scope citacoes_materiais exige ao menos uma citação');
  if (manifest.scope === 'sem_citacoes_materiais' && citations.length > 0) errors.push('scope sem_citacoes_materiais exige citations vazio');
  const citacoesDoTexto = extrairCitacoesMateriais(artifactText);
  if (citacoesDoTexto.length && manifest.scope !== 'citacoes_materiais') {
    errors.push('o artefato aparenta conter citação material; scope não pode declarar ausência');
  }
  citations.forEach((citation, index) => {
    if (!citation || typeof citation !== 'object' || Array.isArray(citation)) {
      errors.push(`citations[${index}] deve ser objeto`);
      return;
    }
    if (typeof citation.title !== 'string' || !citation.title.trim()) errors.push(`citations[${index}].title é obrigatório`);
    if (citation.status !== 'verificada') errors.push(`citations[${index}].status deve ser "verificada"`);
    if (!isHttpsUrl(citation.source_url)) errors.push(`citations[${index}].source_url deve ser URL HTTPS`);
    if (!isIsoDate(citation.consulted_at)) errors.push(`citations[${index}].consulted_at deve ser data/hora ISO 8601 válida`);
    errors.push(...errosDeEvidencia(citation.evidence, index));
  });

  // Cobertura: cada citação do texto precisa de uma entrada que a nomeie (classe + número). Um
  // manifesto com uma citação verificada não atesta as outras três — era exatamente o buraco.
  const titulos = citations.map((c) => semAcento(c && typeof c === 'object' ? String(c.title || '') : ''));
  const descobertas = citacoesDescobertas(citacoesDoTexto, titulos);
  if (descobertas.length) {
    const lista = descobertas.slice(0, 8).map((c) => `"${c.bruto}" (linha ${c.linha})`).join('; ');
    errors.push(`${descobertas.length} citação(ões) do texto sem entrada em citations[] com a mesma classe e o mesmo número: ${lista}${descobertas.length > 8 ? '; …' : ''}`);
  }

  const pending = `${artifactText}\n${JSON.stringify(manifest)}`.match(PENDING_MARKER) || [];
  if (pending.length) errors.push(`há ${pending.length} marcador(es) de pendência`);
  return errors;
}

function readArtifact(filePath) {
  try {
    const buffer = readFileSync(filePath);
    const isText = /\.(?:md|markdown|txt|rtf)$/i.test(filePath);
    return { buffer, text: isText ? buffer.toString('utf8').normalize('NFC') : '' };
  } catch (error) {
    block(`não foi possível ler o artefato final ${filePath}: ${error.message}`);
  }
}

function validateArtifact(filePath) {
  const { buffer, text } = readArtifact(filePath);
  if (!isFinalLegalArtifact(filePath, text)) return;

  const pending = text.match(PENDING_MARKER) || [];
  if (pending.length) {
    const kinds = [...new Set(pending.map((item) => item.toUpperCase()))].join(', ');
    block(`${basename(filePath)} contém ${pending.length} marcador(es) de pendência (${kinds})`);
  }

  const manifestPath = `${filePath}${MANIFEST_SUFFIX}`;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    block(
      `manifesto ausente ou inválido para ${basename(filePath)}. `
        + `Crie ${basename(manifestPath)} conforme scripts/citation-gate-manifest.schema.json (${error.message})`,
    );
  }
  const errors = validateManifest(manifest, filePath, buffer, text);
  if (errors.length) block(`${basename(manifestPath)} inválido: ${errors.join('; ')}`);
}

function artifactFromManifest(manifestPath) {
  const name = basename(manifestPath);
  const artifactName = name.slice(0, -MANIFEST_SUFFIX.length);
  if (!artifactName || artifactName.includes('/') || artifactName.includes('\\')) block('nome de manifesto inválido');
  return join(dirname(manifestPath), artifactName);
}

function runForPath(inputPath) {
  const filePath = normalize(inputPath);
  if (!inSquadOutput(filePath)) return;
  if (filePath.endsWith(MANIFEST_SUFFIX)) {
    const artifactPath = artifactFromManifest(filePath);
    validateArtifact(artifactPath);
    return;
  }
  let text = '';
  try {
    if (/\.(?:md|markdown|txt|rtf)$/i.test(filePath)) text = readFileSync(filePath, 'utf8').normalize('NFC');
  } catch {
    // Só a classificação usa esta leitura; artefato final identificado por nome
    // será relido de modo fail-closed em validateArtifact.
  }
  if (isFinalLegalArtifact(filePath, text)) validateArtifact(filePath);
}

function pathFromHookInput(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return '';
  }
  const toolInput = data && typeof data === 'object' ? (data.tool_input || {}) : {};
  const candidato = toolInput.file_path || toolInput.path || '';
  return typeof candidato === 'string' ? candidato : '';
}

const listarIndex = process.argv.indexOf('--citacoes');
if (listarIndex >= 0) {
  const artefato = process.argv[listarIndex + 1];
  if (!artefato || artefato.startsWith('--')) block('uso: verifica-citacoes.mjs --citacoes <artefato> [--manifesto <json>]');
  const manifestoIndex = process.argv.indexOf('--manifesto');
  const manifesto = manifestoIndex >= 0 ? process.argv[manifestoIndex + 1] : '';
  const abs = (p) => (isAbsolute(p) ? normalize(p) : normalize(resolve(p)));
  listarCitacoes(abs(artefato), manifesto ? abs(manifesto) : '');
  process.exit(0);
}

const checkIndex = process.argv.indexOf('--check');
if (checkIndex >= 0) {
  const requestedPath = process.argv[checkIndex + 1];
  if (!requestedPath) block('uso: verifica-citacoes.mjs --check <artefato-ou-manifesto>');
  runForPath(isAbsolute(requestedPath) ? normalize(requestedPath) : normalize(resolve(requestedPath)));
  process.exit(0);
}

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  process.exit(0);
}
const hookPath = pathFromHookInput(raw);
if (!hookPath) process.exit(0);
bloquearGravacaoEmRunFechado(normalize(hookPath));
runForPath(normalize(hookPath));
process.exit(0);

// Gravação em `output/<run_id>/` de um run que já fechou é edição de entrega
// pela porta dos fundos: sem redator, sem Citation Gate, sem termo novo. A
// alteração depois da entrega tem rota própria (`squad-state reabrir`, que
// devolve o run a `running` para os agentes e os gates fazerem a versão
// seguinte). Vale só para o hook de Write/Edit; `--check` e `--citacoes` não
// gravam nada. Ledger ilegível ou ausente não bloqueia: o run pode ser antigo.
function bloquearGravacaoEmRunFechado(filePath) {
  const m = String(filePath).replace(/\\/g, '/').match(/(^|\/)(squads\/([^/]+))\/output\/([^/]+)\//);
  if (!m) return;
  const runNoCaminho = m[4];
  if (runNoCaminho === 'pacote' || runNoCaminho.startsWith('.')) return;
  const raiz = filePath.slice(0, filePath.replace(/\\/g, '/').indexOf(m[2]));
  const ledgerPath = join(raiz, m[2], 'run-state.json');
  let ledger;
  try { ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')); } catch { return; }
  if (!ledger || ledger.runId !== runNoCaminho || ledger.status === 'running') return;
  block(`o run ${runNoCaminho} de ${m[2]} está "${ledger.status}": a entrega fechou, e gravar em output/ dele à mão pula redator, Citation Gate e termo de conferência. Para alterar a peça entregue, reabra o run (node scripts/squad-state.mjs reabrir ${m[2]} --modo ajustes|revisao --pedido "…") e deixe os agentes e os gates fazerem a versão seguinte.`);
}
