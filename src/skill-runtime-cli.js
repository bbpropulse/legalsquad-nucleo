import { resolveSkillRuntime } from './skill-runtime-policy.js';

function parsePilotFallbacks(values = []) {
  const result = new Map();
  for (const raw of values) {
    const [pilot, fallback, ...extra] = String(raw).split('=');
    if (!pilot || !fallback || extra.length > 0) {
      throw new Error(`Fallback inválido '${raw}'. Use pilot=skill-active.`);
    }
    if (result.has(pilot) && result.get(pilot) !== fallback) {
      throw new Error(`Fallback conflitante para '${pilot}'.`);
    }
    result.set(pilot, fallback);
  }
  return result;
}

function printDecision(decision) {
  if (decision.allowed) {
    const fallback = decision.fallback ? `; fallback=${decision.fallback}` : '';
    console.log(`  ✓ ${decision.id}: ${decision.disposition}${fallback}`);
    return;
  }
  const codes = decision.reasons.map((item) => item.code).join(', ');
  console.error(`  ✗ ${decision.id}: ${codes}`);
}

export function skillRuntimeCli(skillIds, targetDir, values = {}) {
  let result;
  try {
    if (values.selection === true && values['explicit-selection'] === true) {
      throw new Error('Use apenas --selection ou --explicit-selection, nunca ambos.');
    }
    const mode = values.selection === true
      ? 'selection'
      : values['explicit-selection'] === true ? 'explicit-selection' : 'execution';
    result = resolveSkillRuntime(skillIds, {
      rootDir: targetDir,
      mode,
      supervised: values.supervised === true,
      pilotOptIns: new Set(values['pilot-opt-in'] || []),
      pilotFallbacks: parsePilotFallbacks(values['pilot-fallback'] || []),
    });
  } catch (error) {
    const failure = {
      success: false,
      mode: values.selection === true
        ? 'selection'
        : values['explicit-selection'] === true ? 'explicit-selection' : 'execution',
      selected: null,
      decisions: [],
      error: { code: 'runtime-policy-error', message: error.message },
    };
    if (values.json === true) console.log(JSON.stringify(failure));
    else console.error(`RUNTIME_SKILLS:BLOCKED\n  ✗ ${error.message}`);
    return failure;
  }

  if (values.json === true) {
    console.log(JSON.stringify(result));
    return result;
  }

  if (['selection', 'explicit-selection'].includes(result.mode) && result.success) {
    console.log(`RUNTIME_SKILLS:SELECTED ${result.selected}`);
  } else {
    console.log(result.success ? 'RUNTIME_SKILLS:PASS' : 'RUNTIME_SKILLS:BLOCKED');
  }
  for (const decision of result.decisions) printDecision(decision);
  if (result.error) console.error(`  ✗ ${result.error.code}: ${result.error.message}`);
  return result;
}
