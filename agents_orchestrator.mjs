import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = __dirname;
const SKILLS_DIR = path.join(ROOT_DIR, 'skills_agents');
const CONFIG_DIR = path.join(ROOT_DIR, 'config_agents');
const CONTEXT_PATH = path.join(ROOT_DIR, 'context_agents', 'project_state.json');

const PYTHON_BIN = process.env.PYTHON_BIN || process.env.PYTHON || 'python';

const skillCatalog = {
  sqlDatabaseAssistant: {
    id: 'sql-database-assistant',
    group: 'blockchain-api-analysis',
    root: path.join(SKILLS_DIR, 'blockchain-api-analysis', 'sql-database-assistant'),
    source: 'https://github.com/alirezarezvani/claude-skills/tree/main/engineering/skills/sql-database-assistant',
  },
  browserAutomation: {
    id: 'browser-automation',
    group: 'blockchain-api-analysis',
    root: path.join(SKILLS_DIR, 'blockchain-api-analysis', 'browser-automation'),
    source: 'https://github.com/alirezarezvani/claude-skills/tree/main/engineering/skills/browser-automation',
  },
  financialAnalyst: {
    id: 'financial-analyst',
    group: 'math',
    root: path.join(SKILLS_DIR, 'math', 'financial-analyst'),
    source: 'https://github.com/alirezarezvani/claude-skills/tree/main/finance/skills/financial-analyst',
  },
  pulse: {
    id: 'pulse',
    group: 'social',
    root: path.join(SKILLS_DIR, 'social', 'pulse'),
    source: 'https://github.com/alirezarezvani/claude-skills/tree/main/research/pulse/skills/pulse',
  },
  socialMediaAnalyzer: {
    id: 'social-media-analyzer',
    group: 'social',
    root: path.join(SKILLS_DIR, 'social', 'social-media-analyzer'),
    source: 'https://github.com/alirezarezvani/claude-skills/tree/main/marketing-skill/skills/social-media-analyzer',
  },
  socialContent: {
    id: 'social-content',
    group: 'social',
    root: path.join(SKILLS_DIR, 'social', 'social-content'),
    source: 'https://github.com/alirezarezvani/claude-skills/tree/main/marketing-skill/skills/social-content',
  },
  contentProduction: {
    id: 'content-production',
    group: 'social',
    root: path.join(SKILLS_DIR, 'social', 'content-production'),
    source: 'https://github.com/alirezarezvani/claude-skills/tree/main/marketing-skill/skills/content-production',
  },
  copywriting: {
    id: 'copywriting',
    group: 'social',
    root: path.join(SKILLS_DIR, 'social', 'copywriting'),
    source: 'https://github.com/alirezarezvani/claude-skills/tree/main/marketing-skill/skills/copywriting',
  },
  telegramAutoposting: {
    id: 'telegram-autoposting',
    group: 'social',
    root: path.join(SKILLS_DIR, 'social', 'telegram-autoposting'),
    source: 'user-provided previous-project examples: botTelegram.mjs/myBlog.json',
  },
  postStylePreservation: {
    id: 'post-style-preservation',
    group: 'social',
    root: path.join(SKILLS_DIR, 'social', 'post-style-preservation'),
    source: 'user-provided previous-project examples: manager_menu_func.mjs/myBlog.json',
  },
};

function parseSkillMetadata(markdown) {
  const metadata = {};
  const frontmatter = markdown.match(/^<!-- Source:[^\n]+ -->\s*\r?\n---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) {
    return metadata;
  }

  for (const line of frontmatter[1].split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    metadata[match[1]] = value;
  }
  return metadata;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadSkill(skill) {
  const skillPath = path.join(skill.root, 'SKILL.md');
  const markdown = await readFile(skillPath, 'utf8');
  return {
    ...skill,
    skillPath,
    instructions: markdown,
    metadata: parseSkillMetadata(markdown),
  };
}

async function runPython(args, options = {}) {
  const { cwd = ROOT_DIR, input } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python exited ${code}: ${stderr || stdout}`));
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

function jsonFromStdout(stdout) {
  return stdout ? JSON.parse(stdout) : null;
}

class Tool {
  constructor({ name, description, skill, run }) {
    this.name = name;
    this.description = description;
    this.skill = skill;
    this.run = run;
  }
}

class Agent {
  constructor({ id, role, config, tools }) {
    this.id = id;
    this.role = role;
    this.config = config;
    this.tools = tools;
  }

  manifest() {
    return {
      id: this.id,
      role: this.role,
      tools: this.tools.map((tool) => ({
        name: tool.name,
        skill: tool.skill.id,
        source: tool.skill.source,
      })),
    };
  }
}

async function buildTools(skills) {
  const sqlSkill = skills.sqlDatabaseAssistant;
  const browserSkill = skills.browserAutomation;
  const financeSkill = skills.financialAnalyst;
  const pulseSkill = skills.pulse;
  const socialAnalyzerSkill = skills.socialMediaAnalyzer;
  const telegramAutopostingSkill = skills.telegramAutoposting;
  const postStylePreservationSkill = skills.postStylePreservation;

  return {
    optimizeSqlQuery: new Tool({
      name: 'optimizeSqlQuery',
      description: 'Static SQL/API data query quality check for Supabase/Postgres usage.',
      skill: sqlSkill,
      run: async ({ query, dialect = 'postgres' }) => {
        const script = path.join(sqlSkill.root, 'scripts', 'query_optimizer.py');
        const result = await runPython([script, '--query', query, '--dialect', dialect, '--json']);
        return jsonFromStdout(result.stdout);
      },
    }),
    buildScrapingConfig: new Tool({
      name: 'buildScrapingConfig',
      description: 'Build a browser scraping config for terminal/API web pages without executing scraping.',
      skill: browserSkill,
      run: async ({ url, selectors, paginate = false }) => {
        const script = path.join(browserSkill.root, 'scripts', 'scraping_toolkit.py');
        const args = [script, '--url', url, '--selectors', selectors, '--json'];
        if (paginate) {
          args.push('--paginate');
        }
        const result = await runPython(args);
        return jsonFromStdout(result.stdout);
      },
    }),
    calculateFinancialRatios: new Tool({
      name: 'calculateFinancialRatios',
      description: 'Run stdlib financial/math ratios for scoring-style analysis.',
      skill: financeSkill,
      run: async ({ inputPath, category } = {}) => {
        const script = path.join(financeSkill.root, 'scripts', 'ratio_calculator.py');
        const dataPath = inputPath || path.join(financeSkill.root, 'assets', 'sample_financial_data.json');
        const args = [script, dataPath, '--format', 'json'];
        if (category) {
          args.push('--category', category);
        }
        const result = await runPython(args);
        return jsonFromStdout(result.stdout);
      },
    }),
    calculatePulseWindow: new Tool({
      name: 'calculatePulseWindow',
      description: 'Calculate deterministic recency windows for Reddit/HN/web social pulse research.',
      skill: pulseSkill,
      run: async ({ window = '30d', referenceDate } = {}) => {
        const script = path.join(pulseSkill.root, 'scripts', 'time_window_calculator.py');
        const args = [script, '--window', window, '--output', 'json'];
        if (referenceDate) {
          args.push('--reference-date', referenceDate);
        }
        const result = await runPython(args);
        return jsonFromStdout(result.stdout);
      },
    }),
    analyzeSocialMetrics: new Tool({
      name: 'analyzeSocialMetrics',
      description: 'Calculate engagement, ROI, benchmark status, and SMM recommendations.',
      skill: socialAnalyzerSkill,
      run: async ({ inputPath } = {}) => {
        const dataPath = inputPath || path.join(socialAnalyzerSkill.root, 'assets', 'sample_input.json');
        const metricsPath = path.join(socialAnalyzerSkill.root, 'scripts', 'calculate_metrics.py');
        const performancePath = path.join(socialAnalyzerSkill.root, 'scripts', 'analyze_performance.py');
        const code = `
import importlib.util, json
from pathlib import Path

def load_module(name, file_path):
    spec = importlib.util.spec_from_file_location(name, file_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

data = json.loads(Path(r'''${dataPath}''').read_text(encoding='utf-8'))
data.pop('_source', None)
metrics_module = load_module('calculate_metrics', r'''${metricsPath}''')
performance_module = load_module('analyze_performance', r'''${performancePath}''')
metrics = metrics_module.SocialMediaMetricsCalculator(data).analyze_all()
insights = performance_module.PerformanceAnalyzer(
    metrics['campaign_metrics'],
    metrics['roi_metrics']
).generate_insights()
print(json.dumps({'metrics': metrics, 'insights': insights}, ensure_ascii=False))
`;
        const result = await runPython(['-c', code]);
        return jsonFromStdout(result.stdout);
      },
    }),
    planTelegramAutoposting: new Tool({
      name: 'planTelegramAutoposting',
      description: 'Plan approval-first Telegram MTProto publishing with encrypted session restore.',
      skill: telegramAutopostingSkill,
      run: async ({ channel = '@AImodelingAgency' } = {}) => ({
        channel,
        approvalFirst: true,
        sessionFile: 'data/telegram-mtproto-session.enc.json',
        fallbackChannel: '@myPublicGroupAI',
      }),
    }),
    preservePostStyle: new Tool({
      name: 'preservePostStyle',
      description: 'Summarize style-preservation inputs for social draft generation.',
      skill: postStylePreservationSkill,
      run: async ({ posts = [], event = {} } = {}) => ({
        samples: posts.length,
        eventType: event.type || 'unknown',
        guardrails: ['no copied phrases', 'manual trading decisions only', 'approval basket first'],
      }),
    }),
  };
}

async function loadAgents(tools) {
  const [engineerConfig, copywriterConfig, smmConfig] = await Promise.all([
    readFile(path.join(CONFIG_DIR, 'engineer.md'), 'utf8'),
    readFile(path.join(CONFIG_DIR, 'copywriter.md'), 'utf8'),
    readFile(path.join(CONFIG_DIR, 'smm.md'), 'utf8'),
  ]);

  return [
    new Agent({
      id: 'engineer',
      role: 'Developer / blockchain analyst / mathematician',
      config: engineerConfig,
      tools: [
        tools.optimizeSqlQuery,
        tools.buildScrapingConfig,
        tools.calculateFinancialRatios,
        tools.calculatePulseWindow,
      ],
    }),
    new Agent({
      id: 'copywriter',
      role: 'Habr/Dzen long-form content drafter',
      config: copywriterConfig,
      tools: [tools.calculatePulseWindow, tools.analyzeSocialMetrics],
    }),
    new Agent({
      id: 'smm',
      role: 'Telegram/SMM signal packaging analyst',
      config: smmConfig,
      tools: [
        tools.analyzeSocialMetrics,
        tools.calculatePulseWindow,
        tools.planTelegramAutoposting,
        tools.preservePostStyle,
      ],
    }),
  ];
}

async function verifySkillFiles(skills) {
  const missing = [];
  for (const skill of Object.values(skills)) {
    if (!(await fileExists(skill.skillPath))) {
      missing.push(skill.skillPath);
    }
  }
  if (missing.length) {
    throw new Error(`Missing skill files: ${missing.join(', ')}`);
  }
}

async function createOrchestrator() {
  const loadedSkills = {};
  for (const [key, skill] of Object.entries(skillCatalog)) {
    loadedSkills[key] = await loadSkill(skill);
  }

  await verifySkillFiles(loadedSkills);
  const tools = await buildTools(loadedSkills);
  const agents = await loadAgents(tools);
  const context = JSON.parse(await readFile(CONTEXT_PATH, 'utf8'));

  return { agents, tools, skills: loadedSkills, context };
}

async function runSmoke(orchestrator) {
  const { tools } = orchestrator;
  const checks = {
    optimizeSqlQuery: await tools.optimizeSqlQuery.run({
      query: 'SELECT * FROM wallet_links ORDER BY created_at DESC;',
    }),
    buildScrapingConfig: await tools.buildScrapingConfig.run({
      url: 'https://example.com/pools',
      selectors: '.token,.liquidity,.volume',
    }),
    calculateFinancialRatios: await tools.calculateFinancialRatios.run({
      category: 'profitability',
    }),
    calculatePulseWindow: await tools.calculatePulseWindow.run({
      window: '30d',
      referenceDate: '2026-05-25',
    }),
    analyzeSocialMetrics: await tools.analyzeSocialMetrics.run(),
    planTelegramAutoposting: await tools.planTelegramAutoposting.run(),
    preservePostStyle: await tools.preservePostStyle.run({
      posts: ['пример прошлого поста'],
      event: { type: 'trading_metrics' },
    }),
  };

  return {
    status: 'ok',
    autoposting: false,
    agents: orchestrator.agents.map((agent) => agent.manifest()),
    skills: Object.values(orchestrator.skills).map((skill) => ({
      id: skill.id,
      group: skill.group,
      name: skill.metadata.name || skill.id,
      source: skill.source,
    })),
    smoke: {
      optimizeSqlQueryScore: checks.optimizeSqlQuery.analyses[0].score,
      scrapingConfigUrl: checks.buildScrapingConfig.url,
      profitabilityRatioCount: Object.keys(checks.calculateFinancialRatios.ratios || {}).length,
      pulseWindow: checks.calculatePulseWindow.human_label,
      socialHealth: checks.analyzeSocialMetrics.insights.overall_health,
    },
  };
}

async function main() {
  const orchestrator = await createOrchestrator();
  const result = await runSmoke(orchestrator);
  console.log(JSON.stringify(result, null, 2));
}

if (__filename === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { Agent, Tool, buildTools, createOrchestrator, runSmoke };
