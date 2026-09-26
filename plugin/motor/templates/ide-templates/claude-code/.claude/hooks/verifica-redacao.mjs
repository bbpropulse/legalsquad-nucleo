#!/usr/bin/env node
/**
 * Redação Gate — sentinela determinística contra peça RASA.
 *
 * Irmão do Citation Gate, e complementar a ele: aquele bloqueia citação pendente
 * e inventada; este bloqueia o esqueleto bem formatado que não tem os fatos do
 * caso dentro. `skills:` no squad.yaml é declaração, e o `check-squad` confere
 * que a skill existe — mas existir não é ter sido lida nem aplicada.
 *
 * FAZ (fail-closed no escopo):
 * - identifica artefatos jurídicos finais em squads/<squad>/output/;
 * - ANCORAGEM: a peça cita os identificadores do caso (nº, data, valor, sigla)?
 * - COBERTURA: contempla o "Contrato de saída" que a skill declara?
 * - ANDAIME: template do pipeline vazou para a entrega?
 * - VÍCIOS: densidade de marcas de IA fora de citação, e travessão na prosa redigida;
 * - FRENTE: peça longa abre com bloco de síntese nos primeiros 20% (PERSUASAO.md §3)?
 * - FOLHAS: documento dos autos mencionado na peça vem com a folha ou o ID (autos/_index.yaml)?
 *
 * NÃO FAZ:
 * - não julga mérito, estilo nem correção jurídica;
 * - não substitui o revisor isolado nem a revisão humana;
 * - não exige hash dos SKILL.md como "prova de leitura" — hash de arquivo se
 *   produz rodando um script, sem nenhum modelo ter lido nada.
 *
 * A DECISÃO mora em `src/redacao-gate.js`, testada. Este arquivo é casca: lê o
 * disco, monta o contexto e reporta. Se não conseguir carregar o módulo, BLOQUEIA
 * — gate que vira no-op em silêncio é pior que gate nenhum, porque passa a
 * sensação de que existe proteção.
 */
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

const EXIT_BLOCKED = 2;
const SUPPORTED_EXT = /\.(?:md|markdown|txt|rtf)$/i;
const MANIFEST_SUFFIX = /\.(?:citation|redacao)-gate\.json$/i;
const FINAL_NAME = /(?:^|[-_.])final(?:[-_.]|$)/i;

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

// Relatório de gate nunca é peça, nem com "-final" no nome nem com o marcador de final: é o que o
// verificador, o avaliador ou o conferente disse SOBRE a peça, e costuma transcrever a síntese e o
// fecho dela. Só é peça final o que o nome de peça, a forma ou o manifesto reconhecem, fora destas
// pastas e destes nomes. Medido em 26/09/2026 (mandado de segurança, motor 0.9.54): o relatório
// `persuasao/verificador-persuasao-c3-final.md` foi tratado como peça final, o hook bloqueou por
// manifesto ausente e o chefe renomeou o arquivo para seguir.
const PASTA_DE_GATE = /^(?:persuas(?:ao|ão)|cita(?:coes|ções)|_meta|meta)$/i;
const NOME_DE_GATE = /^(?:verificador(?:es)?|verificacao|avaliacao|avaliacoes|avaliador(?:es)?|conferencia|conferente|persuasao|meta-consenso|reabertura|contraditor|red-team)(?:-|$)/;
function relatorioDeGate(filePath) {
  const caminho = String(filePath || '').replace(/\\/g, '/');
  const i = caminho.search(/\/output\//i);
  if (i < 0) return false;
  const dentro = caminho.slice(i + '/output/'.length).split('/');
  const nome = dentro.pop();
  if (dentro.some((pasta) => PASTA_DE_GATE.test(pasta))) return true;
  return leiturasDoNome(nome).some((leitura) => NOME_DE_GATE.test(semSegmentosDeOrdem(leitura)));
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

function p(value = '') {
  return String(value).replace(/\\/g, '/');
}

function block(message) {
  process.stderr.write(`REDAÇÃO GATE (BLOQUEADO): ${message}\n`);
  process.exit(EXIT_BLOCKED);
}

/** `squads/<code>/output/...` → a raiz do projeto e o code do squad. */
function contexto(filePath) {
  const m = p(filePath).match(/^(.*?)\/squads\/([^/]+)\/output\//i);
  return m ? { raiz: m[1] || '.', squad: m[2] } : null;
}

function ehArtefatoFinal(filePath, texto) {
  const nome = basename(p(filePath));
  if (MANIFEST_SUFFIX.test(nome) || !SUPPORTED_EXT.test(nome)) return false;
  if (nome.startsWith('_') || nome.startsWith('.') || nomeRascunho(nome) || relatorioDeGate(p(filePath))) return false;
  const explicito = /\/output\/final\//i.test(p(filePath)) || /<!--\s*LEGALSQUAD:REDACAO-GATE:FINAL\s*-->/i.test(texto);
  if (explicito) return true;
  if (emSubpastaInterna(p(filePath)) || nomeInterno(nome)) return false;
  return FINAL_NAME.test(nome) || nomeDePeca(nome) || formaDePeca(texto);
}

/**
 * O material do caso: os demais artefatos que o pipeline já produziu.
 *
 * O runner grava cada step numa pasta de versão própria (`output/<run>/v3/`,
 * `output/<run>/diagnostico/v1/`), então a pasta da peça costuma ter só a
 * própria peça, e a ancoragem saía `nao-avaliado` em todo run versionado
 * (medido em 15/09/2026). Por isso o material vem da pasta da peça E, quando
 * ela está numa `vN/`, da pasta do run inteira: as outras versões e os
 * subgrupos (diagnóstico, pesquisa), até dois níveis. O alvo nunca entra.
 */
const PASTA_DE_VERSAO = /^v\d+$/;
function entradaDoCaso(outputDir, alvo) {
  if (!existsSync(outputDir)) return '';
  const raizDoRun = PASTA_DE_VERSAO.test(basename(outputDir)) ? dirname(outputDir) : outputDir;
  const arquivos = [];
  const andar = (dir, nivel) => {
    let entradas = [];
    try { entradas = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      const caminho = join(dir, e.name);
      if (e.isDirectory()) {
        if (nivel < 2 && !e.name.startsWith('.') && !e.name.startsWith('_')) andar(caminho, nivel + 1);
        continue;
      }
      if (SUPPORTED_EXT.test(e.name) && !MANIFEST_SUFFIX.test(e.name) && caminho !== alvo) arquivos.push(caminho);
    }
  };
  andar(raizDoRun, 0);
  return arquivos
    .map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } })
    .join('\n');
}

/** Ids em `skills:` — lista de bloco (squad.yaml) ou inline (frontmatter). */
function skillsDeclaradas(texto) {
  const inline = texto.match(/^\s*skills:\s*\[([^\]]*)\]\s*$/m);
  if (inline) return inline[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  const bloco = texto.match(/^skills:\s*\n((?:\s+-\s+.+\n?)+)/m);
  if (!bloco) return [];
  return bloco[1].split('\n')
    .map((l) => l.match(/^\s*-\s+(.+?)\s*$/)?.[1]).filter(Boolean)
    .map((s) => s.replace(/^["']|["']$/g, ''));
}

/**
 * O agente que grava o artefato, pelo `pipeline.yaml`: o step de agente cujo `output` declara um
 * arquivo com o mesmo nome (a versão `vN/` do run guarda o nome). Sem pipeline, ou sem step que o
 * declare, null.
 */
function agenteQueGrava(squadDir, alvo) {
  let yaml;
  try { yaml = readFileSync(join(squadDir, 'pipeline', 'pipeline.yaml'), 'utf8'); } catch { return null; }
  const nome = basename(alvo);
  let agente = null;
  for (const linha of yaml.split('\n')) {
    if (/^\s*-\s+id:/.test(linha)) { agente = null; continue; }
    const a = linha.match(/^\s+agent:\s*["']?([\w.-]+)/);
    if (a) { agente = a[1]; continue; }
    const saida = linha.match(/^\s+-\s+["']?([^\s"']+\.md)["']?\s*$/);
    if (saida && agente && basename(saida[1]) === nome) return agente;
  }
  return null;
}

/**
 * Os contratos que medem a cobertura do artefato: os das skills do agente que o grava (pelo
 * pipeline) e, sem ele, os de todas as skills do squad, como sempre foi. Medido em 25/09/2026
 * (alimentos): a cobertura da minuta vinha do contrato de skills de outros agentes (a pesquisa
 * jurisprudencial do pesquisador, a revisão de citações do revisor), e a mensagem não dizia de
 * onde. O contrato de cada skill governa o artefato de quem a declara.
 */
function contratosDasSkills(raiz, squadDir, alvo = null) {
  const ids = new Set();
  const fontes = [join(squadDir, 'squad.yaml')];
  const agentsDir = join(squadDir, 'agents');
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir).filter((x) => x.endsWith('.md'))) fontes.push(join(agentsDir, f));
  }
  const autor = alvo ? agenteQueGrava(squadDir, alvo) : null;
  const doAutor = autor ? join(agentsDir, `${autor}.agent.md`) : null;
  if (doAutor && existsSync(doAutor) && skillsDeclaradas(readFileSync(doAutor, 'utf8')).length) fontes.splice(0, fontes.length, doAutor);
  for (const arquivo of fontes) {
    if (!existsSync(arquivo)) continue;
    for (const id of skillsDeclaradas(readFileSync(arquivo, 'utf8'))) ids.add(id);
  }

  const contratos = [];
  for (const id of ids) {
    if (!skillRedigePeca(join(raiz, 'skills', id, 'SKILL.md'))) continue;
    // O "## Contrato de saída" mora no arquivo de referência que o SKILL.md linka, não no
    // SKILL.md: a origem vai junto, para a mensagem do gate dizer de onde veio a exigência
    // (medido em 25/09/2026, alimentos/reclamação).
    const origem = `skills/${id}/references/high-performance-contract.md`;
    const caminho = join(raiz, origem);
    if (existsSync(caminho)) {
      try { contratos.push({ texto: readFileSync(caminho, 'utf8'), origem }); } catch { /* ilegível vira ausente */ }
    }
  }
  return contratos;
}

/**
 * Só o contrato de skill que REDIGE peça mede a cobertura da peça. Um squad
 * declara também a calculadora de prazo, a skill de revisão, a de pesquisa; o
 * "Contrato de saída" de cada uma governa o PRÓPRIO artefato (o JSON do motor,
 * o relatório), não a petição. Medido num run real (15/09/2026): a resposta à
 * acusação reprovava por não trazer `regra_id` e `divergências`, exigências do
 * contrato da `calculadora-tempestividade`. O sinal é o frontmatter v5 da skill
 * (`delivery_type: legal-draft` ou `quality_profile: legal-drafting`); skill sem
 * esse metadado (contrato antigo) continua contando, como sempre contou.
 */
function skillRedigePeca(skillMd) {
  if (!existsSync(skillMd)) return true;
  let texto = '';
  try { texto = readFileSync(skillMd, 'utf8'); } catch { return true; }
  const fm = texto.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm) return true;
  const entrega = fm[1].match(/^\s*delivery_type:\s*["']?([\w-]+)/m)?.[1];
  const perfil = fm[1].match(/^\s*quality_profile:\s*["']?([\w-]+)/m)?.[1];
  if (!entrega && !perfil) return true;
  return entrega === 'legal-draft' || perfil === 'legal-drafting';
}

/** `reader:` do squad.yaml — quem lê a peça (juiz · autoridade · contraparte · cliente · publico); default juiz. */
function readerDoSquad(squadDir) {
  const caminho = join(squadDir, 'squad.yaml');
  if (!existsSync(caminho)) return 'juiz';
  try {
    const m = readFileSync(caminho, 'utf8').match(/^reader:[ \t]*["']?([a-z]+)/mi);
    return m ? m[1].toLowerCase() : 'juiz';
  } catch { return 'juiz'; }
}

/**
 * `processo:` do squad.yaml (judicial · administrativo · nenhum), que o compilador grava quando o
 * design o declara; ausente, null, e o sinal `folhas` usa a régua de sempre (autos com folha).
 */
function processoDoSquad(squadDir) {
  const caminho = join(squadDir, 'squad.yaml');
  if (!existsSync(caminho)) return null;
  try {
    const m = readFileSync(caminho, 'utf8').match(/^processo:[ \t]*["']?(judicial|administrativo|nenhum)\b/m);
    return m ? m[1] : null;
  } catch { return null; }
}

// Onde estão os autos: cópia do bloco canônico de src/autos-path.js.
// >>> autos-path:begin
/**
 * Pasta de autos de um squad: `squads/<nome>/autos/` (copiados para o squad) ou,
 * por referência, a pasta do caso que `squads/<nome>/caso.json` aponta
 * (`{"autos": "Processos/<caso>/autos"}` ou `{"pasta": "Processos/<caso>"}`,
 * relativo à raiz do projeto, a pasta acima de `squads/`). A cópia local com
 * `_index.yaml` vence a referência; sem `caso.json`, fica a do squad.
 */
function pastaDeAutos(squadDir) {
  const noSquad = join(squadDir, 'autos');
  if (existsSync(join(noSquad, '_index.yaml'))) return noSquad;
  try {
    const caso = JSON.parse(readFileSync(join(squadDir, 'caso.json'), 'utf8'));
    const raiz = dirname(dirname(squadDir));
    const autos = caso && typeof caso.autos === 'string' ? caso.autos : (caso && typeof caso.pasta === 'string' ? `${caso.pasta}/autos` : null);
    if (autos) return resolve(raiz, autos);
  } catch { /* sem caso.json, ou ilegível: fica o do squad */ }
  return noSquad;
}

/**
 * Aceita `squads/<nome>` (com `autos/` dentro ou `caso.json` apontando o caso), a
 * pasta do caso (com `autos/` dentro) ou o caminho direto de `autos/`.
 * Devolve `{ dir, erro }`; `dir` é absoluto.
 */
function resolverAutos(entrada) {
  const abs = resolve(entrada);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return { dir: null, erro: `pasta não encontrada: ${entrada}` };
  if (basename(abs) === 'autos') return { dir: abs, erro: null };
  const dir = pastaDeAutos(abs);
  if (existsSync(dir) && statSync(dir).isDirectory()) return { dir, erro: null };
  if (existsSync(join(abs, 'caso.json'))) return { dir: null, erro: `${entrada}/caso.json aponta ${dir}, que não existe: confira o caminho (relativo à raiz do projeto, a pasta acima de squads/)` };
  return { dir: null, erro: `${entrada} existe, mas não tem a pasta autos/; crie ${entrada}/autos/ e coloque nela os PDFs e documentos do caso, ou grave ${entrada}/caso.json apontando a pasta do caso` };
}
// <<< autos-path:end

// De onde vem cada documento (autos × cliente): cópia do bloco canônico de src/autos-origem.js.
// >>> autos-origem:begin
/**
 * Âncora de folha que a pasta do caso dá ao documento: a que o conversor e as
 * cópias extraídas de processo trazem (`## fls. 12`, `<!-- fls. 3/40 -->`).
 * Folha citada em prosa ("a via juntada está às fls. 145") não conta: é o
 * documento falando de outro.
 */
const ORIGEM_ANCORA_FOLHA = /(?:^|\s)#{1,3}\s*(?:e-?)?fls?\.?\s*\d+|<!--\s*(?:e-?)?fls?\.\s*\d+/;
/** Âncora de página de documento sem folha (pasta pré-processual): `## p. 1`, `## pág. 2`. */
const ORIGEM_ANCORA_PAGINA = /(?:^|\s)#{1,3}\s*(?:p|pag|pagina)\.?\s*\d+/;
/**
 * Marca de sistema processual no texto de um PDF sem âncora: o rodapé do PJe
 * (`Num. 12345678 - Pág. 1`), o carimbo de folha do e-SAJ numa linha só
 * (`fls. 123`), o rodapé de conferência do e-SAJ e a marca de evento do eproc.
 * Vem DEPOIS da âncora: a cópia de uma sentença de outro processo, que o
 * cliente trouxe e a pasta pagina com `## p. N`, carrega o rodapé do tribunal
 * e continua sendo documento do cliente (medido no despejo de 24/09/2026).
 */
const ORIGEM_SISTEMA = [
  /\bnum\.\s*\d{5,}\s*-\s*pag\.\s*\d+/,
  /(?:^|\n)[ \t]*(?:e-?)?fls\.\s*\d+(?:\s*\/\s*\d+)?[ \t]*(?:\n|$)/,
  /\bevento\s+\d+\s*,\s*[a-z]+\d*\s*,\s*pagina\s+\d+/,
  /\bpara conferir o original,? acesse o site\b/,
];
/** O próprio documento diz, no cabeçalho, que está fora dos autos. */
const ORIGEM_FORA_DOS_AUTOS = /\bnao juntad[oa]s?\b|\bfora da numeracao\b|\bsem folha\b|\bdocumento (?:avulso|do escritorio|do cliente|interno)\b|\ba juntar\b|\bpasta (?:da empresa|do cliente)\b/;
const ORIGEM_CABECALHO = 400;

function semAcentoOrigem(t) {
  return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** `autos`, `cliente` ou `null` (não dá para dizer pelo texto). */
function origemDoTexto(texto) {
  const t = semAcentoOrigem(texto);
  if (!t.trim()) return null;
  if (ORIGEM_ANCORA_FOLHA.test(t)) return 'autos';
  if (ORIGEM_ANCORA_PAGINA.test(t)) return 'cliente';
  if (ORIGEM_FORA_DOS_AUTOS.test(t.slice(0, ORIGEM_CABECALHO))) return 'cliente';
  if (ORIGEM_SISTEMA.some((re) => re.test(t))) return 'autos';
  return null;
}

/**
 * Completa `origem` em cada documento do índice. `textoDe(doc)` devolve o texto
 * (ou `null` quando não há o que ler). A origem já gravada vale; a que falta sai
 * do texto; e, numa pasta em que algum documento tem folha, o documento com
 * texto e sem folha nenhuma está fora da numeração: é do cliente. Documento sem
 * texto (PDF digitalizado sem OCR) fica `null`, e quem lê trata como autos.
 */
function completarOrigens(docs, textoDe) {
  const lista = Array.isArray(docs) ? docs : [];
  const textos = lista.map((d) => { try { return textoDe(d); } catch { return null; } });
  const origens = lista.map((d, i) => (d && (d.origem === 'autos' || d.origem === 'cliente') ? d.origem : origemDoTexto(textos[i])));
  const haAutos = origens.includes('autos');
  return lista.map((d, i) => ({ ...d, origem: origens[i] ?? (haAutos && String(textos[i] || '').trim() ? 'cliente' : null) }));
}
// <<< autos-origem:end

/**
 * Documentos do índice dos autos (`autos/_index.yaml`, gerado pelo indexar-autos)
 * com o que o sinal `folhas` usa: arquivo, tipo, páginas e origem. Índice gerado
 * antes do campo `origem` (medição de 24/09/2026) deduz a origem com a mesma
 * função do indexador, pelo texto do documento (o arquivo de texto, ou o cache do
 * pdftotext) e, sem ele, pela `primeira_pagina`: não obriga a reindexar.
 */
function lerIndiceDeAutos(squadDir) {
  const pasta = pastaDeAutos(squadDir);
  const caminho = join(pasta, '_index.yaml');
  if (!existsSync(caminho)) return [];
  const textoDoDocumento = (d) => {
    const alvo = /\.(?:md|txt)$/i.test(d.arquivo) ? d.arquivo : d.texto_cache;
    if (alvo) { try { return readFileSync(join(pasta, alvo), 'utf8'); } catch { /* cai na primeira página */ } }
    return d.primeira_pagina;
  };
  const semAspas = (v) => { const t = String(v).trim(); try { return JSON.parse(t); } catch { return t.replace(/^["']|["']$/g, ''); } };
  const docs = [];
  let atual = null;
  let texto;
  try { texto = readFileSync(caminho, 'utf8'); } catch { return []; }
  for (const linha of texto.split('\n')) {
    const novo = linha.match(/^\s*-\s+arquivo:\s*(.+)$/);
    if (novo) { atual = { arquivo: semAspas(novo[1]) }; docs.push(atual); continue; }
    const campo = atual && linha.match(/^\s+(tipo|paginas|origem|primeira_pagina|texto_cache):\s*(.+)$/);
    if (!campo) continue;
    const valor = campo[2].trim();
    if (campo[1] === 'paginas') atual.paginas = valor === 'null' ? null : Number(valor);
    else if (valor === 'null') atual[campo[1]] = null;
    else atual[campo[1]] = semAspas(valor);
  }
  const semOrigem = docs.some((d) => d.origem !== 'autos' && d.origem !== 'cliente');
  const completos = semOrigem ? completarOrigens(docs, textoDoDocumento) : docs;
  return completos.map(({ primeira_pagina, texto_cache, ...d }) => d);
}

// A nota ao revisor (o material que o contrato de saída pede, fora da peça): cópia do
// bloco canônico de src/nota-ao-revisor.js.
// >>> nota-ao-revisor:begin
/** As duas linhas que delimitam a nota ao revisor, sozinhas na linha. */
export const NOTA_AO_REVISOR_INICIO = '<!-- nota-ao-revisor:inicio -->';
export const NOTA_AO_REVISOR_FIM = '<!-- nota-ao-revisor:fim -->';
const RE_NOTA_AO_REVISOR = /^[ \t]*<!--\s*nota-ao-revisor:(inicio|fim)\s*-->[ \t]*$/;

/**
 * Separa a peça da nota ao revisor. Devolve `{ peca, nota, blocos, erro }`: `peca`
 * é o texto sem os blocos (e sem as linhas de marcador), `nota` é o miolo dos
 * blocos, `blocos` quantos havia. Marcador fora de ordem (fim sem início, início
 * dentro de outro, início sem fim) é `erro`, e aí nada se separa: `peca` volta
 * como veio e `nota` vazia, para ninguém tirar da peça metade do que devia.
 */
export function separarNotaAoRevisor(texto) {
  const linhas = String(texto ?? '').split('\n');
  const peca = [];
  const nota = [];
  let aberto = -1;
  let blocos = 0;
  for (const [i, linha] of linhas.entries()) {
    const m = linha.replace(/\r$/, '').match(RE_NOTA_AO_REVISOR);
    if (!m) { (aberto >= 0 ? nota : peca).push(linha); continue; }
    if (m[1] === 'inicio') {
      if (aberto >= 0) return { peca: String(texto ?? ''), nota: '', blocos: 0, erro: `nota ao revisor aberta na linha ${i + 1} dentro de outra (aberta na linha ${aberto + 1})` };
      aberto = i;
      continue;
    }
    if (aberto < 0) return { peca: String(texto ?? ''), nota: '', blocos: 0, erro: `nota ao revisor fechada na linha ${i + 1} sem ter sido aberta` };
    aberto = -1;
    blocos += 1;
  }
  if (aberto >= 0) return { peca: String(texto ?? ''), nota: '', blocos: 0, erro: `nota ao revisor aberta na linha ${aberto + 1} e nunca fechada (${NOTA_AO_REVISOR_FIM})` };
  return { peca: peca.join('\n'), nota: nota.join('\n').trim(), blocos, erro: null };
}
// <<< nota-ao-revisor:end

// A decisão do gate vem COPIADA de `src/redacao-gate.js`, não importada: este
// arquivo viaja para o projeto do aluno, onde `src/` não existe. O import
// dinâmico anterior falhava nos dois caminhos que tentava e o gate caía no
// fail-closed, bloqueando a gravação da peça em toda instalação.
// >>> redacao-gate:begin
//
// O Citation Gate bloqueia citação pendente e inventada. Ele NÃO bloqueia peça
// rasa: um esqueleto bem formatado, sem os fatos do caso, passa por ele inteiro.
// `skills:` no squad.yaml é declaração; o `check-squad` confere que a skill
// existe — mas existir não é ter sido lida nem aplicada.
//
// Módulo PURO de propósito. O gate de citação tem 225 linhas de lógica dentro do
// hook, o que o torna difícil de testar; aqui o hook é casca e a decisão mora
// aqui, exercitada por teste.
//
// ── Três sinais, em ordem de força ────────────────────────────────────────
//
// 1. ANCORAGEM — a peça cita os identificadores do caso? É o único que mede
//    profundidade. Peça rasa é genérica por construção: serve para qualquer
//    caso, e por isso não cita âncora nenhuma.
// 2. COBERTURA — a peça contempla o "Contrato de saída" que a skill declara?
//    Derivado da skill, não hardcoded: o núcleo não sabe o que é uma petição,
//    sabe ler o contrato v5. Cada elemento conta como seção da peça (título ou
//    rótulo), não como palavra solta no corpo.
// 3. ANDAIME — template vazou para a entrega? Reprova sozinho, como os outros:
//    `{{variavel}}` ou `[INSERIR]` numa peça protocolada é indefensável, e um
//    sinal que só corrobora deixaria isso passar sempre que os demais
//    aprovassem. O risco conhecido é o inverso — blacklist em prosa gera falso
//    positivo (`(tese 1)` citando um repetitivo, p.ex.) —, e ele é aceito
//    porque reprovar aqui não apaga nem reescreve nada: o gate PARA e escala ao
//    humano com o padrão nomeado, que então libera em um passo.
//
// Os sinais 4 (vícios de redação) e 5 (frente: síntese nos primeiros 20% da
// peça, PERSUASAO.md §3) estão documentados junto ao código que os mede.
//
// O que NÃO se faz aqui: exigir hash dos SKILL.md como prova de leitura. Hash de
// arquivo se produz rodando um script, sem nenhum modelo ter consumido nada — é
// carimbo automático, o mesmo defeito do re-bind de evidência de promoção. A
// força do Citation Gate vem de refutar o manifesto olhando o artefato; é essa
// propriedade que este módulo copia, não o formato do manifesto.

const NAO_AVALIADO = 'nao-avaliado';

/**
 * Andaime de pipeline que nunca deveria chegar à entrega. Mede o CORPO, sem o
 * frontmatter YAML: `run:` e `agente:` são chaves legítimas ali, metadado que o
 * empacotador já tira da peça. Medido em 25/09/2026, alimentos/reclamação: o
 * padrão sem caixa casou com a chave `run:` do frontmatter da minuta e o gate
 * reprovou "1 padrão" sem dizer qual. `Agente:`/`Run:` com caixa, porque o
 * andaime que vaza é o rótulo do pipeline, não a palavra em minúscula.
 */
const ANDAIME = [
  /\(tese\s+\d+\)/i,
  /^\s*Agente:\s/m,
  /^\s*Run:\s/m,
  /^\s*step[-_]?\d+\s*:/im,
  /\{\{\s*[a-z_.]+\s*\}\}/i,
  /\[(?:INSERIR|PREENCHER|TODO|XXX)\]/i,
];

/**
 * Identificadores do caso: número de processo, data, valor, sigla/parte em caixa
 * alta. Vocabulário jurídico comum NÃO entra — ele aparece em qualquer peça e
 * não distingue caso nenhum, que é justamente o que se quer medir.
 */
export function extrairAncoras(texto) {
  const fonte = String(texto || '');
  const ancoras = new Set();

  // Qualquer token com dígito: processo, data, valor, artigo, competência.
  for (const bruto of fonte.match(/[0-9][0-9./:-]*[0-9]|[0-9]/g) || []) {
    if (bruto.replace(/\D/g, '').length >= 4) ancoras.add(bruto);
  }
  // Siglas e partes em caixa alta (ACME, LTDA, INSS) — 3+ letras para não pegar
  // início de frase nem numeral romano curto.
  for (const bruto of fonte.match(/\b[A-ZÁÉÍÓÚÂÊÔÃÕÇ]{3,}\b/g) || []) ancoras.add(bruto);

  return [...ancoras];
}

/**
 * Elementos obrigatórios da entrega, lidos do bloco `## Contrato de saída` do
 * contrato v5. Cada bullet contribui o seu termo-cabeça.
 */
export function extrairExigenciasDeSaida(contrato) {
  // `$(?![\s\S])` é fim de STRING. Um `$` solto, com a flag /m, casaria fim de
  // LINHA e a captura preguiçosa pararia no primeiro bullet — lendo uma
  // exigência de quatro e aprovando peça que falta três.
  const bloco = String(contrato || '').match(/^##\s+Contrato de sa[íi]da\s*\n([\s\S]*?)(?=\n##\s|$(?![\s\S]))/m);
  if (!bloco) return [];

  const exigencias = new Set();
  for (const linha of bloco[1].split('\n')) {
    const item = linha.match(/^\s*-\s+(.+?)\s*$/)?.[1];
    if (!item) continue;
    // Termo-cabeça: primeira palavra significativa do bullet.
    const cabeca = item.split(/[\s:,]/).find((p) => p.length >= 4);
    if (cabeca) exigencias.add(cabeca.toLowerCase());
  }
  return [...exigencias];
}

function normalizar(texto) {
  return String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// Cobertura como ESTRUTURA, não como palavra (medição dos moldes de 24/09/2026,
// G17). O termo-cabeça solto em qualquer ponto do texto media o acaso: no HC da
// medição, "status" passou por uma citação ("permaneceu com status 'minuta'"); na
// reclamação, "matriz" pela "matriz e filial" do CNPJ; e onde a palavra faltava,
// o redator a inseria na prosa para passar. Cada bullet do "Contrato de saída" é
// um elemento da entrega, e a entrega o traz como SEÇÃO: um título, um rótulo em
// negrito no começo da linha (`**Status:** partial`) ou um rótulo simples
// (`Status: ready`). O elemento é nomeado pelos núcleos do bullet (em "riscos,
// lacunas, próximos passos e checkpoint humano", qualquer um dos quatro nomeia a
// seção); o bullet de campo (`status: ready, partial ou blocked`) exige o rótulo
// COM um dos valores. Citação (blockquote) e tabela não são estrutura da peça.
const PALAVRAS_VAZIAS_DA_SECAO = new Set(['para', 'como', 'pelo', 'pela', 'pelos', 'pelas', 'com', 'sem', 'cada', 'toda', 'todo', 'todos', 'todas', 'qualquer', 'sobre', 'entre', 'quando', 'onde', 'uma', 'umas', 'seus', 'suas']);

function nucleoDaSecao(trecho) {
  return normalizar(trecho).split(/[^a-z0-9_]+/).find((p) => (p.length >= 4 || p.includes('_')) && !PALAVRAS_VAZIAS_DA_SECAO.has(p)) || null;
}

/**
 * Seções exigidas pelo `## Contrato de saída`: uma por bullet, `{rotulo, nucleos,
 * valores}`. `valores` só no bullet de campo (`termo: a, b ou c`).
 */
export function extrairSecoesDeSaida(contrato) {
  const bloco = String(contrato || '').match(/^##\s+Contrato de sa[íi]da\s*\n([\s\S]*?)(?=\n##\s|$(?![\s\S]))/m);
  if (!bloco) return [];
  const secoes = [];
  for (const linha of bloco[1].split('\n')) {
    const item = linha.match(/^\s*-\s+(.+?)\s*$/)?.[1];
    if (!item) continue;
    const campo = item.match(/^([^:]{2,40}):\s*(.+)$/);
    if (campo) {
      const valores = normalizar(campo[2]).replace(/[`*_"']/g, '').split(/\s*(?:,|\/|\||\bou\b|\bor\b)\s*/).map((v) => v.trim()).filter(Boolean);
      const nucleo = nucleoDaSecao(campo[1]);
      if (nucleo && valores.length && valores.every((v) => /^[a-z0-9_-]{2,20}$/.test(v))) {
        secoes.push({ rotulo: item, nucleos: [nucleo], valores });
        continue;
      }
    }
    const nucleos = [...new Set(item.split(/\s*,\s*|\s+e\s+|\s+ou\s+|\s+como\s+|;\s*/).map(nucleoDaSecao).filter(Boolean))];
    if (nucleos.length) secoes.push({ rotulo: item, nucleos, valores: null });
  }
  return secoes;
}

/**
 * As linhas que dão ESTRUTURA à peça, normalizadas: título; rótulo em negrito no
 * começo da linha (com o valor, quando o rótulo termina em dois-pontos); rótulo
 * simples de até quatro palavras seguido de dois-pontos. Corpo, citação e tabela
 * ficam de fora.
 */
function linhasDeEstrutura(texto) {
  const linhas = [];
  const todas = String(texto || '').split('\n');
  for (const [i, bruta] of todas.entries()) {
    if (/^\s*>/.test(bruta) || /^\s*\|/.test(bruta)) continue;
    const titulo = bruta.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (titulo) {
      // Título sem valor na linha leva o começo da primeira linha de texto depois dele: "### Status"
      // com "partial" embaixo é o campo preenchido. Medido em 26/09/2026 (despejo, motor 0.9.54): a
      // nota ao revisor trazia "### Status" e o valor na linha seguinte, e a cobertura o dava por ausente.
      const seguinte = todas.slice(i + 1).find((l) => l.trim());
      const valor = seguinte && !/^\s{0,3}#{1,6}\s/.test(seguinte) && !/^\s*(?:>|\||<!--)/.test(seguinte) ? seguinte.replace(/^\s*(?:[-*+]\s+)?(?:\*\*|__)?/, '').slice(0, 40) : '';
      linhas.push(normalizar(titulo[1]));
      // Só o campo (`status: ready, partial ou blocked`) lê o valor de baixo: a seção sem valor
      // continua nomeada só pelo título, para a primeira linha do texto não nomear outra seção.
      if (valor) linhas.push(`${CAMPO_EM_DUAS_LINHAS}${normalizar(`${titulo[1]}: ${valor}`)}`);
      continue;
    }
    const negrito = bruta.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)(.+?)(?:\*\*|__)(.{0,40})/);
    if (negrito) {
      const rotulo = negrito[1].trim();
      linhas.push(normalizar(/:$/.test(rotulo) || /^\s*:/.test(negrito[2]) ? `${rotulo} ${negrito[2]}` : rotulo));
      continue;
    }
    const simples = bruta.match(/^\s*(?:[-*+]\s+)?([^\s:|#>*`][^:|\n]{0,40}):\s*(.{0,40})/);
    if (simples && simples[1].trim().split(/\s+/).length <= 4) linhas.push(normalizar(`${simples[1]}: ${simples[2]}`));
  }
  return linhas;
}

function formasDoNucleo(nucleo) {
  const base = nucleo.replace(/s$/, '');
  return [...new Set([nucleo, base, `${base}s`])].filter((f) => f.length >= 3).map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

const CAMPO_EM_DUAS_LINHAS = '\u0000';
function secaoPresente(secao, estrutura) {
  const nome = new RegExp(`\\b(?:${secao.nucleos.flatMap(formasDoNucleo).join('|')})\\b`);
  if (!secao.valores) return estrutura.some((linha) => !linha.startsWith(CAMPO_EM_DUAS_LINHAS) && nome.test(linha));
  const valores = secao.valores.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const campo = new RegExp(`${nome.source}[^a-z0-9]{0,8}(?:${valores})\\b`);
  return estrutura.some((linha) => campo.test(linha));
}

/**
 * V\u00edcios que denunciam texto de IA numa pe\u00e7a \u2014 par mec\u00e2nico da best-practice
 * `redacao-sem-marcas-de-ia`, que julga os treze padr\u00f5es. Aqui s\u00f3 entram os que
 * d\u00e1 para CONTAR sem interpretar; tr\u00edade ornamental e cita\u00e7\u00e3o decorativa ficam
 * com o guia, porque exigem ler o argumento.
 *
 * Isto \u00e9 estilo do portugu\u00eas forense, n\u00e3o instituto jur\u00eddico \u2014 mesma natureza
 * da lista `ANDAIME` acima, e por isso mora no n\u00facleo. Ainda assim vem por
 * par\u00e2metro em `avaliarRedacao`: uma \u00e1rea em outro idioma traz a sua.
 */
const VICIOS_DE_REDACAO = [
  {
    id: 'assercao-sem-prova',
    rotulo: 'afirma a conclus\u00e3o em vez de demonstr\u00e1-la',
    regex: /\b(?:[\u00e9e]\s+cedi[\u00e7c]o\s+que|resta[m]?\s+(?:cristalino|evidente|claro|patente)|n[\u00e3a]o\s+h[\u00e1a]\s+d[\u00fau]vidas?\s+de\s+que|[\u00e9e]\s+not[\u00f3o]rio\s+que|[\u00e9e]\s+ineg[\u00e1a]vel\s+que)/gi,
  },
  {
    id: 'conectivo-em-cadeia',
    rotulo: 'conectivo pesado como enchimento',
    regex: /\b(?:outrossim|destarte|ademais|nesse\s+diapas[\u00e3a]o|por\s+derradeiro|d'?outra\s+banda)\b/gi,
  },
  {
    id: 'superlativo-empilhado',
    rotulo: 'superlativo no lugar de prova',
    regex: /\b(?:absolutamente|totalmente|completamente|manifestamente|flagrantemente|inquestionavelmente)\s+\p{L}+/giu,
  },
  {
    id: 'fecho-generico',
    rotulo: 'fecho de estilo, sem pedido espec\u00edfico',
    regex: /\bmedida\s+de\s+(?:mais\s+)?l[\u00edi]dima\s+justi[\u00e7c]a|\bpor\s+ser\s+medida\s+de\s+justi[\u00e7c]a/gi,
  },
];

/** Acima disto, o ac\u00famulo deixa de ser escolha de estilo e vira enchimento. */
const LIMITE_DE_VICIOS = 4;

/**
 * Remove o que a pe\u00e7a CITA, deixando s\u00f3 o que ela REDIGE.
 *
 * Blockquote \u00e9 fonte: ementa, dispositivo, depoimento. Contar o estilo de quem
 * escreveu a ementa contra quem a transcreveu empurraria o redator a adulterar
 * a cita\u00e7\u00e3o para passar no gate \u2014 exatamente o que a best-practice pro\u00edbe.
 */
function semCitacoes(texto) {
  return String(texto || '')
    .split('\n')
    .filter((linha) => !/^\s*>/.test(linha))
    .join('\n');
}

/**
 * Frente (PERSUASAO.md §3). Abaixo deste número de linhas redigidas a peça é
 * curta e a síntese não é exigida: manifestação de duas páginas não precisa
 * dela, e exigi-la ensinaria a inflar. Acima, o marcador tem de aparecer nos
 * primeiros 20% das linhas redigidas, com piso de PISO_DA_JANELA linhas.
 */
const LIMIAR_DE_FRENTE = 40;
const PISO_DA_JANELA = 8;

/**
 * Texto (já normalizado: sem acento, minúsculo) que abre um bloco de síntese.
 * Casa por palavra inteira, não por prefixo solto: `tese` não é `tesouraria`.
 */
const MARCADOR_DE_SINTESE = /^(?:em\s+)?sintese\b|^resumo\b|^sumario\b|^teses?\b/;

/**
 * O que a peça real põe ANTES da palavra de síntese num heading forense: o
 * enumerador (`1.`, `1.1`, `2)`, `I.`, `II -`, `a)`) e a preposição que costuma
 * segui-lo (`DA SÍNTESE`). A §3 diz "comece com"; `## I. DA SÍNTESE` obedece
 * ao espírito e reprová-la seria o gate mentindo sobre quem cumpriu. Tolerar o
 * prefixo não afrouxa a regra: depois dele, o texto ainda tem de COMEÇAR pela
 * palavra de síntese. Roman/letra exigem pontuação ou traço para não engolir
 * palavra comum (`civil`, `a`).
 */
const PREFIXO_DE_HEADING = /^(?:\d+(?:\.\d+)*[.)]?|[ivxlc]+(?:[.)]|(?=\s+[-\u2013\u2014:]))|[a-z][.)])\s*(?:[-\u2013\u2014:]\s*)?/;
const PREPOSICAO_DE_HEADING = /^d[aeo]s?\s+/;

/**
 * Heading (`#`, `##`, `###`) ou linha que abre em negrito (`**...**`) cujo texto
 * começa por síntese / em síntese / resumo / sumário / tese(s). Só chega aqui
 * linha redigida: `semCitacoes` já tirou o blockquote, porque `> ## Síntese`
 * transcrito de um acórdão não é a síntese da peça.
 */
function ehMarcadorDeSintese(linha) {
  const heading = linha.match(/^\s*#{1,3}\s+(.+?)\s*$/);
  const negrito = heading ? null : linha.match(/^\s*\*\*(.+?)\*\*/);
  const bruto = heading?.[1] ?? negrito?.[1];
  if (!bruto) return false;
  const texto = normalizar(bruto)
    .trim()
    .replace(/\s+#+\s*$/, '') // fecho opcional do heading ATX: `## Síntese ##`
    .replace(/^[*_]+/, '') // `## **Síntese**`
    .replace(PREFIXO_DE_HEADING, '')
    .replace(PREPOSICAO_DE_HEADING, '');
  return MARCADOR_DE_SINTESE.test(texto);
}

/**
 * Avalia uma peça. Devolve `{ ok, problemas[], sinais }`, onde cada sinal é
 * `aprovado`, `reprovado` ou `nao-avaliado`.
 *
 * **`nao-avaliado` nunca é aprovação.** O que não dá para verificar é declarado,
 * não presumido — mesma regra que o runner aplica à best-practice de redação
 * ausente. Aprovar em silêncio seria o gate mentindo exatamente onde deveria calar.
 */
// ── 6º sinal: folhas ─────────────────────────────────────────────────────────
// Peça que cita as folhas (PLANO-ORQUESTRADOR.md, Fase 5). O índice dos autos
// (`autos/_index.yaml`, Fase 2) diz que documentos existem; a peça diz onde
// cada um está. Para cada documento indexado que a peça menciona — pelo tipo
// (contestação, sentença, certidão…) ou pelo nome do arquivo —, ao menos um
// parágrafo que o menciona tem de trazer a folha ou o ID. Blockquote não conta.
//
// Onde o documento está depende de onde ele vem (campo `origem` do índice,
// medição dos moldes de 24/09/2026, G17). Documento dos AUTOS está numa folha:
// fls., f., e-fls. ou ID. Documento do CLIENTE (pasta pré-processual, documento
// avulso que acompanha a inicial ou o HC) não tem folha: está no
// Doc. N que a peça junta, e na página dele (`Doc. 03, p. 2`, `p. 2`). Cobrar
// folha dele reprovava a declaração da mãe no HC em todas as versões e levava o
// redator a escrever "Doc. 02, fls. 1" para documento que nunca foi juntado.
// Origem desconhecida (índice sem o campo e sem texto para deduzir) é tratada
// como autos: a régua estrita, a de sempre.
//
// Sem processo (`processo: nenhum` no squad.yaml: contrato, escritura, requerimento
// ao registro), a pasta inteira é do cliente: não há folha, e todo documento vale
// pelo Doc. N e pela página, qualquer que seja a origem que o indexador deduziu.
// No procedimento administrativo (`processo: administrativo`), os autos são do
// órgão e numeram por folha ou por documento: as duas âncoras valem. Medido na
// onda extrajudicial de 25/09/2026: o contrato de locação reprovava por "folha".
const REFERENCIA_DE_FOLHA = /\b(?:e-?fls?\.?|fls?\.|folhas?|f\.)\s*\d+|\bid\s*\d{4,}\b/i;
const REFERENCIA_DE_DOCUMENTO = /\bdocs?\.\s*(?:n[.oº°]\s*)?(?:[a-z]-?)?\d+|\bdocumentos?\s+n[.oº°]\s*\d+|\banexos?\s+(?:n[.oº°]\s*)?\d+|\b(?:p|pp|pag|pags)\.\s*\d+/i;
const MENCAO_POR_TIPO = {
  inicial: /peticao inicial|\binicial\b|exordial/,
  contestacao: /contestacao/,
  replica: /\breplica\b/,
  sentenca: /sentenca/,
  acordao: /acordao/,
  decisao: /\bdecisao\b/,
  certidao: /certidao/,
  intimacao: /intimacao/,
  procuracao: /procuracao/,
  contrato: /\bcontrato\b/,
  laudo: /\blaudo\b/,
};
const semAcento = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// A folha tem de vir JUNTO da menção — "a contestação (fls. 45)", "fls. 45, a
// contestação", "o laudo, ID 2048…" — não em qualquer ponto do parágrafo: um
// `fls.` do laudo não serve para a contestação citada na mesma frase.
const JANELA_ANTES = 30;
const JANELA_DEPOIS = 40;

// Palavras do nome do arquivo que não nomeiam o documento: o rótulo de pasta que
// o indexador usa para tipo genérico (`documento`, `doc`, `anexo`) e o que diz da
// cópia, não do conteúdo. Medido em 24/09/2026 (G17): em
// `02-documento-extrato-ctps-digital.md`, a palavra mais longa era "documento", e
// a peça só passava escrevendo "documento" junto da folha. Número e data do nome
// também saem: a peça escreve "holerites", não "fev2025".
const GENERICAS_DO_NOME = new Set(['documento', 'documentos', 'doc', 'docs', 'anexo', 'anexos', 'copia', 'copias', 'arquivo', 'digitalizado', 'digitalizada', 'scan', 'scaneado', 'extraido', 'extraida']);
/** Palavras do nome que identificam o documento, na ordem do nome (no máximo três: o sintagma que o nomeia). */
const PALAVRAS_DO_NOME = 3;
/** As palavras do nome têm de aparecer JUNTAS: da primeira à última, no máximo isto. */
const SINTAGMA_DO_NOME = 60;

function padraoDeMencao(doc) {
  const porTipo = MENCAO_POR_TIPO[semAcento(doc.tipo)];
  if (porTipo) return { re: porTipo, palavras: null };
  // documento/desconhecido e tipos sem vocabulário próprio (ata, auto, declaração,
  // comprovante): pelo nome do arquivo, como sintagma. Todas as palavras que
  // identificam o documento, juntas, não a mais longa solta no parágrafo: a
  // ata `12-ata-audiencia-instrucao-julgamento.md` casava com qualquer
  // "julgamento" num parágrafo que falasse da audiência de instrução (G17).
  const tronco = semAcento(String(doc.arquivo).split('/').pop()).replace(/\.[a-z0-9]+$/, '').replace(/^[\d\s._-]+/, '');
  const palavras = tronco.split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !/\d/.test(t) && !GENERICAS_DO_NOME.has(t))
    .slice(0, PALAVRAS_DO_NOME);
  if (!palavras.length) return null;
  return { re: null, palavras };
}

/** Ocorrências da menção no parágrafo normalizado: `[inicio, fim]` de cada uma. */
function ocorrenciasDaMencao(paragrafo, padrao) {
  const achados = [];
  if (padrao.re) {
    const re = new RegExp(padrao.re.source, padrao.re.flags.includes('g') ? padrao.re.flags : `${padrao.re.flags}g`);
    let m;
    while ((m = re.exec(paragrafo))) {
      achados.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) re.lastIndex += 1;
    }
    return achados;
  }
  // Sintagma do nome: cada ocorrência da primeira palavra abre uma janela, e as
  // demais têm de estar nela (em qualquer ordem, com preposições entre elas).
  const posicoes = padrao.palavras.map((w) => [...paragrafo.matchAll(new RegExp(`\\b${w}`, 'g'))].map((m) => [m.index, m.index + m[0].length]));
  if (posicoes.some((lista) => !lista.length)) return achados;
  for (const [ini, fim] of posicoes[0]) {
    let a = ini;
    let b = fim;
    // Junto é na mesma frase: "…na audiência de instrução. O julgamento desta
    // apelação…" não nomeia a ata.
    const mesmaFrase = (x, y) => !/[.;!?]\s/.test(paragrafo.slice(Math.min(x, a), Math.max(y, b)));
    const junto = posicoes.slice(1).every((lista) => {
      const perto = lista.find(([x, y]) => Math.max(y, b) - Math.min(x, a) <= SINTAGMA_DO_NOME && mesmaFrase(x, y));
      if (!perto) return false;
      a = Math.min(a, perto[0]);
      b = Math.max(b, perto[1]);
      return true;
    });
    if (junto) achados.push([a, b]);
  }
  return achados;
}

/**
 * A linha da lista de anexos ou de documentos abre com a âncora e descreve o
 * documento depois dela: "Doc. 07, fls. 1: Companhia X, edital do Pregão…". A
 * âncora vale para a linha inteira, por longe que a descrição vá.
 */
function linhaAbertaPelaReferencia(paragrafo, posicao, referencia) {
  const ini = paragrafo.lastIndexOf('\n', posicao - 1) + 1;
  const cabeca = paragrafo.slice(ini, posicao).replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?[*_]*/, '');
  const rotulo = cabeca.match(/^([^:;]{0,40})[:;]/);
  // Só o item que o rótulo abre: depois de um ponto final, a frase é outra.
  return Boolean(rotulo && referencia.test(rotulo[1]) && !/[.!?]\s/.test(cabeca.slice(rotulo[0].length)));
}

/**
 * Linha de tabela é um registro: a âncora vale para a linha inteira, esteja na
 * célula que for ("| Exoneração do fiador | Doc. 05, fl. 1 | COMPROVADO |"), e a
 * coluna cujo cabeçalho é a âncora (`| Doc. |`, `| Fls. |`) ancora a célula da
 * linha: "| R-07 | Relatório do canal de ética |" sob "| Doc. | Descrição |".
 */
function linhaDeTabelaAncorada(paragrafo, posicao, referencia) {
  const linhas = paragrafo.split('\n');
  let resto = posicao;
  let i = 0;
  while (i < linhas.length - 1 && resto > linhas[i].length) { resto -= linhas[i].length + 1; i += 1; }
  const celulas = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  if (!/^\s*\|/.test(linhas[i])) return false;
  if (referencia.test(linhas[i])) return true;
  let cabeca = i;
  while (cabeca > 0 && /^\s*\|/.test(linhas[cabeca - 1])) cabeca -= 1;
  if (cabeca === i) return false;
  const titulos = celulas(linhas[cabeca]);
  return celulas(linhas[i]).some((c, k) => titulos[k] && referencia.test(`${titulos[k]} ${c}`));
}

/**
 * O que está entre aspas na linha é transcrição (súmula, lei, depoimento), como o
 * blockquote: fala do fato, não do documento. Medido em 24/09/2026 (G17): a
 * Súmula 656 do STJ, citada entre aspas no despejo ("A exoneração do fiador
 * depende da notificação…"), casava com o nome da notificação de exoneração do
 * fiador. Troca-se por espaços do mesmo tamanho, para as posições não mudarem.
 */
function semTrechoEntreAspas(texto) {
  return texto.replace(/"[^"\n]{1,600}"|“[^”\n]{1,600}”/g, (m) => ' '.repeat(m.length));
}

/** Numa cópia normalizada do parágrafo: há menção? e alguma menção tem a referência na janela? */
function mencaoComFolha(paragrafo, padrao, referencia) {
  const achados = ocorrenciasDaMencao(semTrechoEntreAspas(paragrafo), padrao);
  for (const [ini, fim] of achados) {
    const janela = paragrafo.slice(Math.max(0, ini - JANELA_ANTES), Math.min(paragrafo.length, fim + JANELA_DEPOIS));
    if (referencia.test(janela) || linhaAbertaPelaReferencia(paragrafo, ini, referencia) || linhaDeTabelaAncorada(paragrafo, ini, referencia)) {
      return { mencao: true, folha: true };
    }
  }
  return { mencao: achados.length > 0, folha: false };
}

/** O documento é lido como do cliente (Doc. N ou página) pela origem, ou por não haver processo. */
const doCliente = (doc, processo) => doc.origem === 'cliente' || processo === 'nenhum';

/** A âncora que vale para o documento: folha para o dos autos, Doc. N ou página para o do cliente. */
function referenciaPara(doc, processo = null) {
  if (!doCliente(doc, processo) && processo !== 'administrativo') return REFERENCIA_DE_FOLHA;
  return { test: (janela) => REFERENCIA_DE_FOLHA.test(janela) || REFERENCIA_DE_DOCUMENTO.test(janela) };
}

/**
 * Avalia o sinal `folhas`. `autos` é a lista de documentos do índice
 * (`{arquivo, tipo, paginas, origem}`); `processo` é o do squad.yaml (`judicial`,
 * `administrativo`, `nenhum`; ausente, judicial). Devolve `{sinal, motivo, semFolha}`.
 */
export function avaliarFolhas(texto, autos = [], { processo = null } = {}) {
  const docs = (Array.isArray(autos) ? autos : []).filter((d) => d && d.arquivo);
  if (!docs.length) {
    return {
      sinal: NAO_AVALIADO,
      motivo: processo === 'nenhum'
        ? 'folhas NÃO AVALIADAS: sem índice dos documentos do cliente (autos/_index.yaml) no squad; sem processo, a peça aponta cada documento pelo Doc. N e pela página, e o gate só confere o que o run indexou (node scripts/indexar-autos.mjs squads/<nome>).'
        : 'folhas NÃO AVALIADAS: sem autos/_index.yaml no squad; a peça não pode citar folhas de autos que o run não indexou (node scripts/indexar-autos.mjs squads/<nome>).',
      semFolha: [],
    };
  }
  const paragrafos = String(texto || '')
    .split(/\n\s*\n/)
    .map((p) => p.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n'))
    .filter((p) => p.trim());
  const normalizados = paragrafos.map((p) => semAcento(p));
  const semFolha = [];
  const semFolhaDosAutos = [];
  const semAncoraDoCliente = [];
  let mencionados = 0;
  for (const doc of docs) {
    const padrao = padraoDeMencao(doc);
    if (!padrao) continue;
    const referencia = referenciaPara(doc, processo);
    const resultados = normalizados.map((p) => mencaoComFolha(p, padrao, referencia)).filter((r) => r.mencao);
    if (!resultados.length) continue;
    mencionados += 1;
    if (resultados.some((r) => r.folha)) continue;
    const nome = `${doc.tipo || 'documento'} (${doc.arquivo})`;
    semFolha.push(nome);
    (doCliente(doc, processo) ? semAncoraDoCliente : semFolhaDosAutos).push(nome);
  }
  if (!mencionados) {
    return { sinal: NAO_AVALIADO, motivo: 'folhas NÃO AVALIADAS: a peça não menciona nenhum documento do índice dos autos.', semFolha };
  }
  if (semFolha.length) {
    const partes = [];
    if (semFolhaDosAutos.length) partes.push(`${semFolhaDosAutos.join(', ')}: documento dos autos mencionado sem a folha ou o ID onde está (${processo === 'administrativo' ? 'fls. N, Doc. N ou ID N' : 'fls. N, f. N, e-fls. N ou ID N'})`);
    if (semAncoraDoCliente.length) partes.push(`${semAncoraDoCliente.join(', ')}: documento do cliente (${processo === 'nenhum' ? 'sem processo' : 'fora dos autos'}) mencionado sem dizer onde está (Doc. N, ou Doc. N, p. N)`);
    return {
      sinal: 'reprovado',
      motivo: `folhas REPROVADAS: ${partes.join('; ')}. O índice diz o que existe; a peça diz onde está.`,
      semFolha,
    };
  }
  return { sinal: 'aprovado', motivo: null, semFolha };
}

/**
 * Perfis cujo "Contrato de saída" descreve o material do revisor, não a peça: o
 * `legal-drafting` de `_legalsquad/core/skill-quality-profiles.json` pede status,
 * minuta como rascunho técnico, matriz fato-prova-tese e riscos, lacunas, próximos
 * passos e checkpoint humano. Os outros perfis (análise, parecer, cálculo) pedem o
 * próprio conteúdo da entrega, que conta onde estiver.
 */
const PERFIS_DA_NOTA_AO_REVISOR = new Set(['legal-drafting']);

/** O perfil que o arquivo de contrato declara (`Perfil: \`legal-drafting\``), ou null. */
function perfilDoContrato(texto) {
  return String(texto || '').match(/^Perfil:\s*`?([\w-]+)`?\s*$/m)?.[1] || null;
}

export function avaliarRedacao({ artefato, entrada, contratos = [], vicios = VICIOS_DE_REDACAO, autos = [], reader = 'juiz', final = false, processo = null }) {
  const texto = String(artefato || '');
  const problemas = [];
  const sinais = {};

  // ── 1. Ancoragem ao caso ────────────────────────────────────────────────
  const ancoras = extrairAncoras(entrada);
  if (ancoras.length === 0) {
    sinais.ancoragem = NAO_AVALIADO;
    problemas.push(
      'ancoragem NÃO AVALIADA: o material de entrada não tem identificadores (número, data, valor, '
      + 'sigla) para confrontar. Sem eles não dá para distinguir peça do caso de peça genérica.'
    );
  } else {
    const usadas = ancoras.filter((a) => texto.includes(a));
    if (usadas.length === 0) {
      sinais.ancoragem = 'reprovado';
      problemas.push(
        `ancoragem REPROVADA: a peça não cita nenhum dos ${ancoras.length} identificadores do caso `
        + `(ex.: ${ancoras.slice(0, 3).join(', ')}). Peça que serve para qualquer caso é peça rasa.`
      );
    } else {
      sinais.ancoragem = 'aprovado';
    }
  }

  // ── 2. Cobertura do contrato de saída ───────────────────────────────────
  // O contrato vem como texto ou como `{ texto, origem }` (o hook passa o caminho
  // do `references/high-performance-contract.md` de cada skill): a mensagem diz de
  // onde veio cada exigência. Medido em 25/09/2026, alimentos/reclamação: o gate
  // dizia "exigido pelo contrato de saída da skill", o SKILL.md não tem essa seção
  // (ela mora no arquivo de referência que o SKILL.md linka) e a origem ficou a
  // descobrir. A seção do perfil `legal-drafting` é material do revisor: conta só
  // dentro da nota ao revisor (bloco `nota-ao-revisor`), que o empacotador tira da peça.
  const secoes = [];
  for (const c of contratos) {
    const textoDoContrato = typeof c === 'string' ? c : String((c && c.texto) || '');
    const origem = c && typeof c === 'object' && c.origem ? String(c.origem) : null;
    const daNota = PERFIS_DA_NOTA_AO_REVISOR.has(perfilDoContrato(textoDoContrato));
    for (const secao of extrairSecoesDeSaida(textoDoContrato)) {
      const igual = secoes.find((s) => normalizar(s.rotulo) === normalizar(secao.rotulo));
      if (igual) {
        if (origem && !igual.origens.includes(origem)) igual.origens.push(origem);
        igual.daNota = igual.daNota || daNota;
        continue;
      }
      secoes.push({ ...secao, origens: origem ? [origem] : [], daNota });
    }
  }
  const origens = [...new Set(secoes.flatMap((s) => s.origens))];
  const deOnde = origens.length ? `"## Contrato de saída" de ${origens.join(', ')}` : 'contrato de saída da skill';
  if (final) {
    // O "Contrato de saída" da skill descreve a MINUTA (status, rascunho
    // técnico, matriz fato-prova-tese, riscos e checkpoint humano): material
    // para quem revisa, não para o juízo. O conferente remove tudo isso ao
    // fechar a versão final (`citation_gate: final`), por desenho, e a peça
    // limpa reprovava aqui exatamente por estar limpa (medido em 15/09/2026).
    // A cobertura foi medida na minuta, no step de redação; na final não há o
    // que medir, e `nao-avaliado` nunca aprova nem reprova sozinho.
    sinais.cobertura = NAO_AVALIADO;
    problemas.push('cobertura NÃO AVALIADA: artefato final (citation_gate: final, ou <peça>-final.md com o manifesto ao lado); o contrato de saída da skill descreve a minuta e foi medido nela.');
  } else if (secoes.length === 0) {
    // Área não instalada, ou skill sem contrato v5. Desliga esta dimensão, não o
    // gate inteiro — degradação por dimensão, como o runner faz.
    sinais.cobertura = NAO_AVALIADO;
    problemas.push('cobertura NÃO AVALIADA: nenhum "Contrato de saída" encontrado nas skills declaradas.');
  } else {
    const nota = separarNotaAoRevisor(texto);
    if (nota.erro) {
      sinais.cobertura = 'reprovado';
      problemas.push(`cobertura REPROVADA: ${nota.erro}. A nota ao revisor abre com ${NOTA_AO_REVISOR_INICIO} e fecha com ${NOTA_AO_REVISOR_FIM}, cada um sozinho na linha.`);
    } else {
      const estrutura = linhasDeEstrutura(texto);
      const naNota = linhasDeEstrutura(nota.nota);
      const naPeca = linhasDeEstrutura(nota.peca);
      const ausentes = [];
      const foraDaNota = [];
      for (const s of secoes) {
        if (!s.daNota) { if (!secaoPresente(s, estrutura)) ausentes.push(s); continue; }
        if (secaoPresente(s, naNota)) continue;
        (secaoPresente(s, naPeca) ? foraDaNota : ausentes).push(s);
      }
      const rotulos = (lista) => lista.map((s) => `"${s.rotulo}"`).join(', ');
      const partes = [];
      if (ausentes.length) partes.push(`a minuta não traz como seção ${rotulos(ausentes)}, exigido pelo ${deOnde}.`);
      if (foraDaNota.length) partes.push(`${rotulos(foraDaNota)} está na peça, fora da nota ao revisor: é material de revisão (perfil legal-drafting) e só sai da peça protocolada dentro dela.`);
      if (partes.length) {
        sinais.cobertura = 'reprovado';
        problemas.push(
          `cobertura REPROVADA: ${partes.join(' ')} `
          + `Cada elemento entra como título, rótulo em negrito (**Status:** partial) ou rótulo simples (Status: ready); a palavra solta no corpo não conta. O material do revisor vai no fim da minuta, entre ${NOTA_AO_REVISOR_INICIO} e ${NOTA_AO_REVISOR_FIM}.`
        );
      } else {
        sinais.cobertura = 'aprovado';
      }
    }
  }

  // ── 3. Andaime vazado ───────────────────────────────────────────────────
  const corpo = texto.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
  const vazamentos = ANDAIME.map((padrao) => corpo.match(padrao)).filter(Boolean);
  if (vazamentos.length) {
    sinais.andaime = 'reprovado';
    // O trecho nomeado é a linha onde o padrão casou, para quem libera saber o que liberar.
    const trechoDoVazamento = (m) => {
      const inicio = m.index + (m[0].length - m[0].trimStart().length);
      return JSON.stringify(corpo.slice(inicio).split('\n')[0].trim().slice(0, 60));
    };
    problemas.push(`andaime REPROVADO: template do pipeline vazou para a entrega (${vazamentos.length} padrão/ões: ${vazamentos.map(trechoDoVazamento).join(', ')}).`);
  } else {
    sinais.andaime = 'aprovado';
  }

  // ── 4. Vícios de redação (marcas de IA) ─────────────────────────────────
  // Mede DENSIDADE fora de citação. Presença isolada não reprova: "outrossim"
  // uma vez é conectivo, e reprovar aí ensinaria a evitar a palavra em vez de
  // evitar o enchimento — o gate viraria superstição.
  const lista = Array.isArray(vicios) ? vicios.filter((v) => v && v.regex) : [];
  if (!lista.length) {
    sinais.vicios = NAO_AVALIADO;
    problemas.push('vícios NÃO AVALIADOS: nenhuma lista de padrões de redação foi fornecida ao gate.');
  } else {
    const redigido = semCitacoes(texto);

    // ── Travessão de IA: tolerância ZERO no que a peça REDIGE ──────────────
    // Regra de produto, distinta da densidade: o travessão (—, ou – espaçado
    // como conector) é a marca tipográfica de texto de IA, e a prosa forense
    // brasileira não precisa dele — vírgula, dois-pontos, parênteses ou ponto
    // resolvem. Diferente de "outrossim" (palavra legítima em dose), UM
    // travessão já denuncia; por isso não entra na conta de densidade: é
    // reprovação própria. Citações (blockquote) ficam de fora — ementa
    // transcrita com travessão é fidelidade à fonte, não estilo do redator. O
    // hífen (-) nunca casa: palavra composta e "art. 1.035-A" são intocáveis.
    const travessoes = (redigido.match(/\u2014|\s\u2013\s/g) || []).length;
    if (travessoes > 0) {
      sinais.vicios = 'reprovado';
      problemas.push(
        `travessão REPROVADO: ${travessoes} travessão(ões) na prosa redigida, marca de texto de IA. `
        + 'Reescreva com vírgula, dois-pontos, parênteses ou ponto final; travessão só sobrevive dentro de citação transcrita.'
      );
    }
    const achados = [];
    let total = 0;
    for (const vicio of lista) {
      const n = (redigido.match(vicio.regex) || []).length;
      if (n) {
        total += n;
        achados.push(`${vicio.id}${vicio.rotulo ? ` (${vicio.rotulo})` : ''} ×${n}`);
      }
    }
    if (total > LIMITE_DE_VICIOS) {
      sinais.vicios = 'reprovado';
      problemas.push(
        `vícios REPROVADO: ${total} marcas de redação genérica fora de citação: ${achados.join('; ')}. `
        + 'Troque a asserção pela demonstração e corte o conectivo de enchimento (ver `redacao-sem-marcas-de-ia`).'
      );
    } else if (sinais.vicios !== 'reprovado') {
      // Não sobrescreve a reprovação do travessão acima.
      sinais.vicios = 'aprovado';
    }
  }

  // ── 5. Frente: síntese nos primeiros 20% ────────────────────────────────
  // Front-loading como regra de produto (PERSUASAO.md §3). O juiz recebe a
  // peça já triada ou resumida por IA, e o que não sobrevive ao resumo ele não
  // lê. Peça longa abre com um bloco de síntese (pedido, teses numeradas,
  // Temas/súmulas) nos primeiros 20% do que REDIGE. Mesma natureza do
  // travessão: não há dose legítima, ou a síntese está no começo ou o segundo
  // leitor não a vê. O gate não julga se a síntese é boa (isso é o verificador
  // de persuasão); garante que existe um lugar para ser julgada. Blockquote
  // não é redação: fica fora da conta e não serve de marcador.
  const linhasRedigidas = semCitacoes(texto).split('\n').filter((linha) => linha.trim() !== '');
  const total = linhasRedigidas.length;
  if (total < LIMIAR_DE_FRENTE) {
    // Peça curta não é peça aprovada em frente; é peça não medida.
    sinais.frente = NAO_AVALIADO;
    problemas.push(
      `frente NÃO AVALIADA: peça curta (${total} linhas redigidas); síntese só é exigida a partir de ${LIMIAR_DE_FRENTE}.`
    );
  } else {
    // ceil(total / 5) é o "20%" da spec sem passar por ponto flutuante.
    const janela = Math.max(PISO_DA_JANELA, Math.ceil(total / 5));
    const posicao = linhasRedigidas.findIndex(ehMarcadorDeSintese);
    if (posicao >= 0 && posicao < janela) {
      sinais.frente = 'aprovado';
    } else {
      sinais.frente = 'reprovado';
      const onde = posicao >= 0
        ? `o primeiro marcador só aparece na linha redigida ${posicao + 1} (${JSON.stringify(linhasRedigidas[posicao].trim().slice(0, 60))})`
        : 'não há marcador em toda a peça';
      problemas.push(
        `frente REPROVADA: nenhum marcador de síntese nos primeiros ${janela} de ${total} linhas redigidas; ${onde}. `
        + 'Abra a peça com um bloco de síntese: pedido, teses numeradas e os Temas/súmulas que as governam, em até dez linhas.'
      );
    }
  }

  // Pontas por tipo (PLANO-ORQUESTRADOR.md, Fase 7): contrato (`reader:
  // contraparte`) não abre com síntese de peça — o quadro-resumo é cobrado
  // pelo verifica-contrato; conteúdo de autoridade (`reader: publico`) abre
  // com gancho. O sinal `frente` não se aplica a nenhum dos dois: NÃO AVALIADO.
  const leitor = String(reader || '').toLowerCase();
  if (leitor === 'contraparte' || leitor === 'publico') {
    for (let i = problemas.length - 1; i >= 0; i--) if (/^frente /i.test(problemas[i])) problemas.splice(i, 1);
    sinais.frente = NAO_AVALIADO;
    problemas.push(leitor === 'contraparte'
      ? 'frente NÃO AVALIADA: contrato (reader: contraparte); o quadro-resumo é cobrado pelo verifica-contrato, não pela síntese de peça.'
      : 'frente NÃO AVALIADA: conteúdo de autoridade (reader: publico) abre com gancho, não com síntese de peça; o gancho é cobrado pelo revisor.');
  }

  // ── 6. Folhas ────────────────────────────────────────────────────────────
  const folhas = avaliarFolhas(texto, autos, { processo });
  sinais.folhas = folhas.sinal;
  if (folhas.motivo) problemas.push(folhas.motivo);

  return {
    ok: !Object.values(sinais).includes('reprovado'),
    problemas,
    sinais,
  };
}
// <<< redacao-gate:end

const carregarAvaliador = async () => avaliarRedacao;

/**
 * Avalia um arquivo, SEM a heurística de "é artefato final?". Usado tanto pelo
 * modo passivo (que aplica a heurística por cima) quanto pelo `--json` — o
 * runner que chama `--json` já sabe que este é o output do step de redação; a
 * heurística de nome existe só para escopar o hook automático, que dispara sem
 * ninguém ter dito "isto é uma peça".
 *
 * Devolve `null` quando não há como avaliar (fora de squads/*​/output/, ou
 * ilegível) — distinto de `{ok: true}` ou `{ok: false}`.
 */
async function avaliarArquivo(filePath) {
  const ctx = contexto(filePath);
  if (!ctx) return null;

  let texto = '';
  try { texto = readFileSync(filePath, 'utf8'); } catch { return null; }

  const squadDir = join(ctx.raiz, 'squads', ctx.squad);
  const avaliarRedacao = await carregarAvaliador();
  return avaliarRedacao({
    artefato: texto,
    entrada: entradaDoCaso(dirname(filePath), filePath),
    contratos: contratosDasSkills(ctx.raiz, squadDir, filePath),
    autos: lerIndiceDeAutos(squadDir),
    reader: readerDoSquad(squadDir),
    processo: processoDoSquad(squadDir),
    final: ehVersaoFinalDeclarada(filePath, texto),
  });
}

/**
 * Versão final DECLARADA: o conferente fecha a entrega com `citation_gate: final`
 * no frontmatter (ou grava em `output/final/`, ou deixa o marcador explícito), ou
 * grava `<peça>-final.md` com o manifesto `<peça>-final.md.citation-gate.json` ao
 * lado. O nome sozinho não basta: peça reconhecida só pelo nome continua sendo
 * medida por inteiro, porque pode ser a minuta de um squad sem step de
 * conferência. O nome com o manifesto é a final que o Citation Gate já fechou.
 * Medido em 24/09/2026 (G17): três runs gravaram a final sem o frontmatter, que
 * nenhum step mandava gravar, e a cobertura da minuta reprovou a peça limpa.
 */
function ehVersaoFinalDeclarada(filePath, texto) {
  const nome = basename(p(filePath));
  return /^---[\s\S]*?^citation_gate:\s*final\b[\s\S]*?^---/mi.test(String(texto || ''))
    || /\/output\/final\//i.test(p(filePath))
    || /<!--\s*LEGALSQUAD:REDACAO-GATE:FINAL\s*-->/i.test(String(texto || ''))
    || (FINAL_NAME.test(nome) && !nomeRascunho(nome) && existsSync(`${filePath}.citation-gate.json`));
}

/** Modo PASSIVO (PostToolUse) — só age sobre o que parece artefato final. */
async function rodar(filePath) {
  const alvo = normalize(filePath);
  let texto = '';
  try { texto = readFileSync(alvo, 'utf8'); } catch { return; }
  if (!contexto(alvo) || !ehArtefatoFinal(alvo, texto)) return;

  const veredito = await avaliarArquivo(alvo);
  if (!veredito) return;
  if (!veredito.ok) block(`${basename(alvo)}\n  · ${veredito.problemas.join('\n  · ')}`);
  for (const aviso of veredito.problemas) process.stderr.write(`REDAÇÃO GATE (aviso): ${aviso}\n`);
}

const checkIndex = process.argv.indexOf('--check');
if (checkIndex >= 0) {
  const pedido = process.argv[checkIndex + 1];
  if (!pedido) block('uso: verifica-redacao.mjs --check <artefato> [--json]');
  const alvo = isAbsolute(pedido) ? normalize(pedido) : normalize(resolve(pedido));

  if (process.argv.includes('--json')) {
    // Consulta, não enforcement. O runner usa isto para saber COMO está a
    // minuta e decidir REJECT/ADVANCE dentro do loop de revisão — nunca sai
    // com erro aqui, mesmo reprovado: quem decide o que fazer é quem chamou.
    const veredito = await avaliarArquivo(alvo);
    process.stdout.write(JSON.stringify(veredito ?? { ok: null, problemas: ['fora de squads/*/output/ ou ilegível'], sinais: {} }));
    process.exit(0);
  }

  await rodar(alvo);
  process.exit(0);
}

let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { process.exit(0); }
let entrada = {};
try { entrada = JSON.parse(raw); } catch { process.exit(0); }
const caminho = (entrada.tool_input || {}).file_path || (entrada.tool_input || {}).path || '';
if (!caminho) process.exit(0);
await rodar(normalize(caminho));
process.exit(0);
