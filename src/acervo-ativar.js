// `legalsquad ativar <licença>` — o ÚNICO passo que o aluno executa.
//
// Ele recebe uma coisa da compra: a licença. URL do servidor e chave de
// verificação vêm embarcadas (`acervo-config.js`), então não há arquivo
// `.pem` para ele guardar nem JSON para editar. Na prática quem chama isto é
// a skill do LegalSquad, quando o usuário diz "minha licença é LS-…" — o
// comando existe para que exista um mecanismo determinístico por trás da
// conversa.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CATALOG_URL_PADRAO, gravarConfigDeAcervo } from './acervo-config.js';
import { acervoCli } from './acervo-cli.js';

/** `LS-` + 4 blocos de 4 hex. Formato do `derivarChaveDeLicenca` do servidor. */
const FORMATO_LICENCA = /^LS(-[0-9A-F]{4}){4}$/;

/** Copiar de WhatsApp/e-mail traz espaço e caixa trocada; nada disso é erro do aluno. */
function normalizarLicenca(bruta) {
  return String(bruta || '').trim().toUpperCase();
}

/**
 * Confere a licença contra o servidor ANTES de gravar. Gravar uma licença que
 * o servidor rejeita faria todo `sync` seguinte falhar com uma mensagem sobre
 * outra coisa — o aluno ficaria perseguindo o sintoma errado.
 */
async function conferirLicenca(catalogUrl, licenca) {
  const resposta = await fetch(catalogUrl, { headers: { authorization: `Bearer ${licenca}` } });
  if (!resposta.ok) throw new Error(`o servidor respondeu HTTP ${resposta.status}`);
  const catalogo = await resposta.json();
  return catalogo?.status;
}

export async function ativarCli(licencaBruta, targetDir, options = {}) {
  const licenca = normalizarLicenca(licencaBruta);
  const catalogUrl = options.catalogUrl || CATALOG_URL_PADRAO;

  // `catalogUrl` sai também nos retornos de FALHA: é o que permite conferir,
  // sem rede, que a URL padrão embarcada é mesmo a usada quando ninguém passa
  // outra.
  if (!licenca) {
    console.error('ATIVAR:BLOQUEADO — informe a licença recebida na compra.');
    return { success: false, catalogUrl, error: { code: 'licenca-ausente' } };
  }

  if (!FORMATO_LICENCA.test(licenca)) {
    // Barrar aqui poupa uma ida ao servidor e dá um erro melhor: "formato"
    // aponta para erro de cópia, enquanto "não reconhecida" mandaria o aluno
    // duvidar da compra.
    console.error(
      `ATIVAR:BLOQUEADO — "${licenca}" não tem o formato de uma licença `
      + '(LS-XXXX-XXXX-XXXX-XXXX). Confira se ela foi copiada inteira.'
    );
    return { success: false, catalogUrl, error: { code: 'formato-invalido' } };
  }

  let status;
  try {
    status = await conferirLicenca(catalogUrl, licenca);
  } catch (erro) {
    console.error(
      `ATIVAR:BLOQUEADO — não consegui alcançar o servidor para conferir a licença (${erro.message}). `
      + 'Nada foi gravado; tente de novo quando houver conexão.'
    );
    return { success: false, error: { code: 'servidor-inacessivel', message: erro.message } };
  }

  if (status !== 'active' && status !== 'expired') {
    console.error(
      'ATIVAR:BLOQUEADO — essa licença não foi reconhecida pelo servidor. '
      + 'Confira se foi copiada inteira; se estiver certa, fale com quem vendeu.'
    );
    return { success: false, error: { code: 'licenca-nao-reconhecida' } };
  }

  const { caminho, conteudo } = gravarConfigDeAcervo(targetDir, {
    license: licenca,
    catalogUrl: options.catalogUrl,
  });
  mkdirSync(dirname(caminho), { recursive: true });
  writeFileSync(caminho, conteudo);

  if (status === 'expired') {
    // Vencida não é inválida (SPEC §8.0): o que já foi baixado continua
    // valendo, em leitura. Ativar e avisar é mais útil que recusar.
    console.log('ATIVAR:OK — licença ativada, mas está VENCIDA.');
    console.log('  O conteúdo já baixado continua funcionando; o que para é a atualização.');
  } else {
    console.log('ATIVAR:OK — licença válida e ativada.');
  }

  const resultado = { success: true, status, catalogUrl, licenca };
  if (options.skipSync) return resultado;

  // Ativar sem sincronizar deixaria o aluno com licença e sem conteúdo —
  // ele pediu para usar o produto, não para configurar um arquivo.
  const sync = await acervoCli('sync', targetDir, {});
  return { ...resultado, sync };
}
