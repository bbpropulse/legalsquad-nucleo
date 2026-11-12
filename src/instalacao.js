// O id pseudônimo da instalação, num módulo leve: a contribuição de squads e o servidor de referência
// mandam o mesmo id no `X-Legalsquad-Instalacao` (o limite diário dos dois servidores é por ele), e o
// cliente do índice não precisa carregar o empacotador de modelos para calculá-lo.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { TOKEN_ACESSO_ABERTO } from './acervo-config.js';

/**
 * Identificador pseudônimo e estável da instalação: nunca o nome, nunca a licença em claro. Com
 * licença nominal, o hash dela (a mesma pessoa em duas máquinas é uma só para o limite diário);
 * com o acesso aberto, que é o mesmo token em toda instalação, o hash de um número sorteado uma vez
 * por máquina e guardado em `~/.legalsquad/instalacao.json`.
 */
export function idDaInstalacao({ license, casa = homedir() } = {}) {
  const h = (t) => createHash('sha256').update(`legalsquad-contribuicao|${t}`).digest('hex').slice(0, 32);
  if (license && license !== TOKEN_ACESSO_ABERTO) return h(`licenca|${license}`);
  const arquivo = join(casa, '.legalsquad', 'instalacao.json');
  let sorteio = null;
  try { sorteio = JSON.parse(readFileSync(arquivo, 'utf8'))?.id || null; } catch { /* primeira vez */ }
  if (typeof sorteio !== 'string' || sorteio.length < 16) {
    sorteio = randomUUID();
    try {
      mkdirSync(dirname(arquivo), { recursive: true });
      writeFileSync(arquivo, `${JSON.stringify({ id: sorteio, criado_em: new Date().toISOString().slice(0, 10) }, null, 2)}\n`, 'utf8');
    } catch { /* sem casa gravável: o id vale só para esta vez */ }
  }
  return h(`instalacao|${sorteio}`);
}
