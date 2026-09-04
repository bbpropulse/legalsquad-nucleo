#!/usr/bin/env node
// Gate único de verificação do LegalSquad — roda TUDO que mantém o repo íntegro
// antes de um commit/PR. É o que o CI (.github/workflows/ci.yml) executa.
//   node scripts/verify.mjs   (ou: npm run verify)
//
// lint + test já cobrem: sync do build:ide (ide-build.test.js), parity raiz↔template
// (templates-paridade.test.js) e integridade estrutural (integridade.test.js).
// Aqui adicionamos o que falta: type-check do dashboard e higiene do tarball npm.
//
// O que este gate exige (e o que NÃO exige mais): ele valida o MOTOR — contratos,
// resolvedor, scripts distribuídos, version file, ausência de vazamento de dados
// pessoais. Nenhuma exigência de conteúdo de área: não há contagem fixa de skills,
// nem nome de skill/calculadora/autoridade de matéria. Quando o tarball vier com
// um bundle de skills junto (instalação-produto que empacota um pacote de área),
// as invariantes desse bundle são checadas por DERIVAÇÃO — cada SKILL.md com seu
// contrato e seu agents/openai.yaml, cada motor determinístico chegando também aos
// templates do aluno.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Roda um comando; devolve { ok, out } capturando stdout+stderr (nunca lança).
// maxBuffer alto: a saída do `npm test` (logs dos testes de instalador) passa de 1 MB,
// o default do execSync — sem isso, o capture estouraria e marcaria falso-negativo.
function sh(cmd, opts = {}) {
  try {
    const out = execSync(cmd, {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
      ...opts,
    });
    return { ok: true, out };
  } catch (err) {
    const diagnostic = [
      `comando: ${cmd}`,
      `status: ${err.status ?? 'desconhecido'}; signal: ${err.signal ?? 'nenhum'}`,
      String(err.message || err),
    ].join('\n');
    return {
      ok: false,
      // O diagnóstico vem primeiro para continuar visível mesmo quando a saída
      // do subprocesso é grande e o provedor de CI limita o log do step.
      out: `${diagnostic}\n${err.stdout || ''}${err.stderr || ''}`,
    };
  }
}

const checks = [
  // package.json e o version file distribuído (fonte única em templates/) precisam
  // andar juntos — já divergiram uma vez (0.1.0 stale) e o update anuncia a versão
  // errada quando isso acontece. `npm run release` mantém os dois em sincronia.
  {
    name: 'versão consistente (package.json ↔ version file)',
    fn: () => {
      try {
        const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;
        const fileVersion = readFileSync(join(ROOT, 'templates', '_legalsquad', '.legalsquad-version'), 'utf-8').trim();
        return pkgVersion === fileVersion
          ? { ok: true, out: `v${pkgVersion}` }
          : { ok: false, out: `package.json diz ${pkgVersion} mas o version file diz ${fileVersion} — rode \`npm run release\` (ou sincronize à mão)` };
      } catch (err) {
        return { ok: false, out: String(err.message || err) };
      }
    },
  },

  // O roteamento usa o índice como fonte de verdade. Um índice stale, pasta
  // incompleta ou grafo inválido não pode chegar ao release silenciosamente.
  { name: 'catálogo de skills', fn: () => sh('npm run check:skills') },
  { name: 'contratos de qualidade das skills', fn: () => sh('npm run check:skill-quality') },
  { name: 'casos de skills v5', fn: () => sh('npm run check:skill-evals') },
  { name: 'registro vivo de autoridades', fn: () => sh('npm run check:legal-authorities') },

  // review-loop/run-state/skill-uso/squad-path vivem em 3 cópias cada (src/ é o
  // canônico; scripts/ e templates/scripts/ são cópias, porque o projeto do
  // usuário não tem src/ para importar). Não é risco teórico: o drift entre as
  // cópias já causou bug real, corrigido em d54672f. O teste de igualdade o
  // detecta, mas só aqui ele barra o RELEASE — e é a cópia de templates/scripts/
  // que vai para a máquina do usuário. Divergindo do canônico, o cliente roda um
  // motor diferente do que a suíte testou.
  { name: 'sincronia dos blocos duplicados', fn: () => sh('npm run check:blocos') },

  // src/ bin/ tests/ scripts/
  { name: 'lint', fn: () => sh('npm run lint') },

  // inclui build:ide sync, parity raiz↔template e integridade estrutural
  { name: 'test', fn: () => sh('npm test') },

  // type-check do dashboard (não está no npm test)
  {
    name: 'dashboard tsc',
    fn: () => {
      const dash = join(ROOT, 'dashboard');
      if (!existsSync(join(dash, 'node_modules'))) {
        return { ok: false, out: 'dashboard/node_modules ausente — rode `npm ci` em dashboard/' };
      }
      return sh('npx tsc -b', { cwd: dash });
    },
  },

  // higiene do tarball: sigilo/LGPD + distribuição correta
  {
    name: 'npm pack (higiene do tarball)',
    fn: () => {
      const res = sh('npm pack --dry-run --json');
      if (!res.ok) return res;
      let files;
      try {
        files = JSON.parse(res.out)[0].files.map((f) => f.path);
      } catch {
        return { ok: false, out: 'não consegui parsear a saída de `npm pack --json`' };
      }
      const count = (re) => files.filter((f) => re.test(f)).length;
      const problems = [];
      // NÃO pode vazar:
      if (count(/_legalsquad\/_memory\//)) problems.push('VAZAMENTO: _legalsquad/_memory/ no tarball (dado pessoal/LGPD)');
      if (count(/^squads\/[^/]+\/_memory\//)) problems.push('VAZAMENTO: squads/*/_memory/ (raiz) no tarball (sigilo/LGPD)');
      if (count(/templates\/ide-assets\//)) problems.push('templates/ide-assets/ (fonte build-time) não deve ir no tarball');
      // PRECISA estar presente:
      if (!count(/^scripts\/eval-resumo\.mjs$/)) problems.push('faltando scripts/eval-resumo.mjs no tarball');
      if (!count(/templates\/scripts\/eval-resumo\.mjs$/)) problems.push('faltando templates/scripts/eval-resumo.mjs no tarball');
      if (!count(/^scripts\/squad-state\.mjs$/)) problems.push('faltando scripts/squad-state.mjs no tarball');
      if (!count(/templates\/scripts\/squad-state\.mjs$/)) problems.push('faltando templates/scripts/squad-state.mjs no tarball (aluno não teria o escritor de state.json)');
      // Motores determinísticos são de ÁREA — quais existem depende do pacote.
      // O que o motor garante é PARIDADE: todo motor publicado na raiz precisa
      // chegar ao aluno em templates/scripts/legal-calculators/.
      for (const engine of files.filter((f) => /^scripts\/legal-calculators\/[^/]+\.mjs$/.test(f))) {
        const distributed = `templates/${engine}`;
        if (!files.includes(distributed)) problems.push(`motor determinístico não chega ao aluno: falta ${distributed}`);
      }
      if (!count(/templates\/scripts\/validate-legal-output\.mjs$/)) problems.push('faltando validador de sidecar nos templates');
      if (!count(/_legalsquad\/core\/state\.schema\.json$/)) problems.push('faltando o contrato _legalsquad/core/state.schema.json no tarball');
      if (!count(/_legalsquad\/core\/execution-output\.schema\.json$/)) problems.push('faltando o contrato de saída jurídica v4 no tarball');
      if (!count(/_legalsquad\/core\/skill-quality-profiles\.json$/)) problems.push('faltando os perfis de qualidade de skills no tarball');
      if (!count(/templates\/_legalsquad\/\.legalsquad-version$/)) problems.push('faltando o version file (templates/_legalsquad/.legalsquad-version)');
      if (!count(/templates\/squads\//)) problems.push('faltando templates/squads/ no tarball');
      if (!count(/templates\/ide-templates\/claude-code\/\.claude\/agents\/.+\.md$/)) problems.push('faltando os agentes (templates/.../claude-code/.claude/agents/) no tarball');
      // Bundle de skills: só existe quando um pacote de área é empacotado junto.
      // As invariantes são DERIVADAS da própria contagem — nada de número fixo,
      // que voltaria a acoplar o gate do motor ao tamanho de uma área.
      const skillCount = count(/^skills\/[^/]+\/SKILL\.md$/);
      if (skillCount) {
        const contracts = count(/^skills\/[^/]+\/references\/high-performance-contract\.md$/);
        const openai = count(/^skills\/[^/]+\/agents\/openai\.yaml$/);
        if (contracts !== skillCount) problems.push(`faltam contratos progressivos: ${contracts} para ${skillCount} SKILL.md`);
        if (openai !== skillCount) problems.push(`faltam metadados OpenAI: ${openai} para ${skillCount} SKILL.md`);
        if (!count(/^skills\/_evals\/catalog-v5\.json$/)) problems.push('faltando catálogo v5 de avaliações no tarball');
        if (!count(/^skills\/_evals\/promotion-evidence\.schema\.json$/)) problems.push('faltando schema v1 de evidência de promoção no tarball');
        if (!count(/^skills\/_evals\/README\.md$/)) problems.push('faltando guia de avaliação e promoção no tarball');
        // Antes desta linha, esta checagem era INCONDICIONAL — ao contrário
        // das vizinhas acima, que corretamente só exigem o bundle de área
        // quando skillCount > 0. skills-alta-performance.md é conteúdo de
        // área (dea4579 tirou-o do núcleo), então só faz sentido cobrar
        // presença dele no tarball quando skills/ também estiver presente.
        if (!count(/_legalsquad\/core\/best-practices\/skills-alta-performance\.md$/)) problems.push('faltando o padrão transversal de skills no tarball');
      }
      if (!count(/^src\/skill-runtime-policy\.js$/)) problems.push('faltando resolvedor fail-closed de skills no tarball');
      if (!count(/^src\/skill-runtime-cli\.js$/)) problems.push('faltando CLI do resolvedor de skills no tarball');
      if (!count(/^src\/skill-search\.js$/)) problems.push('faltando busca compacta do catálogo no tarball');
      if (!count(/^src\/skill-rank\.js$/)) problems.push('faltando motor de relevância da busca no tarball');
      // Relatório de qualidade só existe onde existe biblioteca de skills (área).
      // Ausente, nada a verificar; presente, não pode vazar caminho de máquina.
      const qualityReportPath = join(ROOT, 'skills', '_quality-report.json');
      if (existsSync(qualityReportPath)) {
        try {
          const qualityReport = JSON.parse(readFileSync(qualityReportPath, 'utf8'));
          const absoluteEvidencePaths = (qualityReport.results || [])
            .map((item) => item?.behavioralEvidence?.source)
            .filter((source) => typeof source === 'string')
            .filter((source) => source.startsWith('/') || /^[A-Za-z]:[\\/]/.test(source));
          if (absoluteEvidencePaths.length) {
            problems.push('VAZAMENTO: _quality-report.json contém caminhos absolutos da máquina-fonte');
          }
        } catch {
          problems.push('skills/_quality-report.json inválido (JSON ilegível)');
        }
      }
      return problems.length ? { ok: false, out: problems.join('\n') } : { ok: true, out: `${files.length} arquivos; invariantes OK` };
    },
  },
];

console.log('\n  LegalSquad — verify\n');
let failed = 0;
for (const { name, fn } of checks) {
  process.stdout.write(`  • ${name} ... `);
  const { ok, out } = fn();
  if (ok) {
    console.log('✓');
  } else {
    failed++;
    console.log('✗');
    console.log(out.split('\n').map((l) => '      ' + l).join('\n'));
  }
}
console.log('');
if (failed) {
  console.log(`  ✗ verify falhou (${failed}/${checks.length} checagens)\n`);
  process.exit(1);
}
console.log(`  ✓ verify passou (${checks.length}/${checks.length} checagens)\n`);
