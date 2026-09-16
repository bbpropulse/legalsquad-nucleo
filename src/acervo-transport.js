// O fio de rede que faltava ao `sync` (§9.2) — `acervo-sync.js` já decide O
// QUE baixar (`planejarSync`) e como aplicar (`executarSync`, por injeção);
// só faltava buscar os bytes de verdade. `baixar` devolve o mesmo shape que
// `lerPacoteDoDisco` devolve, pra `verificarPacote`/`aplicarPacote` não
// precisarem saber se o pacote veio do disco ou da rede.
import { desempacotarDeTransporte } from './pack-archive.js';

export async function baixar(url) {
  const resposta = await fetch(url);
  if (!resposta.ok) {
    throw new Error(`acervo-transport: download falhou — HTTP ${resposta.status} em ${url}`);
  }
  const buffer = Buffer.from(await resposta.arrayBuffer());
  return desempacotarDeTransporte(buffer);
}
