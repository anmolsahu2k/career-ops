import fs from 'fs';
let content = fs.readFileSync('ft/data/applications.md', 'utf-8');

content = content.replace(
  /\| 5195 \| 2026-09-02 \| ElevenLabs \|([^|]+)\| Rejected-at-eval \| Evaluated \|/g,
  '| 5195 | 2026-09-02 | ElevenLabs |$1| 2.0/5 | Rejected-at-eval |'
);
content = content.replace(
  /\| 5196 \| 2026-09-02 \| ElevenLabs \|([^|]+)\| Rejected-at-eval \| Evaluated \|/g,
  '| 5196 | 2026-09-02 | ElevenLabs |$1| 2.0/5 | Rejected-at-eval |'
);
content = content.replace(
  /\| 5197 \| 2026-09-02 \| ElevenLabs \|([^|]+)\| Rejected-at-eval \| Evaluated \|/g,
  '| 5197 | 2026-09-02 | ElevenLabs |$1| 2.0/5 | Rejected-at-eval |'
);
content = content.replace(
  /\| 5198 \| 2026-09-02 \| ElevenLabs \|([^|]+)\| Rejected-at-eval \| Evaluated \|/g,
  '| 5198 | 2026-09-02 | ElevenLabs |$1| 2.0/5 | Rejected-at-eval |'
);
content = content.replace(
  /\| 5199 \| 2026-09-02 \| ElevenLabs \|([^|]+)\| Rejected-at-eval \| Evaluated \|/g,
  '| 5199 | 2026-09-02 | ElevenLabs |$1| 2.0/5 | Rejected-at-eval |'
);
content = content.replace(
  /\| 5215 \| 2026-09-02 \| Decagon \|([^|]+)\| Evaluated \| Evaluated \|/g,
  '| 5215 | 2026-09-02 | Decagon |$1| 4.5/5 | Evaluated |'
);
content = content.replace(
  /\| 5216 \| 2026-09-02 \| Anyscale \|([^|]+)\| Evaluated \| Evaluated \|/g,
  '| 5216 | 2026-09-02 | Anyscale |$1| 3.5/5 | Evaluated |'
);
content = content.replace(
  /\| 5217 \| 2026-09-02 \| Anyscale \|([^|]+)\| Evaluated \| Evaluated \|/g,
  '| 5217 | 2026-09-02 | Anyscale |$1| 4.5/5 | Evaluated |'
);
content = content.replace(
  /\| 5218 \| 2026-09-02 \| Langchain \|([^|]+)\| Rejected-at-eval \| Evaluated \|/g,
  '| 5218 | 2026-09-02 | Langchain |$1| 2.0/5 | Rejected-at-eval |'
);
content = content.replace(
  /\| 5219 \| 2026-09-02 \| Langchain \|([^|]+)\| Evaluated \| Evaluated \|/g,
  '| 5219 | 2026-09-02 | Langchain |$1| 4.0/5 | Evaluated |'
);

fs.writeFileSync('ft/data/applications.md', content);
