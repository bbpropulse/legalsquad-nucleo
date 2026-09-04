// Núcleo decisório do `legalsquad acervo sync` (SPEC §9.2).
//
// Módulo PURO: decide o que baixar, não baixa. A separação é deliberada — "o que
// sincronizar" é regra de negócio, "buscar bytes" é I/O — e é o que permite
// exercitar o contrato do §7.1 inteiro antes de existir servidor nenhum.
// Escrever o cliente primeiro é o jeito mais barato de descobrir que o contrato
// está mal desenhado.

/** Estados de licença que o cliente entende. Desconhecido é tratado como falha. */
const ESTADOS = new Set(['active', 'expired', 'none']);

function ehMaisNovo(disponivel, instalada) {
  return !instalada || String(disponivel) !== String(instalada);
}

/**
 * Decide o plano de sincronização.
 *
 * @param catalogo resposta de `/v1/catalog` (§7.1), já parseada
 * @param estado   `{ packs: { <pack_id>: <versao instalada> } }`
 * @param opcoes   `{ incluirConteudo }` — o `--content` do §9.1
 * @returns `{ ok, motivo, baixarCatalogo[], baixarConteudo[], revogar[] }`
 */
export function planejarSync(catalogo, estado = { packs: {} }, opcoes = {}) {
  const instalados = estado?.packs || {};
  const vazio = { baixarCatalogo: [], baixarConteudo: [], revogar: [] };

  const status = catalogo?.status;
  if (!ESTADOS.has(status)) {
    return { ok: false, motivo: `status de licença desconhecido (${status}) — recuse, não adivinhe`, ...vazio };
  }

  const packs = Array.isArray(catalogo.packs) ? catalogo.packs : null;
  if (!packs) {
    return { ok: false, motivo: 'resposta sem lista de packs — catálogo ilegível', ...vazio };
  }

  // Lista vazia é indistinguível de "não há nada", e o §7.1 proíbe o servidor de
  // devolvê-la. Se vier assim mesmo, gritar: um sync que reporta "tudo em dia"
  // sobre uma resposta vazia é a mentira mais barata de produzir e a mais cara
  // de descobrir — e apagar o cache por causa dela seria pior ainda.
  if (packs.length === 0) {
    return {
      ok: false,
      motivo: 'catálogo vazio: nenhum pack na resposta. O servidor nunca deve devolver `packs: []` '
        + '(§7.1) — sem licença, os packs vêm com `entitled: false`. Cache preservado.',
      ...vazio,
    };
  }

  // Vencida degrada, nunca revoga (§8.0). O que foi baixado durante a vigência
  // continua servindo; o que para é a ATUALIZAÇÃO. Note que `revogar` fica vazio
  // de propósito: revogação existe para conteúdo errado, jamais para cobrança.
  if (status === 'expired') {
    return {
      ok: true,
      motivo: `licença vencida${catalogo.expires ? ` em ${catalogo.expires}` : ''} — `
        + 'cache mantido em somente leitura, sem atualizar. Nada foi apagado.',
      ...vazio,
    };
  }

  const baixarCatalogo = [];
  const baixarConteudo = [];

  for (const pack of packs) {
    const instalada = instalados[pack.pack_id];
    const novidade = ehMaisNovo(pack.latest, instalada);

    // O catálogo desce mesmo sem direito: é ele que permite a busca local dizer
    // "existe, sua licença não cobre" em vez de "não existe" (§7.1).
    if (pack.catalog && novidade) baixarCatalogo.push(pack);

    // Conteúdo exige as três coisas: direito, URL, e ou já estar instalado (é
    // atualização — deixar para trás produziria instalação que se diz atualizada
    // e responde com conteúdo velho) ou `--content` explícito.
    const querConteudo = opcoes.incluirConteudo || Boolean(instalada);
    if (pack.entitled && pack.content && novidade && querConteudo) baixarConteudo.push(pack);
  }

  // Só revoga o que está instalado: mandar apagar o que não existe é ruído, e
  // ruído em revogação treina quem lê a ignorá-la.
  const revogar = (catalogo.revoked || []).filter((packId) => packId in instalados);

  // DESPUBLICADO ≠ REVOGADO, e a diferença é o que se faz com o disco.
  //
  // O servidor nunca esconde pack por falta de direito — lista com
  // `entitled: false`, para a busca dizer "existe, não está liberado" em vez de
  // mentir. Então ausência da lista só significa uma coisa: saiu de linha.
  //
  // A entrada some do MANIFESTO (senão `acervo status` conta pacotes que o
  // servidor não tem mais, e o número mente sobre o que existe), mas os
  // arquivos FICAM. Revogar é "este conteúdo está errado, apague"; despublicar
  // é "não distribuo mais" — apagar por ausência transformaria uma área
  // descontinuada em perda de conteúdo que o usuário tinha direito de ter.
  // Mesma família da regra de licença vencida: degrada, nunca destrói.
  const noCatalogo = new Set(packs.map((p) => p.pack_id));
  const despublicados = Object.keys(instalados).filter((id) => !noCatalogo.has(id)).sort();

  return {
    ok: true,
    despublicados,
    motivo: baixarCatalogo.length || baixarConteudo.length || revogar.length || despublicados.length
      ? `${baixarCatalogo.length} catálogo(s), ${baixarConteudo.length} conteúdo(s), `
        + `${revogar.length} revogado(s), ${despublicados.length} despublicado(s)`
      : 'tudo em dia',
    baixarCatalogo,
    baixarConteudo,
    revogar,
  };
}

/**
 * Executa um plano. A rede e o disco entram por injeção — `baixar`, `verificar`
 * e `aplicar` —, o que mantém a ordem dos gates testável sem servidor nem FS.
 *
 * **Um pacote ruim não derruba o sync** (§6.7): cada pack é tentado isoladamente,
 * o que falha é reportado com o motivo, e os demais seguem. Abortar tudo por
 * causa de um deixaria o usuário sem as atualizações boas por causa da ruim.
 */
export async function executarSync(plano, ambiente, estadoAnterior = { packs: {} }) {
  const { baixar, verificar, aplicar } = ambiente;
  const aplicados = [];
  const recusados = [];
  const packs = { ...(estadoAnterior.packs || {}) };

  // Despublicado sai do manifesto ANTES de qualquer download: é só apagar uma
  // entrada de registro, não depende de rede, e deixá-lo para o fim faria a
  // limpeza depender de o sync chegar inteiro ao final. Os ARQUIVOS ficam — ver
  // `planejarSync` para por que despublicar não é revogar.
  for (const packId of plano.despublicados || []) delete packs[packId];

  const alvos = [...(plano.baixarCatalogo || []), ...(plano.baixarConteudo || [])];

  for (const pack of alvos) {
    const url = pack.catalog?.url || pack.content?.url;
    try {
      const baixado = await baixar(url);

      // O gate. Verificar SEMPRE antes de aplicar — um pacote assinado ainda é
      // conteúdo remoto materializando arquivos na máquina de um advogado, e se
      // algum caminho aplicasse antes de verificar, a assinatura Ed25519 inteira
      // viraria decoração.
      const veredito = verificar(baixado.manifesto, baixado.entidades);
      if (!veredito.ok) {
        recusados.push({ pack_id: pack.pack_id, motivo: veredito.problemas.join('; ') });
        continue;
      }

      await aplicar(pack, baixado.manifesto, baixado.entidades);
      aplicados.push(pack.pack_id);
      // A versão só avança para quem APLICOU. Avançá-la para quem falhou faria o
      // próximo sync considerar o pack em dia e nunca mais baixá-lo — o usuário
      // ficaria com a versão velha achando que tem a nova.
      packs[pack.pack_id] = pack.latest;
    } catch (erro) {
      recusados.push({ pack_id: pack.pack_id, motivo: erro.message });
    }
  }

  for (const packId of plano.revogar || []) delete packs[packId];

  return {
    aplicados,
    recusados,
    revogados: plano.revogar || [],
    despublicados: plano.despublicados || [],
    estado: { ...estadoAnterior, packs },
  };
}
