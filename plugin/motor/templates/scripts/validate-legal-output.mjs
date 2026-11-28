#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REQUIRED = [
  'schema_version', 'status', 'objetivo_juridico', 'polo', 'fase_processual',
  'cronologia', 'fatos_documentados', 'provas', 'inferencias', 'lacunas_documentais',
  'teses', 'objecoes_provaveis', 'respostas_e_distinguishing',
  'regra_temporal_aplicada', 'citacoes_verificadas', 'calculos', 'riscos',
  'nivel_confianca', 'pedido_operacional', 'proxima_acao',
  'revisao_humana_obrigatoria',
];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateAnchored(items, path, errors) {
  if (!Array.isArray(items)) {
    errors.push(`${path} deve ser array`);
    return;
  }
  items.forEach((item, index) => {
    if (!isObject(item) || !item.conteudo || !item.ancora) {
      errors.push(`${path}[${index}] exige conteudo e ancora`);
    }
  });
}

export function validateLegalOutput(value, { release = false } = {}) {
  const errors = [];
  if (!isObject(value)) return { ok: false, errors: ['saída deve ser objeto JSON'] };

  for (const key of REQUIRED) {
    if (!(key in value)) errors.push(`campo obrigatório ausente: ${key}`);
  }
  if (value.schema_version !== '4') errors.push('schema_version deve ser "4"');
  if (!['concluido', 'concluido_com_ressalvas', 'bloqueado'].includes(value.status)) {
    errors.push('status inválido');
  }
  if (value.revisao_humana_obrigatoria !== true) {
    errors.push('revisao_humana_obrigatoria deve ser true');
  }

  validateAnchored(value.cronologia, 'cronologia', errors);
  validateAnchored(value.fatos_documentados, 'fatos_documentados', errors);
  validateAnchored(value.provas, 'provas', errors);

  if (!isObject(value.teses)) {
    errors.push('teses deve ser objeto');
  } else {
    for (const group of ['principal', 'subsidiarias', 'exploratorias']) {
      if (!Array.isArray(value.teses[group])) errors.push(`teses.${group} deve ser array`);
    }
  }

  if (!isObject(value.regra_temporal_aplicada)) {
    errors.push('regra_temporal_aplicada deve ser objeto');
  } else {
    if (!['verificada', 'pendente', 'controvertida', 'nao_aplicavel'].includes(value.regra_temporal_aplicada.status)) {
      errors.push('regra_temporal_aplicada.status inválido');
    }
    if (!Array.isArray(value.regra_temporal_aplicada.fontes)) {
      errors.push('regra_temporal_aplicada.fontes deve ser array');
    }
  }

  if (!Array.isArray(value.citacoes_verificadas)) {
    errors.push('citacoes_verificadas deve ser array');
  } else {
    value.citacoes_verificadas.forEach((citation, index) => {
      if (!isObject(citation) || !citation.titulo || !citation.status) {
        errors.push(`citacoes_verificadas[${index}] incompleta`);
      }
    });
  }

  if (!Array.isArray(value.calculos)) {
    errors.push('calculos deve ser array');
  } else {
    value.calculos.forEach((calculo, index) => {
      if (!isObject(calculo) || !calculo.motor || !calculo.versao || !calculo.regra_id) {
        errors.push(`calculos[${index}] exige motor, versao e regra_id`);
      }
      if (!Array.isArray(calculo?.memoria)) errors.push(`calculos[${index}].memoria deve ser array`);
      if (!isObject(calculo?.inputs)) errors.push(`calculos[${index}].inputs deve ser objeto`);
    });
  }

  if (!isObject(value.riscos) || !Array.isArray(value.riscos?.hard_fails) || !Array.isArray(value.riscos?.ressalvas)) {
    errors.push('riscos exige hard_fails e ressalvas em arrays');
  }

  if (/\[(NÃO VERIFICADO|NAO VERIFICADO|DIVERGENTE)\]/i.test(JSON.stringify(value))) {
    errors.push('marcador de citação pendente encontrado');
  }

  if (release) {
    if (value.status !== 'concluido') errors.push('release exige status concluido');
    if ((value.riscos?.hard_fails || []).length) errors.push('release bloqueado por hard fail');
    if (value.regra_temporal_aplicada?.status === 'pendente' || value.regra_temporal_aplicada?.status === 'controvertida') {
      errors.push('release bloqueado por regra temporal não resolvida');
    }
    for (const [index, citation] of (value.citacoes_verificadas || []).entries()) {
      if (citation.status !== 'verificada' || !citation.url_oficial || !citation.consultada_em) {
        errors.push(`release exige citação ${index} verificada, com URL oficial e data`);
      }
    }
    for (const [index, calculo] of (value.calculos || []).entries()) {
      if (calculo.revisado_por_humano !== true) errors.push(`release exige revisão humana do cálculo ${index}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function main(argv) {
  const release = argv.includes('--release');
  const file = argv.find((arg) => arg !== '--release');
  if (!file) {
    console.error('Uso: node scripts/validate-legal-output.mjs [--release] <sidecar.json>');
    process.exitCode = 2;
    return;
  }
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`JSON inválido: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  const result = validateLegalOutput(value, { release });
  if (!result.ok) {
    console.error(result.errors.map((error) => `- ${error}`).join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(`Sidecar v4 válido${release ? ' para release' : ''}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
