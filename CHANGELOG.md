# Changelog

## [Unreleased]

## [0.9.58] - 2026-09-26

### Onda extrajudicial: vocabulário do ato, papel dos steps e conferência de contratos

Achados da curadoria dos dez modelos extrajudiciais (locação, promessa de compra e venda, confissão de dívida, acordo
extrajudicial, contrato social, acordo de sócios, inventário e usucapião extrajudiciais, defesa de auto de infração e
recurso em licitação), que as frentes tinham contornado na prosa. Os 37 modelos judiciais compilam byte a byte igual.

- **Papel do step por palavra.** `papelDoStep` lia "tema" dentro de "sistema" (o protocolista da licitação virava
  leitor de temas), "revisão" dentro de "previsão" e "prova" dentro de "aprovação". O radical casa no começo da
  palavra, e o `check-squad` acusa `papel-incoerente` quando o id aponta um papel e o compilador deu outro.
- **Vocabulário do ato negociado, registral e administrativo.** O diagnóstico aprova "pontos" e a "mensagem central"
  em vez de teses e linha de ataque; fora do juízo o intake busca no tribunal que orienta o caso; sem processo, a
  lista de força vinculante não traz IRDR; sem parte adversa, o tom se dirige a quem recebe ou pode impugnar o ato;
  no acordo para homologar, o diagnóstico pergunta a via da homologação. Na locação e nos contratos, 54 termos
  judiciais viraram 23; na usucapião, 121 viraram 61.
- **Rubrica do revisor pelo tipo de entrega.** Contrato ganha exemplo por cláusula e requerimento fora do juízo,
  por seção e item; a peça judicial fica igual.
- **`verifica-contrato`.** Contradição só entre cláusulas do mesmo objeto (remissão, assunto em comum ou parâmetro
  único do contrato); "conclusão" deixa de ser lida como execução; termos definidos em linha corrida e no aposto
  (`cada um, o "Signatário"`).
- **`squad-modelo --criar`** diz o próximo passo pelo desenho: autos com processo, documentos do cliente sem
  processo. **`--extrair --forcar`** preserva os campos de curadoria que o extrator não gera (`derivado_de`).

## [0.9.57] - 2026-09-26

### Sem travessão nos prompts do Arquiteto, nos agentes de núcleo e nos exemplos

- **Arquiteto.** `build.prompt.md`, `design.prompt.md`, `discovery.prompt.md`, os `sherlock-*`, o `architect.agent.yaml` e o
  `skills.engine.md` foram reescritos sem travessão (1.494 ocorrências no escopo, as instruções iguais em conteúdo),
  e o Build e o Design passam a dizer que o texto gerado para o squad não usa travessão.
- **Agentes de núcleo e exemplos.** Verificador de citações, verificador de persuasão, contraditor, catalog-scout e
  avaliador (Claude, Codex e plugin), a skill do chefe, os READMEs e os squads de exemplo, sem o caractere.
- Os 37 modelos compilam byte a byte igual. Fica para uma rodada própria o texto que o `skill-contract` grava nas
  skills, porque mudá-lo reescreve as 7.398 skills e exige republicar os pacotes.

## [0.9.56] - 2026-09-26

### Squads dos alunos para a plataforma da comunidade, e texto sem travessão

- **Contribuição automática.** Depois de um run aprovado (e no `update`), `legalsquad contribuir` manda à caixa de
  entrada privada do servidor do acervo a estrutura dos squads criados ou mudados na pasta: o mesmo que o modelo do
  escritório levaria, nunca autos, saída, memória, estado do run, `identificacao.json`, `caso.json`, nome do aluno ou
  do escritório. O consentimento é o do contrato da mentoria e da comunidade: o onboarding só informa, sem pergunta.
  A varredura de sigilo roda antes e barra o squad (nome do aluno, do escritório e OAB também barram; documento do
  caso que não pôde ser lido segura o envio); o aluno vê uma linha só quando um squad é barrado. Sem rede, fica
  pendente e vai depois; o mesmo conteúdo não sobe duas vezes. Sem crédito: vai só um id pseudônimo da instalação.
  Desligar: `LEGALSQUAD_CONTRIBUIR=0` na máquina ou `"contribuir": false` em `_legalsquad/config/acervo.json`.
- **Sem travessão no texto que o motor escreve.** O molde de agente trocou "Vocabulary — Always Use" e "Never Use"
  por "Vocabulary: Always Use" e "Never Use" (700 linhas nos 37 modelos, nada mais muda; o `check-squad` aceita o
  título antigo). Runner, comando, bloco global, mensagens da CLI, hooks e scripts do projeto foram reescritos sem
  o caractere.

## [0.9.55] - 2026-09-26

### Último par da nova medição: remissão sem diploma, avaliadores e pacote

Medido no mandado de segurança (100 na segunda rodada) e no despejo (92 na segunda rodada). Fecha a nova medição
dos oito moldes: sete aprovados, e o habeas corpus reprovado por um defeito do extrator já corrigido na 0.9.51.

- **Remissão sem diploma.** "(art. 22, VIII)" sumia do extrator. Agora herda o diploma quando o contexto não deixa
  dúvida (mesma oração, enumeração, frase ou parágrafo com um diploma só) e leva `diploma_de` para o verificador
  conferir; sem contexto, sai `sem_diploma` e bloqueia a final até o manifesto a resolver. Na minuta do despejo, 38
  citações viraram 53; as 21 finais da medição que passavam continuam passando.
- **Avaliadores.** O despacho da meta diz que o veredito de cada critério é obrigatório e leva o esqueleto do JSON; o
  consenso reconhece o formato antigo e manda redespachar com a explicação; `update` e `install-global` avisam para
  reabrir a sessão quando trocam um agente. Vários marcadores de dado numa exigência são aceitos se todos estão no
  manifesto.
- **Hooks e cartório.** Relatório de gate (`persuasao/`, `citacoes/`, `_meta/`, `verificador-*`, `avaliacao-*`) nunca é
  peça final; `consulted_at` mais de 2 minutos no futuro é recusado; a cobertura aceita título com o valor na linha
  de baixo.
- **Pacote.** Pendências contam só a peça, sem a nota ao revisor (14, igual ao manifesto); documento citado só para
  ser excluído vai para "a decidir".
- **Fonte oficial e runner.** `--fontes` aceita URL direta; a pesquisa grava as cópias do STJ na pasta do run
  (`--out`); a linha de memória vai para a nota ao revisor.

## [0.9.54] - 2026-09-25

### Terceiro par da nova medição: nota ao revisor fora da peça, cartório e avaliadores

Medido na ação de alimentos (92, aprovada) e na reclamação trabalhista (100 na segunda rodada).

- **Nota ao revisor fora do pacote de protocolo.** A cobertura do Redação Gate exigia na minuta as seções de
  trabalho do contrato da skill (status, matriz, riscos), e elas iam parar no `.docx`. Agora ficam num bloco
  marcado no fim da minuta (`nota-ao-revisor`); o gate as conta só ali, o empacotador tira o bloco da peça e
  grava `NOTA-AO-REVISOR.md` no pacote. A cobertura mede só as skills do agente que grava o artefato e diz de
  qual arquivo veio o contrato.
- **Avaliadores com a lista certa de steps posteriores.** `squad-state steps-posteriores` devolve só steps de
  agente depois da meta; a aprovação (parada humana) derrubava um critério na reclamação.
- **Cartório.** `consulted_at` anterior ao início do run é recusado (a cópia vinda do cache de outro run traz
  `servido_do_cache_em`); `citacoes-pendentes` conta citações como o manifesto e dispositivos à parte (44
  dispositivos em 36 citações na ação de alimentos).
- **Runner e steps.** Quem despacha o verificador de citações a pedido do revisor é o chefe; a reabertura das
  fontes oficiais roda com 10 minutos de limite; avisos de teto em uma linha coerente; o sinal de andaime não
  confunde a chave `run:` do cabeçalho com rascunho esquecido.

## [0.9.53] - 2026-09-25

### Instalar só pelo Claude, e peças extrajudiciais sem vocabulário de processo

- **Plugin com o motor dentro.** O plugin do Claude Code passa a trazer o motor inteiro (`plugin/motor/`), o
  comando `legalsquad` no shell do Claude (`bin/`) e as dependências para o Claude Code instalar sozinho. A cada
  conversa, um SessionStart sem rede (cerca de 50 ms) registra o motor em `~/.legalsquad/motor.json` e injeta o
  bloco do chefe-roteador; com o bloco do npm já no `CLAUDE.md` global, injeta só o que falta. O disparador dos
  hooks do projeto vem no `hooks.json` do plugin e cede a vez ao da máquina. Projeto criado pelo plugin resolve o
  motor pelo registro, então continua funcionando quando o cache troca de versão. Instalar: `/plugin marketplace
  add bbpropulse/legalsquad-nucleo` e `/plugin install legalsquad@bbpropulse`. Falta de Node.js é avisada em
  português. Quem instalou pelo npm segue igual; vale o motor mais novo.
- **Peças extrajudiciais.** O design ganha `reader: autoridade`, `destinatario`, `contraparte: false` e
  `processo: judicial | administrativo | nenhum`. O vocabulário do texto fixo sai desses campos: sem processo, os
  documentos do cliente são citados por Doc. e página, sem juízo nem folha; no administrativo, órgão, autoridade e
  instância; no ato consensual, o pré-mortem ataca da cadeira de quem pode recusar o ato. Redação Gate,
  identificação, empacotador e runner acompanham. Os 37 modelos atuais compilam byte a byte igual.
- **check-squad sem aviso falso.** Skill de peça que só o revisor ou o conferente declara não é cobrada do
  redator em `redacao-sem-skill-de-peca`.

## [0.9.52] - 2026-09-25

### Modelo do escritório: o squad aprovado vira modelo, com as skills do escritório, e vai para outra pasta

Pedido do dono: guardar depois do run o squad que funcionou como modelo do escritório, levar junto as skills
criadas ou personalizadas respeitando integralmente o que foi feito, importar em outra pasta e oferecer isso
no onboarding. A 0.9.42 guardava cópia inteira e foi recolhida (0.9.43); esta versão passou por três revisões
independentes por execução (19, 16 e 14 achados), todos resolvidos ou tornados impossíveis.

- **Diferença sobre o modelo da área.** `squad-modelo --salvar <squad>` guarda só o que o escritório mudou:
  desenho campo a campo, trechos dentro de cada texto e texto fixo ancorado, arquivos acrescentados e
  tirados. Criar do modelo compila o modelo da área na versão de hoje e reaplica a diferença; o que não
  couber é relatado, nunca aplicado às cegas. Squad do Arquiteto vai inteiro. Leva a nota da Verificação da
  Meta do run que o originou, nunca o caso.
- **Skills e best-practices do escritório.** A criada no projeto vai inteira; a de pacote personalizada vai
  como diferença e, no squad novo, vira `esc-<nome>`, usada pelos agentes que escrevem, com a do pacote
  intacta para os outros squads. Na pasta de origem, a edição passa a `SKILL.local.md`, que o `update` e o
  `acervo ligar` não tocam. Skill de conferência de citações, ética ou sigilo não se troca por arquivo de
  fora.
- **Sigilo.** A mesma varredura no salvar, no exportar e no importar: sem caixa e sem acento, identificadores
  com e sem máscara, nomes, valores e datas da pasta do caso inteira (inclusive `.docx` e `.odt` do cliente
  em squad extrajudicial), nome e arquivos das skills. Achado barra; `--substituir` troca o trecho só no
  modelo. A OAB e o e-mail do escritório não barram.
- **Exportar e importar.** `--exportar` grava um `.lsmodelos.json` sem caminho da máquina nem código do
  squad; `--importar` valida e recria numa pasta temporária antes de gravar, tudo ou nada, com o motivo de
  cada recusa. Gatilho coringa curto, régua que tira pedido de outra peça, gate enfraquecido e modelo de área
  não ligada são recusados sem derrubar os outros.
- **Escolha e gestão.** O modelo do escritório vence só o modelo da área da mesma peça; o chefe pergunta no
  empate. `--listar`, `--apagar` (lixeira), `--restaurar`, `--renomear`, `--procurar`.
- **Convites de volta.** Na entrega de um run aprovado, "guardar este squad como modelo do escritório"
  aparece uma vez (não aparece se nada mudou ou se o advogado recusou). No onboarding, a pergunta de importar
  só aparece quando uma pasta ao lado tem modelos do escritório.
- **Depósito.** `acervo status` acusa arquivo do depósito alterado por dentro; `check-squad` avisa skill sem
  contrato e skill citada que não existe.

## [0.9.51] - 2026-09-25

### Segundo par da nova medição: extrator de citações, pacote e despacho em ondas

Medido na apelação criminal (nota 100) e no habeas corpus (92, reprovado pela regra por duas citações
conferidas que o extrator não via na final).

- **Extrator de citações.** Lê a forma abreviada sem "art." (`CPP 244`, `CP 44, § 2º`, `CP 65, III, d`), não
  atravessa parêntese solto nem dois-pontos (saíam títulos como `CPP 400), observado o limite do art. 617`), reconhece
  SL, SS, AP e MI com sinal de acórdão, e MC, Ref, AgR e ED depois do número como outro acórdão, que precisa da
  própria entrada. Nas finais reais: a apelação passa a exigir 19 citações a mais, e o HC, a SL 1395 e o art. 310,
  § 6º, que o manifesto deixou de fora.
- **Pacote.** Citação conferida no acervo conta como conferida no termo e nos próximos passos. O prazo vem do
  `prazo-fatal.json` onde o squad o grava, ou aponta a contagem do run e o último ato. O ANEXOS separa o que juntar
  do que já está nos autos, e a procuração fora dos autos entra no que juntar.
- **Despacho em ondas de até 5.** O limite de subagentes simultâneos é da sessão; o que a ferramenta recusar por
  limite volta na onda seguinte, sem contar como falha.
- **Persuasão de outra versão.** `squad-state persuasao-carimbo` guarda o hash da síntese e dos pedidos aprovados; o
  `manifesto-final` avisa quando a final mudou depois do gate. O runner diz quando a reconferência é obrigatória.
- **Arquivos temporários do run** em `output/<run>/_tmp/`, fora do pacote, e sem o comando `timeout`, que o macOS
  não tem.

## [0.9.50] - 2026-09-25

### Primeiro par da nova medição: formato não é nota, citações fora do gate e o cartório

Medido na negativação e na contestação trabalhista, rodadas com a 0.9.49.

- **Falha de formato do avaliador não vira nota.** Os três avaliadores da negativação deram ATENDE nos seis
  critérios, com o local e o marcador dentro da evidência, e o consenso rebaixou tudo: nota 50, reprovada. O
  consenso agora tira da evidência o local (linha, seção, Doc., folha) e o marcador que está no manifesto; o
  que não dá para tirar devolve `refazer-avaliacao`, e o runner redespacha aquele avaliador uma vez. Recalculado:
  negativação 92, aprovada; contestação, rodada 1, 75 pelas faltas reais da peça.
- **Citações que passavam fora do gate.** Acórdão do TST de classe composta (`E-ED-ARR`, `Ag-AIRR`), plurais
  ("ADIs 6.050, 6.069 e 6.082", "Súmulas 85 e 338"), recurso interno antes da classe ("EDcl no REsp"), "parágrafo
  único do mesmo artigo" e intervalos de incisos. O artigo inteiro no título não cobre mais parágrafo, inciso e
  alínea: cada dispositivo citado precisa da própria entrada no manifesto, como o runner já pedia.
- **Laço final com as confirmações pedidas.** Com `--expect 2`, o laço do gate final não fecha com uma só e
  aceita o voto que falta no mesmo laço.
- **Cartório honesto.** O `manifesto-final` mantém `verificada_no_acervo` com a cópia e o hash; o cartório recusa
  entrada cujo hash é de outra URL no índice das fontes (a OJ 233 da contestação trazia a URL de uma página do TST
  com o hash de outra).
- **Fonte oficial vazia não é fonte.** Página que pede JavaScript ("habilitar o javascript") é `desafio-js` e
  JSON sem conteúdo é `json-sem-conteudo`; o cache do acervo recusa o que for vazio.
- **Pacote e sumário.** O ANEXOS.md dá como citado só o documento referido por Doc. NN, folha ou nome; o sumário
  dos autos não se invalida por campo novo do índice, só por mudança nos autos; o PROXIMOS-PASSOS não fala de
  prazo fatal quando o intake registrou que não há prazo processual.

## [0.9.49] - 2026-09-24

### Pasta do Codex com o nome que o Codex lê

- **`.codex`, não `.Codex`.** A documentação oficial do Codex lê `<repo>/.codex/` (hooks.json, config.toml,
  agentes). O motor criava `.Codex`: no macOS dava no mesmo, no Linux o Codex não achava nada do projeto.
  Template, hooks, cartório e testes passam a usar `.codex`.
- **Migração no `legalsquad update`.** Projeto com `.Codex` sai com `.codex`, conteúdo preservado, renomeado
  por um nome temporário para funcionar também em disco sem diferença de maiúsculas. Com as duas pastas, o
  update não mexe e avisa. Até o update, o disparador e o cartório ainda acham os hooks na pasta antiga.

## [0.9.48] - 2026-09-24

### P2 da medição: métricas certas, pacote sem resposta livre, nove defeitos pequenos e gates no Codex

- **Métricas do run medem a espera e a peça certas (G22).** A espera humana usa o último registro do step
  antes da resposta, e o fan-out da fase zero deixa de contar como espera: na contestação trabalhista, de
  48,7 para 3,2 min. Paradas humanas e escaladas ao profissional são métricas separadas (escalada se registra
  com `--step escalada-{gate}`). Pendências contam só a peça que o empacotador escolhe; com duas candidatas,
  a métrica diz "não medido". Na reclamação, o TERMO dizia 7 pendências vindas do pré-mortem; agora diz 0.
- **Pacote sem texto livre do profissional (sigilo).** TERMO e PROXIMOS-PASSOS não copiam mais a resposta
  dos checkpoints nem o pedido de reabertura, que traziam nomes: sai a decisão pelo rótulo da opção, ou
  "resposta livre, não transcrita", com o caminho do `run-state.json`, que fica no escritório.
- **Nove defeitos pequenos (G23).** `resolve-skills` separa ids num argumento só; `autos-para-md.py` sai 0
  quando os autos são só Markdown; o acervo aceita `VERIFIED_OFFICIAL_OCR` e rebaixa a `DISCOVERY_ONLY` o
  oficial declarado sem URL e data; a identificação exige `ultimo_ato.arquivo` existente; o runner diz que o
  chefe grava a resposta dos verificadores sem escrita; o compilador só cita best-practice de persuasão que o
  projeto tem; o despacho do nativo declarado é obrigatório e fica registrado no artefato; o `sumario-autos`
  aceita "Doc. 03" e "pp. 2-3".
- **Decisão no teto registrada por código.** `squad-state gate-decisao --decisao corrigir|seguir` grava a
  decisão do profissional sobre um laço escalado; `corrigir` abre um único ciclo de conferência da correção.
  O `manifesto-final` recusa enquanto houver laço escalado sem decisão, o que pegaria a persuasão da apelação
  e o gate de redação do HC e da reclamação na medição.
- **Gates do projeto no Codex (sigilo).** No Codex a escrita é o `apply_patch`, sem `file_path`, e os gates não
  rodavam nem na raiz. O disparador de máquina lê o patch, acha a raiz de cada arquivo e roda os hooks do
  projeto, guarda de memória incluída. O `install-global` o registra em `~/.codex/hooks.json` só quando há
  `~/.codex/`, e o diagnóstico ganha o item "hooks do projeto no Codex". Falta a aprovação manual em `/hooks`
  no Codex, que o motor não consegue conferir.

## [0.9.47] - 2026-09-24

### P1 da medição: autos por referência, pacote certo, Redação Gate sem falso positivo, fonte oficial honesta e manifesto por comando

- **Autos por referência seguidos em tempo de run (G16).** `squads/<code>/autos/...` é o caminho lógico e o
  `squad-path` o resolve pelo `caso.json`: a fase zero de squad criado com `--caso` não dá mais
  VALIDATION:FAIL, inclusive nos squads já compilados. O empacotador lê o índice do caso.
- **Pacote com a peça conferida (G21).** Sem `--artefato`, vale a peça do manifesto do Citation Gate, depois a
  declarada pelo step de conferência, e só então a entrega mais alta; avaliação da meta, verificações e apoio
  não são entrega. `squad-path --modo escrita` cria a pasta da versão (pasta vazia é reserva).
- **ANEXOS.md sem nome de arquivo (sigilo).** Cada documento sai como "Doc. NN", com tipo e folha; o
  `MANIFESTO.json` guarda o hash do índice. Nada do que o empacotador gera tem travessão.
- **Redação Gate sem falso positivo (G17).** O índice dos autos ganha `origem` (autos, cliente); documento do
  cliente vale pelo Doc. N e pela página; a menção pelo nome do arquivo é o sintagma do nome, não palavra
  solta. A `cobertura` cobra cada item do contrato de saída da skill como seção, não como palavra. A final é
  reconhecida também por `<peça>-final.md` com o manifesto ao lado, e o step de conferência manda gravar o
  frontmatter. Nas 51 minutas e finais da medição: `folhas` de 8 reprovações falsas para 0.
- **Fonte oficial sem pendência falsa nem prova apagada (G18).** `--reabrir` compara pelo texto extraído, pelo
  PDF sem os metadados voláteis ou pelo trecho, nunca só pelos bytes; a cópia registrada nunca é
  sobrescrita (a nova vai a `fontes/reabertura/`); resposta vazia, página de erro e inteiro teor de outro
  processo são `acesso_falhou` com motivo, e o `INDEX.jsonl` grava o resultado real.
- **TST, STF e acervo com status honesto (G19).** O `<noscript>` de página com conteúdo não é desafio (o TST
  abre por fetch); desafio real sai `acesso_falhou: desafio-js` com a instrução do Playwright. Citação conferida
  só no acervo assinado é `verificada_no_acervo`, com a cópia e o hash, no cartório, no manifesto, no
  verificador e na meta; nunca aparece como verificada na fonte oficial.
- **Manifesto da final gerado do cartório (G20).** `squad-state manifesto-final <squad> --peca <final>` monta o
  manifesto (fonte, evidência, verificadores, SHA-256, `pendencias_do_profissional[]`), valida contra o schema e
  o hook, e recusa, sem gravar, citação da peça sem entrada no cartório. O runner e os steps compilados mandam
  rodar o comando; ninguém escreve o JSON à mão. Medido: na apelação, o manifesto à mão levava uma citação
  que ninguém conferiu.

## [0.9.46] - 2026-09-24

### A rubrica da meta vira régua do run inteiro, com avaliador estável e sem leniência

A medição dos oito moldes mostrou que 29% dos pontos perdidos vinham do avaliador da meta fora da
rubrica, com um voto só, e que a rubrica só era aplicada no fim. Reavaliar as oito peças, sem rodar nada
de novo, mediu cada passo: o avaliador antigo mudou 9 de 48 vereditos numa segunda leitura; o primeiro
avaliador novo ficou estável, mas leniente (média 92,8, nenhum ATENDE frouxo caiu); o ajustado ficou
estável e fiel (44 de 48 critérios unânimes, nenhum voto isolado muda veredito, 6 das 7 perdas fora da
rubrica sumidas e os defeitos reais de volta).

- **Avaliador pela rubrica.** Julga só pelos `success_criteria` e pelo `quality-criteria.md`, decompondo
  cada critério e cada cláusula "PARCIAL quando…" em exigências; falta que o critério exige é falta,
  nunca sugestão; `posterior` só para artefato de step de agente depois da meta; lê o diagnóstico
  aprovado; lista fechada de leitura. Não declara nota, limiar nem veredito.
- **Consenso por código** (`squad-state meta-consenso`): três avaliadores (o ritmo não rebaixa
  `meta_verifiers`), ATENDE só com maioria e evidência por exigência; sugestão que repete exigência do
  critério vira falta; `dado-ausente` só para dado do cliente (índice oficial, órgão público, data,
  pedido e cálculo são da peça); faltas duplicadas juntadas sem misturar classes nem núcleos; quem não
  leu não contradiz quem conferiu com evidência.
- **Regra de entrega estruturada** (`meta_limiar` no `squad.yaml`): o código aplica a regra do squad e
  diz qual parte reprovou; sem o campo, nunca tira número de texto (nenhum NÃO e nota 85, com aviso).
- **Rubrica dentro do laço.** O revisor dá veredito por critério e cada exigência que falta vira fix
  `alta`; o diagnóstico traz uma linha por critério que depende de decisão do profissional; dado ausente
  com diligência listada no manifesto não perde ponto.
- **check-squad:** avisa critério que cobra artefato posterior à meta e limiar escrito em texto sem
  `meta_limiar`. A nota mínima de ouro é 85 em todo modelo.

## [0.9.45] - 2026-09-24

### P0 da medição dos moldes: gates que medem certo, fonte oficial fiel e sigilo

A medição de oito squads-modelo em Opus (23 e 24/09) achou 62 defeitos; o diagnóstico agrupou-os por
causa-raiz e esta versão fecha os que afetam citação, correção jurídica e sigilo. 1.625 testes; cada
defeito tem teste que falhava no código anterior.

- **Laços dos gates (G1, G2).** O ritmo limita ciclos e quantos votantes se despacham, nunca quantas
  vozes o ciclo espera; o ciclo só fecha com todas, e a mesma voz não vota duas vezes. Veredito em laço
  aprovado ou escalado é recusado (`action: refuse`, saída 1, nada gravado), e a escalada ao
  profissional não é apagada por um APPROVE posterior. O teto vale para qualquer veredito
  (`acima-do-teto`). APPROVE que traz citação contestada vira REJECT; `fonte_mudou` e `acesso_falhou`
  só saem se uma voz posterior do mesmo ciclo confirmar na fonte. O gate final de citações abre laço
  próprio (`citation-gate-final`).
- **Gate final com confirmação nova (G3).** A reabertura por código devolve em `citations[]`, com
  `sem_evidencia`, o que não tem com que comparar (antes ia para uma lista que o cartório não via).
  `citacoes-pendentes --final` exige de cada citação uma confirmação com evidência depois que o laço
  final abriu e um piso de 2 confirmações que o ritmo não rebaixa. O runner manda transcrever a
  evidência (trecho, `sha256_texto`, fonte local).
- **Chave da citação com o dispositivo (G4).** Inciso, parágrafo, caput, alínea e sufixo de letra
  entram na chave; a enumeração de artigos não para em inciso nem em parágrafo único; "Lei N/AAAA" sem
  artigo é citação própria. Nas oito peças finais da medição, o hook novo acha de 0 a 6 citações por
  peça que o manifesto não cobria.
- **STJ só aceita o processo pedido (G5).** `fonte-oficial --stj` confere recursos internos, classe,
  número, UF e registro no bloco do processo e no cabeçalho do inteiro teor; fora disso,
  `acesso_falhou` (`processo-divergente` ou `processo-nao-localizado-na-pagina`). Medido: três REsp
  tinham saído com o inteiro teor de outro processo.
- **Texto riscado e charset do Planalto (G7).** O trecho riscado sai marcado no lugar exato; risco de
  âncora vazia não marca nada. Página sem charset declarado é lida pelos bytes (UTF-8 ou
  Windows-1252): fim do acento corrompido e do "fonte mudou" falso; o cache antigo é baixado de novo.
- **Runner e conferência (G8 a G11).** Autoridade que a persuasão pede fora da pesquisa vai antes ao
  pesquisador. EDcl procurados no mesmo registro antes de marcar divergência. Revisor e conferente
  recebem o índice dos autos: documento afirmado fora dele é fix crítico, e pendência aberta não
  promove a final. Marcador de dado (`[CONFIRMAR]`, `[PREENCHER]`, `[DILIGÊNCIA]`) passa na final só se
  listado em `pendencias_do_profissional[]`, mostrado na aprovação; o de citação continua bloqueando.
  O conferente não edita a final: devolve ao redator pelo laço `conferencia`.
- **Sigilo (G12, G13).** O `install-global` registra um disparador que acha a raiz do projeto pelo
  arquivo tocado, e os hooks rodam mesmo com a sessão aberta em outra pasta. O `.gitignore` cobre
  `casos/*/autos/`, `caso.json`, `identificacao.json` e a pasta que cada `caso.json` aponta; `init`,
  `update` e `squad-modelo --caso` acrescentam sem apagar nada do usuário.

Depois de atualizar, rode `legalsquad install-global` (registra o disparador dos hooks).

## [0.9.44] - 2026-09-24

### Sumário dos autos: o que parecia lento era a máquina parada

Medido nos seis runs da medição dos moldes: o sumário leva de 2 a 7 minutos ativos (13 a 58 mil
tokens de saída). As quase 3 horas do habeas corpus foram 170 minutos em que toda chamada de
ferramenta, de qualquer agente, voltava em exatos 600 s (de 23h55 a 05h14, com a máquina ociosa de
madrugada); o trabalho do sumário ali foi de 7 minutos.

- **`sumario-autos marcar`** aceita âncora por página de documento (`p. N`, `pág. N`, `Doc. 03, p. 2`):
  a pasta pré-processual do cliente não tem folha, e o sumário ancorado nas páginas era recusado,
  forçando `--sem-folhas` (3 de 7 runs).

## [0.9.43] - 2026-09-24

### Modelo do escritório recolhido para revisão, com as correções que não esperam

A revisão por execução da 0.9.42 provou 19 defeitos (1 crítico, 5 altos) que os testes não cobriam, e
a revisão de desenho chegou à mesma causa: o modelo do escritório guardado como cópia inteira. Ele
será refeito como diferença sobre o modelo de origem. Até lá:

- **Sem convite:** saem o passo do onboarding (importar ou começar do zero) e a opção de salvar na
  entrega do run. O comando continua, só a pedido explícito, e o chefe avisa que é experimental.
- **Sequestro de outras peças (crítico):** o modelo do escritório substitui só o modelo de pacote da
  mesma peça ou o de onde nasceu; as outras peças continuam na disputa. Ele herda só os gatilhos do
  modelo de origem (somar o nome da peça dava pontos a mais que as peças vizinhas). A régua passa a
  testar os exemplos de pacote com os modelos do escritório na disputa, e aceita o modelo do escritório
  que substitui o esperado. Medido: um modelo de petição inicial salvo pelo escritório respondia por
  37 dos 272 exemplos de pacote, 31 de outras peças.
- **Prefixo `esc-` obrigatório** no salvar e na importação: um id de pacote substituía o modelo de pacote.
- **Dado aceito uma vez não vira conhecido:** só o texto dos modelos de pacote libera trecho na varredura.

## [0.9.42] - 2026-09-24

### Modelo do escritório: o squad que funcionou num caso vira modelo para os próximos

Pedido do dono: o escritório reutilizar os próprios squads em casos parecidos, sem criar do zero. A
extração existia só para a curadoria, e tinha dois buracos para esse uso: perdia em silêncio o que o
advogado acrescentou fora dos marcadores (uma seção nova num agente, uma linha fixa mudada, uma task
a mais) e o modelo saía sem gatilhos, então o chefe nunca o escolhia.

- **`squad-modelo --salvar <squad>`** grava `squads/_modelos/esc-<peça>/`: desenho, prosa e, inteiros,
  os arquivos que o escritório mexeu fora do texto do modelo (`sobreposicoes/`, aplicados por cima do
  compilado ao criar). Nunca leva autos, output, memória, estado do run nem o `discovery.yaml`.
- **Dado do caso barrado:** recusa, listando trecho e arquivo, número de processo, CPF, CNPJ, e-mail,
  telefone, OAB, e nome, valor ou data que também aparecem nos autos do squad (o que já está nos outros
  modelos não conta). `--aceitar-achados` só depois de o advogado ler os trechos.
- **Escolha:** o modelo herda gatilhos e exemplos do modelo de origem (ou recebe o nome técnico da
  peça) e vence o modelo do pacote quando os dois cobrem o pedido. A régua testa os exemplos dos
  modelos de pacote sem os do escritório. Squad criado de modelo e não mexido: "nada a salvar".
- **Roteador e runner:** rota "guarda esse squad como modelo" e a opção na entrega de um run aprovado
  de squad do Arquiteto ou ajustado pelo escritório. O sync não toca `esc-*`, que nenhum pacote declara.
- **Levar a outra pasta:** `--exportar todos|<id>,<id> --arquivo <x>.lsmodelos.json` grava os modelos
  do escritório num arquivo só; `--importar <arquivo|pasta de outro projeto>` os traz, com a lista
  fechada de arquivos de modelo (caminho fora dela é recusado) e a mesma varredura de dado de caso.
- **Onboarding:** novo passo "importar os squads do escritório ou começar do zero", que procura as
  pastas irmãs com modelos `esc-*` antes de pedir caminho; rotas `exportar-modelos` e `importar-modelos`.

## [0.9.41] - 2026-09-23

### Retry que reexecuta, e subagente que grava o que produziu

Dois defeitos do runner achados ao retomar a medição da contestação trabalhista depois de uma queda:

- **Retry:** a receita dizia `gate-open --gate retry --max 1`, e o primeiro REJECT já devolvia
  `escalate`; a reexecução prometida no texto nunca acontecia. O `--max` conta tentativas: agora é
  `--max 2` nas duas receitas, com teste que prende a receita ao comportamento do ledger.
- **Output do subagente:** um leitor da fase zero fez o trabalho inteiro e não gravou o arquivo,
  citando a regra geral de não criar arquivos de relatório. O despacho agora traz a ordem literal de
  gravar com Write no caminho resolvido, dizendo que é o output obrigatório do step; se o subagente
  ainda assim só responder, o runner grava a resposta como veio antes da validação.

## [0.9.40] - 2026-09-23

### Fase zero paralela na mesma pasta: o runner deixa de proibir o que o compilador gera

Medido no primeiro run da medição dos sete moldes (contestação trabalhista): o runner proibia ramos
paralelos no mesmo diretório-grupo de versão, e os 37 modelos compilados gravam os cinco leitores da
fase zero em `output/diagnostico/`. Um runner que segue a regra à risca parava no intake. A regra
era mais estrita que o código: `squad-path --modo leitura` já acha cada arquivo na versão mais nova
que o contém (desde 15/09), então ramos com arquivos distintos, resolvidos antes do fan-out, podem
dividir a pasta; refazer um ramo vai para a versão seguinte e o consolidador lê cada arquivo onde está.

- **Runner:** itens 4 e 5 dos passos paralelos reescritos com essa condição.
- **`autos-para-md.py`:** segue o `caso.json` do squad (autos por referência), como o indexador.

## [0.9.39] - 2026-09-23

- Lint do 0.9.38 (atribuição inútil no aviso de autos por referência). O 0.9.38 foi publicado com o
  `verify` reprovando só nessa regra do eslint; nenhum comportamento muda.

## [0.9.38] - 2026-09-23

### Criar o squad pelo nome do modelo honra `--identificacao` e `--caso`

`squad-modelo <id> --code <code>` (sem o seletor) ignorava as duas opções em silêncio: o squad nascia
sem `identificacao.json` e sem `caso.json`, e mandava copiar os autos para dentro dele. Achado ao
preparar a medição dos sete moldes. Agora os dois caminhos gravam os mesmos arquivos; com `--caso`, o
"Próximo" manda indexar pela referência, e o aviso de autos ausentes olha a pasta do caso.

## [0.9.37] - 2026-09-23

### Arquivo publicado em dois pacotes chega a quem liga qualquer um deles

O registro do depósito guardava um dono por caminho, o último lido. Quando a mesma skill ou
best-practice vinha em dois pacotes, o escritório que ligava só a outra área ficava sem ela, sem
aviso. Medido hoje num projeto só-criminal: faltavam 24 best-practices que o pacote trabalhista
também traz, entre elas a revisão jurídica e a verificação de citações; o check-squad reprovava os
cinco modelos criminais. No depósito da máquina havia 79 caminhos nessa situação (55 skills e 24
best-practices; 30 com conteúdo diferente entre os pacotes).

- **Ligação:** o arquivo entra quando algum pacote que o declara é das áreas escolhidas e o conteúdo
  que está no depósito é o desse pacote. Conteúdo de outra área não entra: a ligação avisa que o
  curador precisa dar um dono só ao caminho.
- **Curadoria (pacotes 23/09):** as 20 best-practices iguais ou gerais saíram dos pacotes criminal e
  trabalhista e foram para o transversal (a verificação de citações com os dois subagentes de
  jurisprudência); as quatro com conteúdo penal viraram `-criminal` (revisão jurídica, pesquisa
  jurisprudencial, gestão de prazos, atendimento).

## [0.9.36] - 2026-09-23

### A régua dos modelos confere o pacote que traz o modelo, e também as best-practices

`squad-modelo --testar` julgava a skill pelo texto da área do modelo. Os 16 modelos cíveis antigos
declaram "direito civil e do consumidor" e viajam no pacote civil: 103 usos de skills do
consumidor, do empresarial, do constitucional e do administrativo passavam, e o escritório que liga
só a área civil ficava com agentes sem a skill que o design lhes deu.

- **Pacote do modelo decide:** quando o depósito diz qual pacote traz o modelo, a skill tem de vir
  num pacote que a escolha da área desse pacote liga (os pacotes-irmãos do trabalho continuam
  valendo). Sem o registro, vale o texto da área, como antes.
- **Mais de um dono:** skill ou best-practice publicada em dois pacotes passa se a área do modelo
  receber um deles (`pacotesPorArquivoDoDeposito`).
- **Best-practices:** entram na mesma régua, como aviso agrupado por best-practice. As genéricas
  (revisão jurídica, ética e sigilo, verificação de citações) hoje só viajam nos pacotes criminal e
  trabalhista, com cópias que divergem; levá-las ao transversal é decisão de curadoria.

Na curadoria, os 16 modelos cíveis antigos tinham 194 usos de skills de outras áreas: 150 foram
trocados pelas do pacote civil ou do transversal e 44 retirados com o motivo. Os modelos perderam as best-practices de protocolo de
outras áreas, e o texto dos agentes passou a nomear só skills que eles têm. A calculadora de prazo
cível saiu do pacote criminal para o civil. Régua: 405/405; os 23 modelos cíveis recompilam sem
marcador restante e passam no check-squad.

## [0.9.35] - 2026-09-23

### O chefe identifica a peça pelo pedido e pela pasta do caso antes de escolher o modelo

Quem usa o sistema é o advogado, e a peça raramente está nas palavras do pedido: está no último ato
dos autos, na fase e no lado que o escritório representa. Medido com pedidos de advogado: 36/42 em
pedido curto e 12/21 em caso descrito pelos autos, com erros de polo e fase ("empresa notificada de
reclamação trabalhista" escolhia a reclamação, e não a contestação).

- **Roteador:** antes do seletor, o chefe faz a triagem da pasta (`indexar-autos --json`: tipo e
  data de cada documento), fixa polo, fase e último ato com prazo, e decide a peça. Pedido e
  documentos em contradição, ou mais de um ato com prazo aberto: uma pergunta, e nada é criado antes
  da resposta. O seletor recebe o nome técnico da peça, nunca o pedido cru nem dado do caso.
- **`squad-modelo --criar --identificacao '<json>'`** grava `identificacao.json` no squad (peça,
  polo, fase, último ato com data e folha, fontes), validada; **`--caso <pasta>`** liga os autos por
  referência.
- **Compilador:** o intake mostra a identificação para confirmar; todo leitor da fase zero de squad
  de peça para o run com CONFLITO DE PEÇA se os autos a contradizem.
- **Sync:** o aviso de colisão entre pacotes diz o que fazer conforme o caminho (skill ou modelo).

Com o chefe no caminho (teste sobre 21 casos descritos pelos autos e 2 de conflito), 20/21 casos
escolhem o modelo certo na primeira passada e os dois conflitos viram pergunta; a colisão que sobrou
(recurso ao CRPS × RO trabalhista) foi fechada na curadoria. Régua dos 37 modelos: 405/405.

## [0.9.34] - 2026-09-22

Rodada de 20 squads-modelo em seis áreas (trabalhista, criminal, família, consumidor,
previdenciário, cível de rotina e imobiliário). Cada defeito abaixo foi achado por um modelo real e
entrou com teste.

### Extração e derivação de modelo

- **Só `squads/<code>` e o campo `code` viram `{code}`.** Antes, qualquer ocorrência do code como
  palavra virava `{code}`: code igual ao nome da peça (`divorcio-litigioso`) ou de uma skill
  (`recurso-inominado`) fazia a peça e a skill seguirem o code de quem cria o squad. Recriado com
  outro code, o caso-ouro ficava sem prosa ou o squad declarava skill inexistente.
- **Arquivo de saída com o nome da peça segue a peça nova** (`output/apelacao-minuta.md` no
  recurso inominado derivado da apelação): o redator gravava um nome e a prosa lia outro.

### Compilador (texto fixo, igual em toda área)

- **Prazo sem calculadora da área** é enumerado por código e marcado `[CONFIRMAR]`. O step mandava
  sempre usar "a calculadora determinística declarada", e só o pacote criminal tem calculadora.
- O exemplo de fix do revisor falava em "data do sinistro"; o pré-mortem, em "tese do autor". Guarda
  nova em `fronteira.test.js` para termo de uma só área em string do compilador.

### `squad-modelo --testar` reprova skill de pacote de outra área

Um modelo cuja skill vem de um pacote que não é da área dele (nem transversal) compila e passa no
`check-squad`, mas o escritório que liga só a área do modelo não recebe aquele pacote: o agente roda
sem a skill que o design lhe deu. A régua agora aponta cada caso (agente, skill, pacote) e sai com
falha. Medido no primeiro sync depois da trava: **104 usos em todos os 16 modelos cíveis**, quase todos
de quatro skills genéricas publicadas em pacotes de área (`verificacao-citacoes` no imobiliário,
`auditoria-de-citacoes-jurisprudenciais` no administrativo, `pesquisar-jurisprudencia-validada` no
extrajudicial, `calculadora-prazo-civel` no criminal).

### `--derivar` mantém skill e protocolo do pacote da área nova

### Aviso de colisão no sync virava ruído

Todo pacote de área traz `skills/_index.yaml`, e o aviso de colisão entre pacotes (0.9.31) disparava
23 vezes num sync limpo, mandando "renomear o id do modelo". O índice é gerado por projeto e nunca
viaja do depósito; só caminho que viaja conta como colisão.

## [0.9.33] - 2026-09-22

### A escolha de áreas do projeto usava regra própria, e escondia pacotes

`acervo areas` (e a ligação por área) casava a área pedida com o pacote por uma regra só dela,
separada da do roteador. Medido: **"trabalhista" ligava só `execucao-trabalhista`**, sem o pacote
principal `direito-do-trabalho`, sem os recursos e sem a jurisprudência trabalhista; **"penal" não
ligava o `criminal`** (475 skills), só o `direito-penal` (4); **"família" não ligava nada**. A tabela
de rotas do `/legalsquad` usa justamente "liga a área trabalhista também" como exemplo.

- `packLigavel` passa a usar a mesma regra do roteador (`casaArea`). Nada que ligava deixa de ligar;
  a única perda é a precisão por nome inteiro ("direito-civil" deixava o processual-civil de fora):
  ligar pacote a mais só acrescenta skills, esconder o da área pedida é o erro que o motor não comete.
- `casaArea` trata singular e plural como a mesma área (`recursos-trabalhistas` é trabalhista) e
  ignora "direitos" como ignora "direito".
- **Ramos do curador.** O `area_ramos` do `_packs.yaml`, que já viajava no manifesto assinado, agora
  é gravado no depósito no sync (`acervo/_packs/_ramos.json`) e entra no casamento: é por ele que
  "família" liga o pacote civil e a jurisprudência civil, e que o roteador acha squad e modelo cível
  para um caso de família. O motor segue sem tabela de matéria; quem sabe onde família mora é o pacote.
  Pedido que é, inteiro, um ramo declarado vale só para quem o declarou, para um ramo de duas
  palavras não casar palavra por palavra com o pacote de outra área.
- Depósito sincronizado antes desta versão não tem os ramos até o próximo sync do pacote; até lá o
  casamento cai no nome da área, como antes.

### `build-area` exige `--version`

O padrão era `AAAA.MM.1`, e toda área publicada já estava entre `.7` e `.14`: o build saía com um
pacote **mais velho** que o publicado, sem aviso, porque é cego e não conhece o servidor. A versão
passou a ser obrigatória e a mensagem aponta o `latest` do `/v1/catalog`.

## [0.9.32] - 2026-09-22

### `--derivar` copiava o `discovery.yaml` da área de origem

O modelo criminal derivado da contestação cível saiu com o `discovery.yaml` da contestação intacto:
propósito, contexto, consultas de pesquisa e vocabulário de processo civil, com CPC 335, 341, 343,
373 e 436. A derivação já recusava a prosa por ser matéria; o discovery é matéria pela mesma razão, e
ainda vale como fonte de especialistas para o `check-squad`. Agora não é copiado. Quem deriva roda a
Discovery da área nova, ou escreve o brief no `research_brief` do design.

### Matéria civil no texto fixo do compilador, e a guarda que não a via

Ao derivar o primeiro modelo criminal de ponta a ponta, o squad de resposta à acusação saiu com o
protocolista dizendo "poder especial quando a peça o exige (CPC 105)" e "refaz a conta do prazo em
dias úteis restantes", e com o intake perguntando por "prazo em dobro (CPC 180, 183, 186 ou 229)".
Os dois vêm de **texto fixo do compilador**, injetado em toda área, e no processo penal não eram só
fora de escopo: eram errados, porque ali o prazo é contínuo (CPP 798). O motor agora diz o conceito
(poderes bastantes, poder expresso onde a lei o exigir, a contagem que a área usa, prazo em dobro) e
o pacote diz o artigo.

A guarda de fronteira não pegava: ela procura matéria **criminal**, herdada de quando o risco era o
resíduo do produto de origem, e o risco se inverteu quando o motor passou a ser desenvolvido sobre
squads civis. Entrou um teste próprio, que varre o texto fixo de `squad-compile.js` atrás de
dispositivo de lei **dentro de string literal** (o que vira texto do aluno), ignorando comentário de
código, que é onde se documenta justamente este tipo de defeito.

### A área de uma skill é o pacote que a trouxe, não o que ela declara

`search-skills --area` dava o bônus de ramo comparando a área pedida com o `grupo` do índice, e o
grupo sai da primeira `categories:` que a skill declara — informação do curador, que falha calada.
Medido ao derivar o primeiro modelo criminal: **402 das 475 skills criminais declaram `law`**, e
2.473 do depósito caem em `Law`/`Outras`, então `--area criminal` não casava com skill criminal
nenhuma; o mesmo valia para o trabalhista. De que pacote a skill veio é fato, está nos registros do
depósito, e agora é o que decide: `area.criminal` casa com "criminal" e com "penal" (pelos sinônimos
do roteador, que o casamento por token do grupo não conhece). Sem pacote (skill local do usuário),
vale o grupo, como antes. Custo medido: 0,11 s para mapear as 7.475 skills, contra 1,07 s da busca
inteira, e só quando há `--area` a casar.

### Squad-modelo por área: namespace, guarda no build e `--derivar`

Os squads-modelo viajam com caminho literal (`squads/_modelos/<id>/`) e o depósito não compara
caminhos **entre** pacotes: no dia em que uma segunda área publicasse `apelacao`, os arquivos do
primeiro seriam sobrescritos no depósito do aluno, em silêncio (`pack-apply` só detecta caminho
repetido dentro do mesmo pacote). "Apelação", "embargos" e "contestação" são nomes naturais em
cível, previdenciário, trabalhista e criminal ao mesmo tempo. Agora `_packs.yaml` declara
`modelo_prefixo` (`prev`, `trab`, `crim`…, ou `""` para a área-base que publica sem prefixo); o
`build-area` recusa a área que tem modelos e não declara a chave, e o modelo cujo id não cabe no
prefixo; o `sync` avisa quando dois pacotes declaram o mesmo caminho.

`npx legalsquad squad-modelo --derivar <modelo> --area <área> --id <novo-id> [--peca <peca>]`
reaproveita o **esqueleto** de um modelo curado (paradas, fase zero em paralelo, loop de revisão,
conferência com voting, knobs por agente) para outra área, trocando área e peça e substituindo cada
skill da origem por uma marcação `A CONFERIR` com candidatas da área nova — buscadas pelo **papel do
agente**, não pelo nome da skill antiga, que traria de volta o ramo de origem. O derivado nasce
**sem `prosa.yaml`**, e isso é desenho, não falta: medido em 22/09/2026, 144 dos 161 marcadores da
apelação cível carregam dispositivo, nome de peça ou o caso fictício do squad, então copiar a prosa
daria um modelo trabalhista falando de CPC 1.009. Sem prosa o modelo fica `completo: false` e o
chefe não o escolhe; quem escreve a matéria é o Build, e o comando imprime o ciclo que fecha o
modelo (escolher as skills → compilar → Build → `--extrair`).

As **best-practices** do design também são de área: trocar só as skills entregaria um squad
trabalhista operando pelo `protocolo-operacional-direito-civil`. Cada uma é conferida contra os
catálogos instalados — a transversal fica, a de outra área vira marcação com as candidatas da área
nova, e quando a área nova não declara best-practice de matéria o design diz isso, em vez de apontar
para a da origem.

O **texto do design** também é matéria e vai marcado com `[REESCREVER PARA A ÁREA]`: `goal`,
`success_criteria`, `name`, `description`, `title`, `role_summary` e `brief` falam da peça de
origem, e o `check-squad` não reclama porque é prosa válida. Medido ao derivar o primeiro modelo
criminal: o derivado nascia com meta de contestação cível e CPC 337/341 nos critérios de sucesso.
O texto antigo fica legível ao lado da marca, como rascunho do que reescrever, nunca apagado em
silêncio.

Dois blocos a mais, achados ao derivar o primeiro modelo criminal de ponta a ponta: o
`research_brief` (57 linhas, o texto mais denso de matéria do design inteiro, que vira
`pipeline/data/research-brief.md` no squad) leva a marca na primeira linha; e os registros da
Discovery e do Design da origem saem zerados, com o motivo escrito no lugar. `catalog_decisions`
era o pior: justifica, uma a uma, as escolhas de skill que a derivação acabou de trocar
(`calculadora-prazo-civel`, com a razão citando CPC 219), fazendo o design derivado afirmar algo
falso sobre si mesmo. `lexico_sugerido`, `gaps_declarados` e `best_practices_consulted` saem pela
mesma razão.

`- name:` de item de lista também entra: o nome de uma task do agente vira NOME DE ARQUIVO no squad
compilado, e a derivação produzia `agents/redator/tasks/preliminares-337.md` dentro de um squad
criminal.

## [0.9.31] - 2026-09-22

### Code-review da área do caso (v0.9.29..v0.9.30): oito achados, oito corrigidos

O `squad.yaml` compilado passou a gravar `area:` (o design já a tinha; um squad do Arquiteto caía
em `sem_area`); `--area` com mais de uma palavra ("processual civil") casa por palavra, e
"processual"/"processo" não distinguem área; `squads` lê só as entradas `squads/` dos registros do
depósito em vez do mapa inteiro; `escalarDeChave` do check-squad é reusado no lugar de um parser
que cortava valores no apóstrofo; o gatilho do onboarding cobre `Áreas de atuação` ausente ou
`(não informado)` (perfil de versão anterior ganha só a pergunta das áreas); a Discovery herda o
`Polo predominante` no vocabulário novo e pergunta quando é `Varia por caso`; o `catalog-scout`
ganhou o passo de squads filtrados pela área.

## [0.9.30] - 2026-09-22

### A área do caso filtra squads, modelos e onboarding (o criminal não é o padrão)

Num escritório cível ("Demonstração 55", 22/09/2026), o onboarding gravou polo "Postulante/Acusação"
e o chefe reusou a "Sala de Recursos Criminais" para embargos de declaração contra sentença cível:
os squads prontos chegam com os pacotes (o criminal traz seis, o trabalhista três; o civil traz
modelos), `squads/` não dizia de que área cada um veio, e o roteador mandava reusar squad existente
antes de olhar os modelos. Três correções, todas no motor. O onboarding pergunta as áreas de atuação
(conferidas em `acervo areas`, obrigatórias no `company.md`) e oferece polo em vocabulário de qualquer
ramo (ativo, passivo, varia por caso, consultivo); o seed perdeu "teses defensivas, nulidades,
garantias". `npx legalsquad squads --area <área>` lista os squads da pasta com a área de origem
(declarada no squad.yaml, herdada do modelo ou do pacote que o trouxe) e separa `da_area` de
`de_outra_area`; `squad-modelo --para` ganhou `--area`. O roteador identifica a área do caso antes
de REUSAR: squad, modelo, agente ou skill de outra área nunca entra na shortlist, mesmo com o mesmo
nome de peça.

## [0.9.29] - 2026-09-22

### `reader: publico`: o leitor do conteúdo de autoridade (revisão de 20/09, C16/V2)

A variante de prosa do conteúdo era ligada por um flag derivado de `formats_selected`: um
squad de peça com a lista preenchida virava squad de conteúdo em silêncio, e o modelo
`conteudo-autoridade` declarava `reader: cliente`, que só não trazia a prosa de parecer porque o
flag vencia o reader. Agora o reader é a única chave: `publico` é o leitor fixo de
`delivery_type: content` (o compilador o assume quando o design não declara, normaliza com
aviso quando declara outro, e falha nomeando o campo quando `formats_selected` aparece fora de
conteúdo ou `publico` fora de `content`). O agente de conteúdo deixou de receber o "Tom forense"
(afirmativo e sóbrio, ironia com a parte contrária) e recebe o tom do público. O `check-squad`
conhece o valor, expõe os gates dele (citação e redação; nunca persuasão nem contrato), cai em
`publico` num squad de conteúdo sem reader e avisa `reader-incoerente` quando o reader e o
`delivery_type` se contradizem. O Redação Gate (hook e módulo) não cobra a síntese na frente com
`publico`, como já não cobrava com `contraparte`; o runner e os prompts de Design e Build sabem
disso. O bloco `redacao-gate` do `sync-blocos` passou a cobrir também os hooks da raiz.

### Proveniência do perfil no carimbo do contrato (revisão de 20/09, C24/V6)

O `contract-skills` gravava `quality_profile` sem dizer de onde veio: na segunda passada o
perfil que o motor inferiu pelo id lia-se como declarado pelo curador, e uma declaração inválida
(`quality_profile: "perfil-que-nao-existe"`) sumia sem aviso, substituída pela inferência. O
carimbo agora traz `quality_profile_source: declarado | inferido`; com a fonte `inferido`, quem
decide na passada seguinte é o classificador de novo (o valor no arquivo é dele, não do
curador), e para declarar o curador escreve o perfil e troca a linha de fonte. Declaração
inválida continua caindo na inferência, mas sai no relatório do comando (`⚠ skill: quality_profile
«x» não existe…`) e no resumo (`invalid_declarations`). O `detail-skill` mostra a fonte.

Duas regras a mais, do code-review de 22/09 sobre a própria mudança: carimbo antigo (tem
`contract_version`, não tem a linha de fonte) só conta como declarado quando o valor difere do que
o classificador inferiria, senão a primeira passada deste motor carimbava `declarado` em todo o
corpo já contratado (medido: 11 de 11 na fixture); e a linha nova, sozinha, não reescreve a skill
sem `--force`, porque é o SHA desses bytes que amarra a evidência de promoção (SPEC §6.8). Edição
do perfil com a fonte `inferido` continua revertida, mas sai no relatório (`reverted_edits`) com
a instrução para declarar.

### Limpeza do compilador (revisão de 20/09, L3/L4)

O nome de quem lê primeiro na parada aprovacao era um ternário escrito duas vezes (no Process e
no exemplo da parada); virou `leitorDe`. O relatório da extração de prosa era impresso por duas
cópias com wording diferente (`compilar-squad --extrair-prosa` e `squad-modelo --extrair`); virou
`relatorioDaExtracao`, uma só. Do mesmo code-review: `reader: publico` sem `delivery_type` compila
com `delivery_type: content` no squad.yaml (o check-squad e o Build reconhecem conteúdo por ele);
o rodapé do `pipeline.yaml` de um squad de conteúdo deixou de prometer o Gate de Sobrevivência ao
Resumo e o red-team; `squad-modelo --extrair` mostra os avisos do design (o reader normalizado). E `formats_selected`, que
era validado e nunca lido, virou o cardápio do intake e do diagnóstico de conteúdo (vazio = carrossel,
reels, stories, legenda); o Design documenta o campo.

## [0.9.28] - 2026-09-21

### Escritório virtual com squads e agentes em tempo real

`legalsquad dashboard` prepara as dependências na primeira abertura, inicia o servidor
Node local e abre o navegador. O escritório em pixel art tem uma sala por squad,
biblioteca, recepção, mesas dos agentes, zoom e modo ampliado. A equipe cadastrada
aparece aguardando mesmo sem execução; atividades, trabalho em paralelo, repasses e
aprovações acompanham os estados escritos pelo runner. Uma demonstração identificada
usa apenas dados fictícios em memória.

Corrigida a abertura em que o estado chegava antes de a cena carregar e deixava o
escritório vazio. O servidor usa a raiz correta mesmo quando iniciado dentro da pasta
de um caso, atualiza o cadastro dos agentes e sinaliza desconexão ou estado ilegível.
O comando também está disponível nas instruções distribuídas às IDEs e no plugin.

## [0.9.27] - 2026-09-20

### Revisão do motor (v0.9.21 a v0.9.26): 15 defeitos confirmados por execução, corrigidos

Conversor e indexador dos autos. O rodapé do PJe era descontado com regras sem fronteira
(`esaj` dentro de "desajuste", `eproc` dentro de "reprocessamento", a assinatura comendo o
dispositivo da sentença numa linha juntada pelo extrator): agora cada regra é limitada pelo
próprio conteúdo, e o rodapé só sai da medição, nunca do texto gravado (que também deixou de
ser colapsado numa linha só). A classificação `ocr | imagem | vazia` passou a ser uma função
única, decidida pelo que foi lido: despacho escaneado curto é `ocr`, foto com legenda é
`imagem`, capa curta com camada de texto volta a ser `nativo` (regressão da 0.9.26), e sem
tesseract a folha sai `vazia`, como o aviso promete (`--sem-ocr` vale também para o OCR
embutido do pymupdf4llm; o manifesto registra `ocr: tesseract | indisponivel | desligado`).
O conversor encontra `.PDF` e subpastas, com o mesmo slug do indexador. O indexador conta a
folha `imagem` sem texto como não lida, relê o manifesto de conversão na entrada
reaproveitada (reindexar depois de reconverter zerava só com `--forcar`) e também sem
`pdftotext`; a linha de cobertura diz o que falta (converter, converter com OCR, ou ler as
folhas de imagem). Medido no caso de 506 folhas: o texto OCR gravado cresceu 10% (palavras
que eram apagadas) e o `documento.md` passou de 21 mil para 38 mil linhas (quebras mantidas).

Autos por referência. Um bloco canônico `autos-path` (`src/autos-path.js`, sincronizado por
`sync-blocos`) resolve `squads/<nome>/autos/` ou o `caso.json` em indexador, sumário, hook de
redação e `squad-state reabrir`, cuja guarda "fato novo é run novo" ficava muda no desenho
por referência; a saída do `reabrir` diz se os autos foram conferidos.

Sumário do caso. O hash da leitura ignora carimbos de hora (reconverter os mesmos autos
invalidava o sumário a cada squad); `status` sai 4 quando o sumário vale mas há imagem sem
descrição (o teto de 40 deixava o resto para uma rodada que nunca vinha), `marcar
--indice-hash` certifica a leitura que o agente fez, e duas imagens com o mesmo nome de
descrição não se confundem.

Gate final. A gramática do marcador de pendência é um bloco canônico (`src/pendencia.js`)
sincronizado no hook e na métrica: o hook não conhecia `[CONFIRMAR …]` (a final passava e o
pacote a listava como pendência), e a carga por espaço com a flag `i` bloqueava links
Markdown e termos em minúsculas entre colchetes. O `RELATORIO.md` de run fechado só se
escreve na janela do fechamento (uma hora), não para sempre.

Compilador e modelos. O Build grava `_build/esqueleto.json` e a extração alinha contra ele
(recompilar com o motor do dia engolia como prosa a linha fixa que o compilador removeu, e
lista fixa que cresceu no fim tirava a âncora); `--extrair --forcar` preserva gatilhos,
pedidos, `ouro` e o run medido; a família do prazo é decidida pelo `prazo:` declarado ou pela
calculadora processual do agente (o modelo de prazos do dia compilava prazos materiais, com
veto contraditório); a numeração continuada só toca a primeira lista; o intake de conteúdo
traz o escopo da pesquisa; dois steps no mesmo artefato falham na compilação; o vocabulário
de entrega do squad.yaml é traduzido para o das skills no check-squad; `squad-modelo --para`
devolve `existentes` e, com `--reusar`, roda o squad já criado do modelo (a rotina de prazos
criava um squad novo por dia).

## [0.9.26] - 2026-09-20

### Conversão dos autos: camada de texto decidida pelo texto útil, folha `imagem`

O rodapé do PJe passava do limiar de texto e escondia 122 de 506 folhas (fotos, notas, BO,
procurações escaneadas) como `nativo`: a decisão passou a usar o texto útil (rodapé e
"picture text" descontados) e a folha dominada por figura sai como `imagem`; o sumário do caso
invalida na reconversão.

## [0.9.25] - 2026-09-20

### Sumário durável dos autos por caso, com descritor de imagens

`scripts/sumario-autos.mjs status | imagens | marcar`: o especialista `resumo-processo`
escreve `autos/_sumario/sumario-dos-autos.md` uma vez por autos (não por run) e descreve as
folhas sem texto em `_sumario/imagens/`; o runner despacha na fase zero.

## [0.9.24] - 2026-09-20

### Compilador: variante de prosa para conteúdo de autoridade

`delivery_type: content` troca intake, redator, revisão e aprovação pela ponta do público
(tema, formatos, gancho, ética); `contract-skills` honra o `quality_profile` declarado; rotas
do DJEN e do briefing no `/legalsquad`.

## [0.9.23] - 2026-09-19

### Hook de citações: RELATORIO.md do run fechado não é bloqueado

O rastro de auditoria gravado depois do `complete` passava a ser bloqueado pelo guard de run
fechado; liberado.

## [0.9.22] - 2026-09-19

### Squads-modelo: régua de seleção (`--testar`), extração tolerante e correções do lote

`squad-modelo --testar` confere os `pedidos_exemplo` e `pedidos_fora` de todos os modelos;
âncora parcial na extração; papel `leitor`; id do agente decide o papel antes do texto livre;
check-squad aceita a skill do tipo da entrega.

## [0.9.21] - 2026-09-19

### Compilador: paradas e papel de prazo conforme haja processo

Achado nos Designs de parecer e petição inicial (19/09/2026): o intake compilado perguntava autos e
intimação, a aprovação oferecia red-team com `meta_verifiers: 1`, e o papel de prazo presumia
calculadora e intimação em squads sem processo. Agora: com `le_autos: false` o intake pergunta os
documentos do cliente, o leitor e a decisão, e os prazos materiais; a aprovação nomeia o leitor da
ponta (juiz, decisor, contraparte) e só oferece red-team com `meta_verifiers` de 3; o papel de prazo
ganha a variante `prazo-sem-processo` (marco, regra, fonte, risco com medida).


## [0.9.20] - 2026-09-19

### Compilador: famílias contrato (leitor contraparte) e relatório (leitor cliente)

Para os squads-modelo de contrato, notificação, parecer, triagem de processo e dossiê de provas: a
prosa fixa do redator, do revisor e do conferente muda com o `reader` do design (contraparte:
cláusula a cláusula, termos definidos, remissões, riscos alocados, gate de consistência
`verifica-contrato.mjs` no lugar da persuasão; cliente: conclusão primeiro, risco com medida,
sobrevivência ao resumo do decisor). O design.prompt documenta `delivery_type: legal-analysis` e
os nomes de entrega que o empacotador trata como internos.


## [0.9.19] - 2026-09-19

### Alteração depois da entrega: o run reabre, os agentes e os gates fazem a versão seguinte

Lacuna achada em 19/09/2026: depois do run fechar, um pedido do profissional sobre a peça
entregue não tinha rota, e o risco era o assistente editar a peça à mão, sem redator, sem
Citation Gate e sem termo novo. Decisões do dono: aprovação humana de novo mesmo em ajuste de
forma; reabertura só a pedido na conversa; autos novos exigem run novo.

- `squad-state reabrir <squad> --modo ajustes|revisao --pedido "<literal>"`: só run `completed`,
  só o último run, recusa autos com documento mais novo que o começo do run; volta a `running` no
  step de redação com os checkpoints preservados e registra `reaberturas[]`. `run-status` devolve
  `reabriveis` (fechado) e `reaberto`/`reabertura` (retomada).
- Hook de citações: gravação (Write/Edit) em `output/<run_id>/` de run fechado é bloqueada, com a
  rota de reabertura na mensagem.
- Empacotador: run reaberto guarda o pacote anterior em `pacote/<run_id>/anteriores/r<N>/`; o termo
  de conferência ganha a seção "3b. Revisões depois da entrega", gerada do ledger, pedido mascarado.
- Runner: seção "Alteração depois da entrega (run reaberto)" (classificação pela régua da
  revisão, comandos, fechamento pelo caminho canônico, quando não reabrir). Roteador e bloco global:
  rota "Pedido sobre peça já entregue", nunca edição de arquivo.


## [0.9.18] - 2026-09-19

### Squad-modelo: escolha semântica pelo chefe, sem terminal para o usuário

Regra do dono (19/09/2026): o usuário pede a peça em linguagem natural e o chefe (ou o Arquiteto)
identifica e já seleciona o squad. `modelo.yaml` ganha `gatilhos` (frases; `a + b` exige as duas,
`respond*` casa por prefixo), `nao_use_para` (frases que afastam) e `pedidos_exemplo`;
`npx legalsquad squad-modelo --para "<pedido>" [--criar] --json` devolve `escolha`, `ambiguo` ou
`nenhum` com o motivo, e com `--criar` já cria o squad num code livre. O roteamento (skill
`/legalsquad` e bloco global do `install-global`) manda o chefe rodar isso com as palavras do
usuário, criar sem perguntar quando há escolha e avisar em uma linha; o checkpoint de "criar
squad" fica para o Arquiteto. Nove pedidos de teste: sete decididos certo de primeira; "a ré" e
"o réu" num pedido de réplica não afastam mais o modelo (a heurística de polo por palavra saiu; o
polo é afastado só por frase declarada).


## [0.9.17] - 2026-09-19

### Squads-modelo: design + prosa curada, compilados na criação (segundos, não 45 minutos)

Decisão do dono (19/09/2026): squads padrão ouro das principais peças e atuações, prontos na
instalação. Não como squad congelado (envelhece a cada release do runner; os seis criminais
precisaram de migração), mas como modelo compilável: `squads/_modelos/<id>/` com `design.yaml`,
`prosa.yaml` (o texto de cada marcador) e `modelo.yaml` (identidade e provas). Viaja no pacote da
área pela subárvore `squads/`.

- `npx legalsquad squad-modelo` lista; `squad-modelo <id> --code <code>` cria o squad compilado com
  a prosa (medido: 43 arquivos e 156 marcadores em 0,24 s, check-squad limpo);
  `squad-modelo --extrair <squad> --id <id>` faz o inverso, para a curadoria.
- `compilar-squad --prosa <arquivo>` preenche marcadores; `--extrair-prosa <arquivo>` recupera a
  prosa de um squad construído por alinhamento com o compilado (o que não se recupera é listado).
- Marcador multi-linha: o molde dos exemplos das paradas vai dentro do comentário, e nada de
  esqueleto sobra no arquivo. O caso-ouro passa a chamar-se `exemplo-<peça>.md`, sem o code.
- `/legalsquad create` ganha a Phase 0: oferece o modelo antes da Discovery.
- Primeiro modelo, `replica` (réplica à contestação cível, polo ativo): prosa da v6 medida
  (153 marcadores) mais o que a revisão independente apontou (CPC 436/437 e 396, achado
  desfavorável obrigatório, pesquisa em frentes) e os exemplos das três paradas. Provas em
  `modelo.yaml`: check-squad limpo; run de 19/09 com nota 75 (antes das correções); `ouro: false`
  até um run passar a régua.


## [0.9.16] - 2026-09-19

### Compilador: triagem de prazo calcula com a hipótese do intake

Medido nos dois runs de 19/09/2026 (Sonnet, ritmo equilibrado, mesmos autos): a v6 compilada
devolveu `blocked` no prazo por falta da certidão de publicação, mesmo com a hipótese registrada
no intake, e perdeu um critério da meta por isso (nota 75 contra 83 da v4). O princípio fixo do
triador passa a calcular com a hipótese marcada `[CONFIRMAR]` e a bloquear só sem data nenhuma.


## [0.9.15] - 2026-09-19

### Compilador: o que a revisão independente da prosa (v4 × v6) apontou como defeito do compilador

Revisão read-only de 19/09/2026, agente por agente: nos dez papéis os squads empatam (344 × 341 de
400), a v6 ganha em exemplos, contador de cobertura e zero citação inventável (v4 traz a Súmula
101 mal aplicada e carimbada como verificada), e perde nas três paradas (81 × 118 de 120), que o
compilador entregava como esqueleto.

- Pré-mortem com família própria (adversário): argumenta contra, não "só reporta".
- Regra única para marcador pendente, escrita no revisor (REJECT com fix alta quando sustenta
  tese) e no conferente (a citação sai da peça; não existe marcador visível na final).
- Intake colhe onde estão os autos, a data da intimação e o prazo em dobro; diagnóstico colhe a
  decisão sobre cada lacuna e a estratégia processual; as três paradas ganham um marcador de
  exemplo com o caso fictício; o rótulo Rigoroso diz que grava `completo`.
- Protocolo confere poder especial (CPC 105) e refaz o prazo na data do ato; o step de agente
  não repete os critérios do agente.


## [0.9.14] - 2026-09-19

### Compilador: segunda construção medida (v6, mesmo design da v5)

Build ativo de 23,7 min (v5: 30,7; v4: 31,4), 105 mil tokens de saída (148 mil; 162 mil), 128 mil
caracteres escritos pelo modelo (177 mil; 301 mil), check-squad limpo de primeira. Três achados do
relatório do Build entraram: a ordem de preenchimento do manifesto segue os grupos (dados; cada
agente com as tasks e os steps dele), o marcador opcional diz "apague esta linha", e o compilador
avisa quando a fase zero lê `autos/_index.yaml` e a pasta ainda não existe no squad.


## [0.9.13] - 2026-09-18

### Compilador: o que a primeira construção medida ensinou (v5 da réplica, 18/09/2026)

Design 20,5 min (gravação do design.yaml de 11,1 min para 2,8 min; 124 mil para 34 mil
caracteres); Build 31 min com 43 arquivos compilados e 180 marcadores preenchidos em 33 mensagens,
check-squad limpo de primeira. O Build não encurtou porque o modelo escrevia o exemplo e os
critérios específicos duas vezes (agente e step) e os marcadores pediam prosa demais.

- Compilador: o step aponta para o exemplo e para os critérios do agente em vez de pedir os dois
  de novo (28 marcadores a menos em 10 agentes); marcadores mais curtos; Tone Rules compilado;
  passos específicos entram antes da gravação ("Por último, gravar…", sem renumerar linha
  compilada); manifesto do conferente com o caminho real; `[NÃO VERIFICADO]` fica na minuta e
  nunca na final; `specialist` aceita lista; sem linha em branco dupla.
- Prompts: piso de skills para papéis operacionais (1 a 2) e teto de 5 no redator; duas linhas
  novas na tabela de calibragem (leitura de autos; triagem de prazo); `resolver_dry_run` no
  schema; `citation_verifiers`/`meta_verifiers` documentados no frontmatter do step.


## [0.9.12] - 2026-09-18

### Compilador de squad: o Design entrega decisões e o Build escreve a prosa uma vez

Medido em 18/09/2026 num rebuild real da réplica cível (10 agentes, 61 arquivos): Discovery+Design
23,5 min e Build 31,5 min, quase tudo o modelo escrevendo a 85 tokens por segundo; o Design gravava
69 mil caracteres de `artifacts` por agente e o Build reescrevia o mesmo em 291 mil.

- `npx legalsquad compilar-squad <code>` (novo, `src/squad-compile.js`): lê `_build/design.yaml`
  e grava por código, determinístico e fail-closed, `squad.yaml`, `squad-party.csv`,
  `pipeline/pipeline.yaml`, frontmatters, esqueletos de agente, task e step com marcadores
  `<!-- LEGALSQUAD:PREENCHER id | instrução -->`, as três paradas completas, o wiring que o runner
  cobra de cada tipo de step, `research-brief.md`, `_evals/`, `_memory/` e o manifesto
  `_build/compilacao.json`. Nunca sobrescreve sem `--forcar`.
- `design.prompt.md`: schema enxuto (decisões, briefs de até 600 caracteres, `reason` de uma linha
  por skill; sem `artifacts:`); `build.prompt.md`: Step 0 compila, o Build preenche marcadores.
- `check-squad`: erro `marcador-de-compilacao` para marcador que sobrou.
- `src/yaml-subconjunto.js`: o parser do subconjunto YAML saiu de `tools/compilar-workflow.mjs`
  (que segue usando-o) e ganhou um emissor com a indentação que o `check-squad` lê.


## [0.9.11] - 2026-09-18

### Corrigido

- **Schema do `design.yaml` completo para o pipeline canônico.** O Arquiteto, reconstruindo um
  squad de réplica em 18/09/2026, teve de improvisar `id` por step, `depends_on`, `parallel_group`,
  `on_reject` por id, `max_review_cycles` e os knobs de voting, porque o schema do prompt de design
  só trazia `step`, `name`, `type`, `agent`, `execution` e `on_reject` por número. Entram no
  schema, com o bloco `squad` levando `reader` e os verificadores. Também: exemplos de output por
  agente passam a ser compactos (2 exemplos "FULL" × 10 agentes estourava o contexto) e a regra de
  polo × substância (a skill mais rica pode ser peça do polo contrário: vai ao pré-mortem, nunca ao
  redator).

## [0.9.10] - 2026-09-18

### Corrigido

- **O prompt de design descrevia um pipeline jurídico defasado.** O "padrão-ouro" trazia cinco
  paradas humanas (foco, seleção de teses, aprovar minuta, aprovar versão final, protocolo), uma
  leitura única dos autos, revisão jurídica depois de o humano aprovar a minuta, e nem conferência
  de entrega nem checklist de protocolo, enquanto o runner e o `check-squad` cobram o caminho 0.5
  (três paradas: intake, diagnóstico, aprovação; fase zero com quatro leitores em paralelo;
  pesquisa; redação; revisão com `on_reject`; conferência; aprovação com pacote; checklist). Os
  squads civis desenhados em 16 e 17/09 saíram desse diagrama: sem fase zero e com gates como steps.
  O prompt passa a trazer o caminho canônico, com o que não entra, e o exemplo jurídico na
  apresentação do design.

## [0.9.9] - 2026-09-18

### Alterado

- **`contracted` executa em produção sem confirmação por run** (decisão do dono, 18/09/2026). Num
  catálogo real, 7.455 de 7.457 skills são `contracted` e nenhuma é `verified`/`certified`: o
  "sim" de supervisão por run era ruído, e os prompts ensinavam o Arquiteto a tratar todo o
  catálogo como não confiável e a ligar menos skills. O resolvedor deixa de emitir
  `human-supervision-required`; a disposição passa a ser `contracted`; `--supervised` é aceito e
  não muda nada; a supervisão é a revisão humana da peça, que todo run já exige. Preview,
  deprecated, quarantined, legacy, hard fail estrutural e promoção alegada sem evidência continuam
  bloqueados. Runner, Skills Engine, prompts e o índice (`contracted_execution_requires:
  revisao-humana-da-peca`) dizem o mesmo.
- **Design de squad de peça parte de oito papéis, não de "o mínimo".** O prompt de design ganha o
  piso: fase zero com quatro leitores (resumo, prova e contradições, contraditor pré-mortem, temas
  do acervo), pesquisa, redator, revisor isolado e conferente; YAGNI corta redundância, não papéis.
  E o piso de skills por agente de conteúdo (2 a 4, por família: peça ou leitura, estratégia/teses,
  calculadora), no lugar da regra "cada skill injetada custa contexto" que produzia agentes vazios.

### Adicionado

- **`search-skills --area "<área>"`: afinidade de área na shortlist.** O `grupo` que a skill declara
  (e que o índice já gravava) entra no resultado e ganha bônus de rank quando casa com a área do
  squad; sem `--area` nada muda. Medido em 18/09/2026 com 48 áreas ligadas: "ônus da prova,
  excludente de cobertura, seguro" devolvia excludentes de ilicitude e tese de júri antes de qualquer
  skill de seguros. Discovery, design e `catalog-scout` passam a pedir `--area` e `--limit 12`.
- **Uso de skill com rejeição dirigida.** O registro de uso grava `dirigida: true` quando um fix do
  revisor cita a skill pelo id; `detail-skill` devolve `rejeicoes_dirigidas` e
  `ultima_rejeicao_dirigida`, e o prompt de design só pesa essas. Antes, toda rejeição do ciclo era
  creditada a toda skill do squad, e a skill da própria peça (`replica-civel`: 7 rejeições em 8
  ciclos, todas da minuta) saía da shortlist como "ruim".
- **`check-squad` avisa `redacao-sem-skill`**: o step que redige a peça com agente sem skill no
  frontmatter. O runner injeta o corpo da skill por agente; a lista do `squad.yaml` alimenta o gate
  e o hook, não o contexto de quem escreve (os seis squads criminais publicados estão assim).

## [0.9.8] - 2026-09-18

### Corrigido

- **A pergunta do ritmo entra no step de intake, não só no runner.** O squad-modelo
  (`tests/fixtures/area-demo/squads/peca-modelo`, o que o Arquiteto espelha) e o prompt de build
  passam a listar o ritmo do run entre o que a parada intake coleta, com o comando que o grava;
  squad cujo step de intake só listava escopo, prazo e juízo dependia de o chefe lembrar do runner.

## [0.9.7] - 2026-09-18

### Adicionado

- **Ajuste fino do ritmo por run.** Além dos três ritmos, o profissional escolhe o número direto:
  `squad-state ritmo --ciclos 1|2|3`, `--verificadores 1|3`, `--persuasao sim|nao`,
  `--red-team sim|nao`, por cima do ritmo ("equilibrado, mas com 3 ciclos"); gravado em
  `ritmo_ajustes` no ledger e devolvido pelo `run-status`. O perfil do projeto continua sendo o teto.

## [0.9.6] - 2026-09-18

### Adicionado

- **Ritmo do run, escolhido pelo profissional na parada intake.** Quanto de verificação por IA a
  peça paga passa a ser pergunta da primeira parada, com o custo em linguagem de gente: **rápido**
  (1 verificador de citações por gate, 1 avaliador da meta, 1 ciclo de revisão, sem gate de
  persuasão nem red-team), **equilibrado** (1 verificador por gate, 2 ciclos, persuasão em uma
  passada, sem red-team) e **rigoroso/completo** (o que o squad declara: consenso de 3, 3 ciclos,
  persuasão e red-team oferecido). `node scripts/squad-state.mjs ritmo squads/<nome> --set
  rapido|equilibrado|completo` grava no ledger do run; quem aplica é o código (`review-open`/
  `gate-open` rebaixam `--max`, `gate-verdict` rebaixa `--expect`, `citacoes-pendentes` rebaixa
  `--confirmacoes`, com aviso no stderr), e o `run-status` devolve o ritmo para a retomada não
  reperguntar. O Citation Gate nunca cai abaixo de 1 verificador, e os hooks determinísticos não
  têm ritmo. Bloco canônico `src/perfil.js`, sincronizado para o `squad-state`.
- **Perfil do projeto** (`legalsquad perfil rapido|equilibrado|completo`, `init --perfil`): teto e
  padrão de todos os runs de um projeto, em `_legalsquad/_memory/perfil.json` (o update
  preserva). Um projeto travado em rápido (curso, palestra) não sobe por escolha de um run.
  `diagnostico` mostra o perfil. `light` é aceito como sinônimo de `rapido`.
- **`check-squad` avisa gate do runner desenhado como step** (`gate-do-runner-como-step`).
  Medido numa réplica cível real (17/09/2026): o Arquiteto desenhou um step "Citation Gate Final
  (votação de 3)" e um "Gate de Sobrevivência ao Resumo", com agentes próprios, em cima dos gates
  que o runner já roda com cartório e reabertura por código: o mesmo trabalho pago duas vezes.
  Os prompts de design e de build passam a dizer que esses gates não viram steps.
- **`diagnostico` mostra a leitura dos autos por código**: `pdftotext`, `tesseract` e o venv de
  OCR do projeto, com o que instalar quando faltar (sem eles, folha digitalizada só se lê pelo
  modelo, página a página).

### Corrigido

- **A pesquisa não vai mais à web pelo que o acervo assinado já tem.** No run civil de
  17/09/2026 a Súmula 229/STJ e os Informativos 824 e 842 do STJ foram abertos pelo navegador da
  IDE, com Google no meio, estando os três no acervo local; a skill de área manda "abrir a fonte
  oficial de cada precedente" e "confirmar se ainda vale", regras escritas para um mundo sem acervo
  assinado. O runner e o prompt de build fixam a regra: julgado do acervo é fonte lida (registra
  `origem: acervo` e a `fonte_url`, não reabre); súmula fora de `acervo.sumulas` não existe; inteiro
  teor só por código (`fonte-oficial.mjs --stj`), nunca navegador; captcha ou login é
  `acesso_falhou` e marcador; e o step de pesquisa fecha com a conta (acervo, código, LLM).
- **`squad-state init --run` não reabre o ledger do zero na retomada.** Retomar um run passava o
  `--run` ao `init`, que gravava um ledger novo e apagava os checkpoints (a resposta da parada que
  o runner promete não reperguntar) e agora também o ritmo. Com o run ainda aberto e o mesmo id, o
  ledger é preservado; a resposta traz `retomado: true`.
- **Onboarding do `/legalsquad` em três perguntas.** Tipo de instituição e polo numa só
  AskUserQuestion (MP e Defensoria têm o polo implícito), identidade numa linha de texto livre, e
  salvar; nome e idioma vêm do `init`, e nichos, sistemas processuais, e-mail, agenda e redes
  passam a ser coletados quando um run precisar (ou por `edit-company`). Antes eram nove passos,
  cinco campos obrigatórios e uma rodada de confirmação.

## [0.9.5] - 2026-09-18

### Corrigido

- **`cobertura-acervo` não transforma tema longo em "acervo vazio".** A ferramenta exigia todos
  os termos do `--tema` juntos no cabeçalho de um mesmo julgado (tema, tags, caminho); um tema de
  dez termos zerava a busca e a recomendação saía "os superiores calam, buscar no tribunal" como
  se fosse fato do acervo (caso real de 17/09/2026: as mesmas questões em três temas curtos davam
  9, 3 e 1). Agora vírgula, ponto e vírgula, dois-pontos, barra e travessão separam questões, cada
  uma medida em separado (`questoes[]` no JSON, linha "Por questão" no Markdown); palavras de
  ligação ("por", "que", "para") não contam; e, com zero resultado numa questão de 4 ou mais
  termos, a recomendação abstém (`buscaExterna: null`), diz o mais perto que o acervo chega ("K
  casam pelo menos M") e como reformular. O runner e o prompt de build passam a pedir 2 ou 3
  termos por questão.

## [0.9.4] - 2026-09-16

### Corrigido

- **Reabertura por código não chama de "fonte mudou" o que não conseguiu comparar.** No gate final
  do run de 16/09/2026, 3 das 39 citações voltaram `fonte_mudou` e eram falsos positivos: tinham sido
  conferidas no acervo assinado (sem hash de download) e a reabertura foi à web, não achou o trecho
  literal e tratou como mudança. Registrar isso apagaria as confirmações das três. Agora: evidência
  que aponta arquivo do acervo (`fonte_local` em `acervo/`) é reaberta no arquivo, sem rede
  (`comparado_por: acervo`, com o hash do arquivo para a próxima); o trecho é comparado por
  fragmentos (as elipses `(...)` separam, travessão, aspas e pontuação não contam); só trecho, não
  localizado, vai para `sem_hash` com `motivo: trecho-nao-localizado` (conferência humana) em vez de
  virar contestação; `fonte_mudou` só quando um hash registrado não bate e o trecho sumiu. Com a
  correção, as 39 fecharam em 104 s: 31 por hash do texto baixado de novo, 8 na cópia do acervo.
- **O hook de citações lê acórdão de tribunal local em numeração CNJ.** "Apelação Criminal nº
  1517288-67.2019.8.26.0050" (e agravo de instrumento, agravo em execução, recurso em sentido
  estrito, embargos infringentes, sempre com o número no formato NNNNNNN-DD.AAAA.J.TR.OOOO) passava
  fora da rede: não entrava no cartório nem na cobertura do manifesto, e um acórdão inventado com
  esse formato passaria junto. "Processo nº …" e "apelação" em prosa continuam fora.
- **`--stj` prefere a publicação mais recente do mesmo registro.** O REsp 2.048.687/BA (Tema
  1260/STJ) devolvia a afetação de 29/05/2024 no lugar do mérito de 08/09/2026; quando a página de
  resultados traz mais de um acórdão do mesmo registro, vale o de data de publicação maior, e a
  resposta diz quantos havia (`publicacoes`).
- **`--pesquisa`/`--fontes --json` não carregam o texto extraído.** O JSON de saída aponta a cópia
  em disco, como o `INDEX.jsonl`; com 40 fontes ele passava de 5 MB.
- **`install-global` desregistra o gate de redação global do CriminalSquad.** Um `PreToolUse`
  legado (`~/.claude/hooks/verifica-redacao.mjs`, de 21/08/2026) bloqueava a gravação de qualquer
  minuta com frontmatter de controle; o instalador o remove do `settings.json` e renomeia o arquivo
  para `.criminalsquad.bak`.
- **O título com enumeração e sufixo de letra cobre cada artigo.** "CPP, arts. 396-A e 401" no
  manifesto deixava o art. 401 pendente porque a enumeração parava no "-A".
- **O índice dos autos conhece documentos de prova.** `denuncia`, `auto`, `boletim`, `relatorio`,
  `ata`, `declaracao` e `comprovante` entram no vocabulário (pelo nome do arquivo e pelo cabeçalho);
  no run de 16/09/2026, 8 dos 12 documentos saíam `desconhecido`.

## [0.9.3] - 2026-09-16

### Corrigido

- **O termo e as métricas mostram todas as rodadas de um gate.** O Citation Gate roda no step de
  redação e de novo na conferência final; o segundo `gate-open` gravava por cima do primeiro e o
  `TERMO-DE-CONFERENCIA.md` do run de 15/09/2026 mostrava "citacao: 1 ciclo" onde houve quatro. O
  `gate-open` agora arquiva o laço anterior em `historico[gate]` do `review-state.json` (com a hora),
  devolve `laco_anterior` e avisa no stderr quando o laço arquivado ainda estava aberto com ciclos
  (reabrir zera a contagem do teto). `run-metricas` soma as rodadas por gate (`ciclos`, `rejeicoes`,
  `lacos`, `rodadas[]`) e o termo ganha a coluna Laços e a lista rodada a rodada.
- **Auditoria aceita `compatibility` no topo do frontmatter.** É campo opcional do padrão aberto
  Agent Skills (requisitos de ambiente, até 500 caracteres); faltava na lista do motor e 66 skills
  de uma área escritas no padrão reprovavam por "frontmatter não oficial". `contract-skills`
  também o preserva no lugar.
- **Guarda de link morto ignora molde com `{placeholder}`.** `[preview]({absolute_path}/output/_build/a.png)`
  é instrução que o agente preenche em runtime, não referência a arquivo do pacote; o build de
  duas áreas parava nisso.
- **`empacotar.mjs` lê o `prazo-fatal.json` do motor determinístico da área.** O
  `PROXIMOS-PASSOS.md` dizia "prazo não informado" com o prazo gravado em `v1/prazo-fatal.json` pela
  triagem. O empacotador procura o arquivo da pasta da peça para fora (`vN/` → run → `output/`, as
  `vN/` da maior para a menor, `diagnostico/`) e transcreve a **data-limite** com a regra do motor
  (dias, contagem, marco, dobro, prorrogação) e os `avisos`; alerta quando a data-limite é anterior
  à data do pacote; arquivo presente mas ilegível ou sem `data_limite` vira pendência explícita, nunca
  "não informado". Continua sem calcular nada. O `MANIFESTO.json` do pacote traz `prazo_fatal`.

### Adicionado

- **`build-area` recusa skill de produção que o resolvedor recusaria.** A mesma auditoria estrutural
  do runtime roda antes de assinar: skill `active`/`pilot` com hard fail ou abaixo do piso de 90
  reprova o build, nomeando skill e motivo (eval não vinculada, cálculo sem motor, frontmatter fora do
  oficial, description inválida). Em 15/09/2026 o depósito de um aluno tinha 158 skills assim, subidas
  caladas. Skill declarada `lifecycle: preview` passa: o resolvedor a recusa do mesmo jeito, mas por
  decisão dita do curador.
- **Degrau Playwright provado com navegador de verdade.** O teste opt-in (`LEGALSQUAD_PLAYWRIGHT_MODULO`)
  passou a simular um desafio de JavaScript como os gateways reais (a origem planta um cookie por
  script e só quem o executou recebe o documento): o `fetch` cai no desafio, a escada abre o Chromium
  headless, ganha o cookie e baixa o PDF pela API de rede do mesmo contexto; captcha continua sem ir
  ao navegador. Sem navegador, o desafio sai `acesso_falhou: js-challenge` com o aviso de que falta o
  Playwright (teste sempre ligado).
- **`diagnostico`: "skills que o resolvedor recusa".** Lê o relatório da última auditoria
  (`skills/_quality-report.json`) ou audita na hora, e diz quantas skills de produção nenhum squad
  consegue usar, por motivo. Aviso, não falha: é defeito do pacote, e o conserto é do curador.

## [0.9.2] - 2026-09-16

### Adicionado

- **`scripts/fonte-oficial.mjs`: acesso a fonte oficial por código.** Medido no run de paridade de
  15/09/2026: o `verificador-citacoes` só tem `WebFetch`, e o `WebFetch` não abre o SCON do STJ
  (a busca exige User-Agent de navegador e `Referer`) nem o e-SAJ (devolve um gateway de
  JavaScript) — nove citações do acórdão voltaram `acesso_falhou` sem que a fonte estivesse
  indisponível. O script baixa a fonte oficial com escada de motores: `fetch` com cabeçalhos de
  navegador e cookies, uma repetição em 429/5xx, variante anônima do e-SAJ (`&casChecked=true`) e,
  só para gateway, Playwright quando instalado. **Nunca resolve captcha e nunca faz login**: o que
  exige um dos dois volta `acesso_falhou` com o motivo. Guarda a cópia local, o texto extraído e o
  SHA-256 do texto e dos bytes; escreve `fontes/INDEX.jsonl` (uma linha por fonte) e um cache em
  `acervo/_fontes/`. Modos: `--pesquisa <md> [--peca <md>]`, `--fontes <tabela|manifesto>`,
  `--stj "<citação>"` (acha registro, data de publicação e o link do inteiro teor na própria
  página do tribunal) e `--reabrir <manifesto>`.
- **Cadeia de certificados incompleta: o degrau que o navegador tem e o Node não.**
  `www.stf.jus.br` serve o certificado da folha sem o intermediário da CA; o navegador busca esse
  elo pelo endereço gravado no próprio certificado e abre a página, o Node não busca, e **todo
  informativo do STF** caía em `acesso_falhou: tls` com a fonte no ar. A escada agora completa a
  cadeia e refaz o pedido **com verificação normal** — o intermediário ainda precisa fechar numa
  raiz do sistema e o nome do host ainda é conferido. Não há opção para desligar a verificação de
  certificado, e não vai haver: fonte de prova aberta sem verificar certificado não é fonte de
  prova.
- **Reabertura do gate final por código.** `--reabrir` refaz o download de cada citação com
  evidência gravada e compara o hash: igual (ou trecho literal ainda presente) → `verificada`;
  diferente → `fonte_mudou`; sem acesso → `acesso_falhou`. A saída entra direto em
  `gate-verdict --gate citacao --reviewer reabertura --citacoes`. É o que tira do LLM a parte
  mecânica do voto final — no run medido, reabrir 25 fontes × 3 votantes custava ~16 minutos e
  ~850k tokens para confirmar o que já estava confirmado.
- **Cartório: evidência de acesso e consenso acumulado.** Cada citação verificada guarda
  `evidence` (`sha256_texto`, `sha256_bytes`, `trecho`, `fonte_local`, `registro`,
  `dt_publicacao`) e acumula `confirmacoes[]` (verificador, gate, hora, hash), distintas por
  verificador e hora de consulta. `citacoes-pendentes --confirmacoes N` devolve
  `pendentes_de_consenso`: com `citation_verifiers: 3`, a conferência da redação (1) mais a
  reabertura por código (2) deixam **um** votante LLM para fechar o consenso, em vez de três
  reabrindo tudo. `citacoes-status` mostra o resumo por número de confirmações.
- **`fonte_mudou` é contestação.** Entra no conjunto de status que derruba a citação do cartório —
  e leva junto as confirmações acumuladas: fonte que mudou desde a consulta não é fonte conferida.
- **Manifesto: `evidence` opcional por citação.** O schema aceita a prova de acesso e o hook
  `verifica-citacoes` valida a forma quando ela vem (hash hexadecimal de 64, trecho com ao menos
  8 caracteres, campo desconhecido é erro). Citação conferida só por leitura continua válida:
  evidência é reforço, não requisito.

### Mudado

- **Citation Gate (runner): passo 0 de pré-busca.** Antes de despachar verificador, o runner baixa
  por código as fontes oficiais da pesquisa e da peça e narra quantas abriram. Fonte que o tribunal
  não serve a robô vira `alta` para o redator **antes** da rodada de verificação, em vez de virar
  veredito ruim do verificador.
- **`verificador-citacoes`: cópia local antes da web, uma tentativa por citação, trecho
  obrigatório.** O agente lê primeiro o `fontes/INDEX.jsonl` do run; a tabela ganha a coluna
  **trecho** (fragmento literal da fonte), exigida em toda linha `VERIFICADA` — é o que a
  reabertura compara quando o hash da página muda por carimbo de data.
- **`build.prompt.md`: a URL do precedente tem de abrir sozinha.** O contrato do step de pesquisa
  passa a exigir o link do documento oficial (para o STJ, o inteiro teor com registro e data de
  publicação em colunas próprias), não o da busca que o encontrou.

### Medido

Contra os artefatos do run de 15/09 e os sites de verdade (detalhe em
[`docs/specs/legalsquad/FONTE-OFICIAL.md`](docs/specs/legalsquad/FONTE-OFICIAL.md) §10):
pré-busca de 37 URLs da pesquisa e da peça em **1 min 47 s**, 35 abertas (os 5 informativos do STF
pela cadeia completada, os 2 acórdãos do e-SAJ pela variante anônima); as 2 que continuam fechadas
são páginas de **busca** do SCON atrás de captcha. Gate final: reabrir as 25 citações levou
**54,5 s e nenhum token de LLM** (24 idênticas, 0 mudou, 0 sem acesso, 1 sem hash), contra
**16 minutos e ~850k tokens** com três verificadores no run de ontem — e sobrou **1** citação para
conferência por LLM, em vez de 25 × 3.

## [0.9.1] - 2026-09-15

### Corrigido

- **`build-area` recusa SKILL.md sem o marcador do contrato v5.** Achado do run de paridade do
  squad `defesa-criminal-completa` (15/09/2026): as 474 skills da área criminal traziam o marcador
  com o prefixo de origem (`CRIMINALSQUAD:HP-CONTRACT`); a auditoria estrutural só lê
  `LEGALSQUAD:HP-CONTRACT:START`, acusava `contrato v5 ausente` e o resolvedor de runtime
  recusava toda skill da área com `structural-gate-failed`: nenhum squad criminal passava da
  inicialização, e o pacote subiu e sincronizou íntegro sem ninguém notar. O build agora falha
  nomeando a skill e o marcador estranho; o conteúdo foi corrigido e republicado
  (`area.criminal@2026.09.5`).
- **`squad-path.mjs --modo leitura` olha o disco.** Resolvia sempre para a MAIOR pasta `vN` do
  grupo; com `v1/prazo-fatal.json` na raiz do run, `foco.md` (resposta de checkpoint, gravada sem
  versão) resolvia para `v1/foco.md`, e a validação de input do step seguinte reprovava um
  arquivo que existia. A leitura procura o arquivo da maior versão para a menor e depois o
  caminho sem versão; só sem nada no disco cai na conta antiga. CLI passa `existsSync`.
- **Redação Gate: `cobertura` só com contrato de skill que redige peça.** O hook aplicava o
  "Contrato de saída" de todas as skills declaradas no squad e nos agentes; a
  `calculadora-tempestividade` (perfil `legal-calculation`) exigia `regra_id` e `divergências` na
  petição. Agora só skill com `delivery_type: legal-draft` ou `quality_profile: legal-drafting`
  contribui (skill sem o metadado continua contando).
- **Redação Gate: `cobertura` não cobra da versão final o contrato da minuta.** O conferente
  fecha a entrega limpa de `status`, matriz e riscos (material da minuta, para quem revisa), e a
  peça final com `citation_gate: final` reprovava em cobertura por estar limpa; o hook passivo
  bloquearia a gravação. Versão final declarada (`citation_gate: final`, `output/final/` ou o
  marcador explícito) recebe `cobertura: nao-avaliado` com o motivo; a minuta continua medida.
- **Redação Gate: `ancoragem` lê o run inteiro.** O material do caso vinha só da pasta do
  artefato; com uma pasta `vN/` por step, a peça ficava sozinha e o sinal saía `nao-avaliado` em
  todo run versionado. Com a peça numa `vN/`, o material vem da pasta do run (dois níveis).

### Mudado

- **`verificador-persuasao`: estado `SEM TEMA (pesquisa)`.** Tese sem Tema no acervo cuja
  inexistência a pesquisa jurídica já registrou (repetitivos anotados e súmulas consultados) deixa
  de sair `[TEMA A CONFERIR]`; a delegação ao verificador de citações fica só para o que a
  pesquisa não conferiu.
- **Runner: subagente não despacha subagente.** Quando o step de um agente do squad manda
  "acionar" um subagente nativo (o `contraditor` em pré-mortem, `resumo-processo`), quem despacha
  é o runner, pelo nome, e grava o que voltou como a persona gravaria; a persona sem despacho
  aplica ela mesma o método do nativo.
- **Medido no run de paridade do `defesa-criminal-completa`** (15/09/2026, caso-ouro, 184 min,
  nota 92/92/83 por 3 avaliadores, 26 citações verificadas): o loop convergiu como o 0.9.0
  desenhou (revisão 2 ciclos, o segundo `aprovado-com-ajustes`; persuasão uma passada e uma
  reconferência; Citation Gate incremental com 3 rodadas de 26, 9 e 1 citações). Relatório em
  `skills-enriquecimento/relatorios/paridade-criminal-2026-09-15.md`.

## [0.9.0] - 2026-09-15

### Mudado

- **O loop de revisão converge: gravidade em cada correção, ajustes de forma sem rodada nova.**
  Medido no run real de 15/09/2026 (5h21): a revisão reprovou três vezes seguidas (13, 8 e 6
  fixes) com a peça já certa no mérito, porque cada rodada abria frente nova de forma (hífen,
  grafia, título) até o teto, e cada rodada custava 40 minutos. Agora o revisor escreve a
  gravidade no prefixo de cada fix (`critica`, `alta`, `media`, `baixa`) e o cartório
  (`src/review-loop.js`, espelhado em `squad-state.mjs`) só sustenta REJECT com `critica` ou
  `alta`: um REJECT só de forma vira aprovação com ajustes (`rebaixado-para-ajustes`), o redator
  aplica os `ajustes` em modo ajustes e o run segue do step seguinte ao revisor, sem rodada nova.
  `review-verdict` aceita `--ajuste`; a decisão traz `bloqueantes` e `ajustes`; a não-convergência
  só conta fix bloqueante repetido. Fix sem prefixo conta como `alta` (fail-closed: quem não
  classifica reprova como antes). A partir do ciclo 2 o revisor confere primeiro os fixes do ciclo
  anterior (aplicado, não aplicado, regressão); defeito novo só reprova se crítico ou alto.
  `check-squad` avisa `revisao-sem-gravidade` quando nem o step nem o agente revisor instruem a
  gravidade.
- **Citation Gate incremental: o veredito vale por citação, não por ciclo.** Cada rodada
  reverificava as 24 citações do zero. O cartório do run passou a guardar, por citação, o que já
  foi conferido (`review-state.json`, chave `citacoes`): `review-verdict`/`gate-verdict
  --citacoes tabela.json` registra a tabela do verificador (verificada exige `source_url` HTTPS
  e `consulted_at`; contestação recente vence confirmação antiga), e `squad-state.mjs
  citacoes-pendentes --peca <minuta>` diz o que a versão atual cita e ninguém conferiu
  (`pendentes`), o que já está conferido (`reaproveitadas`, prontas para o manifesto) e o que um
  verificador derrubou. O verificador recebe só as pendentes; `nada-a-verificar` dispensa o
  despacho. No gate final com voting, as reaproveitadas são reabertas pela fonte registrada
  (conferência, não descoberta). O hook `verifica-citacoes.mjs` ganhou o modo `--citacoes
  <artefato> [--manifesto <json>]`, que lista as citações materiais e a cobertura por título; é
  dele a extração, para o cartório não ter uma segunda.
- **Gate de Sobrevivência ao Resumo em uma passada e uma reconferência.** Três rodadas inteiras
  do gate (77 minutos) para mover frases para a síntese. Agora a primeira passada descobre (com
  `meta_verifiers`), os fixes levam gravidade (`alta` para pedido, tese principal, linha de ataque
  e Tema da principal; `media` para subsidiárias e citações perdidas, que viram ajustes), e a
  reconferência é um verificador só, em modo reconferência, sobre os itens que estavam
  `PERDIDO`/`TEMA NAO ANCORADO`. Teto do laço `persuasao`: 2. Agentes `verificador-citacoes`
  (lista de pendentes; colunas `source_url` e `consulted_at`) e `verificador-persuasao` (gravidade
  e modo reconferência) atualizados; squad-modelo `peca-modelo` e `build.prompt.md` seguem o
  contrato novo.

### Conteúdo (fora do motor, registrado aqui porque muda a experiência do aluno)

- **CriminalSquad dentro do LegalSquad, agora com os squads.** `area.criminal@2026.09.3` traz os
  seis squads criminais (`defesa-criminal-completa`, `execucao-penal`, `tribunal-juri`,
  `recurso-criminal`, `negociacao-penal`, `investigacao-acusacao-privada`) migrados para o caminho
  canônico 0.5: três paradas humanas com nome, fase zero em paralelo sobre o índice dos autos,
  agentes completos em `.agent.md`, pesquisa pelo `search-acervo`, conferência de entrega com o
  manifesto do Citation Gate fora do loop de revisão, e um único artefato de entrega
  (`<peça>-final.md`) para o empacotador. Todos passam em `check-squad` sem aviso e compilam no
  `compilar-workflow`. As 43 referências das skills, best-practices e autoridades criminais que
  apontavam para `acervo/legislacao/…` e `acervo/teses-modelos/crime-*.md` (layout do CriminalSquad)
  passaram a apontar para `acervo/_packs/acervo.criminal/…`, onde o pacote é ligado; o agente
  `acervo-busca` consulta por `search-acervo` em vez de ler o índice inteiro. `legalsquad acervo
  sync` traz tudo: 48 pacotes no catálogo, nenhum removido.

## [0.8.4] - 2026-09-15

### Corrigido

- **PDF grande na ferramenta `Read`.** No run real o verificador baixou informativos de 19 a 30
  páginas e a ferramenta recusou ("máximo 20 páginas por chamada"; acima de 10 páginas só com
  `pages`). O verificador e o runner passam a dizer a regra: PDF com mais de 10 páginas se lê por
  faixa (`pages: "1-20"`), inclusive as folhas dos autos lidas por imagem.

## [0.8.3] - 2026-09-15

### Corrigido

- **`npm run autos:md:deps` falhava no Python do Homebrew** (PEP 668, "externally managed
  environment": o `pip install --user` é recusado), e foi assim que um run real ficou com 73
  páginas digitalizadas sem OCR. `scripts/autos-md.mjs` cria um ambiente virtual do projeto em
  `_legalsquad/.venv` (ignorado no git), instala PyMuPDF, pytesseract e Pillow lá, sem tocar no
  Python da máquina, e `npm run autos:md` usa esse Python quando existe; sem `tesseract` no PATH,
  diz o que instalar. No caso real: 73 páginas reconhecidas por OCR em 7 min, cobertura 506/506.
- **"Informativo 876" casava acórdão cujo número contém 876.** O identificador exato passa a exigir
  o campo certo: `Informativo N` só é exato no julgado do informativo N, `Tema N` no tema repetitivo
  N, `Súmula N` no verbete N (não num acórdão que a cita).

## [0.8.2] - 2026-09-15

## [0.8.1] - 2026-09-15

## [Unreleased]

### Corrigido (achados de um run real com 506 páginas, 15/09/2026)

- **"Texto extraído parcialmente, deu para ler bem" deixa de existir.** O índice dos autos
  (`indexar-autos`, formato 2) passa a trazer a cobertura (`cobertura: { paginas, com_texto,
  sem_texto }`) e, por documento, as faixas de páginas sem camada de texto
  (`paginas_sem_texto: "150-151, 190-197, 237-292"`); o resumo no terminal diz a conta. O
  runner ganha o **gate de leitura integral** na fase zero: com `sem_texto` maior que zero, não
  passa sem OCR (`npm run autos:md`), leitura por imagem das faixas ou a decisão do usuário
  sobre as faixas exatas, e o intake diz sempre a conta inteira. No caso real, 73 das 506 páginas
  (os anexos digitalizados) tinham ficado sem leitura.
- **O verificador ia à web com o julgado no disco.** Os agentes tentavam abrir `acervo/_index.yaml`
  e os índices dos pacotes com `Read` (centenas de KB a MB: a leitura falha) e caíam em baixar
  os informativos do STJ, que são exatamente a fonte do acervo. Agora: o índice traz `informativo`
  e `tema_repetitivo`, e `search-acervo` os trata como identificador ("Informativo 876 STJ",
  "Tema 1282" acham o julgado); o `verificador-citacoes` (sem Bash) recebe o procedimento por
  `Grep` (número, `processo: "Súmula 188"`, `tema_repetitivo`, `informativo`) e a regra de que
  julgado achado no acervo **é** a fonte oficial (a `fonte_url` vai para o manifesto); runner,
  skill, build prompt e o squad-modelo mandam consultar por `search-acervo` e nunca ler o índice
  inteiro; o próprio índice abre com esse aviso. Os oito precedentes do run estavam todos no
  acervo, com identificador exato.
- **O pacote da entrega saiu com o `foco-do-caso.md` no lugar da réplica.** A peça só existia como
  `replica-minuta.md` (rascunho pelo nome) e `foco` não era nome interno. `check-squad` ganha
  `entrega-sem-artefato-final` (squad de peça precisa declarar `output/<peça>-final.md`), o filtro
  de nome interno inclui `foco`, `gate`, `termo`, `conferencia`, `linha`, `memoria`, `notas`,
  `plano`, `mapa`, `analise`, `contradicoes`, `pre-mortem`, `temas`, `anexos`, `proximos-passos`
  e `manifesto`, e o build prompt exige o step que promove a minuta a final.
- **`empacotar` falhava sem `docx` no projeto** (o `init --yes` não instala dependências). O
  script resolve a biblioteca no projeto ou no `node_modules` do próprio motor (que a declara),
  sem `npm install`.

### Adicionado

- **O pacote de área leva autoridades e calculadoras.** `build-area` ganha duas subárvores:
  `core/authorities/` → `_legalsquad/core/authorities/` (os registros que
  `scripts/check-legal-authorities.mjs` confere; até aqui nenhum pacote os trazia) e
  `scripts/legal-calculators/` → `scripts/legal-calculators/` (as calculadoras que as skills
  declaram em `engines:`; "chegam pelo sync, não pelo init", como o `init.js` já dizia). O
  depósito liga as duas por hard link. Um pacote de acervo pode vir organizado por tipo na raiz
  da área (`legislacao/`, `teses-modelos/`, `doutrina/`, `sumulas/`, `jurisprudencia/`), e o
  tipo é preservado no caminho de instalação (sem pasta de tipo, tudo continua jurisprudência).
  Foi o que faltava para trazer o CriminalSquad: `area.criminal` (474 skills, 43 best-practices,
  30 agentes, 19 autoridades, 4 calculadoras) e `acervo.criminal` (21 leis, 25 teses-modelo, 20
  notas) publicados em 15/09/2026; os 7.351 julgados criminais já estavam nos pacotes
  `acervo.direito-penal`, `acervo.direito-processual-penal` e `acervo.execucao-penal`, hash a
  hash. Os 9 squads ficaram para migrar ao desenho 0.5 (`check-squad` os reprova hoje).

### Corrigido

- **Alvo canônico em best-practice de pacote nunca resolvia.** A checagem de canonicalização
  (`skills/_*-integration.yaml`) lia só `_catalog.yaml`, e os pacotes instalam
  `_catalog.<area>.yaml`; agora lê todos os catálogos da pasta.

- **Acervo republicado com nomes de até 100 caracteres** (`acervo.*@2026.09.3`, 15/09/2026):
  conteúdo idêntico hash a hash aos 61.367 julgados anteriores, 26.697 nomes cortados; o maior
  caminho relativo do depósito caiu de 250 para 176 e o depósito passa a caber no limite de 260
  do Windows sem a chave `LongPathsEnabled`. O `sync` reaplica os 22 pacotes e religa os
  projetos com os nomes novos. A linha da ligação passa a dizer "removido(s) (saíram dos pacotes
  ou pacote revogado)" em vez de só "pacote revogado", que assustava nessa troca de nomes.
- **`diagnostico` via `npx` dizia "só pelo atalho" mesmo com o comando no PATH do shell.** O
  npx põe `node_modules/.bin` na frente do PATH e o primeiro achado era sempre o atalho; agora
  vale o primeiro achado fora de um `node_modules/.bin`, e "só pelo atalho" fica para quando não
  há outro.

## [0.8.0] - 2026-09-14

### Adicionado

- **Depósito de conteúdo da máquina: um sync para todos os projetos.** O `acervo sync` passa a
  gravar os pacotes em `~/.legalsquad/acervo/` (uma vez por máquina) e a ligar o projeto atual a
  ele por hard link: skills, best-practices e jurisprudência aparecem em `skills/`,
  `_legalsquad/core/best-practices/` e `acervo/_packs/` como arquivos comuns (Grep, Glob e
  `Read` funcionam sem atravessar symlink), sem ocupar disco de novo e **sem bit de escrita** (o
  conteúdo do pacote é do curador; editar no lugar falha em vez de corromper a cópia de todos os
  projetos; o ajuste local continua em `SKILL.local.md`). Squads e agentes de área vêm por cópia
  e passam a ser do projeto. Novo `legalsquad acervo ligar` liga uma pasta sem rede; `init` nasce
  ligado (com o índice de skills e do acervo já regerados) e `update` liga projetos antigos,
  trocando a cópia própria pelo link. Onde o volume não aceita hard link, o projeto recebe cópias
  e o `status` diz isso. `contract-skills` passa a pular (e contar) as skills protegidas do
  depósito em vez de rebaixar o contrato do curador. Medido em 14/09/2026 contra a produção: 46
  pacotes, 6.981 skills e 61.367 julgados em 645 MB no depósito; ligar um segundo projeto levou
  49 s sem rede e ~20 MB de disco (índices e cópias). Antes, cem projetos eram cem syncs e cem
  cópias. `tests/deposito.test.js`; a suíte roda com um depósito vazio e descartável
  (`tests/test-setup.js`), nunca o da máquina.
  A revisão adversarial do mesmo dia (15 achados) endureceu o desenho antes do release: a posse
  é decidida pelo **registro de arquivos por pacote** (`acervo/_packs/_arquivos/<pack>.json`,
  gravado a cada aplicação), não pela pasta crua; **pacote revogado** sai do depósito e é podado
  dos projetos pelo hash; arquivo que o projeto tem **diferente do curador** vai para `.bak` antes
  de ser substituído (link antigo intocado de uma versão anterior troca sem barulho); **squads e
  agentes** copiados são atualizados em três vias (o curador mudou e o usuário não tocou:
  substitui; o usuário mexeu: mantém e avisa); o `status` acusa **DEFASADO** quando o depósito
  mudou depois da ligação e **LEGADO** quando o projeto tem pacotes do motor anterior dentro de
  si (o `sync` os migra, pedindo o conteúdo inteiro e arquivando o manifesto antigo); o alvo
  antigo de um pacote atualizado **nunca ganha bit de escrita** (o inode é de todos os projetos
  ainda não religados) e um temporário sobrando de sync interrompido não bloqueia o próximo;
  **trava** entre syncs simultâneos no mesmo depósito; erro de um arquivo copia só ele (só
  `EXDEV` e afins viram modo cópia); catálogo ou chave **próprios** ganham depósito separado
  (`~/.legalsquad/acervo-<hash>`); `contract-skills` reconhece a skill do curador por **posse
  positiva** (mesmo inode ou mesmo conteúdo), não pela falha de escrita; o atalho `npx
  legalsquad` **nunca executa outro atalho** (recursão), prefere o **motor mais novo** entre os
  que existem, repassa sinais, e `ligarMotor` **nunca escreve através dos symlinks do npm** (o
  `cli.mjs` era sobrescrito pelo shim depois de init + npm install + update); o indexador do
  acervo é lido pela linha `Indexados N arquivos` com `maxBuffer` de 64 MB; ligação sem mudança
  é pulada (carimbo do conjunto pack@versão); a suíte define `LEGALSQUAD_DEPOSITO` sem condição
  e o motor recusa o depósito real dentro do runner do node.
- **O bloco global e a skill olham as pastas acima antes de propor preparar a atual.** Quem abre
  o Claude Code dentro da pasta de um processo passa a usar o LegalSquad do escritório (a pasta
  acima com `_legalsquad/`), em vez de ganhar um projeto novo e vazio a cada caso; a pergunta de
  autorização diz que o comum é uma pasta por escritório com os casos dentro, e que a pasta nasce
  ligada à biblioteca já sincronizada na máquina.

- **Índice dos julgados gerado uma vez, no depósito.** Cada pacote de acervo é indexado na
  origem ao ser aplicado (`acervo/_packs/<pack>/_index.yaml`, registrado com o pacote, ligado e
  podado com ele); o `indexar-acervo` do projeto pula os pacotes já indexados e a busca soma o
  índice do projeto aos de pacote (entrada de pacote vence a antiga do projeto; a checagem de
  índice defasado deixa de revarrer 60 mil julgados a cada busca). O indexador ganhou
  `--acervo`, `--subarvore` e `--saida`. Depósito anterior a esta versão é indexado no próximo
  sync. Medido: 12,6 s uma vez por máquina em vez de por projeto.
  Segunda revisão adversarial (15 achados) antes do release: `pack_id` do catálogo só vira caminho
  se for um segmento simples (um catálogo hostil podia levar `rmSync` até o `$HOME`); a identidade
  do depósito lê a chave PRÓPRIA (`chavesPublicas.propria`), não o PEM de produção que a config
  sempre preenche (todo projeto caía em `acervo-<hash>`); o carimbo de "nada mudou" e o `DEFASADO`
  cobrem o registro, não só as versões (o índice gerado pela migração nunca chegava aos projetos já
  ligados); posse de caminho compartilhado por "outros pacotes", não pela ordem do `readdir`; a
  trava do sync solta no Ctrl+C, reconhece pid morto e é tomada antes de ler o estado; pacote
  atualizado desce uma vez (o conteúdo já traz o catálogo) e registro vazio é ignorado; o índice
  do projeto volta a listar os julgados dos pacotes (copiados do índice de pacote, sem revarrer),
  porque os agentes fazem Grep em `acervo/_index.yaml`, e os wikilinks para notas de pacote seguem
  válidos; projeto antigo usa a data do último sync para distinguir cópia do curador de edição (sem
  inundar `.bak`); posse conferida em cada ARQUIVO alvo do contrato, não só no `SKILL.local.md`;
  muitos `EPERM` seguidos viram modo cópia com aviso (vfat no Linux); depósito sem registros é
  reaplicado pelo sync; registro ou marcador corrompido falha com o nome do arquivo em vez de sumir;
  `LEGALSQUAD_DEPOSITO` é resolvido; a sonda `npx` do diagnóstico só roda com o shim presente e
  com `--no-install`; pré-release perde para a versão limpa; trocar de depósito religa e avisa.
- **Motor registrado na máquina.** `install-global` grava `~/.legalsquad/motor.json`; o atalho
  `npx legalsquad` o lê depois do `motor.json` do projeto e antes dos prefixos conhecidos, então
  trocar de motor e rodar `install-global` atualiza todos os projetos de uma vez.
- **`legalsquad diagnostico`.** Node, npm, `legalsquad` no PATH, motor em uso e registrado,
  atalho do projeto (presente e executando), `npx legalsquad`, depósito e ligação (em dia ou
  DEFASADO), hard link no volume do projeto e entre depósito e projeto, e bit somente-leitura
  respeitado; `--json` para colar num chamado. É a prova de campo do desenho em Windows.
- **A busca no acervo acha um julgado pelo identificador.** O indexador passa a gravar no
  índice o `processo` e o `tribunal` do frontmatter de cada julgado (`Súmula 54` + `STJ-SUM`,
  `REsp 1.132.866-SP` + `STJ`), e `search-acervo` pontua o identificador acima do tema: "Súmula
  54 STJ" devolve o verbete em primeiro (antes devolvia um informativo de mesmo número e o
  verbete nem aparecia), "REsp 1.132.866/SP" devolve o acórdão, e "Súmula 999 STJ" não devolve
  identificador exato nenhum, que é o que o verificador de citações precisa ler para dizer "não
  encontrada". Número é identificador, não radical: "54" deixa de casar "544" e "548", e um
  número de um dígito ("Súmula 7") deixa de ser descartado como palavra curta. Os índices de
  pacote já gerados no depósito por um indexador anterior são refeitos uma vez por máquina
  (o registro guarda a identidade do indexador; `sync`, `ligar`, `init` e `update` refazem sob a
  trava) e os projetos religam o índice novo. Achado no teste de montagem de 14/09/2026.
- **A CLI age sobre a casa mais próxima.** Rodar `npx legalsquad …` de dentro de
  `Escritório/Processos/<caso>/autos/` age sobre o escritório (a regra do roteador, "uma pasta
  por escritório, com os casos dentro", aplicada à CLI, como o git faz com o `.git` acima); a
  raiz usada sai no stderr quando difere da pasta atual, e `LEGALSQUAD_RAIZ` a fixa sem subir.
  `init` numa subpasta de uma casa avisa que a pasta acima é a raiz (não bloqueia). Antes,
  `search-skills` numa subpasta respondia "diretório skills/ ausente" e `update` dizia "não
  inicializado".
- **`legalsquad --version`** (`-v`, `version`) imprime a versão do motor; antes imprimia a ajuda.
- **`npm run e2e:aluno`: o teste de montagem do aluno como comando** (`scripts/e2e-aluno.mjs`).
  Numa máquina simulada (HOME e prefixo npm isolados, dist empacotado como o `npm install -g
  github:…` instala, pasta de processo com acento, espaço e `&`, shell sem `legalsquad` no
  PATH) roda install-global, init, sync real (ou `--deposito <pasta>` para ligar um depósito já
  sincronizado, sem rede), `diagnostico --json`, buscas por identificador, os hooks de citação
  com o payload do Claude Code, update, `--version`, a CLI de dentro de `autos/` e um segundo
  projeto; relatório em tabela e `--json`, orçamentos de tempo (aviso por padrão, falha com
  `--estrito`). Nunca toca o `~/.legalsquad` de quem roda. É também a prova de campo no
  Windows: `node scripts/e2e-aluno.mjs --json relatorio.json` numa máquina Windows e mandar o
  arquivo. A CI ganha o job `test-windows` (suíte em `windows-latest`, sem bloquear até a
  primeira execução verde) e o job `e2e-aluno` (Linux e Windows) no agendamento diário, em tag
  `v*` e a pedido. Medido em 14/09/2026 no macOS: 2 min 41 s sem rede, todos os passos ✓.
- **Windows: caminhos longos medidos e nomes de arquivo com teto.** O acervo publicado tinha
  nomes de até 250 caracteres (8.641 arquivos acima de 180), e o Windows limita o caminho
  inteiro a 260 até alguém ligar `LongPathsEnabled`: `C:\Users\ana\.legalsquad\acervo\` + 250
  já estoura no próprio depósito, e um projeto em `Documentos\Escritório\Processos\<caso>\`
  estoura milhares de links. Três frentes: `construirAcervo` passa a cortar o nome do arquivo em
  100 caracteres (determinístico, preservando o hash final; declarado no manifesto em
  `normalization.max_basename`; medido no acervo real: 21.756 nomes cortados, zero colisão);
  `diagnostico` no Windows ganha o item "caminhos longos" (lê a chave do registro e conta
  quantos arquivos passariam de 260 ao lado do depósito e do projeto) e, em todo sistema, o
  aviso "pasta sincronizada com a nuvem" (OneDrive, iCloud Drive, Google Drive, Dropbox: 83 mil
  hard links viram 83 mil uploads); e a ligação nomeia a causa quando um arquivo falha por
  caminho longo. Os pacotes de acervo precisam ser republicados com o teto (do curador, com a
  fonte completa).
- **Ligar só as áreas do escritório.** `acervo.json` ganha `"areas": ["direito-civil", …]`
  (ausente = todas, como sempre); `ligarDeposito` liga só os pacotes dessas áreas mais os
  sempre-ligados (`transversal`, `acervo.sumulas`, `acervo.outros`) e **desliga** do projeto o que
  saiu da seleção (só o arquivo do curador; o alterado localmente fica, com aviso; pastas vazias
  saem junto). Novo `legalsquad acervo areas`: lista as áreas do depósito com skills e julgados e
  o que esta pasta liga (●/○); `acervo areas <área>…` grava a escolha e religa sem rede;
  `--todas` volta a tudo. `acervo status` e `diagnostico` mostram as áreas e acusam DEFASADO
  quando a escolha mudou. A busca de skills devolve `nao_ligadas` (`BUSCA_FORA_DAS_AREAS`): o
  que existe no depósito fora das áreas ligadas, para o chefe oferecer ligar em vez de dizer
  "não existe" (princípio 3). O onboarding da skill pergunta as áreas. Medido em 14/09/2026:
  civil + consumidor liga 7 de 46 pacotes, 1.384 skills em 14 s (tudo: 6.981 skills em 62 s).
- **Autos por referência (uma pasta por escritório, casos dentro).** O run pode gravar
  `squads/<nome>/caso.json` apontando a pasta do caso (`{"pasta": "Processos/<caso>",
  "autos": "Processos/<caso>/autos"}`); o hook de redação lê `autos/_index.yaml` de lá para o
  sinal `folhas`, `indexar-autos` e `autos-para-md` aceitam a pasta do caso, e a carteira
  (`carteira-consolidar`, `carteira-metricas`, o briefing do chefe) passa a enxergar
  `carteira-row.json` em pastas de caso da casa (`Processos/<caso>/`, `Clientes/<nome>/<caso>/`),
  além de `acervo/casos/`. Nada é copiado para o squad; `squads/<nome>/autos/` continua valendo.
- **Empacotador recusa link morto.** `build-area` reprova a skill cujo `SKILL.md` linka um
  arquivo relativo que o pacote não traz (`references/…`), nomeando skill e alvo, como já
  recusa pacote sem catálogo. Achado real: 38 skills `emp-*` publicadas com
  `references/high-performance-contract.md` inexistente, que o catálogo do aluno acusava como
  `broken-reference` a cada indexação.

### Corrigido

- **O primeiro projeto de uma máquina não nasce mais sem biblioteca em silêncio.** Com o
  depósito ainda vazio, o `init` terminava com "inicializado com sucesso" sem dizer que não
  havia skill nem jurisprudência; agora avisa que a biblioteca da máquina está vazia, lista
  `npx legalsquad acervo sync` nos próximos passos, e o bloco global e a skill mandam o
  assistente rodar o sync logo depois do `init` (o sim do usuário já cobre; a pergunta passa a
  dizer que a primeira vez baixa a biblioteca para `~/.legalsquad/`, em vez de prometer que nada
  fora da pasta muda). Na ativação, a skill confere se `skills/` está vazio e aponta `sync` ou
  `ligar` conforme o `acervo status`.
- **`--lang "português"` (o exemplo do README) caía no inglês.** O rótulo do idioma passa a ser
  tolerante ("português", "Português (Brasil)", "pt-BR", "portuguese", "español", "inglês");
  antes só o rótulo exato do menu interativo casava, e o `init --yes` disparado pelo assistente
  imprimia tudo em inglês.
- **`diagnostico` dizia "legalsquad no PATH ✓" quando só o atalho do projeto respondia.** O `npx`
  põe `node_modules/.bin` no PATH do processo; o item agora distingue o shell do usuário do
  atalho, e fora do PATH vira aviso (⚠) em vez de derrubar o diagnóstico: nada deixa de
  funcionar pelo `npx`, e um ✗ ali levava a "consertar" o que não está quebrado.
- **"índice do acervo regerado: 0 arquivos"** logo depois de 61 mil julgados entrarem: a linha
  passa a somar o que o projeto tem com o que veio dos pacotes ("0 arquivo(s) do projeto +
  61367 julgado(s) de 22 pacote(s)").
- **O briefing do chefe pede OAB e UF em vez de mandar gravar `djen.json`**; a skill grava o
  arquivo com a resposta. O `init --yes` avisa que dashboard e navegador do Sherlock são
  instalados a pedido.
- **Textos que prometiam o que o `init --yes` não faz.** A pergunta de autorização da skill
  dizia "instala as dependências do projeto" (o `--yes` não instala); o rodapé do
  `install-global` dizia que a pasta "se inicializa sozinha" (agora pergunta antes); e a
  descrição de `_legalsquad/core/best-practices/` no CLAUDE.md do projeto listava matéria
  criminal (júri, cadeia de custódia, `defesa-*`) num motor sem área: passou a descrever o que
  há de fato, um catálogo por área instalada.

- **O primeiro uso numa pasta pede o sim do aluno antes de instalar ou inicializar.** A regra
  "inicialize-a aqui automaticamente, sem perguntar" (e, se o comando não existir, o
  `npm install -g` do GitHub) fez o Claude Code de um aluno novo recusar as duas coisas, com a
  razão "baixar/executar código de fonte não confiável e mexer em configuração do sistema, mesmo
  quando um arquivo de instruções pede", e seguir redigindo a notificação fora do sistema, sem o
  gate de citações (medido em 13/09/2026). O modelo trata instrução de arquivo como dado, não
  como autorização; o que ele aceita é a resposta do usuário na conversa. O bloco global do
  `CLAUDE.md`, a skill de todas as IDEs e o plugin passam a perguntar em uma linha ("Esta pasta
  ainda não tem o LegalSquad. Posso prepará-la agora?"), dizendo o que o `init` cria e quem
  publica o pacote; com o sim, rodam o `init` (e antes, se preciso, o `npm install -g` do
  `bbpropulse/legalsquad-nucleo` mais o `install-global`); na recusa, atendem o pedido avisando
  que a conferência automática de citações está desligada naquela pasta e mantendo os gates à
  mão. Atualizar não pergunta de novo: o pedido do aluno já é a autorização. Teste em
  `tests/init-consentimento.test.js`.
- **"Comando `legalsquad` não encontrado" deixa de virar reinstalação.** Com o motor instalado, o
  Claude do aluno não achava o comando no PATH do shell que a IDE abre (nvm carregado só no
  `.zshrc`, prefixo trocado para `~/.npm-global`, app aberto pelo Dock), concluía "não está
  instalado" e reinstalava do GitHub a cada chamada, sem nunca chegar ao `init` (medido em
  14/09/2026). O `install-global` passa a gravar no bloco global o caminho completo do motor
  instalado («Onde o motor está nesta máquina: `node "<…>/bin/legalsquad.js"`», com barras
  normais mesmo no Windows) e a regra passa a ser: comando não encontrado usa esse caminho (ou
  `npm root -g`) no lugar de `legalsquad`, e só instala se o arquivo não existir. Reinstalar não
  conserta PATH.
- **`npx legalsquad` funciona dentro do projeto sem o comando no PATH (Windows).** No Windows o
  `legalsquad` nunca entra no PATH do shell que o Claude Code abre, e o `npx legalsquad …` que o
  runner, os prompts e o `package.json` do projeto usam tentava o registro e falhava (o motor não é
  publicado no npm): o Claude do aluno concluía "não está instalado" e reinstalava do GitHub a
  cada chamada. O `init` e o `update` passam a deixar no projeto um pacote-atalho
  (`_legalsquad/motor/`, com `motor.json` apontando para o motor desta máquina) e os shims em
  `node_modules/.bin/legalsquad` (sh, cmd, ps1); o `package.json` do projeto declara
  `"legalsquad": "file:_legalsquad/motor"` para o `npm install` manter o link. O atalho acha o
  motor por `LEGALSQUAD_BIN`, pelo `motor.json`, pelos prefixos do node em uso (`%APPDATA%\npm`,
  a pasta do `node.exe`, nvm, Homebrew, `/usr/local`, `~/.npm-global`) e, por último, por
  `npm root -g`; sem achar, explica o que instalar. Projetos antigos ganham o atalho no próximo
  `legalsquad update`, sem `npm install`. Testes em `tests/motor-link.test.js`, inclusive a
  integração com o `npm install` (o link sobrevive e o `npx` resolve local).

## [0.7.4] - 2026-09-11

### Corrigido

- **`install-global` reconhece as cópias antigas dos nossos agentes.** A 0.7.3 só atualizava o
  agente que carregasse a palavra LegalSquad; as cópias instaladas antes da assinatura existir
  (medido em 11/09/2026: `verificador-citacoes.md`, `avaliador-squad.md` e `catalog-scout.md` de
  21/08 na máquina do autor) eram "preservadas" como se fossem do usuário, e ficavam sem a regra do
  manifesto por citação ao lado do hook novo. Agora é nosso o agente com assinatura de squad OU com
  o mesmo `name:` e a mesma abertura de `description:` do atual; o agente do usuário com nome
  coincidente continua intocado.

## [0.7.3] - 2026-09-11

### Corrigido

- **Citation Gate: o manifesto passa a cobrir CADA citação da peça, não "ao menos uma".** O hook
  `verifica-citacoes` aceitava um manifesto com uma citação verificada para uma peça com quatro:
  as outras três saíam sem atestação nenhuma. Agora ele extrai as citações materiais do texto
  (lei com artigo em qualquer ordem e grafia, inclusive diploma por extenso, sigla variante, órgão
  entre nome e número, enumeração `arts. 5º e 6º`, milhar `art. 1.022` e apelido `Lei de Drogas`;
  súmula, SV, Enunciado, OJ, precedente normativo; Tema; acórdão em sigla ou por extenso, com
  numeração eleitoral e NPU do TST) e exige em `citations[]` uma entrada com a mesma classe e o
  mesmo número; sigla, nome por extenso ou número da lei valem, no singular ou no plural; tribunal
  e natureza vinculante contam; número parecido não cobre (`REsp 11.234.567` não atesta `REsp
  1.234.567`, `art. 1º` não atesta `art. 1.015`, o ano da lei não atesta o artigo). Endereço e
  título de seção não viram citação. A mensagem de bloqueio lista as descobertas com a linha.
  Medido em fixture real antes da correção: peça com 4 citações e manifesto de 1 passava com exit
  0; `contestacao.md` com citação e sem manifesto passava com exit 0.
- **Citation Gate e Redação Gate reconhecem a peça pelo nome em todas as áreas, e pela forma
  quando o nome não diz.** A lista de nomes de peça tinha 20 termos, cobria o tipo de 39% das
  1.165 skills em produção que entregam peça e divergia entre os dois hooks. Os dois passam a
  carregar um bloco compartilhado com 600 nomes levantados das 6.999 skills, família a família, e
  verificados adversarialmente contra 850 nomes de ataque: o token conta em qualquer posição
  (`0001234-56.2024.8.26.0100-sentenca.md`, `cliente-x-inicial.md`, `PeticaoInicial.docx`), e o
  que livra o artefato interno é a convenção interna (prefixo `analise-`, `fichamento-`, `resumo-`,
  `pesquisa-`, mesmo depois de `03-` ou de data; sufixo `-analise`; segmento `-tarefas`,
  `-reuniao`; subpasta `output/diagnostico/`, contada só depois de `output/`, porque uma pasta
  ancestral chamada `autos/` desligava o gate do projeto inteiro). `agravo-interno.md` deixa de
  ser rascunho; `relatorio-e-voto.md` e `revisao-de-beneficio.md` deixam de ser internos. Um
  arquivo de nome neutro é peça quando tem **forma de peça**: duas fórmulas em trechos distintos,
  na redação corrente ("Exmo. Sr. Dr.", "Vistos.", "Posto isso", "Pelo exposto, NEGA-SE
  PROVIMENTO", "1. OBJETO", "no uso de suas atribuições"); um dispositivo transcrito numa análise
  vale uma e não faz peça. `output/final/`, o marcador e o frontmatter `citation_gate: final`
  vencem a convenção de nome interno. `tests/templates-paridade` prende o bloco idêntico nos dois
  hooks e no plugin; `tests/fronteira` trata o vocabulário como mecanismo, confinado ao bloco.
- **Desempenho do hook.** `FINAL_FRONTMATTER` com flag `m` varria o arquivo inteiro a partir de
  cada régua `---` (6 s numa peça de 3 MB; herdado da v0.7.2); agora só o cabeçalho é lido. Peça
  de 3 MB com milhares de citações passa em 0,2 s. Entrada de hook com `file_path` que não é
  string deixa de derrubar o processo com stack trace.
- **A minuta do squad-modelo deixa de ser gateada como peça final.** `step-08` gravava
  `output/peca-modelo.md`, nome que o hook lê como peça (`peca`): o rascunho exigia manifesto e
  o empacotador o via como candidato a entrega. Passa a `output/peca-modelo-minuta.md`; o step-10
  passa a dizer que o conferente grava o manifesto, uma entrada por citação.
- **`install-global` atualiza os agentes de núcleo desatualizados.** Ele sobrescrevia o hook mas
  preservava qualquer agente já existente, inclusive o nosso `verificador-citacoes.md` de uma
  versão anterior, que não sabia da regra do manifesto por citação. Agente que carrega a assinatura
  LegalSquad e difere do atual é atualizado; agente do usuário com o mesmo nome continua intocado.

## [0.7.2] - 2026-09-11

## [0.7.1] - 2026-09-09

### Alterado

- **O bloco global e a skill `/legalsquad` passam a ensinar o Claude a ATUALIZAR o LegalSquad,
  não só a instalar — porque o aluno não usa terminal.** O bloco que o `install-global` grava no
  `~/.claude/CLAUDE.md` só dizia como instalar ("se o comando não existir, `npm install -g
  github:bbpropulse/legalsquad-nucleo`"); "atualiza o LegalSquad" dependia de cada sessão inferir
  "reinstalar e refazer o global". Medido em 09/09/2026, na primeira atualização para a 0.7.0: uma
  sessão inferiu certo (CLI 0.5.2 → 0.7.0 e `install-global` refeito) e em seguida tentou
  `git pull` num clone do motor, que é privado — a janela de credenciais do Windows abriu, o
  agente não tinha como respondê-la e o comando morreu no timeout com "Repository not found". O
  bloco ganha o item 5: quando o usuário pedir para atualizar, quem roda é o Claude, na ordem
  `npm install -g github:bbpropulse/legalsquad-nucleo` (é git do GitHub, não o registro npm) e
  `legalsquad install-global`, mais `legalsquad update` se a pasta for um projeto; nunca
  `git pull`/`git fetch` (a distribuição é um snapshot forçado e o código-fonte é privado); e diz
  a versão que ficou. A skill `/legalsquad`, que mandava "orientar" o usuário a rodar o comando,
  passa a mandar o Claude rodá-lo. `tests/install-global.test.js` prende a regra no bloco.

## [0.7.0] - 2026-09-09

### Adicionado

- **`area_presumida` atravessa o motor: índice, busca e cobertura param de tratar palpite como
  declaração.** O acervo marca com `area_presumida: true` o julgado cuja ÁREA veio de heurística por
  termo, e não da fonte. Até agora o campo existia no arquivo e ninguém o lia — o que significa que
  o `cobertura-acervo` contava palpite como cobertura e o `search-acervo` entregava palpite
  empatado com classificação declarada.

  Num acervo real de 41.788 julgados, **19.811 são palpite**. Fora o eleitoral, quase toda área é
  majoritariamente presumida: processual do trabalho 99,8%, trabalho 98%, tributário 90%. Em
  direito administrativo, a cobertura real cai de 2.905 para 1.007.

  As três pontas:
  - **`indexar-acervo`** leva o campo do frontmatter para o `_index.yaml`;
  - **`search-acervo`** aplica penalidade proporcional (0,6) e rotula o resultado com
    `[área presumida]`. É penalidade, não corte: o julgado presumido continua aparecendo, porque é
    material de partida válido, mas nunca à frente de um cuja área a fonte declarou. Medido: num
    tema com material declarado, os presumidos saem do topo; num tema 98% palpite, 7 dos 8
    resultados vêm rotulados, que é a informação que o profissional precisa ter;
  - **`cobertura-acervo`** conta as duas colunas separadas e acrescenta uma recomendação nova: se
    TODOS os julgados do tema forem presumidos, o tema "não está coberto, está apenas indexado".

  O selo `[oficial-verificado]`/`[descoberta]` diz de onde vem a CONFIANÇA; este rótulo diz de onde
  vem a ÁREA. São coisas diferentes, e sem o segundo um julgado tributário arquivado como
  administrativo entra numa peça sem ninguém perceber.

- **`scripts/build-metricas.mjs` — a criação de squad passa a ser medida, sem tocar em prompt.**
  A execução tinha ledger e `run-metricas`; a criação tinha uma frase: "medido em quatro builds
  reais, 16 a 18 minutos". Sem série não há como saber se uma mudança no Build ajudou, atrapalhou
  ou não fez nada — e o cliente reclama de lentidão exatamente aí. O script lê o que o Arquiteto
  já grava, na ordem fixa em que grava: os carimbos de `discovery.yaml`, `design.yaml`,
  `squad.yaml` e party (onda 1), `pipeline.yaml` (onda 2) e de cada agente, task e step (onda 3).
  Devolve Design, Step A, as três ondas, o Build e a criação inteira em minutos, mais o modo
  inferido da onda 3. Nenhuma linha de prompt mudou.

  **O guard nasceu de um número inventado.** A primeira versão, rodada no `peca-modelo` do
  próprio repositório, disse "Build: 2,6 min · Onda 3: 1658 min" — um checkout carrega mtimes de
  commits diferentes, e o `design.yaml` era mais novo que o `pipeline.yaml`. Uniformidade não
  basta como critério; o que descreve uma criação é a **ordem**: os marcos só podem crescer. Um
  marco mais novo que o seguinte é impossível numa criação e denuncia cópia, checkout ou
  restauração. Nesses casos — uniforme, fora de ordem, ou onda 3 espalhada por mais de 6 horas —
  o script devolve `confiavel: false` com o motivo, **nenhuma duração** e só o inventário. É a
  regra do `run-metricas` ("ausência de medida é `null`, nunca zero inventado") com a cara que
  ela tem quando a fonte é carimbo de arquivo. O fixture do repositório é caso de teste: tem de
  sair não confiável.

  **A regravação do Step C não derruba mais a medição.** A revisão independente derrubou a
  primeira versão com uma sonda: as famílias mais frequentes do C.1 (`agents-fora-do-squad-yaml`,
  `on-reject-invalido`, `input-sem-produtor`…) regravam o `squad.yaml` e o `pipeline.yaml`
  **depois** da onda 3 inteira, e a criação mais comum — a que passou por uma correção de YAML —
  saía "fora de ordem" e não media nada; a tabela da BASELINE ficaria vazia. O primeiro conserto
  apostou no `birthtime` (o `fs.writeFile` do Node regrava no mesmo inode e o nascimento
  sobrevive) e caiu no primeiro build medido, em 08/09/2026: a Write/Edit do Claude Code
  **recria o arquivo** — os três regravados no C.2 saíram com birthtime igual ao mtime, na hora
  da regravação — e dois `pipeline/data/*.md` regravados bastaram para a cadeia quebrar. A regra
  que ficou é de **ordem**, não de inode: a cada quebra da cadeia canônica sai o arquivo mais novo
  do grupo que ficou novo demais, até a cadeia fechar (no máximo um quarto dos arquivos). Sai
  assim tanto a regravação do Step C, no fim, quanto uma limpeza em lote no meio — o segundo
  build medido regravou os cinco `pipeline/data/*.md` e o `pipeline.yaml` num `sed` só, antes
  da onda 3, e "descascar os mais novos" não alcançava. A geração se mede pelo que ficou, e a
  regravação se mede à parte, até a última gravação — que é o fim de fato do Build, e sai como
  "Regravados no Step C". Squad copiado ou vindo de checkout não passa por aí: é uniforme (com ou
  sem edições por cima), ou está embaralhado além do que uma correção explica. O `birthtime` ficou
  como sinal extra, onde o escritor preserva o inode. Regravação que não quebra a ordem continua
  invisível; separar isso de verdade pede um ledger de marcos gravado pelo Build, que é a próxima
  medida, não esta.
  Gravação a mais de uma hora do último arquivo gerado não é Step C, é `/legalsquad edit` ou o
  usuário ajustando um arquivo: fica fora da medição, com aviso. O que os carimbos não separam,
  e o relatório diz: um agente regravado no C.2 de um gerado por último — a onda 3 inclui a
  regravação dos próprios arquivos, se houver.

  Da mesma revisão, mais três: a regra das 6 horas valia só para a onda 3, e um Design retomado
  dias depois entrava na tabela como "Design: 2880 min" — agora toda fase com mais de 6 h entre
  os carimbos sai `null` com um aviso nomeando-a, sem derrubar as outras; o modo da onda 3 era
  inferido pelo "maior lote em 30 s", que exige dois terços dos arquivos no mesmo lote e ficava
  "indeterminado" no fan-out que existia para detectar (com tasks no mesmo worker, as conclusões
  se espalham por minutos) — passa a exigir que dois sinais concordem, a **vazão** (menos de 0,5
  min/arquivo, metade do ritmo serial) e a **rajada** (a maioria das chegadas a menos de 30 s da
  anterior), e um só dos dois é "indeterminado", que é a resposta honesta; e 2 s arredondados
  saíam como "0 min", visualmente iguais ao zero inventado que a regra proíbe — saem como
  "< 0,1 min". A janela de 30 s é metade do ritmo serial de propósito (o round-trip
  `utimes → mtimeMs → ISO` devolve 59 999 ms para um gap de um minuto; com 60 s o serial passava
  por lote).

- **`legalsquad eval-init` — o caminho de migração que faltava para squad antigo.** O `check-squad`
  exige `_evals/scores.md` e ao menos um caso em `_evals/casos/`, e a exigência é boa: sem log não
  há regressão a detectar, sem caso-ouro a avaliação não é repetível. Mas ela chegou depois de muita
  gente já ter squads escritos, e o `update` preserva `squads/` — corretamente, é conteúdo do
  usuário. O resultado eram **dois erros por squad antigo, sem saída**: num projeto real de cliente,
  oito erros em quatro squads que nenhum comando resolvia. Gate que reprova sem dar caminho ensina a
  conviver com vermelho, e vermelho a que se convive deixa de ser lido.

  `npx legalsquad eval-init` semeia o harness. Sem argumento, varre `squads/` e trata só quem
  precisa. É idempotente: nunca sobrescreve, e avaliação já registrada não se perde.

  **A divisão de trabalho é o ponto.** A RUBRICA ele deriva do que o squad já declara — `goal` e
  `success_criteria` estão no `squad.yaml` e são exatamente os critérios que o `avaliador-squad`
  usa. O INPUT fictício ele **se recusa** a inventar: fica marcado `[PREENCHER]`, e o arquivo abre
  dizendo que ainda não é utilizável. Caso-ouro com fato inventado por máquina é pior que caso-ouro
  nenhum, porque dá a impressão de que a avaliação mede alguma coisa. O CLI conta os marcadores
  restantes e diz isso em voz alta.

  As duas mensagens de erro passam a nomear o comando, com o code do squad já preenchido.

### Alterado

- **O Build passa a saber o que ler e o que não ler antes de escrever — e o prompt passa a trazer
  o contrato do runner e dos hooks.** Medido em 08/09/2026 num build real: antes da primeira
  gravação o Build leu 276 KB em 45 chamadas — o prompt inteiro, os 25 arquivos do squad-modelo
  (agentes-stub de 3 KB), metade do runner e **43 KB do código dos dois hooks**, para descobrir o
  que o Redação Gate e o Citation Gate reprovam — e levou nove minutos para começar. O "## Context
  Loading" ganhou um plano de leitura explícito (do modelo, só `squad.yaml`, `pipeline.yaml`, um
  agente, um step e os checkpoints; do runner, nada; dos hooks, nunca o código; `CLAUDE.md`,
  `_evals/` e `demo-squad` fora) e um bloco "O que o runner e os hooks cobram", transcrito das
  fontes: as três frases literais do `intake` e o `cobertura-acervo`; o que as paradas
  `diagnostico` e `aprovacao` mostram (tela com fonte por linha, `empacotar.mjs --run` e seu
  fallback, a ordem das fontes de "O que o juiz lê primeiro", as quatro opções, o `contraditor`
  oferecido e nunca automático, memória agrupada); o arquivo de checkpoint; o ledger e quem o roda
  (o runner, nunca o agente); os caminhos resolvidos por `run_id`; os seis sinais do Redação Gate
  com os padrões que o hook conta; o escopo dos dois hooks; o que o empacotador trata como
  entrega; os campos ISO/https do manifesto; e a string que reprova sozinha no C.1.

  Três builds até chegar lá, todos com a régua do C.2 aplicada por auditor independente contra o
  serial. A primeira versão do bloco (T4) cortou tokens e **custou qualidade** — 9 OK · 7 PARCIAL
  · 3 FALHA contra 19 · 0 · 0: correta no que afirmava, incompleta no que omitia (paradas
  `diagnostico`/`aprovacao`, arquivo de checkpoint, quem roda o ledger, classificação de "final"
  do hook). A segunda (T5) chegou a um degrau (16 · 2 · 1 contra 18 · 1 · 0), com um erro grave
  meu: mandar a peça final para `output/final/`, subpasta que o `empacotar.mjs` não varre — com a
  peça ali, ele embrulharia o `foco.md` como entrega. A terceira (T6) deu **19 · 0 · 0 contra
  15 · 4 · 0**, com o serial perdendo pontos por ter copiado "contraditor automático" de um
  `contraditor.md` que contradiz o runner. Custo medido (T6 contra o serial): 94 requisições
  contra 157 (−40%), contexto médio por requisição 232 K contra 282 K, cache lido −49%, cache
  criado −75%, saída −10%; parede igual dentro da variação — a onda 3 em série (~24 min) é
  limitada pela velocidade de saída do modelo, e o contexto não a muda. As três omissões que o
  último auditor apontou (padrões de vício do hook, semântica de `cobertura`, predicado do
  empacotador) entraram depois da medição, como transcrição literal do código, sem novo build.
  Nenhuma regra saiu do prompt; entraram as que faltavam nele. Os 159 testes que leem o prompt
  seguem verdes; detalhe por build em `BASELINE-2026-09.md` (T4 a T6).

- **Onda 3 do Build ganha um modo paralelo, opt-in, por fan-out de subagentes — e a proibição
  antiga ganha o escopo que ela sempre teve.** O Step B é o bloco mais caro da criação (16 a 18
  min medidos, ~75% do Build, 15 a 24 arquivos a ~1 min cada, em série), e é onde o cliente sente
  a lentidão. A única tentativa de paralelizá-lo foi revertida na 0.6.1, e o prompt passou a
  proibir "emitir a onda 3 em paralelo". Lido de novo, o que aquele teste mediu foi **um agente
  emitindo N arquivos numa mensagem** — estourou o limite de saída, truncou, travou. Não mediu N
  subagentes independentes, cada um com o próprio orçamento de saída: a forma que a Investigation
  já usa (um por perfil) e que o runner usa na fase zero. A proibição estava certa no fato e ampla
  demais no escopo, e bloqueava exatamente o que nunca foi testado.

  O modo novo só liga com a linha literal `- **Build paralelo (onda 3):** sim` em
  `_legalsquad/_memory/preferences.md` — arquivo que o Build já carrega, que o `init` nunca
  sobrescreve depois de existir, que o `update` preserva e cujo parser ignora bullets que não
  conhece. Sem a linha, o texto do modo padrão continua mandando gerar um de cada vez, sem mudar
  uma vírgula. Com ela, depois das ondas 1 e 2 (que congelam elenco e topologia e por isso não
  se paralelizam), o Build despacha um subagente por `.agent.md` (tasks no mesmo worker, porque
  `tasks:` e os arquivos de task nascem juntos) e um por step de agente, no mesmo tier do Build
  (`inherit`, não `fast` — worker barato gera agente descritivo), cada um lendo só as seções de
  formato por título. Checkpoints ficam de fora, gerados em série como hoje. Fan-in por comando:
  arquivo faltando cai para o serial naquele arquivo, worker que falha não derruba o build, e o
  Step C roda exatamente igual — o `check-squad` valida o resultado, não o processo. Se a
  plataforma recusar o segundo nível de subagente, o Build volta ao padrão e diz.

  O ganho é tempo de parede; o custo é tokens (o próprio plano registra "três a dez vezes") e um
  C.2 mais caro — são N arquivos que o Build não escreveu e precisa ler por inteiro; é custo do
  modo, e entra na conta. Quem decide se o modo vira padrão é a medição do `build-metricas`
  (Fase 0), não a promessa — `tests/build-onda3-paralela.test.js` prende o opt-in, o padrão
  serial, a lição preservada e a queda para o serial, para que nenhum dos quatro suma numa edição
  futura.

  **O brief do worker, corrigido pela revisão independente antes do primeiro build medido.** A
  primeira redação mandava o worker de step ler "Pipeline Step Format" — e os requisitos por tipo
  de step (o `[NÃO VERIFICADO]` da pesquisa, o bloco `verdict/fixes` e o `verificador-citacoes`
  da revisão, o `on_reject`, a memória do chefe) moram numa seção separada, "Requisitos jurídicos
  do step", que o worker nunca via: cada step de peça voltaria incompleto, o C.1 acusaria
  (`revisao-sem-veredito`, `pesquisa-sem-citation-gate`…) e a reescrita em série comeria o ganho.
  Ela entrou na lista, junto com as "Content squad rules" para squad de conteúdo. O worker de
  agente recebia só a linha do party e não tinha como cumprir a coerência frontmatter × tier que
  o C.2 cobra (o `model:` dos steps que ele executa está no `pipeline.yaml`); o worker de step
  não via o predecessor nem o produtor dos seus inputs — todo worker passa a receber o
  `pipeline.yaml` inteiro, já normalizado. E três buracos de mecanismo: o despacho tem de ser
  **numa única mensagem com N `Task`** (um por turno re-serializa a onda), em **contexto fresco,
  nunca `fork`** (o fork herda a conversa do Build, anula a economia de ler só as seções pedidas
  e pode sair agindo como o Build), e o fan-in lista o que apareceu **a mais** em `agents/` e
  `pipeline/steps/`, porque nada no `check-squad` acusa `.agent.md` órfão. O resumo do Step D
  ganha, só neste modo, a linha "Onda 3: paralela (N workers; M caíram para o serial)".

  **Medido em 08/09/2026, dois builds do mesmo design (8 agentes, 11 steps), um em cada modo — e
  o modo fica opt-in, porque não ganhou nada.** Onda 3 em série: 23,3 min (1,33 min/arquivo). Onda
  3 em paralelo: 23,0 min pelos `date` do próprio Build, do despacho ao fim do fan-in. Empate,
  por três razões que o transcript mostra: o Build gastou 6,5 min só para **escrever** 16 briefs
  de 5 a 9 KB (118 KB de prompt gerado em série), o despacho **não coube numa mensagem** (13
  workers na primeira, os 3 steps pesados numa segunda, depois de esperar a primeira leva), e
  cada worker levou de 2,7 a 8,0 min (média 5,7) por arquivo, contra 1,3 do serial — o contexto
  fresco relê design, discovery, company, best-practices, pipeline e as seções do prompt antes de
  escrever uma linha. A vazão empatou (1,39 min/arquivo). O que o modo entregou de bom: o
  `check-squad` saiu limpo sem correção nenhuma, o C.2 editou um único agente, e a onda chegou
  fora da ordem do party — assinatura de workers de verdade. O que custou: 2,8× os tokens de
  saída, 5× o cache criado e 3,7× as requisições do serial, e o limite da sessão; e, na
  auditoria com a régua do C.2, 4 arquivos com defeito bloqueante e 4 a alinhar (peça-modelo com
  travessão e placeholder, manifesto do Citation Gate sem dono, opções de checkpoint inventadas,
  pares step × agente divergentes) contra uma edição cosmética no serial — coerência entre
  arquivos e com o motor é o que worker isolado não paga. Detalhe por worker e por arquivo na
  `BASELINE-2026-09.md`. A hipótese seguinte foi brief curto apontando para um arquivo compartilhado,
  workers agrupados (um por 3 a 4 arquivos) e um despacho que coubesse numa mensagem.

  **Segunda forma, medida em 09/09/2026 — grupos e brief compartilhado — e o veredito final.** A
  hipótese foi testada tal qual: um brief de 27,5 KB gravado uma vez em `_build/onda3-brief.md`
  (com o que o worker não veria sozinho — as frases literais do checkpoint, o dono do manifesto,
  zero travessão, o caso fictício único — e o `pipeline.yaml` inteiro), 4 grupos de 4 arquivos
  (agente + seu step, dois pares por grupo) despachados numa única mensagem com prompts de 2 a
  3 KB. Mecanicamente, tudo o que a primeira forma errou saiu certo: uma mensagem, 0 queda para
  o serial, `check-squad` limpo, C.2 sem correção. E a onda 3 levou **36 min** — pior que as
  duas anteriores — porque a parede é o worker mais lento (34,8 min para 4 arquivos): cada um lê
  ~60 KB antes de escrever, escreve 70% mais texto que o Build serial para o mesmo design (347 KB
  contra 205 KB nos 16 arquivos) e revisa os próprios arquivos; e custou 3× os tokens de saída de
  novo. Dois experimentos, o mesmo teto: o custo fixo de um contexto fresco é da ordem do que o
  Build serial gasta escrevendo oito arquivos com o contexto quente, e nenhum arranjo de fan-out
  muda isso. O bloco opt-in fica com a segunda forma (a mecânica correta, para quem quiser medir
  uma variante nova), com o veredito escrito no próprio prompt: **não recomendado**. A velocidade
  tem de vir de menos texto por arquivo ou de clonar-e-adaptar o squad-modelo quando o desenho é
  o mesmo tipo de peça — hipóteses a medir com a mesma régua.

  **O que a segunda forma ganhou, e vale sem o fan-out.** Na auditoria com a régua do C.2, o
  squad agrupado saiu, sem nenhuma correção, **acima** do serial já corrigido (17 OK · 2 PARCIAL
  · 0 FALHA contra 13 · 6 · 0): um único caso fictício atravessando os 19 arquivos, com as mesmas
  citações da pesquisa ao manifesto e os mesmos fixes da revisão ao redator; formato idêntico nos
  oito pares step × agente; as frases literais do runner; o manifesto com dono; zero placeholder
  na peça. Os cinco defeitos do worker-por-arquivo sumiram. A causa não é o paralelismo, é o
  **brief compartilhado**, que fixa o contrato da onda antes de qualquer arquivo nascer — e um
  brief o Build serial pode escrever para si mesmo, por 3 min, antes da onda 3. É a hipótese que
  sobra deste ciclo, registrada na `BASELINE-2026-09.md`.


### Corrigido

- **O `contraditor.md` dizia o contrário do runner sobre quando roda.** O arquivo do subagente (e
  suas cópias no template do Claude Code, no plugin gerado e no Codex) afirmava que o contraditor
  roda "automaticamente, uma vez, antes do Citation Gate final, quando `meta_verifiers ≥ 3`" e que
  "o revisor (automático)" decide o que fazer com a tabela. O runner diz o oposto desde que o
  red-team virou oferta: "NUNCA por disparo automático" — com `meta_verifiers ≥ 3` o chefe
  **oferece** o contraditor na parada `aprovacao`, diz o custo e o ganho, e só despacha com o
  "sim", uma vez por run. Duas auditorias independentes de squads gerados pelo Build (09/09/2026,
  `BASELINE-2026-09.md`, T5 e T6) acharam a contradição pelo efeito: o Build serial, que leu o
  arquivo do agente, copiou "contraditor automático" em sete lugares do squad — e o Build de
  contexto enxuto, que leu só o prompt, acertou. O runner é a prosa executada e a fonte de verdade;
  o agente passa a dizer o mesmo, nas quatro cópias, com a description reescrita e uma âncora em
  `tests/mike-voz.test.js` que prende a regra nas quatro e a proibição no runner.

## [0.6.1] - 2026-09-04

### Corrigido

- **O Redação Gate bloqueava a gravação da peça em TODA instalação.** O hook `verifica-redacao.mjs`
  carregava a decisão por import dinâmico de `src/redacao-gate.js`, tentando dois caminhos:
  `legalsquad/src/redacao-gate.js` (só resolve com o pacote em `node_modules`, e o aluno instala
  global) e `../../src/redacao-gate.js` (aponta para `{projeto}/src/`, que não existe). Os dois
  falhavam, e o gate caía no fail-closed — que é o comportamento certo para um gate que não consegue
  carregar a própria lógica, e que aqui significava **"REDAÇÃO GATE — BLOQUEADO"** em cima de toda
  peça, em todo projeto.

  É o mesmo defeito do `cobertura-acervo`, e o motor já tinha o mecanismo. As 452 linhas de
  `src/redacao-gate.js` — módulo puro, sem imports — viram o bloco sincronizado `redacao-gate`,
  copiado verbatim para os hooks do Claude Code e do Codex. São 7 blocos e 14 cópias, guardados pela
  suíte: divergir passa a quebrar o `check:blocos`.

  Achado por um usuário ao rodar `/legalsquad atualizar` num projeto real — não por teste nosso.

### Alterado

- **Step B do `build.prompt.md` passa a declarar a ordem de geração em três ondas** — alicerce
  (`squad.yaml` e party), topologia (`pipeline.yaml`), e só então os agentes e os steps. O que a
  onda anterior fixa, a seguinte consome.

  **A tentativa de paralelizar a onda 3 foi revertida, e o prompt agora proíbe explicitamente
  refazê-la.** A hipótese era que o minuto por arquivo fosse ida e volta de turno; o build cego
  mediu o contrário. Emitir N arquivos numa mensagem estoura o limite de saída: a mensagem é
  truncada, e o run trava. No teste, três arquivos saíram no ritmo serial de sempre, seguiram treze
  minutos de silêncio e o build morreu sem terminar. O custo é tempo de GERAR duzentas linhas, e
  esse não se comprime empacotando chamadas.

## [0.6.0] - 2026-09-04

### Corrigido

- **O squad-modelo contradizia o prompt que manda espelhá-lo.** O `build.prompt.md` diz "espelhe os
  agentes de um squad-modelo de peça já presente"; o `peca-modelo` distribuído trazia steps com
  frontmatter sem `agent:`, `execution:` nem `outputFile:`, e corpo com apenas duas seções
  (`## Para o Pipeline Runner` e `## Ação`) contra as sete que o Arquiteto tem de escrever. Ele
  escapava porque não tinha `_build/`, e a isenção dos Gates 1, 1b e 2 para squad escrito à mão é
  deliberada. **O defeito não era a isenção: era mandar espelhar um squad isento de regras que quem
  espelha tem de cumprir.** Um build cego mediu o custo — o agente teve de escolher entre o prompt e
  o modelo, e só acertou por ler com cuidado; um Arquiteto mais literal entregaria step sem seção.

  Os 11 steps foram regerados no formato do Arquiteto, com conteúdo real em cada seção (Context
  Loading nomeando os artefatos por caminho, Veto Conditions e Quality Criteria próprios de cada
  step). A fixture ganhou `_build/design.yaml`, de modo que os gates de seção passam a cobrar o
  modelo e a divergência vira falha de suíte. O `_build/` não viaja para `templates/`: o exemplo
  distribuído continua sendo squad editável, agora demonstrando o formato certo.

  Junto: `sync-templates-squads` passou a esvaziar também o `skills:` do frontmatter dos agentes.
  Sem isso, o exemplo distribuído declarava skills `demo-*` que a instalação nova não tem, e o
  primeiro `check-squad` do usuário devolvia `skill-declarada-inexistente` (erro).

- **O Citation Gate era conferido no squad inteiro, não onde a citação nasce.** Bastava
  `[NÃO VERIFICADO]` aparecer em qualquer arquivo. Provado num build cego: removidos os marcadores
  do step de redação, o squad seguia `✓ estrutura íntegra` porque a palavra sobrevivia noutro canto.
  Num squad cujo design não pediu step de pesquisa — e o `build.prompt.md` manda não criar o que o
  design não pede — isso significa peça jurídica gerada **sem disciplina de citação nenhuma**, e
  aprovada. Passa a ser cobrado na cadeia: o step que redige, o agente dele e os steps que o
  alimentam. O squad-modelo, que carrega a marca no step de pesquisa, continua correto.

- **O `build.prompt.md` quase induzia o erro `comando-da-cli-inexistente`.** A seção do Step de
  PESQUISA mandava ler o escopo autorizado "com `run-status`", solto, sem dizer como invocá-lo — e
  `npx legalsquad run-status` não existe. Foi essa linha que fez um Arquiteto escrever o comando
  inválido num squad real. Agora o prompt dá a forma correta, diz com todas as letras que é script e
  não subcomando, e a regra entrou na tabela do Step C.1.

- **Reindexar não via a conversão feita depois.** `indexar-autos` reaproveita a entrada quando o PDF
  não mudou — e a conversão para Markdown roda DEPOIS do índice, que é a ordem natural (indexar para
  saber o que há, converter em seguida). A entrada voltava do cache com `markdown: null`, o ponteiro
  nunca aparecia, e o agente seguia abrindo o PDF com o Markdown pronto ao lado. O cache passa a
  reagir à presença da conversão.

- **`files` do package.json tinha precedência sobre o `.npmignore`, e bytecode Python entrava no
  tarball.** O `.npmignore` já excluía `__pycache__/` e `*.pyc`, mas o whitelist `files` inclui
  `scripts/` inteiro e vence. Com o primeiro script `.py` do motor o teste de higiene do tarball
  acusou; o whitelist ganhou as negações explícitas.

### Alterado

- **O `contraditor` deixa de ser disparo automático e passa a ser oferta no checkpoint.** Com
  `meta_verifiers >= 3`, o runner o despachava sozinho antes do Citation Gate final. Ele custa um
  ciclo inteiro de subagente, e o tempo do run é do profissional que está esperando, não do motor.
  Agora o chefe **oferece** no checkpoint de aprovação, dizendo o custo e o que se ganha, e só
  despacha com o sim. Continua uma vez por run, com a memória no disco (`test -s
  .../contraditor.md`), e continua sem votar: ele gera os ataques, quem decide o que fazer com eles
  é o profissional. Pedido do usuário depois de sentir o custo num run real.

### Adicionado

- **O arquivo que se declara interno no cabeçalho deixa de contar como entrega.** A lista de nomes
  internos (`revisao`, `intake`, `foco`…) é corrida perdida: cada squad inventa nomes novos. Num run
  real, `contraditor.md` entrou na contagem de pendências da ENTREGA, e o arquivo de pendências
  internas — o que carrega a avaliação de risco da própria tese e que, protocolado, é confissão —
  **disputou com a peça a escolha do empacotador**. Só não foi embrulhado no lugar dela porque havia
  dois candidatos e o empacotador recusou por ambiguidade; com um só, teria entregado o errado.
  Agora `ehArtefatoDeEntrega` aceita o texto e honra a marca no cabeçalho ("NÃO PROTOCOLAR",
  "Documento interno do run", "uso interno do escritório"). A marca só EXCLUI, nunca inclui, e vale
  só nas primeiras linhas. Nome é convenção; a declaração do autor é fato.

  Junto: `escolherArtefato` passou a usar **um predicado só** para eleger a pasta e para listar
  dentro dela. Com dois, ele elegia a pasta pelo nome e a esvaziava pelo conteúdo, respondendo
  "nenhum artefato de entrega" numa pasta que acabara de eleger por ter um.

- **`comando-da-cli-inexistente` (error).** Rodando um squad real de mandado de segurança, o step de
  pesquisa mandava ler o escopo do ledger com `npx legalsquad run-status`. **O comando não existe** —
  o runner do motor manda `node scripts/squad-state.mjs run-status`, e o Arquiteto inventou a forma
  da CLI. A falha é quase muda: imprime o banner de ajuda. O agente daquele run percebeu e caiu para
  o artefato do checkpoint, mas um menos cuidadoso teria seguido com escopo vazio sem saber por quê.
  Um step é lei para quem o executa. O validador passa a conferir todo `npx legalsquad <sub>` citado
  em step ou agente contra os subcomandos que a CLI realmente tem, e um teste cobra a paridade entre
  essa lista e o `HELP` de `bin/legalsquad.js` — cópia que ninguém confere envelhece em silêncio.

- **Seis gates que o `build.prompt.md` prometia e o validador não cobrava.** Achados por uma bateria
  de 18 avarias controladas sobre um squad real de mandado de segurança — o `check-squad` respondia
  `✓ estrutura íntegra` a todas.

  1. **`revisao-sem-verificador-citacoes` media vocabulário, não wiring.** Bastava a palavra
     `verificador-citacoes` aparecer em QUALQUER step ou agente. Provado em campo: uma menção dentro
     de um comentário no step de **intake** — que não revisa nada — satisfazia o gate com o revisor
     já sem acionar o verificador. Agora o acionamento é cobrado de quem revisa: o step revisor ou o
     arquivo do agente dele.
  2. **`revisao-nao-isolada` lia só o `squad-party.csv`.** Um step com `execution: inline` no
     frontmatter derrubava o isolamento anti-viés em silêncio. Passa a ler as duas fontes,
     fail-closed (basta uma dizer que não é subagente), e a divergência entre elas virou aviso
     próprio: `revisao-execucao-divergente`.
  3. **`output-fora-do-escopo-do-run` (error).** O prompt escreve "NEVER use `pipeline/data/` for
     outputFile" porque só sob `output/` o runner aplica o escopo por `run_id`. Gravar fora contorna
     o escopo e dois runs simultâneos se sobrescrevem — regra escrita, nunca conferida.
  4. **`aprovacao-sem-registro`.** O checkpoint de aprovação sem `outputFile` nem artefato não grava
     nada: a autorização humana da entrega fica sem rastro de quem aprovou o quê. O prompt já
     avisava em caixa; faltava o código.
  5. **`agente-sem-step`.** Agente no elenco que nenhum step aciona. O inverso já era erro; este
     lado ficava mudo, e elenco fantasma engana quem lê o squad.
  6. **`tier-do-step-contradiz-o-agente`.** O prompt define o mapa (`powerful` → opus/xhigh,
     `fast` → haiku/low) e diz que declarar um e escrever outro faz "o frontmatter mentir". Um step
     `powerful` com o agente em `haiku` passava limpo.

  Silenciosos nos cinco squads reais testados.

- **`scripts/autos-para-md.py` — os autos viram Markdown uma vez, não a cada step.** O
  `indexar-autos.mjs` inventaria a pasta e extrai texto cru com `pdftotext`: serve ao índice, mas
  deixa o agente reabrindo o PDF a cada step — 700 folhas relidas por step — e **não vê** as páginas
  sem camada de texto. Num processo real de 707 folhas eram **73** invisíveis. O conversor (PyMuPDF
  + `pymupdf4llm`, com OCR por tesseract) grava `autos/_md/<slug>/documento.md` com cada folha
  ancorada em `## fls. N`, e `indexar-autos` passa a apontar o arquivo no campo `markdown` do índice.
  Citar folha vira `grep`, não memória.

  **Em blocos de 25 folhas, não o documento inteiro.** Chamado de uma vez sobre as 707 folhas, o
  extrator ficou 10 minutos sem devolver nada: nenhum progresso, memória crescendo, e um erro no fim
  jogaria fora o trabalho todo. Processo de centenas de folhas é o caso NORMAL deste domínio. Bloco
  que falha cai para texto simples só naquele trecho e o run segue — com a degradação registrada
  folha a folha no manifesto, nunca silenciosa.

  **E sem o OCR de figura por padrão.** Medido no mesmo bloco de 25 folhas do processo real: 63,4 s
  com imagens contra 25,2 s sem — e os dois devolveram **94.952 caracteres**, a mesma saída. O que o
  caminho caro acrescenta é o texto dentro de figura numa folha que já tem camada de texto; as
  folhas que só têm imagem seguem cobertas, porque são exatamente as que o script manda ao OCR por
  conta própria, com a procedência marcada. `--com-imagens` restaura o caminho caro.

  **A imagem de conferência sai em JPEG.** Ela existe para o profissional CONFERIR o que o OCR leu,
  não para arquivar fac-símile. Em PNG a 220 dpi, as 73 folhas escaneadas de um processo real
  pesaram 151 MB — mais do que o PDF inteiro — dentro da pasta do squad, que é copiada e
  versionada. Em JPEG a 200 dpi lê igual e cabe em cerca de um sexto: medido num segundo caso, 377
  folhas com 42 de OCR couberam em 17 MB.

  **Procedência é medida, não presumida** — e a primeira versão deste script errou exatamente aí:
  o `pymupdf4llm` roda OCR por conta própria nas páginas escaneadas e devolve o texto sem dizer de
  onde veio, e 73 folhas reconhecidas por máquina saíram carimbadas como `nativo`. Agora a camada de
  texto do PDF é lida ANTES de qualquer extração e é ela que decide: `nativo`, `ocr` (com o aviso
  folha a folha e o PNG ao lado, para conferir antes de citar) ou `vazia` (nada reconhecido — nunca
  se inventa conteúdo). Afirmar procedência que não se verificou é o erro do Citation Gate uma
  camada abaixo.

- **Paridade `scripts/` ↔ `templates/scripts/` por VARREDURA.** Os testes de espelho eram um por
  arquivo, escritos à mão: script novo nos dois lados não ganhava teste até alguém lembrar — e
  "lembrar" é o que a paridade existe para não depender. Agora um teste varre o par e cobra todo
  arquivo presente dos dois lados, inclusive os que ainda não nasceram.

- **`build.prompt.md`: as seis lacunas que um build CEGO expôs.** Um Arquiteto construiu o mesmo
  squad proibido de abrir `src/squad-check.js` — como faz qualquer usuário de `/legalsquad create`.
  Veredito: o prompt basta para a parte difícil (doutrina de agentes, gates, fase zero) e falha na
  **sintaxe dos artefatos estruturais**, justamente os que o validador reprova por código. Ele só
  passou porque foi ler `templates/squads/peca-modelo/` no motor — caminho que o prompt nunca
  nomeia e que a casa do projeto não tem instalado. Agora estão escritos: o esqueleto completo do
  `pipeline.yaml` (era "Pipeline entry point", uma linha, para um arquivo que o `check-squad`
  confere campo a campo), o bloco `agents:` do `squad.yaml` (só denunciado pelo nome de um código de
  erro), o cabeçalho do `squad-party.csv`, a regra do nome aliterado no lugar onde o nome é escrito,
  e o caminho do squad-modelo. A sexta era a única que quebra o RUN e não a validação: sem `autos/`,
  a fase zero tem de apontar o `inputFile` para `output/intake.md` — o runner para o step quando o
  arquivo não existe, e nenhum gate de design-time vê isso.

- **`parallel_group`: a independência dos irmãos passa a ser conferida.** O `build.prompt.md` define
  o grupo paralelo como "só para `execution: subagent` INDEPENDENTES (sem `depends_on` entre si, sem
  o mesmo `outputFile`)" — regra escrita e nunca implementada. Quebrando um squad real de propósito,
  as duas avarias saíam com `✓ estrutura íntegra`: um step esperando por um irmão que roda ao mesmo
  tempo (corrida — o arquivo pode não existir, ou ser o do run anterior) e dois irmãos gravando o
  mesmo `outputFile` (um sobrescreve o outro, e qual vence depende de quem terminar por último).
  Dois códigos novos, ambos `error`: `parallel-group-com-dependencia-interna` e
  `parallel-group-com-saida-colidente`.

- **`output-sem-consumidor` — o espelho de `input-sem-produtor`.** É a falha clássica da EDIÇÃO:
  acrescenta-se um agente, ele passa a gravar um artefato, ninguém o pluga a jusante, e o validador
  aprova. O critério é topológico, não por nome — quem não tem dependente é o fim do pipeline e
  legitimamente não tem leitor; quem tem, e mesmo assim não é lido por ninguém, produz trabalho que
  não chega a lugar nenhum. Aviso, não erro. Silencioso nas fixtures e em 4 dos 5 squads reais
  testados; o único achado é verdadeiro (um checkpoint que grava a decisão de aprovação do humano
  e o step seguinte nunca a lê).

### Corrigido

- **O Gate 1c reprovava agente instalado — e contradizia o instalador deste motor.**
  `especialista-nao-instalado` é ERROR e barra o squad; ele procurava o subagente só em
  `{projeto}/.claude/agents/`. Num projeto real o advogado tinha **38 agentes em
  `~/.claude/agents/`** (onde o `install-global` DESTE motor os põe) e 3 no projeto — e um
  `resumo-processo` instalado, funcional e acionado sem problema pelo runner era acusado de ausente.
  Passa a olhar os dois escopos, na ordem em que o harness resolve, e a mensagem diz onde procurou.
  Um gate que reprova o que funciona custa mais caro do que um gate que não roda: ensina a ignorá-lo.

- **`artefato-sem-produtor` e `input-sem-produtor` discordavam sobre quem produz um arquivo.** No
  mesmo arquivo, a dez linhas de distância: `input-sem-produtor` contava `outputFile` (frontmatter)
  **e** `output.artifacts`; `artefato-sem-produtor` contava só o segundo — e o desacordo sai como
  ERRO. Um step que declara a saída onde o formato de step do `build.prompt.md` manda declarar era
  acusado de não produzir nada. Os dois passam a contar as duas formas, com o caminho normalizado a
  partir de `output/` nos dois lados. É a mesma dívida do `check-squad` × `compilar-workflow`.

- **O squad-semente do `init` era reprovado pelo validador do próprio motor.** O `demo-squad` que
  toda instalação nova recebe declara `status: "placeholder"` e traz só o `squad.yaml`, de
  propósito. `check-squad demo-squad` — a primeira coisa que um usuário novo roda — devolvia quatro
  erros (goal, success_criteria, party, pipeline) sobre um arquivo que o instalador acabara de pôr
  ali e que se descreve como placeholder na linha 12. Agora é reconhecido: uma linha dizendo o que
  ele é e que `npx legalsquad update` o substitui pelo exemplo completo.

- **`empacotar` dizia que não havia `.md` com o `.md` à vista na pasta.** `ehArtefatoDeEntrega`
  recusa nome de rascunho (`minuta`, `rascunho`, `draft`) e de peça interna (`revisao`, `intake`,
  `foco`, `diagnostico`…) — e faz certo, é trabalho, não entrega. Só que "minuta" é como os prompts
  chamam a peça EM PROSA, então gravá-la como `minuta.md` é o erro natural de quem os leu, e a
  resposta era "nenhum artefato de entrega (.md) em …", mandando procurar o que não faltava. O erro
  passa a nomear os arquivos recusados, dizer que a recusa é por nome e dar a saída (renomear ou
  `--artefato`). Achado rodando o ciclo completo num install limpo do dist.

- **O Gate 1c inteiro nunca rodava, e o `check-squad` dizia "estrutura íntegra" mesmo assim.**
  `checarReusoDeEspecialistas` lia `specialist_agents` só de `_build/discovery.yaml`; o
  `build.prompt.md` manda escrever `_build/design.yaml`, e é o que o Arquiteto grava em campo.
  Rodado contra um squad real de 5 agentes com três especialistas declarados, o validador respondia
  verde sem ter conferido reuso nenhum — o pior tipo de verde, o que afirma o que não olhou. Passa a
  ler as duas fontes, e a mensagem nomeia qual delas escolheu o especialista. Achado ao construir um
  squad de verdade, não por leitura de código.

- **Um squad de peça sem os dois campos declarados escapava do Gate 4 INTEIRO.** A detecção de
  "entrega peça" tinha dois sinais, e ambos eram campos declarados (`citation_verifiers` e uma skill
  `delivery_type: legal-draft`). Quem esquecesse os dois não produzia sinal, saía da população dos
  checks de peça e recebia "estrutura íntegra" sem que veredito, revisor isolado, Citation Gate ou
  ética/sigilo tivessem sido conferidos uma única vez. Terceiro sinal, que não depende de ninguém
  declarar nada: acionar `verificador-citacoes` ou `verificador-persuasao` no pipeline — subagentes
  que só existem para entrega que cita fonte.

- **`success-criteria-insuficiente` mentia na causa.** O parser exigia exatamente dois espaços de
  indentação; a mesma rubrica escrita com quatro (YAML igualmente válido) ou inline virava
  "0 critério(s); esperado 3–6", acusando de não ter escrito a rubrica quem a tinha escrito. Passa a
  usar `listaDeTopo`, que lê qualquer indentação e a forma inline, e a mensagem de zero diz que não
  achou a lista. A faixa 3–6 continua igual.

- **Step fora da indentação do template era chamado de inexistente.** `parseSteps` ancora nas
  colunas do template e assim continua (ali a indentação é estrutural). Mas um step escrito noutra
  coluna sumia da lista e os checks de grafo o acusavam com `depends_on "step-03" não é um step` —
  mandando procurar o erro onde ele não está. `depends-on-invalido`, `on-reject-invalido`,
  `checkpoint-invalido` e `pipeline-sem-steps` passam a reconhecer o id presente no arquivo e a
  apontar a indentação. Continuam reprovando: o que o validador não lê, o runner não roda.

### Alterado

- **`build.prompt.md`: cinco contradições e ambiguidades que custaram retrabalho num build real.**
  (1) O `model_tier` do step listava "reviewer, writer, researcher → powerful" enquanto a seção de
  calibragem manda NÃO declarar `model:` nos steps de juízo; o bloco agora explica os dois valores,
  diz que omitir é a terceira opção e a mais comum, e registra que `model:` e `model_tier:` são
  sinônimos para o compilador. (2) "Corrija todo `✖` e todo `⚠` das famílias abaixo" deixava ler que
  só os erros tabelados contavam — agora diz que a tabela é guia de leitura, não a lista dos erros.
  (3) O teto de "máx 2 rodadas" era o mesmo texto em C.1 e C.2: agora são tetos separados, a rodada
  inicial não conta, e está escrito o que fazer quando sai limpo de primeira (seguir para C.2).
  (4) C.2 prometia "leia só os arquivos que estes itens pedem" e os itens pedem todos: a economia é
  ler menos DE CADA arquivo, e o texto agora diz isso. (5) A Fase zero exigia um `parallel_group` de
  quatro steps nomeados enquanto o Step A proíbe criar o que o design não pediu — o grupo passa a ter
  os steps que os agentes do design cobrem, com o que ficou sem dono indo para o report.

- **Um squad podia passar no `check-squad` e ser recusado pelo compilador.** O
  `tools/compilar-workflow.mjs` lê o bloco `agents:` do `squad.yaml` (MIKE-CHEFE §7); todo o resto
  do validador lê o `squad-party.csv`. Ninguém confrontava as duas fontes, e um squad real passava
  limpo aqui e morria lá com "agent «X» não está declarado em squad.yaml". O validador agora avisa,
  nomeando o compilador. Aviso, não erro: o run pelo runner não depende desse bloco.
- **A espera pelo humano era medida por sorteio.** `run-metricas` casava o carimbo do checkpoint
  (que usa o id do step) com o `label` do step no ledger, e o runner mandava passar em `--label` o
  "id **ou** rótulo". Com "step-01" a métrica media; com "Foco do Caso" devolvia "não medido"; e em
  `parallel_group`, onde o rótulo nunca é um id, era sempre imedível. É uma das quatro linhas do
  baseline da Fase 0. O ledger passa a carimbar `stepId` (novo `--step` no subcomando `step`), a
  junção é por id, o rótulo fica como heurística de compatibilidade, e o runner separa os dois
  campos. Achado ao instrumentar um run real.

- **A Fase 4 nunca empacotou um run real.** O runner grava por `squad-path` em
  `output/{run_id}/v{N}/arquivo.md` e chama `empacotar.mjs squads/{name} --run {run_id}` sem
  `--artefato`; o empacotador varria só a RAIZ de `output/`. Resultado: "nenhum artefato de entrega"
  em todo run que seguisse o runner — e, pior que falhar, um `.md` esquecido na raiz por um fluxo
  antigo faria empacotar a peça ERRADA em silêncio. A busca agora desce o run, da versão mais alta
  para a mais baixa, com a raiz por último (instalação anterior ao escopo por run continua
  funcionando). Achado ao empacotar uma contestação real.
- **`cobertura-acervo` estava morto em toda instalação.** O script que decide a pesquisa em camadas
  (Fase 3 — se o acervo local cobre o tema ou se vale buscar no tribunal) importava
  `../src/acervo-search.js`, caminho que só resolve no repositório do motor. No projeto do aluno,
  `ERR_MODULE_NOT_FOUND` na primeira chamada. A paridade byte a byte não pegava: as duas cópias eram
  idênticas **e as duas erradas para o destino**. O leitor do índice agora vem por bloco sincronizado
  (`acervo-index`, o sexto do `sync-blocos`), e dois testes prendem: o script não importa `src/`, e
  nenhum script distribuído ao aluno importa. Achado ao rodar um caso real.

### Corrigido

- **CI verde pela primeira vez.** Duas causas, em camadas. A primeira era o `engines: >=20` mentindo:
  o CI rodava Node 20, que não tem o zstd nativo do `node:zlib`, e a suíte inteira morria no import —
  resolvido na 0.5.6, que passou o CI para 22. A segunda ficou visível só depois: dois testes de
  `chefe --status` cobravam a saída do LaunchAgent do macOS através do bin de verdade, e no Linux o
  comando responde (corretamente) que não grava nem lê agendamento naquela plataforma. Os dois agora
  cobrem **as duas plataformas** — o invariante que vale em ambas (o horário padrão nunca é anunciado
  como se fosse o agendado) mais o que cada uma promete. É o que o cabeçalho do próprio arquivo já
  estabelecia para o núcleo, que recebe `plataforma` injetada para ser testado em qualquer máquina.

## [0.5.8] - 2026-09-03

## [0.5.8] - 2026-09-03

### Corrigido — o catálogo de evals não acompanhava as skills transversais

- **`skills/_evals/*.json` viaja com o pacote `transversal`**, como o catálogo de best-practices já
  fazia. O arquivo não mora sob nenhum id de skill, então caía inteiro no balde da área; num pacote
  100% transversal a área não é emitida e o catálogo sumia. Sem o caso, `eval_linked` reprova, a
  skill cai em hard fail e o resolvedor a bloqueia. Medido ao recontratar o `transversal` em
  03/09/2026: 70 skills publicadas com o contrato inteiro e **zero casos**, todas recusadas no
  runtime. Duplicar é inócuo — mesmos bytes, mesmo caminho, e o leitor já funde todo `.json` de
  `_evals/`.

## [0.5.7] - 2026-09-03

## [0.5.7] - 2026-09-03

### Corrigido — o catálogo de evals de cada área colidia, e isso bloqueava as skills

- **`skills/_evals/catalog-v5.json` viaja com o nome da área** (`catalog-v5.<area>.json`). Toda área
  trazia o seu catálogo de casos no MESMO caminho de instalação, e `pack-apply` escreve arquivo a
  arquivo: a última área instalada vencia e as outras sumiam. Diferente da colisão equivalente das
  best-practices (corrigida antes), esta não deixava a área só invisível para a busca — sem o caso de
  eval, `eval_linked` reprova, a skill cai em hard fail e **o resolvedor a bloqueia**. Medido numa
  instalação de aluno com as 11 áreas contratadas publicadas: 6.621 skills no disco, catálogo com 263
  casos e **252 skills executáveis**; as outras 6.369 recusadas com `structural-gate-failed`, apesar
  de o pacote trazer o contrato inteiro. O leitor já fundia todo `.json` de `_evals/`: só a escrita
  precisava do nome por área. Áreas precisam ser republicadas para a correção chegar ao aluno.

## [0.5.6] - 2026-09-03

## [0.5.6] - 2026-09-03

### As skills passam a ser executáveis, e o motor diz a verdade sobre o que exige

- **Node 22.15 ou mais novo, declarado.** O motor verifica pacotes com o zstd nativo do `node:zlib`,
  que só existe a partir dessa versão; `engines` dizia 20 e o aluno em Node 20 instalava sem erro e
  quebrava no primeiro `acervo sync`. `engines`, CI e README agora dizem 22.15.
- **`publish-pack` lê `ADMIN_SECRET` do ambiente.** Por flag, o segredo ficava no histórico do shell e
  na lista de processos. A flag continua aceita, com aviso.
- **Busca de skills 5× mais rápida.** `search-skills` relia todo `SKILL.md` a cada consulta: 2,3 s
  numa instalação de aluno (6.584 skills). Um cache do catálogo, gravado junto com o índice a cada
  `sync`/`indexar-skills`/`contract-skills`, derruba para 0,4 s com o mesmo resultado; skill
  adicionada ou removida à mão invalida o cache. O cache é local: nunca viaja no pacote nem no git.
- **Os squads-exemplo ensinam o formato canônico.** `demo-squad` e `peca-modelo` — os que toda
  instalação recebe — tinham agentes no formato legado `.custom.md` (overlay com `base_agent`), o
  que o `check-squad` reprova em squad do Arquiteto. Agora são `.agent.md` completos: todas as
  seções obrigatórias, `model`/`effort`/`maxTurns` calibrados. O gerador da fixture emite o mesmo.
- **A suíte deixou de sincronizar produção.** Um teste fazia um `sync` real contra o servidor — 35
  pacotes, 93 s de uma suíte de 93 s, e dependia de rede. A afirmação ("não pede licença") se prova
  com um servidor de fixture em 20 ms; o sync real fica opt-in (`LEGALSQUAD_TESTE_REDE=1`).

### Na curadoria (repositório de conteúdo, não no motor)

- **Contrato operacional v5 aplicado em 15 áreas.** Toda skill de pacote era recusada pelo resolvedor
  do motor (`structural-gate-failed`): sem bloco de contrato, sem `references/high-performance-contract.md`,
  sem `agents/openai.yaml`, sem caso de eval vinculado. Com o contrato, 6.500+ skills passam no gate;
  ficam bloqueadas 77 de perfil de cálculo sem motor determinístico declarado (lista no repositório de
  curadoria). Chega ao aluno quando os pacotes forem republicados.

### Documentação

- CLAUDE.md: o motor **embarca** as chaves públicas (anel), não "não embarca". Auditoria: M13 fechado.

## [0.5.5] - 2026-09-03

## [0.5.5] - 2026-09-03

### Rotação da chave de assinatura — o motor confia num anel

- **A privada `prod-2026-07` foi perdida** (formatação de máquina). Os 35 pacotes no ar continuam
  verificáveis pela pública, que não se perde; mas nada novo podia ser assinado. O motor passa a
  confiar num **anel** (`CHAVES_PUBLICAS_PRODUCAO`): `prod-2026-07` para o que está publicado,
  `prod-2026-09` para o que vem. O `sync` escolhe pela `signing_kid` do manifesto; pacote sem kid
  (os de 2026.08.14) é tentado contra cada chave; kid que o anel não conhece é recusado com a causa
  certa — "atualize o LegalSquad" — e nunca como adulteração. Chave própria por arquivo continua
  substituindo o anel inteiro.
- **Quem está em 0.5.4 ou anterior** verá os pacotes novos recusados com essa mensagem até
  atualizar. Nada é apagado: o pacote antigo continua instalado.

## [0.5.4] - 2026-09-03

## [0.5.4] - 2026-09-03

### Corrigido

- **`update` também semeia o squad-exemplo que falta.** A 0.5.2 trocava o placeholder do
  `demo-squad`, mas quem instalou antes do `peca-modelo` existir não o recebia — `squads/` é do
  usuário e o update não o toca. Seed do motor AUSENTE agora entra inteiro; placeholder é substituído
  com backup; squad com qualquer outro `squad.yaml` continua intocado.

## [0.5.3] - 2026-09-03

## [0.5.3] - 2026-09-03

### Corrigido

- **`check-squad` lia a lista `checkpoints:` como vazia quando cada parada vinha explicada na própria
  linha** (`- step-01  # Carteira: OAB, período`) — o formato dos squads de pacote. Todo squad
  instalado de área recebia `sem-checkpoint` ("nenhum checkpoint humano declarado") tendo três.
  Mesma classe do comentário inline nos artefatos, mesma correção: o comentário sai antes de comparar.

## [0.5.2] - 2026-09-03

## [0.5.2] - 2026-09-03

### O que a instalação entrega passa no validador

- **O `demo-squad` placeholder morreu.** O motor distribuía um exemplo de um arquivo só —
  `squad.yaml` sem pipeline, agentes ou harness — e o aluno via quatro erros no `check-squad` do
  exemplo que o próprio motor instalou. `templates/squads/` agora é GERADO da fixture sintética por
  `scripts/sync-templates-squads.mjs`: `demo-squad` inteiro e, novidade, `peca-modelo`, o squad de
  referência do caminho canônico (três paradas, `reader`, fase zero, autos, pacote), que até então
  só existia dentro dos testes. Skills e best-practices de demo saem na geração; os dois passam no
  `check-squad` sem nenhuma área instalada, e um teste prende a paridade fixture ↔ template.
- **`update` troca o placeholder das instalações existentes.** `squads/` é do usuário e o update
  nunca o toca; o placeholder é do motor (`status: "placeholder"`) e é o único substituído, com
  backup do `squad.yaml` e sem sobrescrever arquivo que já exista.

### Corrigido no `check-squad`

- `web_search`/`web_fetch` — tool-skills nativas que o Build manda declarar — eram aceitas num laço e
  acusadas de "inexistentes" no outro; todo squad de conteúdo instalado de pacote saía com dois erros.
- Artefato com comentário inline (`- output/carta.md  # só no caminho "declinar"`) não era o mesmo
  artefato do topo do pipeline: falso `artefato-sem-produtor`.
- Steps adjacentes sem linha em branco perdiam o último artefato do bloco (o parser exigia `\n`).
- O `demo-squad` da fixture passa a aliterar os nomes dos revisores, como o Gate 0 pede.

### Arquiteto

- **M13 fechado:** "the standard 6 tones" não existia em lugar nenhum e o modelo inventava seis por
  squad. O conjunto está definido (didático, institucional, opinativo, alerta, narrativo, técnico);
  o usuário edita o arquivo gerado, mas ele nasce igual toda vez.

## [0.5.1] - 2026-09-03

## [0.5.1] - 2026-09-03

### O fim da criação de squad deixou de demorar mais que a criação

- **Gates do Arquiteto em código.** O Step C do `build.prompt.md` mandava o modelo reler cada
  arquivo gerado, gate a gate (0, 1, 1b, 1c, 2, 2b, 3 e a metade mecânica do 4), com "máx 2
  tentativas" cada. Agora são regras do `check-squad`, com teste: `nome-de-agente-fora-do-padrao`,
  `secoes-de-agente-ausentes`, `task-ausente`/`task-frontmatter-incompleto`/`task-secao-ausente`,
  `especialista-nao-instalado`/`especialista-nao-referenciado`, `step-secao-ausente`,
  `input-sem-produtor`, e para squad de peça `revisao-sem-veredito`, `revisao-pelo-proprio-autor`,
  `revisao-nao-isolada`, `revisao-sem-verificador-citacoes`, `pesquisa-sem-citation-gate`,
  `sem-etica-sigilo`. O Step C virou "rode o validador, corrija a saída, leia só os quatro itens
  de juízo". O contrato de seções só é cobrado de squad que passou pelo Arquiteto (tem `_build/`);
  nome do agente e regras de peça valem para todo squad.
- **`audit-skills --skill <id>`.** O Gate 5 auditava a biblioteca inteira para conferir a skill que
  o squad acabou de criar — meio minuto e milhares de linhas numa instalação de aluno. O escopo
  audita só as pedidas e não sobrescreve o retrato da biblioteca em `_quality-report.json`.
- **`/legalsquad edit <name>` tem fluxo.** O comando roteava para um "Edit Squad flow" que não
  existia no Arquiteto — "acrescente um agente" virava rebuild completo ou improviso sem
  validação. O fluxo lê o que existe, muda só a peça pedida, valida por comando, apresenta o diff.

### Corrigido

- **`acervo sync` regenera `skills/_index.yaml`.** Numa instalação limpa de aluno, 6.584 skills em
  disco conviviam com um índice que dizia "0 skills" — o índice é a fonte do Arquiteto e do
  `catalog-scout`, e só `update` o regenerava. Só o índice: `check-skills` continua comando à parte.
- **A suíte está verde: 1.202 testes, 0 falhas.** As 7 falhas carregadas desde o F0 como "dívida
  conhecida" eram fósseis da era CriminalSquad; os testes agora exercitam o mesmo mecanismo contra
  a fixture sintética, por injeção do bundle (`_skillsBundle`). `npm run verify` verde pela
  primeira vez desde o F0.
- O squad-modelo `peca-modelo` cumpre o que o validador passou a cobrar: revisora aliterada
  ("Regina Revisão"), bloco `verdict:` parseável no step de revisão, `etica-oab-sigilo` referenciada.

## [0.5.0] - 2026-09-03

### As duas pontas do run

O advogado sente dois momentos: o que aparece na tela nos primeiros minutos e o
que sai pronto no final. Os gates continuam sendo o piso; esta versão constrói
as duas pontas (`docs/specs/legalsquad/ENTREGA.md` e `PLANO-ORQUESTRADOR.md`).

- **Três paradas humanas, com nome.** Squad de entrega jurídica para o
  profissional exatamente três vezes — `intake` (objetivo, prazo, juízo, estilo
  e o escopo da pesquisa), `diagnostico` (foco, teses e a linha de ataque) e
  `aprovacao` (o pacote, o que o juiz lê primeiro, e as propostas de memória
  agrupadas) —, mais o checkpoint imediatamente antes de qualquer ato
  irreversível. Antes eram cinco ou mais, espalhadas. O `check-squad` avisa
  quando um squad declara paradas a mais ou sem nome canônico.
- **Fase zero: os autos indexados uma vez.** Os PDFs do processo ficam em
  `squads/<nome>/autos/`; `scripts/indexar-autos.mjs` gera o índice (tipo do
  documento inferido pelo nome ou pelo cabeçalho, páginas, datas, número CNJ,
  começo de cada peça com CPF e CNPJ mascarados) e cacheia o texto quando há
  `pdftotext`. Sem poppler, marca `nao-extraivel-localmente` e não tenta
  parsear PDF à mão; escaneado vira `nao-extraivel` e o agente lê por página.
  Dali em diante os agentes leem o índice em vez de reabrir cada PDF a cada
  step. **O MCP do PJe não é fonte de autos** — segue em teste, fora do
  orquestrador.
- **Diagnóstico em paralelo.** O `parallel_group: diagnostico` despacha quatro
  leitores read-only sobre o índice (resumo do caso, contradições da prova,
  `contraditor` em modo pré-mortem e Temas do acervo), e a parada `diagnostico`
  consolida os quatro numa tela, com a fonte de cada linha nomeada.
- **Pacote pronto para protocolar.** `scripts/empacotar.mjs` monta, a partir da
  saída do run: a peça em `.docx` no estilo forense
  (`_legalsquad/core/estilo-forense.json`, sobrescrito por
  `_legalsquad/estilo-escritorio.json` do escritório sem tocar o script), PDF
  quando houver LibreOffice, o **termo de conferência** gerado só dos ledgers
  (citações com status e fonte, gates e ciclos, cada parada humana com carimbo
  e resposta mascarada, pendências com a linha), a lista de documentos a juntar
  cruzada com o índice dos autos, os próximos passos e um manifesto com
  SHA-256. A parada `aprovacao` roda o empacotador antes de perguntar: o que se
  aprova é o pacote, não um Markdown.
- **Persuasão como mecanismo — a peça tem dois leitores, e o segundo lê
  primeiro** (`docs/specs/legalsquad/PERSUASAO.md`). O juiz recebe a petição já
  triada por IA, e o que não sobrevive ao resumo ele não lê. Entram: o sinal
  `frente` no Redação Gate (peça longa abre com síntese nos primeiros 20%; peça
  curta é `nao-avaliado`, nunca reprovada), o agente `verificador-persuasao` no
  **Gate de Sobrevivência ao Resumo (Passo 4.6)** — resumo de triagem hostil,
  inventário de pedidos, teses e Temas, veredito `SOBREVIVE`/`PERDIDO` e
  `TEMA NAO ANCORADO` — e o agente `contraditor`, red team que **não vota**,
  com os três ataques mais fortes (fato, direito, forma) e o estado
  `ANTECIPADO`/`DESCOBERTO`. A opção "Red-team antes de seguir" do checkpoint
  deixou de ser rótulo e passou a ter comportamento.
- **Sexto sinal do Redação Gate: `folhas`.** Documento dos autos mencionado na
  peça vem com a folha ou o ID onde está (`fls. N`, `f. N`, `e-fls. N`,
  `ID N`), numa janela curta em torno da menção — um `fls.` do laudo não serve
  para a contestação citada na mesma frase. Sem índice ou sem menção,
  `nao-avaliado`, nunca aprovado.
- **Pesquisa em camadas.** Superiores, vinculantes do tribunal competente
  (IRDR, IAC, súmulas) e o acervo local entram **sempre**; a busca externa de
  acórdãos ordinários do tribunal local é decidida no `intake`, com a
  recomendação que `scripts/cobertura-acervo.mjs` calcula da cobertura real do
  acervo por tribunal e tema. O que vem de fora entra no acervo, para o próximo
  run cair na camada barata. A pesquisa passa a sair ordenada por força
  vinculante, e a tabela "Tema que governa cada tese" nasce nela — o gate 4.6
  vira rede, não descoberta.
- **`reader` decide o gate.** `reader: juiz | contraparte | cliente` no
  `squad.yaml` (default `juiz`): peça e parecer pagam a sobrevivência ao
  resumo; contrato paga a **consistência interna** (Passo 4.7,
  `scripts/verifica-contrato.mjs` — termos definidos, remissões, numeração,
  contradições de prazo, valor, multa, foro e índice, campos em aberto), e não
  é cobrado por síntese de peça. O `check-squad` expõe os gates por tipo.
- **Métricas do run, lidas do ledger.** `scripts/run-metricas.mjs` devolve
  duração, tempo até o primeiro artefato, paradas humanas, espera pelo humano,
  ciclos e REJECTs por gate e pendências na entrega; o `RELATORIO.md` publica a
  seção. Ausência de medida sai como "não medido" — nunca zero inventado.
- **Varredura determinística do DJEN.** `scripts/orchestra/djen-varredura.mjs`
  consulta a API pública de comunicações do CNJ por OAB e UF, pagina, grava no
  cache com dedupe pelo hash do próprio diário e registra a varredura **só em
  sucesso** — falha de rede não vira frescor. A data fatal continua sendo do
  profissional: o script grava `fatal: null`. O briefing do chefe roda a
  varredura antes das fontes quando existe `_legalsquad/_memory/djen.json`.
- **Estilo do escritório e lição do juízo entram na redação**, lidos da memória
  do chefe antes de escrever, não só na revisão.
- **Squad-modelo `peca-modelo`** com o caminho canônico inteiro, e o guia
  `docs/specs/legalsquad/MIGRACAO-SQUADS-0.5.md` para migrar squads desenhados
  antes desta versão. Nada quebra sem migrar: o validador avisa, não reprova.

### Mudou

- **Abertura do run em código.** O `run_id` é gerado pelo `init` no fuso do
  foro, com desempate de colisão e criação da pasta do run, e devolvido em
  JSON; o runner não faz mais aritmética de data de cabeça. O `init` agora
  **sempre** abre o ledger — antes, sem `--run`, o run ficava sem ledger e não
  era retomável. A normalização de `memories.md` e `runs.md` também virou
  código, **idempotente e não destrutiva**: garante as seções que faltam sem
  descartar o que o escritório escreveu (a instrução anterior mandava
  sobrescrever sem salvar o conteúdo).
- **Auditoria de prompts aplicada** ao runner, ao prompt de build e aos agentes
  de núcleo: marcadores de pressão, válvulas de escape manuais, narrativa de
  migração e pisos numéricos saíram; a orientação atual de prompting registra
  que instrução prescritiva demais reduz a qualidade. Relatório e diff em
  `docs/baseline/`.
- **Despacho de verificadores sempre por agente nomeado, nunca como fork.** O
  fork herda a conversa inteira, inclusive o raciocínio de quem redigiu, e
  destruiria o anti-viés que justifica o subagente.
- Aprendizado técnico que vale para qualquer squad passa a ser `licao` da
  memória do chefe, sob o gate M3. Antes era gravado em
  `_legalsquad/core/best-practices/`, que é conteúdo de pacote: o `sync`
  renomeava por cima e o aprendizado **desaparecia em silêncio**.

### Para quem já usa

- **Dependência nova (`docx`)**: depois de `legalsquad update`, rode
  `npm install` no projeto uma vez — é o que habilita o pacote em `.docx`.
- Squads criados antes desta versão continuam funcionando. Para ganhar as três
  paradas, o diagnóstico e o pacote, siga
  `docs/specs/legalsquad/MIGRACAO-SQUADS-0.5.md`.

## [0.4.0] - 2026-08-31

- **Contrato de autonomia do chefe (M0–M4)**: `chefe.autonomia_max` no
  `squad.yaml` trava o teto de decisão do chefe (M0 narra · M1 roteia e
  delega · M2 gere o ciclo dentro dos tetos · M3 propõe estrutura, só
  executa com o "sim" · M4 nunca: protocolar, enviar, assinar, publicar,
  pagar). Checkpoint de nível M3 passa sempre pela pergunta estruturada de
  aprovação (Aprovar e seguir · Ajustar · Red-team antes de seguir · Parar
  aqui), com o texto equivalente herdado onde a ferramenta não suportar o
  formato.
- **Gates de citação e redação saem do hook de máquina para o frontmatter**:
  antes o gate era instalado uma vez em toda a máquina, inclusive fora de
  projeto jurídico, e por isso nascia advisory. Agora a skill `/legalsquad`
  e os agentes de citação e avaliação declaram os dois gates no próprio
  frontmatter, valendo para a sessão jurídica que os invocou; o hook de
  máquina vira backstop.
- **Memória do chefe, com trava de LGPD por mecanismo**: o chefe passa a
  guardar fato, preferência, decisão e lição por projeto, um arquivo por
  fato. Toda escrita passa por um detector de dado identificável (CPF/CNPJ
  com dígito verificador, número OAB, número CNJ, e-mail, telefone) que
  BARRA a gravação antes de tocar o disco. O diretório de memória nunca é
  versionado, por decisão declarada.
- **Rituais agendados**: `legalsquad chefe --briefing` reúne prazos do dia,
  intimações recentes e carteira numa única leitura, narrada; `chefe
  --agendar [--aplicar] [--hora]` monta e mostra a minuta do agendamento
  diário e só grava com o "sim" explícito.
- **`model`, `effort` e `maxTurns` saem da prosa para o frontmatter dos
  agentes**: tabela de calibragem por papel (resolução mecânica de citação
  em haiku/low; julgamento de aderência temática e meta em opus/high;
  redator e revisor de peça em opus/xhigh), validada pelo `squad-check`.
- **Compilador `pipeline.yaml` → Workflow**: o `pipeline.yaml` continua
  sendo a única fonte da regra do squad; um passo de build agora o traduz
  para um script Workflow determinístico e auditável, sem duplicar a regra
  em dois lugares.
- **LegalSquad como plugin do Claude Code**: instalação e atualização por
  `claude plugin marketplace add` / `claude plugin install`, como
  alternativa ao instalador global. Gerado automaticamente a partir da
  mesma fonte que o pacote npm distribui, nunca mantido à mão.
- **Acervo**: DL 3.365/1941 (Desapropriação) somado à coleta de direito
  administrativo; corpus de direito do consumidor ampliado; dicionário de
  sinônimos de busca mais que dobrado.
- **Correções**: o painel do escritório deixava de mostrar o desfecho de um
  run em reconexão ou sob polling, e voltou a mostrar; `squad-check` deixava
  passar `chefe:` malformado quando escrito em estilo de uma linha só, e
  passou a recusar; a sincronização dos blocos compartilhados do motor
  passa a garantir, por construção, que uma falha no meio da propagação
  nunca deixa uma cópia parcialmente atualizada.

## 0.3.0 — 2026-08-22

- **Mike (chefe de squad) de alta performance**: abertura com a meta, narração
  do rigor dos gates (citações verificadas, ciclos, meta critério a critério),
  escalada e falhas traduzidas, checkpoint emoldurado, retomada com molde,
  handoff explícito roteador→chefe.
- **Arquiteto — análise profunda de skills por agente**: Phase D.5 (matriz de
  cobertura, inspeção via `detail-skill`, registro auditável por agente),
  busca com variantes + léxico do curador (`skills/_lexico*.yaml`), filtros
  `--delivery-type/--risk/--quality-profile`, `negative_triggers` como
  penalidade de frase no ranking.
- **Comandos novos**: `detail-skill <id>` (digest estrutural de uma skill);
  registro de uso por ciclo de revisão em `skills/_evals/uso/`.
- **Run ledger com tempo**: `startedAt`/`endedAt`, histórico `steps[]` e
  carimbo de checkpoints — retomada e entrega com duração real.
- **Correções**: fluxo de atualização aponta para o dist público
  (`legalsquad-nucleo`); assistente não pede mais licença (acesso aberto
  embutido); extração de frames compatível com ffmpeg 8+ (`-fps_mode`).

## 0.1.0 — 2026-07/08

- Motor F0–F3: empacotador de áreas, sync assinado (Ed25519) com o servidor de
  acervo, gates de citação e redação, squads jurídicos padrão-ouro.
