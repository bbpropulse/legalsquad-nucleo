// Aplicação de um pacote verificado (SPEC §6.5) — o lado CLIENTE do formato.
//
// Um pacote assinado ainda é conteúdo REMOTO materializando arquivos na máquina
// de um advogado. A assinatura prova origem, não boa-fé de quem tinha a chave:
// quem assina pode ter sido comprometido, e o dano de escrever no lugar errado
// é irreversível.
//
// Semântica que atravessa o módulo: violação recusa o PACOTE INTEIRO, nunca só a
// linha. Pular a linha hostil em silêncio instalaria o resto de um pacote que já
// provou não merecer confiança — e o usuário veria uma instalação normal.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { ARQUIVOS_PROIBIDOS, ehUserOwned } from './pack-format.js';

// A lista de subárvores do usuário é do FORMATO e mora em `pack-format.js`:
// o build exclui e o apply recusa, a partir da mesma definição. Duplicá-la aqui
// deixaria os dois lados divergirem sem que nada avisasse.

/**
 * Um caminho é seguro quando é relativo, não escapa, e normaliza para si mesmo.
 * A comparação com a forma normalizada é o que pega `a/./b`, `a//b` e `a/../b`
 * de uma vez, sem precisar enumerar as variações.
 */
function caminhoSeguro(caminho) {
  if (typeof caminho !== 'string' || caminho === '') return false;
  if (posix.isAbsolute(caminho) || /^[a-zA-Z]:/.test(caminho)) return false;
  if (caminho.includes('\\')) return false;
  if (caminho.split('/').includes('..')) return false;
  return posix.normalize(caminho) === caminho;
}

/**
 * Verifica a contenção de um pacote de árvore antes de escrever qualquer byte.
 * Devolve `{ ok, problemas[] }` com TODAS as violações — recusar na primeira
 * esconde as outras, e o curador corrigiria uma por vez, rodando de novo a cada
 * descoberta. Um pacote hostil merece ser diagnosticado de uma vez.
 */
export function validarContencao(manifesto, arquivos) {
  const problemas = [];
  const appliesTo = Array.isArray(manifesto?.applies_to) ? manifesto.applies_to : [];
  const vistos = new Set();

  for (const arquivo of arquivos) {
    const caminho = arquivo?.path;

    if (!caminhoSeguro(caminho)) {
      problemas.push(`caminho inseguro (absoluto, com ".." ou não-normalizado) — ${caminho}`);
      continue;
    }
    if (ARQUIVOS_PROIBIDOS.has(posix.basename(caminho)) || ARQUIVOS_PROIBIDOS.has(caminho)) {
      problemas.push(`arquivo que nenhum pacote pode escrever — ${caminho}`);
      continue;
    }
    if (ehUserOwned(caminho)) {
      problemas.push(
        `subárvore do usuário — ${caminho}. Nenhum pacote escreve aqui, ainda que declare em applies_to.`
      );
      continue;
    }
    if (!appliesTo.some((prefixo) => caminho.startsWith(prefixo))) {
      problemas.push(`fora de applies_to (${appliesTo.join(', ') || 'vazio'}) — ${caminho}`);
      continue;
    }
    if (vistos.has(caminho)) {
      problemas.push(`caminho repetido no mesmo pacote — ${caminho}`);
      continue;
    }
    vistos.add(caminho);
  }

  return { ok: problemas.length === 0, problemas };
}

/** Conteúdo decodificado de uma entidade-arquivo (§6.2): `text` XOR `b64`. */
function conteudoDe(arquivo) {
  if (typeof arquivo.text === 'string' && arquivo.b64 === undefined) {
    return Buffer.from(arquivo.text, 'utf8');
  }
  if (typeof arquivo.b64 === 'string' && arquivo.text === undefined) {
    return Buffer.from(arquivo.b64, 'base64');
  }
  return null;
}

/**
 * Aplica um pacote de árvore em `destino`.
 *
 * **Verifica tudo antes de escrever qualquer byte.** Uma área meio-instalada é
 * pior que nenhuma: o resolvedor a veria como instalada e responderia "essa
 * skill não existe" no lugar de "essa área não terminou de instalar" — a
 * degradação silenciosa outra vez, no pior lugar possível.
 *
 * Cada arquivo é escrito num temporário e **renomeado por cima**. `rename` no
 * mesmo sistema de arquivos é atômico, então nenhum arquivo fica pela metade,
 * nem se o processo morrer no meio. O que não dá para tornar atômico é a árvore
 * inteira — um pacote MESCLA com o que já existe, e trocar o diretório de uma
 * vez apagaria conteúdo que o pacote não gerencia. Por isso a garantia é
 * por-arquivo, e a verificação prévia é o que evita começar uma aplicação que
 * vai falhar no meio.
 *
 * `opcoes.somenteLeitura` grava os arquivos sem bit de escrita (0444/0555). É
 * o modo do depósito da máquina (`deposito.js`): os projetos recebem hard
 * links desses arquivos, e um link compartilha o inode — sem o bit, uma edição
 * no lugar dentro de um projeto falha em vez de corromper a cópia de todos os
 * outros. Duas regras protegem esse inode compartilhado: o temporário nasce
 * gravável (um sync interrompido não deixa um `.legalsquad-tmp` 0444 que
 * bloqueie o próximo) e só perde o bit na hora do rename; e o alvo antigo
 * NUNCA recebe chmod (o bit é dele e de todos os links nos projetos que ainda
 * apontam para ele). No POSIX o rename por cima de arquivo somente-leitura é
 * permitido (é o diretório que precisa de escrita); no Windows o atributo
 * bloqueia o replace, então o alvo é desvinculado antes (o libuv apaga sem
 * mexer no atributo compartilhado quando o sistema permite).
 */
export function aplicarPacote(destino, manifesto, arquivos, opcoes = {}) {
  const somenteLeitura = opcoes.somenteLeitura === true;
  const contencao = validarContencao(manifesto, arquivos);
  if (!contencao.ok) return { ok: false, problemas: contencao.problemas, escritos: [] };

  // Segunda passada: o conteúdo tem de bater com o `sha256` declarado. O
  // manifesto assinado cobre o hash da ENTIDADE; este é o de cada arquivo dentro
  // dela. Divergência significa payload inconsistente com o que foi assinado.
  const problemas = [];
  const prontos = [];
  for (const arquivo of arquivos) {
    const conteudo = conteudoDe(arquivo);
    if (conteudo === null) {
      problemas.push(`\`text\` e \`b64\` são mutuamente exclusivos, e um é obrigatório — ${arquivo.path}`);
      continue;
    }
    const real = createHash('sha256').update(conteudo).digest('hex');
    if (real !== arquivo.sha256) {
      problemas.push(`sha256 do arquivo não confere com o declarado — ${arquivo.path}`);
      continue;
    }
    prontos.push({ ...arquivo, conteudo });
  }
  if (problemas.length) return { ok: false, problemas, escritos: [] };

  const escritos = [];
  for (const arquivo of prontos) {
    const alvo = join(destino, ...arquivo.path.split('/'));
    const temporario = `${alvo}.legalsquad-tmp`;
    mkdirSync(dirname(alvo), { recursive: true });
    try {
      const executavel = arquivo.mode === '755';
      // Sobra de um sync interrompido: sai antes (pode estar sem bit de escrita).
      rmSync(temporario, { force: true });
      writeFileSync(temporario, arquivo.conteudo, { mode: executavel ? 0o755 : 0o644 });
      if (somenteLeitura) chmodSync(temporario, executavel ? 0o555 : 0o444); // umask não afeta chmod
      if (somenteLeitura && process.platform === 'win32' && existsSync(alvo)) {
        try { unlinkSync(alvo); } catch { /* o rename decide */ }
      }
      renameSync(temporario, alvo);
    } catch (erro) {
      // Falha aqui é ruidosa e deixa o temporário para trás só se o próprio
      // `rm` falhar — o estado anterior do arquivo alvo permanece intacto,
      // porque o rename ou aconteceu por inteiro ou não aconteceu.
      rmSync(temporario, { force: true });
      throw new Error(`pack-apply: falha ao gravar ${arquivo.path} — ${erro.message}`, { cause: erro });
    }
    escritos.push(arquivo.path);
  }

  return { ok: true, problemas: [], escritos };
}
