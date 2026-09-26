# Perfil da Instituição (LegalSquad)

> Preencha/ajuste os campos entre colchetes angulares com os dados reais. Este arquivo é carregado em
> TODA execução de squad e orienta foco, **polo**, tom e conformidade.
> Normalmente é gerado/atualizado pelo onboarding do `/legalsquad`: você também
> pode editá-lo à mão ou rodar `/legalsquad edit-company`.

## Identidade
- Tipo de instituição: <Escritório de advocacia | Advogado(a) autônomo(a) | Gabinete do Ministério Público (Promotoria/Procuradoria) | Defensoria Pública | Departamento jurídico | Outro>
- Nome/denominação: <preencher>
- Responsável: <nome>, <OAB/UF nº (advocacia) **ou** cargo: Promotor(a)/Defensor(a)/Procurador(a)>
- Contato: <e-mail institucional>
- Comarcas/Tribunais: <ex.: TJ__, TRF__, STJ, STF>

## Áreas de atuação (obrigatório: é o filtro do roteador)
- Áreas de atuação: <slugs das áreas ligadas nesta pasta, conferidos em `npx legalsquad acervo areas` (ex.: direito-civil, direito-do-consumidor, criminal, direito-do-trabalho); mais de uma, separadas por vírgula>
- Nichos: <os nomes vêm do catálogo da área, descubra com `search-skills`>
  > O LegalSquad atende qualquer área do Direito. Squad, modelo, agente ou skill de outra área nunca é
  > sugerido para um caso; os squads prontos que chegam com os pacotes são de uma área, não "do sistema".

## Polo de atuação (postura padrão; o caso pode inverter)
- Polo predominante: <Polo ativo (autor, requerente, exequente, reclamante, acusação) | Polo passivo (réu, requerido, executado, reclamada, defesa) | Varia por caso | Consultivo/extrajudicial>
- Implicação prática: o polo orienta a postura padrão (o que pedir, o que impugnar, que recurso cabe e
  para quem), nunca a matéria; a matéria vem da área do caso.
  > Os instrumentos concretos de cada polo (nomes de peça, ritos, prazos) vêm do **pacote da área
  > instalada**: descubra-os com `search-skills` no catálogo instalado, não os presuma aqui.

## Posicionamento
- Proposta de valor: <ex.: atuação técnica e preventiva; foco em contencioso empresarial; atendimento humanizado em família>
- Perfil de cliente/assistido: <ex.: pessoa física; pessoa jurídica; ente público, conforme a área de atuação>
- Tom de voz institucional: formal, técnico e sóbrio, sem sensacionalismo e sem promessa de resultado

## Conhecimento e fontes
- Acervo local: `./acervo/` (jurisprudência, doutrina, legislação, teses-modelo); rode `npm run indexar-acervo` após adicionar material
- Fontes oficiais: STJ, STF, Planalto, DJEN
- Peças e habilidades: `./skills/` (peças da área instalada) e `./.claude/agents/` (subagentes especialistas)

## Operação
- Sistemas processuais: <ex.: PJe, e-SAJ, Projudi, Eproc, conforme tribunal>
- E-mail: <Gmail / Resend, a definir na 1ª execução de um squad que envie e-mail>
- Agenda: <Google Calendar>
- Redes (autoridade): <Instagram / LinkedIn: handles>

## Conformidade (transversal e obrigatória)
> Ajuste a moldura ética ao **tipo de instituição**:
> - **Advocacia** → Código de Ética da OAB + **Provimento 205/2021** (sem captação/mercantilização, sem promessa de resultado).
> - **Ministério Público** → regime do MP (CNMP) e deveres funcionais; **não** se aplica a publicidade advocatícia.
> - **Defensoria Pública** → LC 80/94 e regras próprias; foco no assistido hipossuficiente.
- Revisão humana **obrigatória**: toda peça/parecer é rascunho técnico: "hipótese a confirmar".
- Verificação de citações (`verificacao-citacoes`) **antes** de qualquer protocolo: nada citado de memória.
- Sigilo profissional e LGPD: dados de cliente/assistido nunca em repositório público (`acervo/casos/` é gitignored).
- Conflito de interesses: checagem do art. 17 do Estatuto da OAB (ou equivalente) na triagem.
