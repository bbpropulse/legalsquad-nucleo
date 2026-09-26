// Converte a página de uma lei em texto e a fatia por artigo.
//
// Existe por causa de uma falha medida em campo: no piloto de enriquecimento,
// o agente tentou abrir dispositivos no Planalto, levou ECONNRESET, e **escreveu
// o conteúdo mesmo assim** — inventando texto de lei. A causa raiz não era
// instabilidade: o Planalto recusa requisição sem user-agent de navegador. Com
// UA de navegador responde 200.
//
// A lição de desenho é essa: enquanto a fonte da lei depender de rede no
// momento da redação, a falha de rede vira invenção. A lei precisa estar no
// acervo, local, antes de qualquer agente precisar dela.

const ENTIDADES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ordm: 'º', ordf: 'ª',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', agrave: 'à',
  acirc: 'â', ecirc: 'ê', ocirc: 'ô', atilde: 'ã', otilde: 'õ', ccedil: 'ç',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Agrave: 'À',
  Acirc: 'Â', Ecirc: 'Ê', Ocirc: 'Ô', Atilde: 'Ã', Otilde: 'Õ', Ccedil: 'Ç',
  uuml: 'ü', Uuml: 'Ü', laquo: '«', raquo: '»', deg: '°', sect: '§',
};

/**
 * O Planalto serve ISO-8859-1 e o restante do ecossistema serve utf-8.
 * Decodificar errado não quebra — corrompe **todo acento em silêncio**, e um
 * texto de lei com acento corrompido passaria no gate de citação como se
 * estivesse certo.
 */
function decodificar(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8');
  const comoUtf8 = bytes.toString('utf8');
  // U+FFFD é o que o decodificador utf-8 emite ao encontrar byte inválido:
  // sinal de que a fonte não era utf-8.
  return comoUtf8.includes('�') ? bytes.toString('latin1') : comoUtf8;
}

export function htmlParaTexto(entrada) {
  let texto = decodificar(entrada).replace(/\r\n?/g, '\n');
  texto = texto.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Quebra na ABERTURA e no fechamento de bloco. Só no fechamento não basta:
  // a página da Lei 14.133 abre `<p>` e nunca fecha, e a lei inteira colapsava
  // em 17 linhas — o coletor gravava 17 artigos de 194 achando que deu certo.
  texto = texto.replace(/<\s*(br|\/?p|\/?div|\/?tr|\/?li|\/?h[1-6])\b[^>]*>/gi, '\n');
  texto = texto.replace(/<[^>]+>/g, '');
  texto = texto.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  texto = texto.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
  texto = texto.replace(/&([a-z]+);/gi, (todo, nome) => ENTIDADES[nome] ?? todo);
  texto = texto.replace(/[ \t\u00a0]+/g, ' ');
  texto = texto.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n');
  // "Art ." — espaço (ou quebra de linha) entre a abreviatura e o ponto.
  // Medido na Lei 6.437/1977: das ~60 aberturas o parser reconhecia 4, e o
  // guard recusava gravar a lei inteira. "Art" não é palavra do português
  // jurídico, então colar o ponto nunca destrói texto legítimo.
  texto = texto.replace(/\bArt[ \t]*\n?[ \t]*\./g, 'Art.');
  // Reúne o "Art." que ficou órfão do próprio número. Medido na Lei 14.133:
  // o HTML exportado do Word separa os dois, e as 194 aberturas viravam 194
  // linhas soltas com "Art." e nenhum artigo reconhecido.
  texto = texto.replace(/\bArt\.[ \t]*\n+[ \t]*(?=\d)/g, 'Art. ');
  // O número em si também parte entre linhas: "Art. 5" numa, "7." na outra.
  // Medido na LGPD — o art. 57 ("(VETADO)") virava um segundo "artigo 5", e
  // como a ÚLTIMA ocorrência leva o nome canônico, o fragmento expulsava as
  // definições do art. 5º do arquivo `l13709-art-5.md`.
  //
  // O lookahead exige que a continuação PAREÇA fim de número de artigo —
  // marcador ordinal, ponto final não seguido de dígito, ou sufixo de letra.
  // Sem isso, "Art. 5" seguido de "1.500 (mil e quinhentos)" viraria o artigo
  // 51.500: trocar um erro por outro maior.
  texto = texto.replace(/\bArt\.[ \t]*(\d+)[ \t]*\n+[ \t]*(?=\d+(?:[ºo°]|\.(?!\d)|-[A-Z]))/g, 'Art. $1');
  return texto.trim();
}

// `Art.` só abre dispositivo no INÍCIO da linha e com A maiúsculo. "no art. 5º
// desta Lei" é remissão dentro do texto — tratá-la como abertura partiria o
// artigo ao meio e o gate validaria contra meio dispositivo.
// `[\d.]` aceita a forma com separador de milhar ("Art.1.048."), encontrada na
// Lei 14.133. Lida como "artigo 1", o gate resolveria a citação contra outro
// dispositivo e devolveria VERIFICADA — pior que não verificar.
// O número casa de forma gulosa como grupos de milhar OU dígitos corridos, e o
// ponto final do dispositivo fica FORA da captura — assim "Art.1.048." é o
// artigo 1048 e não o artigo 1. O sufixo de letra é opcional, e o lookahead
// final só exige que não venha letra ou dígito colado: sem isso, "Art. 30-A."
// caía por backtracking no artigo 30, porque o ponto depois do "A" não era
// aceito. O 30-A da Lei 9.504 é dispositivo autônomo e dos mais citados da
// matéria eleitoral; confundi-lo com o 30 entrega o texto errado como certo.
// A vírgula logo após o número denuncia REMISSÃO, não abertura: a redação
// legislativa brasileira abre com "Art. 200." ou "Art. 200º", nunca com
// "Art. 200, texto". Sem essa guarda, o "...no prazo previsto no / Art. 200,
// quando terá vista..." do Código Eleitoral — partido pela quebra de linha do
// HTML — abria artigo e gravava o fim do art. 179 sob o nome do art. 200.
// **O sufixo vem COLADO.** A redação legislativa grafa "Art. 1.080-A.",
// "Art. 5º-A", "Art. 30-A" sem espaço; o traço com espaços em volta é
// pontuação separando o número do texto do dispositivo — "Art. 126 - O
// Ministro do Trabalho expedirá...".
//
// A guarda anterior olhava se depois da letra vinha palavra minúscula, e por
// isso só pegava metade dos casos: em "Art. 13 - A Carteira de Trabalho" a
// palavra seguinte é maiúscula, e na Lei 6.437 a fonte quebra a linha logo
// depois da letra ("Art. 13 - O" / "auto de infração"), onde não há nada na
// linha para olhar. Medido no acervo: **78 arquivos sufixados falsos** —
// inclusive `cf-art-40-b.md`, que guardava o art. 40 da Constituição, o
// dispositivo central de todo o regime próprio de previdência.
//
// A guarda da minúscula fica: cobre "Art. 30-A cancelamento", em que o traço
// é colado mas a letra ainda é artigo definido.
const ABERTURA = /^[ \t]*Art\.[ \t]*(\d{1,3}(?:\.\d{3})+|\d+)[ºo°]?\.?(?:-([A-Z])(?![ \t]+\p{Ll}))?(?![\p{L}\p{N}])(?![ \t]*,)/u;

/**
 * @param {string} texto
 * @returns {{numero: string, texto: string}[]} na ordem do documento,
 *   preservando repetições (o texto compilado traz redação revogada e vigente).
 */
export function fatiarArtigos(texto) {
  const linhas = String(texto || '').split('\n');
  const artigos = [];
  let atual = null;
  // A página da Constituição traz o ADCT no fim. Sem separar os corpos, o
  // art. 5º do ADCT vira "redação vigente" do art. 5º da CF — e o gate
  // validaria a citação contra o texto errado, devolvendo VERIFICADA para
  // afirmação materialmente falsa.
  let corpo = '';
  // O título do ADCT aparece DUAS vezes na página: uma no sumário, no topo, e
  // outra onde o ato de fato começa. Marcar na primeira jogaria a Constituição
  // inteira para dentro do ADCT — medido: 501 de 514 artigos.
  const MARCADOR_ADCT = /^\s*(ATO DAS DISPOSI[ÇC][ÕO]ES CONSTITUCIONAIS TRANSIT[ÓO]RIAS|ADCT)\s*$/i;
  const inicioDoAdct = linhas.reduce((ultimo, linha, i) => (MARCADOR_ADCT.test(linha) ? i : ultimo), -1);

  for (const [indice, linha] of linhas.entries()) {
    if (inicioDoAdct >= 0 && indice >= inicioDoAdct) corpo = 'ADCT';
    const abre = linha.match(ABERTURA);
    if (abre) {
      const numero = abre[1].replace(/\./g, '');
      atual = { numero: abre[2] ? `${numero}-${abre[2]}` : numero, corpo, linhas: [linha] };
      artigos.push(atual);
      continue;
    }
    // Texto anterior ao primeiro artigo (ementa, preâmbulo) não pertence a
    // dispositivo nenhum e é descartado aqui — vai inteiro no arquivo da lei.
    if (atual) atual.linhas.push(linha);
  }

  return artigos.map(({ numero, corpo, linhas: linhasDoArtigo }) => ({
    numero,
    corpo,
    texto: linhasDoArtigo.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
  }));
}
