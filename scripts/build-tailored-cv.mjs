#!/usr/bin/env node
/**
 * build-tailored-cv.mjs - Generate JD-tailored HTML from cv-template.html
 *
 * Usage: node scripts/build-tailored-cv.mjs <profile-key>
 *   profile-key: "sierra" | "cohere" | "lindy"
 *
 * Reads cv-template.html + config/profile.yml + per-job profile data,
 * outputs to /tmp/cv-anmol-sahu-<profile-key>.html
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const profile = process.argv[2];
if (!['sierra', 'cohere', 'lindy'].includes(profile)) {
  console.error('Usage: node scripts/build-tailored-cv.mjs <sierra|cohere|lindy>');
  process.exit(1);
}

const TEMPLATE = readFileSync(resolve(root, 'templates/cv-template.html'), 'utf8');

// Per-job tailored content
const profiles = {
  sierra: {
    summary: `CMU MISM master's student bridging 2.5 yrs production SWE at Byju's (200K+ DAU e-commerce, $400K AWS→GCP migration) into applied AI. Shipped <strong>Cloudify</strong> at TartanHacks 2026 - multi-agent platform using OpenAI + Anthropic Claude APIs (Dedalus SDK) that decomposes full-stack cloud migration into agent-callable skills, days → &lt;20 minutes across 8+ stack configurations. Currently building Highmark cancer-staging XGBoost pipeline on 6M+ claims records. 6 hackathon wins, ~$22K in prizes including 1st at Red Hat Hack APAC. F-1 / CPT-eligible.`,
    competencies: ['Multi-agent orchestration', 'OpenAI &amp; Anthropic APIs', 'Eval frameworks', 'RAG pipelines', 'Agent tooling (Dedalus SDK)', 'Production LLM systems', 'Python / PyTorch', 'React / Node.js'],
    projectsOrder: ['cloudify', 'highmark', 'personalized', 'multimodal'],
  },
  cohere: {
    summary: `CMU MISM master's student. 2.5 yrs production SWE at Byju's (200K+ DAU, $400K AWS→GCP migration, 100% test coverage on Scheduling microservice). Built ML rank-prediction pipeline (70%+ multi-class accuracy). Shipped LLM applications (Cloudify multi-agent OpenAI+Claude, Personalized Content GPT-4 + Llama 3) and currently scaling Highmark cancer-staging XGBoost on 6M+ claims. F-1 / CPT-eligible.`,
    competencies: ['Distributed data pipelines', 'SQL at scale (6M+ records)', 'LLM API integration', 'Python / PyTorch / XGBoost', 'Microservices', 'Production ML', 'Internal tooling / CI/CD', 'Cloud (AWS / GCP)'],
    projectsOrder: ['highmark', 'cloudify', 'personalized', 'multimodal'],
  },
  lindy: {
    summary: `CMU MISM master's. Shipped <strong>Cloudify</strong> at TartanHacks 2026 - multi-agent OpenAI + Anthropic Claude system, days → &lt;20 minutes cloud migration, 8+ stack configs. 2.5 yrs SDE at Byju's: built e-commerce (200K+ DAU) and DRM e-book platform used daily by 400K+ paid subscribers. 6 hackathon wins (~$22K prizes incl. 1st at Red Hat Hack APAC). F-1 / CPT-eligible. Picks up languages fast (bridged Java/C++ → Python in 2 months at CMU).`,
    competencies: ['Agentic workflows', 'LLM APIs (OpenAI / Anthropic)', 'React / Node.js / Python', 'Full-stack production', 'Shipping fast under deadline', 'Multi-agent orchestration', 'Real users at scale (400K+)', 'Hackathon execution'],
    projectsOrder: ['cloudify', 'byjus_drm', 'personalized', 'multimodal'],
  },
};

const PROJECTS = {
  cloudify: {
    title: 'Cloudify - Agentic Cloud Migration',
    badge: 'TartanHacks 2026 · github.com/anmolsahu2k/cloudify',
    desc: 'Multi-agent automation platform using <strong>OpenAI</strong> and <strong>Anthropic Claude APIs</strong> (Dedalus SDK). Decomposes full-stack cloud migration into agent-callable skills (dependency analysis, IaC generation, secret rotation, smoke-test validation). Days → &lt;20 minutes across 8+ stack configurations on AWS, GCP, and Heroku via single CLI.',
    tech: 'OpenAI · Anthropic · Dedalus SDK · Python · Multi-agent orchestration',
  },
  highmark: {
    title: 'Estimating Cancer Stage at Scale',
    badge: 'Highmark × CMU · Jan 2026 - present',
    desc: 'XGBoost-based proxy cancer-staging inference pipeline over <strong>6M+ longitudinal claims records</strong> spanning 20,323 members. Trained on 3,657 EMR-labeled cases to infer stages for 16,666+ undocumented members. Augmented features with NCCN clinical guidelines (treatment-pathway encoding, biomarker proxies, procedure-code clustering) to address <strong>40-51% missingness</strong> in primary staging fields.',
    tech: 'Python · XGBoost · scikit-learn · SQL · NCCN guidelines',
  },
  personalized: {
    title: 'Personalized Content Generator',
    badge: 'Oct - Nov 2025',
    desc: 'LLM-driven content service using <strong>Flask + GPT-4 + locally deployed Llama 3</strong> with adaptive prompt templates and per-user preference modeling. <strong>38% engagement lift, sub-3-second latency</strong> across 5 subject domains.',
    tech: 'GPT-4 · Llama 3 · Flask · Python · Prompt engineering',
  },
  multimodal: {
    title: 'Multimodal Sentiment-Driven Stock Prediction',
    badge: 'Sep - Oct 2025',
    desc: 'Multimodal pipeline fusing sentiment analysis on 12,000+ news articles, OHLCV time-series, and candlestick image classification (OpenCV). <strong>67% directional accuracy</strong> across 50 S&amp;P 500 tickers over 2-year backtest.',
    tech: 'PyTorch · OpenCV · scikit-learn · Pandas',
  },
  byjus_drm: {
    title: 'Byju\'s - DRM-Protected E-Book Platform',
    badge: 'Production · 400K+ subscribers',
    desc: 'Built React-pdf-based e-book reader with full-text search, jump-to-page, chapter tabs, and OS-level screenshot/recording prevention. Daily reading surface for <strong>400K+ paid subscribers</strong>; eliminated hard-copy distribution costs.',
    tech: 'React · TypeScript-adjacent · DRM · Native bridging',
  },
};

const sel = profiles[profile];

const competenciesHTML = sel.competencies.map(c => `<div class="competency-tag">${c}</div>`).join('\n      ');

const experienceHTML = `
    <div class="role">
      <div class="role-header">
        <span class="company">Byju's</span>
        <span class="role-meta">Software Engineer · Bengaluru, India · Oct 2023 - July 2025</span>
      </div>
      <ul class="role-bullets">
        <li><strong>ML Rank Prediction Pipeline:</strong> Designed and deployed multi-class rank prediction model for national-level competitive exams; feature engineering on historical performance data; <strong>70%+ classification accuracy</strong> in production.</li>
        <li><strong>High-Traffic E-Commerce Platform:</strong> Developed e-commerce portal serving <strong>200,000+ daily users</strong>; sales costs -15%, ARPU +20% via optimized checkout workflows.</li>
        <li><strong>Cloud Infrastructure Migration:</strong> Contributed to AWS → GCP migration of application + data infrastructure; <strong>$400K annual savings</strong> with improved reliability and deployment scalability.</li>
        <li><strong>Content Migration at Scale:</strong> Migrated and restructured 10,000+ articles ReactJS → WordPress with SEO tagging; organic traffic 2.5×, page speed 30×.</li>
        <li><strong>Secure E-Book Viewer:</strong> Engineered DRM-protected PDF reader with full-text search, jump-to-page, OS-level screenshot prevention; secured premium content for 400K+ paid subscribers.</li>
      </ul>
    </div>
    <div class="role">
      <div class="role-header">
        <span class="company">Byju's</span>
        <span class="role-meta">Software Engineer Intern · Jan 2023 - Oct 2023</span>
      </div>
      <ul class="role-bullets">
        <li><strong>Microservice Architecture Migration:</strong> Refactored services across <strong>10+ legacy verticals</strong> into unified horizontal microservice topology; reduced deployment complexity, improved scalability.</li>
        <li><strong>Service Reliability Engineering:</strong> Authored unit-test suite for Scheduling microservice backend reaching <strong>100% code coverage</strong>; eliminated regression class.</li>
        <li><strong>Batching Service Frontend:</strong> Built and owned the Batching service frontend end-to-end; bug resolution time -25%, consistently shipped ahead of sprint deadlines.</li>
      </ul>
    </div>`;

const projectsHTML = sel.projectsOrder.map(key => {
  const p = PROJECTS[key];
  return `
    <div class="project">
      <div class="project-title">
        <span>${p.title}</span>
        <span class="project-badge">${p.badge}</span>
      </div>
      <div class="project-desc">${p.desc}</div>
      <div class="project-tech">${p.tech}</div>
    </div>`;
}).join('\n');

const educationHTML = `
    <div class="edu-item">
      <div class="edu-header">
        <span class="edu-school">Carnegie Mellon University</span>
        <span class="edu-meta">Aug 2025 - Dec 2026</span>
      </div>
      <div class="edu-degree">Master of Information Systems Management (Heinz College) · CGPA <strong>3.75 / 4.00</strong></div>
      <div class="edu-coursework">Coursework: Intro to Deep Learning · Machine Learning for Problem Solving · Unstructured Data Analytics · Advanced Business Analytics · Data Focused Python · OOP Java</div>
    </div>
    <div class="edu-item">
      <div class="edu-header">
        <span class="edu-school">Vellore Institute of Technology</span>
        <span class="edu-meta">July 2019 - May 2023</span>
      </div>
      <div class="edu-degree">B.Tech, Computer Science &amp; Engineering · CGPA <strong>3.87 / 4.00</strong></div>
    </div>`;

const skillsHTML = `
    <div class="skills-grid">
      <div class="skill-item"><span class="skill-category">Languages:</span> Python, Java, JavaScript, SQL, C++, PHP</div>
      <div class="skill-item"><span class="skill-category">ML / AI:</span> PyTorch, XGBoost, scikit-learn, OpenCV, Pandas, NumPy, OpenAI API, Anthropic Claude API, Dedalus SDK, RAG, prompt engineering, multi-agent orchestration</div>
      <div class="skill-item"><span class="skill-category">Backend:</span> Spring Boot, Flask, Node.js, Express, GraphQL, Mockito</div>
      <div class="skill-item"><span class="skill-category">Frontend:</span> React, Next.js, Redux</div>
      <div class="skill-item"><span class="skill-category">Cloud / Infra:</span> AWS, GCP, Docker, Firebase, MongoDB Atlas, Redis, Grafana, Postman</div>
      <div class="skill-item"><span class="skill-category">Healthcare-data:</span> ICD-10 / CPT / HCPCS, NCCN clinical guidelines, longitudinal claims modeling</div>
    </div>`;

// Replace placeholders
const html = TEMPLATE
  .replaceAll('{{LANG}}', 'en')
  .replaceAll('{{PAGE_WIDTH}}', '8.5in')
  .replaceAll('{{NAME}}', 'Anmol Sahu')
  .replaceAll('{{PHONE}}', '+1 (412) 689-3928')
  .replaceAll('{{EMAIL}}', 'anmolsahu2k@gmail.com')
  .replaceAll('{{LINKEDIN_URL}}', 'https://linkedin.com/in/anmolsahu2k')
  .replaceAll('{{LINKEDIN_DISPLAY}}', 'linkedin.com/in/anmolsahu2k')
  .replaceAll('{{PORTFOLIO_URL}}', 'https://github.com/anmolsahu2k/cloudify')
  .replaceAll('{{PORTFOLIO_DISPLAY}}', 'github.com/anmolsahu2k/cloudify')
  .replaceAll('{{LOCATION}}', 'Pittsburgh, PA · Available June 1, 2026')
  .replaceAll('{{SECTION_SUMMARY}}', 'Professional Summary')
  .replaceAll('{{SECTION_COMPETENCIES}}', 'Core Competencies')
  .replaceAll('{{SECTION_EXPERIENCE}}', 'Work Experience')
  .replaceAll('{{SECTION_PROJECTS}}', 'Projects')
  .replaceAll('{{SECTION_EDUCATION}}', 'Education')
  .replaceAll('{{SECTION_SKILLS}}', 'Skills')
  .replaceAll('{{SECTION_CERTIFICATIONS}}', '')
  .replaceAll('{{CERTIFICATIONS}}', '')
  .replaceAll('{{SUMMARY_TEXT}}', sel.summary)
  .replaceAll('{{COMPETENCIES}}', competenciesHTML)
  .replaceAll('{{EXPERIENCE}}', experienceHTML)
  .replaceAll('{{PROJECTS}}', projectsHTML)
  .replaceAll('{{EDUCATION}}', educationHTML)
  .replaceAll('{{SKILLS}}', skillsHTML);

const outPath = `/tmp/cv-anmol-sahu-${profile}.html`;
writeFileSync(outPath, html);
console.log(`Wrote ${outPath} (${html.length} bytes)`);
